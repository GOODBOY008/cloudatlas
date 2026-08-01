//! Integration tests for the cloud-account credential lifecycle (spec
//! 2026-08-17 §4): create with credentials, shape validation at create,
//! write-only rotation / clear via PUT, and the derived `has_credentials`
//! response flag. Mirrors the harness of `api_integration_tests.rs`.

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use cloudatlas_lib::{config, db, routes, state, state::AppState};
use serde_json::{json, Value};
use tower::ServiceExt;

const TEST_DB_URL: &str = "postgres://cloudatlas:cloudatlas@localhost:5432/cloudatlas_test";

fn test_db_url() -> String {
    std::env::var("DATABASE_URL").unwrap_or_else(|_| TEST_DB_URL.to_string())
}

/// Ensure the test database exists, then apply migrations and build the app.
/// Returns None (test skipped) when the database is unreachable and no
/// DATABASE_URL was explicitly provided — CI always sets DATABASE_URL so the
/// suite stays strict there.
async fn setup() -> Option<(axum::Router, sqlx::PgPool)> {
    let url = test_db_url();
    let explicit = std::env::var("DATABASE_URL").is_ok();

    // Quick reachability probe before sqlx's long acquire timeout.
    let host = url
        .split("://")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .and_then(|authority| authority.rsplit('@').next()) // strip user:pass@
        .unwrap_or("localhost:5432");
    if tokio::net::TcpStream::connect(host).await.is_err() {
        if !explicit {
            eprintln!(
                "SKIP: database at {host} unreachable — run with DATABASE_URL=... to execute integration tests"
            );
            return None;
        }
        panic!("DATABASE_URL {url} is not reachable");
    }

    // Set required env vars for Config::from_env (idempotent).
    if std::env::var("DATABASE_URL").is_err() {
        std::env::set_var("DATABASE_URL", TEST_DB_URL);
    }
    if std::env::var("JWT_SECRET").is_err() {
        std::env::set_var("JWT_SECRET", "integration-test-secret-at-least-32-chars");
    }
    if std::env::var("ENCRYPTION_KEY").is_err() {
        std::env::set_var(
            "ENCRYPTION_KEY",
            "0000000000000000000000000000000000000000000000000000000000000000",
        );
    }

    // Create the test database if it does not exist yet.
    {
        use sqlx::ConnectOptions as _;
        let mut opts: sqlx::postgres::PgConnectOptions = url.parse().expect("valid DATABASE_URL");
        let db_name = opts.get_database().unwrap_or("cloudatlas_test").to_string();
        let admin = sqlx::PgPool::connect_with(opts.database("postgres"))
            .await
            .expect("connect to postgres admin db");
        let _ = sqlx::query(&format!("CREATE DATABASE \"{db_name}\""))
            .execute(&admin)
            .await; // ignore "already exists"
        admin.close().await;
    }

    let pool = db::create_pool(&url, 5, 1, 300, 1800, 30).await.expect("connect to test db");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrations applied");

    let cfg = config::Config::from_env().expect("config loads");
    let app_state: AppState = state::AppState::new(pool.clone(), cfg);
    let app = routes::build_router(app_state);
    Some((app, pool))
}

/// Perform one HTTP request against the router and return (status, body).
async fn send(
    app: &axum::Router,
    method: Method,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(t) = token {
        builder = builder.header("authorization", format!("Bearer {t}"));
    }
    let req = match body {
        Some(b) => builder
            .header("content-type", "application/json")
            .body(Body::from(b.to_string()))
            .expect("valid body"),
        None => builder.body(Body::empty()).expect("empty body"),
    };

    let resp = app.clone().oneshot(req).await.expect("request completes");
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), 4 * 1024 * 1024)
        .await
        .expect("read body");
    let value: Value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
    (status, value)
}

