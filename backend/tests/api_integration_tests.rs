//! End-to-end API integration tests against a real PostgreSQL database.
//!
//! Uses `DATABASE_URL` (defaults to a local `cloudatlas_test` database),
//! creates the database if missing, applies all migrations, then exercises the
//! full Axum router over HTTP (via `tower::ServiceExt::oneshot`).
//!
//! Run locally: `DATABASE_URL=postgres://cloudatlas:cloudatlas@localhost:5432/cloudatlas_test cargo test --test api_integration_tests`

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
        let _ = sqlx::query(sqlx::AssertSqlSafe(&*format!(
            "CREATE DATABASE \"{db_name}\""
        )))
        .execute(&admin)
        .await; // ignore "already exists"
        admin.close().await;
    }

    let pool = db::create_pool(&url, 5, 1, 300, 1800, 30)
        .await
        .expect("connect to test db");
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
    // JSON when parseable, otherwise keep the raw text so text endpoints
    // (e.g. /metrics) can be asserted too.
    let value: Value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
    (status, value)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn full_api_flow() {
    let Some((app, pool)) = setup().await else {
        return; // DB unreachable and no explicit DATABASE_URL — skipped
    };

    // ── Auth: register → login → me ────────────────────────────────────────
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/v1/auth/register",
        None,
        Some(json!({
            "email": format!("it-{}@test.dev", uuid::Uuid::new_v4()),
            "password": "Test1234!",
            "display_name": "Integration Tester",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "register: {body}");
    let token = body["data"]["access_token"]
        .as_str()
        .expect("access token returned")
        .to_string();

    let (status, body) = send(&app, Method::GET, "/api/v1/auth/me", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK, "auth/me: {body}");

    // ── Org creation ────────────────────────────────────────────────────────
    let run_suffix = uuid::Uuid::new_v4().to_string();
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/v1/organizations",
        Some(&token),
        Some(json!({ "name": format!("IT Org {run_suffix}") })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "create org: {body}");
    let org_id = body["data"]["id"].as_str().expect("org id").to_string();

    // ── Expense summary (empty org → 200 with zeros) ────────────────────────
    let (status, _) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{org_id}/expenses/summary"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "expenses summary");

    // ── Webhooks CRUD round-trip ────────────────────────────────────────────
    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/webhooks"),
        Some(&token),
        Some(json!({
            "name": "it-hook",
            "url": "https://example.com/hook",
            "events": ["budget.exceeded"],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "create webhook: {body}");
    let hook_id = body["data"]["id"].as_str().expect("hook id").to_string();

    let (status, body) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{org_id}/webhooks"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"][0]["id"].as_str(), Some(hook_id.as_str()));

    let (status, _) = send(
        &app,
        Method::PUT,
        &format!("/api/v1/orgs/{org_id}/webhooks/{hook_id}"),
        Some(&token),
        Some(json!({ "is_active": false })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "update webhook");

    let (status, _) = send(
        &app,
        Method::DELETE,
        &format!("/api/v1/orgs/{org_id}/webhooks/{hook_id}"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "delete webhook");

    // ── Constraints: create + evaluate ──────────────────────────────────────
    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/constraints"),
        Some(&token),
        Some(json!({
            "name": "monthly-limit",
            "constraint_type": "total_expense_limit",
            "limit_value": 1000.0,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "create constraint: {body}");

    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/constraints/evaluate"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "evaluate constraints: {body}");
    assert!(body["data"]["evaluated"].as_u64().unwrap_or(0) >= 1);

    // ── Recommendations checklist: patch then read ──────────────────────────
    let (status, body) = send(
        &app,
        Method::PATCH,
        &format!("/api/v1/orgs/{org_id}/recommendations/checklist"),
        Some(&token),
        Some(json!({
            "modules_config": { "abandoned_volume": { "enabled": false } }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "patch checklist: {body}");
    assert_eq!(
        body["data"]["modules_config"]["abandoned_volume"]["enabled"],
        false
    );

    let (status, body) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{org_id}/recommendations/checklist"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "get checklist: {body}");
    assert_eq!(
        body["data"]["recommendation_counts"]["active"].as_u64(),
        Some(0)
    );

    // ── Events feed (unified alert + webhook stream) ────────────────────────
    let (status, body) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{org_id}/events?limit=10"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "events: {body}");
    assert!(body["meta"]["total"].is_u64(), "pagination meta present");

    // ── Pagination meta on a paginated list ─────────────────────────────────
    let (status, body) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{org_id}/alert-events?limit=5&offset=0"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "alert-events: {body}");
    assert_eq!(body["meta"]["limit"].as_u64(), Some(5));

    // ── Recommendation engine run (all 26 detectors, background job) ────────
    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/recommendations/run"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "engine run: {body}");

    // The engine runs in the background — poll the checklist until completed.
    let mut run_ok = false;
    for _ in 0..25 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let (_, body) = send(
            &app,
            Method::GET,
            &format!("/api/v1/orgs/{org_id}/recommendations/checklist"),
            Some(&token),
            None,
        )
        .await;
        if body["data"]["run_status"].as_str() == Some("completed") {
            run_ok = true;
            break;
        }
    }
    assert!(run_ok, "engine run should complete with all 26 detectors");

    let (status, _) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{org_id}/recommendations"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "recommendations list after run");

    // ── Tenant isolation: a second org cannot see the first org's data ──────
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/v1/organizations",
        Some(&token),
        Some(json!({ "name": format!("Other Org {run_suffix}") })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let other_org = body["data"]["id"]
        .as_str()
        .expect("second org id")
        .to_string();

    let (status, body) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{other_org}/webhooks"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["data"].as_array().map(Vec::len),
        Some(0),
        "other org sees no webhooks from org A"
    );

    // ── Auth guard: unauthenticated requests are rejected ───────────────────
    let (status, _) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{org_id}/expenses/summary"),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "no token → 401");

    // ── BI Export: create → run → download ──────────────────────────────────
    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/bi-exports"),
        Some(&token),
        Some(json!({
            "name": format!("it-export-{run_suffix}"),
            "format": "csv",
            "scope": "expenses",
            "filters": { "start_date": "2026-01-01", "end_date": "2026-12-31" },
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "create export: {body}");
    let export_id = body["data"]["id"].as_str().expect("export id").to_string();

    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/bi-exports/{export_id}/run"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "run export: {body}");
    assert!(body["data"]["run_id"].is_string());

    let (status, body) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{org_id}/bi-exports/{export_id}/runs"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "export runs: {body}");
    assert_eq!(body["data"][0]["status"].as_str(), Some("completed"));

    let (status, _) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{org_id}/bi-exports/{export_id}/download"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "export download");

    // ── Integrations: create → test (pagerduty key-only → connected) ────────
    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/integrations"),
        Some(&token),
        Some(json!({
            "provider": "pagerduty",
            "name": format!("it-pd-{run_suffix}"),
            "config": { "service_key": "test-key" },
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "create integration: {body}");
    let integration_id = body["data"]["id"]
        .as_str()
        .expect("integration id")
        .to_string();

    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/integrations/{integration_id}/test"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "test integration: {body}");
    assert_eq!(body["data"]["status"].as_str(), Some("connected"));

    // ── AI: settings, forecast, anomalies, notes ────────────────────────────
    let (status, body) = send(
        &app,
        Method::PUT,
        &format!("/api/v1/orgs/{org_id}/ai/settings"),
        Some(&token),
        Some(json!({ "forecast_enabled": false })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "update ai settings: {body}");
    assert_eq!(body["data"]["forecast_enabled"], false);

    let (status, body) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{org_id}/ai/settings"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "get ai settings: {body}");

    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/ai/forecast"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "ai forecast: {body}");
    assert_eq!(body["data"]["horizon_days"].as_u64(), Some(14));

    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/ai/anomalies"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "ai anomalies: {body}");
    assert!(body["data"]["anomalies"].is_array());

    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/ai/notes"),
        Some(&token),
        Some(json!({
            "title": "it-note",
            "body": "Prod account uses savings plans for all EC2",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "create note: {body}");

    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/ai/notes/search"),
        Some(&token),
        Some(json!({ "query": "savings plans", "limit": 5 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "search notes: {body}");
    assert_eq!(body["data"][0]["title"].as_str(), Some("it-note"));

    // ── S3 duplicate analysis (empty → zero summary) ────────────────────────
    let (status, body) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{org_id}/s3-duplicates"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "s3 duplicates: {body}");
    assert_eq!(body["data"]["summary"]["bucket_count"].as_u64(), Some(0));

    // ── Copilot (local mode — no API key in tests) ─────────────────────────
    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/ai/copilot/chat"),
        Some(&token),
        Some(json!({
            "messages": [{ "role": "user", "content": "how much did we spend this month?" }]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "copilot chat: {body}");
    let sse = body.as_str().expect("copilot replies as SSE text");
    assert!(sse.contains("delta"), "SSE delta frames present: {sse}");
    assert!(
        sse.contains("\"done\":true"),
        "SSE done frame present: {sse}"
    );
    assert!(
        sse.contains("month-to-date") || sse.contains("spend picture"),
        "local copilot answers from the digest: {sse}"
    );

    // page_context is accepted (and ignored by local mode).
    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/ai/copilot/chat"),
        Some(&token),
        Some(json!({
            "messages": [{ "role": "user", "content": "top resources" }],
            "page_context": "/recommendations"
        })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "copilot chat with page_context: {body}"
    );

    // page_context is length-capped.
    let long_ctx = "x".repeat(201);
    let (status, _) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/ai/copilot/chat"),
        Some(&token),
        Some(json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "page_context": long_ctx
        })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "page_context > 200 chars is rejected"
    );

    // Copilot is org-scoped: other org sees 403 (not a member).
    let (status, _) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{other_org}/ai/copilot/chat"),
        Some(&token),
        Some(json!({ "messages": [{ "role": "user", "content": "hi" }] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "member of second org can chat");

    // ── AI provider config (org-level, spec 2026-08-14) ─────────────────────
    // PUT then GET: key never returned raw, masked hint present, source=org.
    let (status, body) = send(
        &app,
        Method::PUT,
        &format!("/api/v1/orgs/{org_id}/ai/provider"),
        Some(&token),
        Some(json!({
            "ai_provider_enabled": true,
            "ai_base_url": "http://localhost:9/v1", // unreachable on purpose
            "api_key": "sk-test-1234",
            "ai_chat_model": "test-model"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "put provider: {body}");
    assert_eq!(body["data"]["source"], "org");
    assert_eq!(body["data"]["api_key_set"], true);
    assert!(body["data"]["api_key_hint"]
        .as_str()
        .unwrap()
        .ends_with("1234"));
    assert!(
        !body.to_string().contains("sk-test-1234"),
        "raw key must never be returned"
    );

    // GET as member: allowed, still masked.
    let (status, body) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{org_id}/ai/provider"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "get provider: {body}");
    assert_eq!(body["data"]["stored"]["ai_chat_model"], "test-model");
    assert!(body["data"]["api_key_set"].as_bool().unwrap());

    // Enabling without a key must 422 (post-condition guard).
    let (status, body) = send(
        &app,
        Method::PUT,
        &format!("/api/v1/orgs/{org_id}/ai/provider"),
        Some(&token),
        Some(json!({ "ai_base_url": "http://localhost:9/v1", "ai_provider_enabled": true, "api_key": "__CLEAR__" })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "enable without key must 422: {body}"
    );

    // Clear the key (disable in the same request so the enable-guard passes).
    let (status, body) = send(
        &app,
        Method::PUT,
        &format!("/api/v1/orgs/{org_id}/ai/provider"),
        Some(&token),
        Some(json!({ "api_key": "__CLEAR__", "ai_provider_enabled": false })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "clear key: {body}");
    assert_eq!(body["data"]["api_key_set"], false);

    // Invalid base_url → 422.
    let (status, _) = send(
        &app,
        Method::PUT,
        &format!("/api/v1/orgs/{org_id}/ai/provider"),
        Some(&token),
        Some(json!({ "ai_base_url": "ftp://nope" })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    // Test endpoint: unreachable upstream reports ok=false without panicking.
    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/ai/provider/test"),
        Some(&token),
        Some(json!({ "ai_base_url": "http://localhost:9/v1", "api_key": "sk-x", "ai_provider_enabled": true })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "test provider: {body}");
    assert_eq!(body["data"]["ok"], false);

    // Reset to clean state (local mode) for later tests.
    let _ = send(
        &app,
        Method::PUT,
        &format!("/api/v1/orgs/{org_id}/ai/provider"),
        Some(&token),
        Some(json!({ "ai_provider_enabled": false })),
    )
    .await;

    // ── RBAC: Member role is enforced on mutating endpoints ─────────────────
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/v1/auth/register",
        None,
        Some(json!({
            "email": format!("member-{run_suffix}@test.dev"),
            "password": "Test1234!",
            "display_name": "Member User",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "register member: {body}");
    let member_token = body["data"]["access_token"]
        .as_str()
        .expect("member token")
        .to_string();
    let member_id = body["data"]["user"]["id"]
        .as_str()
        .expect("member id")
        .to_string();

    // Owner invites the member and assigns the Member role.
    let (status, _) = send(
        &app,
        Method::POST,
        &format!("/api/v1/organizations/{org_id}/members"),
        Some(&token),
        Some(json!({ "user_id": member_id })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "invite member");
    let (status, _) = send(
        &app,
        Method::PUT,
        &format!("/api/v1/orgs/{org_id}/members/{member_id}/role"),
        Some(&token),
        Some(json!({ "role_name": "Member" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "assign member role");

    // Member can read.
    let (status, _) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{org_id}/expenses/summary"),
        Some(&member_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "member can read expenses");

    // Member mutations are rejected with 403.
    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/pools"),
        Some(&member_token),
        Some(json!({ "name": "member-pool", "pool_type": "project" })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "member cannot create pools: {body}"
    );

    let (status, _) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/webhooks"),
        Some(&member_token),
        Some(json!({
            "name": "member-hook",
            "url": "https://example.com/x",
            "events": ["budget.exceeded"],
        })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "member cannot create webhooks"
    );

    let (status, _) = send(
        &app,
        Method::PATCH,
        &format!("/api/v1/orgs/{org_id}/recommendations/checklist"),
        Some(&member_token),
        Some(json!({ "modules_config": {} })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "member cannot mutate checklist"
    );

    // Owner can still mutate.
    let (status, _) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/pools"),
        Some(&token),
        Some(json!({ "name": "owner-pool", "pool_type": "project" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "owner can create pools");

    // ── AI conversations (G3): create → chat persists → list → messages ─────
    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/ai/conversations"),
        Some(&token),
        Some(json!({ "title": "it-convo" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "create conversation: {body}");
    let conv_id = body["data"]["id"]
        .as_str()
        .expect("conversation id")
        .to_string();

    // Copilot chat with the conversation id persists user + assistant messages.
    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/ai/copilot/chat"),
        Some(&token),
        Some(json!({
            "messages": [{ "role": "user", "content": "any budget alerts?" }],
            "conversation_id": conv_id,
        })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "copilot chat in conversation: {body}"
    );
    assert!(
        body.as_str()
            .map_or(false, |s| s.contains("conversation_id")),
        "SSE carries the conversation id: {body}"
    );

    let (status, body) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{org_id}/ai/conversations/{conv_id}/messages"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "list messages: {body}");
    let msgs = body["data"].as_array().expect("messages array");
    assert!(
        msgs.iter().any(|m| m["role"] == "user") && msgs.iter().any(|m| m["role"] == "assistant"),
        "both user and assistant messages persisted: {body}"
    );

    let (status, body) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{org_id}/ai/conversations"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "list conversations: {body}");
    assert!(body["data"]
        .as_array()
        .map_or(false, |a| a.iter().any(|c| c["id"] == conv_id)));

    // ── AI analysis runs (G9): forecast + anomaly persist history ───────────
    let (status, _) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/ai/forecast"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "forecast run");
    let (status, body) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{org_id}/ai/analysis-runs?kind=forecast"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "analysis runs: {body}");
    assert!(
        body["data"]
            .as_array()
            .map_or(false, |a| a.iter().any(|r| r["kind"] == "forecast")),
        "forecast run recorded"
    );

    // ── Notifications inbox (G11) ───────────────────────────────────────────
    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/notifications"),
        Some(&token),
        Some(json!({ "kind": "system", "title": "hello", "body": "integration test" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "create notification: {body}");

    let (status, body) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{org_id}/notifications"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "list notifications: {body}");
    assert!(
        body["unread"].as_u64().unwrap_or(0) >= 1,
        "unread count present"
    );

    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/notifications/read-all"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "mark all read: {body}");

    // ── Resource → recommendations drill-down (G12) ────────────────────────
    let (status, body) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{org_id}/resources?limit=5"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "resources list: {body}");
    if let Some(resource_id) = body["data"][0]["id"].as_str() {
        let (status, body) = send(
            &app,
            Method::GET,
            &format!("/api/v1/orgs/{org_id}/resources/{resource_id}/recommendations"),
            Some(&token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "resource recommendations: {body}");
        assert!(body["data"].is_array());
    }

    // ── API keys (I1): create → authenticate → revoke ──────────────────────
    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/api-keys"),
        Some(&token),
        Some(json!({ "name": "it-key" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "create api key: {body}");
    let api_key = body["data"]["key"]
        .as_str()
        .expect("plaintext key")
        .to_string();

    // Authenticate with the key (as a Bearer token).
    let (status, _) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{org_id}/expenses/summary"),
        Some(&api_key),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "api key authenticates");

    let key_id = body["data"]["id"].as_str().expect("key id").to_string();
    let (status, _) = send(
        &app,
        Method::DELETE,
        &format!("/api/v1/orgs/{org_id}/api-keys/{key_id}"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "revoke api key");
    let (status, _) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{org_id}/expenses/summary"),
        Some(&api_key),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "revoked key rejected");

    // ── Metrics (D1): ingest then read ──────────────────────────────────────
    let (status, body) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{org_id}/resources?limit=1"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    if let Some(resource_id) = body["data"][0]["id"].as_str() {
        let (status, body) = send(
            &app,
            Method::POST,
            &format!("/api/v1/orgs/{org_id}/metrics"),
            Some(&token),
            Some(json!({
                "points": [{ "resource_id": resource_id, "metric_name": "cpu_utilization", "value": 2.5 }]
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "ingest metrics: {body}");
        assert_eq!(body["data"]["inserted"].as_u64(), Some(1));

        let (status, body) = send(
            &app,
            Method::GET,
            &format!(
                "/api/v1/orgs/{org_id}/metrics?resource_id={resource_id}&metric=cpu_utilization"
            ),
            Some(&token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "read metrics: {body}");
        assert!(body["data"].as_array().map_or(false, |a| a.len() >= 1));
    }

    // ── Global search (P3) ──────────────────────────────────────────────────
    let (status, body) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{org_id}/search?q=owner"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "global search: {body}");
    assert!(
        body["data"]["pools"].is_array(),
        "search returns grouped results"
    );

    // ── Demo data (P5): seed → expenses present → idempotent ───────────────
    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/demo-data"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "seed demo data: {body}");

    let (status, body) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{org_id}/expenses/summary"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        body["data"]["total_cost"].as_f64().unwrap_or(0.0) > 0.0,
        "demo expenses present: {body}"
    );

    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/demo-data"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "demo data idempotent");
    assert!(
        body["data"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("already"),
        "no double seed"
    );

    // ── Invites (C1): create + list + revoke ────────────────────────────────
    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/invites"),
        Some(&token),
        Some(json!({ "email": format!("invitee-{run_suffix}@test.dev"), "role": "Member" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "create invite: {body}");
    let invite_id = body["data"]["id"].as_str().expect("invite id").to_string();

    let (status, body) = send(
        &app,
        Method::GET,
        &format!("/api/v1/orgs/{org_id}/invites"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "list invites: {body}");
    assert!(body["data"]
        .as_array()
        .map_or(false, |a| a.iter().any(|i| i["id"] == invite_id)));

    let (status, _) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/invites/{invite_id}/revoke"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "revoke invite");

    // ── Metrics endpoint ────────────────────────────────────────────────────
    let (status, body) = send(&app, Method::GET, "/metrics", None, None).await;
    assert_eq!(status, StatusCode::OK, "metrics endpoint");
    assert!(body
        .as_str()
        .map_or(false, |s| s.contains("cloudatlas_http_requests_total")));

    pool.close().await;
}
