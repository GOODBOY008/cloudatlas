//! SSO regressions against TEST_DATABASE_URL and a local OIDC provider.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

use axum::{
    body::{to_bytes, Body},
    extract::{Form, State},
    http::{header, Method, Request, StatusCode},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use cloudatlas_lib::{
    config::Config, modules::auth::service::Claims, routes::build_router, state::AppState,
};
use reqwest::Url;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::{net::TcpListener, task::JoinHandle};
use tower::ServiceExt;
use uuid::Uuid;

const APP_ORIGIN: &str = "https://cloudatlas.example.test";
const CALLBACK: &str = "/api/v1/auth/oidc/callback";
const SESSION: &str = "/api/v1/auth/oidc/session";
const LOGIN_COOKIE: &str = "__Host-cloudatlas-oidc-login";
const SESSION_COOKIE: &str = "__Host-cloudatlas-oidc-session";

struct Fixture {
    router: Router,
    db: sqlx::PgPool,
    jwt_secret: String,
    email: String,
    token_requests: Arc<AtomicUsize>,
    provider: JoinHandle<()>,
}

impl Fixture {
    async fn new() -> Option<Self> {
        let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
            eprintln!("SKIP: set TEST_DATABASE_URL to a disposable DB for OIDC regressions");
            return None;
        };
        let db = sqlx::PgPool::connect(&url).await.unwrap();
        sqlx::migrate!("./migrations").run(&db).await.unwrap();
        let mut config = Config::from_env().expect("test config");
        config.app_url = Some(APP_ORIGIN.into());
        config.oidc_redirect_url = Some(format!("{APP_ORIGIN}{CALLBACK}"));
        config.oidc_client_id = Some("cloudatlas test client".into());
        config.oidc_client_secret = Some(Uuid::new_v4().to_string());

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let issuer = format!("http://{}", listener.local_addr().unwrap());
        config.oidc_issuer = Some(issuer.clone());
        let email = format!("oidc-{}@example.test", Uuid::new_v4());
        let provider_email = email.clone();
        let token_requests = Arc::new(AtomicUsize::new(0));
        let discovery = json!({
            "authorization_endpoint": format!("{issuer}/authorize?flow=browser"),
            "token_endpoint": format!("{issuer}/token"),
            "userinfo_endpoint": format!("{issuer}/userinfo"),
        });
        let app =
            Router::new()
                .route(
                    "/.well-known/openid-configuration",
                    get(move || async move { Json(discovery) }),
                )
                .route(
                    "/token",
                    post(
                        |State(requests): State<Arc<AtomicUsize>>,
                         Form(form): Form<HashMap<String, String>>| async move {
                            requests.fetch_add(1, Ordering::SeqCst);
                            let challenge = URL_SAFE_NO_PAD
                                .encode(Sha256::digest(form["code_verifier"].as_bytes()));
                            assert_eq!(form["grant_type"], "authorization_code");
                            assert_eq!(form["client_id"], "cloudatlas test client");
                            assert_eq!(form["redirect_uri"], format!("{APP_ORIGIN}{CALLBACK}"));
                            assert_eq!(form["code"], challenge);
                            Json(json!({ "access_token": "mock-provider-access" }))
                        },
                    ),
                )
                .route(
                    "/userinfo",
                    get(move || async move {
                        Json(json!({ "email": provider_email, "name": "SSO User" }))
                    }),
                )
                .with_state(token_requests.clone());
        let provider = tokio::spawn(async { axum::serve(listener, app).await.unwrap() });
        let jwt_secret = config.jwt_secret.clone();
        let router = build_router(AppState::new(db.clone(), config));
        Some(Self {
            router,
            db,
            jwt_secret,
            email,
            token_requests,
            provider,
        })
    }

    async fn start(&self) -> (String, String, String) {
        let response = self
            .request(Method::GET, "/api/v1/auth/oidc/start", None, None, None)
            .await;
        assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let location = Url::parse(response.headers()[header::LOCATION].to_str().unwrap()).unwrap();
        let params: HashMap<_, _> = location.query_pairs().into_owned().collect();
        assert_eq!(params["flow"], "browser");
        assert_eq!(params["client_id"], "cloudatlas test client");
        assert_eq!(params["code_challenge_method"], "S256");
        let browser_cookie = protected_cookie(&response, LOGIN_COOKIE);
        let callback = format!(
            "{CALLBACK}?state={}&code={}",
            params["state"], params["code_challenge"]
        );
        (callback, browser_cookie, params["state"].clone())
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        cookie: Option<&str>,
        body: Option<Value>,
        site: Option<&str>,
    ) -> Response {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie);
        }
        if let Some(site) = site {
            request = request.header("sec-fetch-site", site);
        }
        let body = match body {
            Some(body) => {
                request = request.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        self.router
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap()
    }

    async fn cleanup(self) {
        self.provider.abort();
        sqlx::query("DELETE FROM users WHERE email = $1")
            .bind(&self.email)
            .execute(&self.db)
            .await
            .unwrap();
    }
}