/// Register a fresh user + org; returns (token, org_id).
async fn register_and_org(app: &axum::Router) -> (String, String) {
    let (status, body) = send(
        app,
        Method::POST,
        "/api/v1/auth/register",
        None,
        Some(json!({
            "email": format!("creds-{}@test.dev", uuid::Uuid::new_v4()),
            "password": "Test1234!",
            "display_name": "Creds Tester",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "register: {body}");
    let token = body["data"]["access_token"].as_str().expect("token").to_string();

    let (status, body) = send(
        app,
        Method::POST,
        "/api/v1/organizations",
        Some(&token),
        Some(json!({ "name": format!("Creds Org {}", uuid::Uuid::new_v4()) })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "org: {body}");
    let org_id = body["data"]["id"].as_str().expect("org id").to_string();
    (token, org_id)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_account_credential_lifecycle() {
    let Some((app, _pool)) = setup().await else {
        return; // DB unreachable and no explicit DATABASE_URL — skipped
    };
    let (token, org_id) = register_and_org(&app).await;
    let base = format!("/api/v1/orgs/{org_id}/cloud-accounts");

    // ── Create with full AWS credentials ──────────────────────────────────
    let (status, body) = send(
        &app,
        Method::POST,
        &base,
        Some(&token),
        Some(json!({
            "name": "aws-prod",
            "provider": "aws",
            "credentials": { "access_key_id": "AKIA123", "secret_access_key": "s3cr3t" },
            "config": { "external_id": "111" },
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "create: {body}");
    assert_eq!(body["data"]["has_credentials"], true, "flag set: {body}");
    assert!(body["data"].get("credentials").is_none(), "never return credentials");
    assert!(body["data"].get("credentials_enc").is_none(), "never return encrypted blob");
    let acct_id = body["data"]["id"].as_str().expect("account id").to_string();
    let acct = format!("{base}/{acct_id}");

    // ── Create with malformed (incomplete) credentials → 422 ─────────────
    let (status, body) = send(
        &app,
        Method::POST,
        &base,
        Some(&token),
        Some(json!({
            "name": "aws-bad",
            "provider": "aws",
            "credentials": { "access_key_id": "AKIA123" },
        })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "malformed create: {body}");
    assert!(
        body["error"]["message"].as_str().unwrap_or("").contains("secret_access_key"),
        "error should name the missing key: {body}"
    );

    // ── Empty credentials still allowed (mock/dev contract, D-1) ─────────
    let (status, body) = send(
        &app,
        Method::POST,
        &base,
        Some(&token),
        Some(json!({ "name": "mock-dev", "provider": "mock", "credentials": {} })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "empty creds create: {body}");
    assert_eq!(body["data"]["has_credentials"], false);

    // ── GET shows has_credentials, never the material ─────────────────────
    let (status, body) = send(&app, Method::GET, &acct, Some(&token), None).await;
    assert_eq!(status, StatusCode::OK, "get: {body}");
    assert_eq!(body["data"]["has_credentials"], true);
    assert!(body["data"].get("credentials").is_none());
    assert!(body["data"].get("credentials_enc").is_none());

    // ── Rotate via PUT with new credentials ───────────────────────────────
    let (status, body) = send(
        &app,
        Method::PUT,
        &acct,
        Some(&token),
        Some(json!({ "credentials": { "access_key_id": "AKIA456", "secret_access_key": "n3w" } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "rotate: {body}");
    assert_eq!(body["data"]["has_credentials"], true);

    // ── Invalid rotation → 422, nothing changes ───────────────────────────
    let (status, _) = send(
        &app,
        Method::PUT,
        &acct,
        Some(&token),
        Some(json!({ "credentials": { "access_key_id": "AKIA789" } })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "invalid rotate must 422");
    let (status, body) = send(&app, Method::GET, &acct, Some(&token), None).await;
    assert_eq!(body["data"]["has_credentials"], true, "creds preserved after failed rotate");

    // ── Clear via __CLEAR__ sentinel ──────────────────────────────────────
    let (status, body) = send(
        &app,
        Method::PUT,
        &acct,
        Some(&token),
        Some(json!({ "credentials": "__CLEAR__" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "clear: {body}");
    assert_eq!(body["data"]["has_credentials"], false);

    // ── PUT without credentials field → unchanged (no accidental clear) ───
    let (status, body) = send(
        &app,
        Method::PUT,
        &acct,
        Some(&token),
        Some(json!({ "name": "aws-renamed" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "rename: {body}");
    assert_eq!(body["data"]["name"], "aws-renamed");
    assert_eq!(body["data"]["has_credentials"], false);

    // ── "other" provider now creatable (mock-backed demo path) ────────────
    let (status, body) = send(
        &app,
        Method::POST,
        &base,
        Some(&token),
        Some(json!({ "name": "other-demo", "provider": "other", "config": { "external_id": "999" } })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "other create: {body}");
    let other_id = body["data"]["id"].as_str().expect("other id").to_string();
    let (status, body) = send(
        &app,
        Method::POST,
        &format!("{base}/{other_id}/test"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "other test connection: {body}");
    assert_eq!(body["data"]["success"], true, "mock-backed test: {body}");
}