fn protected_cookie(response: &Response, name: &str) -> String {
    let cookie = response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|value| value.to_str().unwrap())
        .find(|cookie| cookie.starts_with(&format!("{name}=")))
        .expect("OIDC cookie");
    let fields: Vec<_> = cookie.split("; ").collect();
    for field in ["Path=/", "HttpOnly", "Secure", "SameSite=Lax"] {
        assert!(fields.contains(&field));
    }
    assert!(!fields.iter().any(|field| field.starts_with("Domain=")));
    fields[0].to_owned()
}

async fn json_body(response: Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap()
}

#[tokio::test]
async fn handoff_binds_pkce_to_one_browser_then_issues_and_revokes_a_cookie_session() {
    let Some(fixture) = Fixture::new().await else {
        return;
    };
    let (callback, browser_cookie, _) = fixture.start().await;
    let (_, other_browser_cookie, _) = fixture.start().await;
    for cookie in [None, Some(other_browser_cookie.as_str())] {
        let response = fixture
            .request(Method::GET, &callback, cookie, None, None)
            .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    assert_eq!(fixture.token_requests.load(Ordering::SeqCst), 0);

    let (first, second) = tokio::join!(
        fixture.request(Method::GET, &callback, Some(&browser_cookie), None, None),
        fixture.request(Method::GET, &callback, Some(&browser_cookie), None, None),
    );
    let (completed, replay) = if first.status() == StatusCode::SEE_OTHER {
        (first, second)
    } else {
        (second, first)
    };
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(completed.status(), StatusCode::SEE_OTHER);
    assert_eq!(
        completed.headers()[header::LOCATION].to_str().unwrap(),
        format!("{APP_ORIGIN}/auth/oidc/complete"),
    );
    assert_eq!(completed.headers()[header::CACHE_CONTROL], "no-store");
    let cookie = protected_cookie(&completed, SESSION_COOKIE);
    assert_eq!(fixture.token_requests.load(Ordering::SeqCst), 1);

    let unauthorized = fixture
        .request(
            Method::POST,
            SESSION,
            None,
            Some(json!({})),
            Some("same-origin"),
        )
        .await;
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    let cross_origin = fixture
        .request(
            Method::POST,
            SESSION,
            Some(&cookie),
            Some(json!({})),
            Some("same-site"),
        )
        .await;
    assert_eq!(cross_origin.status(), StatusCode::FORBIDDEN);

    let session = fixture
        .request(
            Method::POST,
            SESSION,
            Some(&cookie),
            Some(json!({})),
            Some("same-origin"),
        )
        .await;
    assert_eq!(session.status(), StatusCode::OK);
    assert_eq!(session.headers()[header::CACHE_CONTROL], "no-store");
    let session = json_body(session).await;
    let data = &session["data"];
    let access = data["access_token"].as_str().unwrap();
    assert_eq!(
        Claims::verify(access, &fixture.jwt_secret).unwrap().email,
        fixture.email
    );
    assert!(data.get("refresh_token").is_none());
    let matched = json!({ "session_id": data["session_id"] });
    let mismatch = json!({ "session_id": Uuid::new_v4() });
    assert_eq!(
        fixture
            .request(
                Method::POST,
                SESSION,
                Some(&cookie),
                Some(mismatch.clone()),
                Some("same-origin"),
            )
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert!(fixture
        .request(
            Method::DELETE,
            SESSION,
            Some(&cookie),
            Some(mismatch),
            Some("same-origin"),
        )
        .await
        .headers()
        .get(header::SET_COOKIE)
        .is_none());
    assert_eq!(
        fixture
            .request(
                Method::DELETE,
                SESSION,
                Some(&cookie),
                Some(matched.clone()),
                Some("cross-site"),
            )
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        fixture
            .request(
                Method::POST,
                SESSION,
                Some(&cookie),
                Some(matched.clone()),
                Some("same-origin"),
            )
            .await
            .status(),
        StatusCode::OK
    );

    let logout = fixture
        .request(
            Method::DELETE,
            SESSION,
            Some(&cookie),
            Some(matched.clone()),
            Some("same-origin"),
        )
        .await;
    assert_eq!(logout.status(), StatusCode::NO_CONTENT);
    assert!(logout.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .contains("Max-Age=0"));
    assert_eq!(
        fixture
            .request(
                Method::POST,
                SESSION,
                Some(&cookie),
                Some(matched),
                Some("same-origin"),
            )
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    fixture.cleanup().await;
}

#[tokio::test]
async fn expired_login_transaction_cannot_exchange_a_code() {
    let Some(fixture) = Fixture::new().await else {
        return;
    };
    let (callback, browser_cookie, state) = fixture.start().await;
    sqlx::query("UPDATE oidc_login_transactions SET expires_at = NOW() WHERE state_hash = $1")
        .bind(hex::encode(Sha256::digest(state.as_bytes())))
        .execute(&fixture.db)
        .await
        .unwrap();
    let response = fixture
        .request(Method::GET, &callback, Some(&browser_cookie), None, None)
        .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(fixture.token_requests.load(Ordering::SeqCst), 0);
    fixture.cleanup().await;
}
