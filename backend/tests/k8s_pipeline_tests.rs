//! Integration tests for the k8s rightsizing pipeline (spec/plan
//! 2026-08-17): create a kubernetes cloud account, then exercise the
//! persistence + recompute path directly with fixture structs — cluster
//! upsert, workload upsert, usage samples, P95 recommendation math.
//! Mirrors the harness of `cloud_credentials_tests.rs`.

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use cloudatlas_lib::modules::cloud::adapters::kubernetes::{K8sNodeInfo, K8sWorkload};
use cloudatlas_lib::modules::k8s::pipeline::{
    compute_recommendation, recompute_recommendations, record_samples, upsert_cluster,
    upsert_workloads,
};
use cloudatlas_lib::{config, db, routes, state, state::AppState};
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

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
        let opts: sqlx::postgres::PgConnectOptions = url.parse().expect("valid DATABASE_URL");
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
            "email": format!("k8s-{}@test.dev", uuid::Uuid::new_v4()),
            "password": "Test1234!",
            "display_name": "K8s Tester",
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
        Some(json!({ "name": format!("K8s Org {}", uuid::Uuid::new_v4()) })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "org: {body}");
    let org_id = body["data"]["id"].as_str().expect("org id").to_string();
    (token, org_id)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn k8s_pipeline_persists_and_recomputes() {
    let Some((app, pool)) = setup().await else {
        return; // DB unreachable and no explicit DATABASE_URL — skipped
    };

    // Org + kubernetes account (provider enum includes 'kubernetes').
    let (token, org_id) = register_and_org(&app).await;
    let (status, body) = send(
        &app,
        Method::POST,
        &format!("/api/v1/orgs/{org_id}/cloud-accounts"),
        Some(&token),
        Some(json!({
            "name": "k8s-prod",
            "provider": "kubernetes",
            "credentials": { "server": "https://cluster.example", "token": "secret" },
            "config": { "cluster_name": "prod-cluster" },
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "create account: {body}");
    let account_id: Uuid = body["data"]["id"].as_str().unwrap().parse().unwrap();
    let org: Uuid = org_id.parse().unwrap();

    // ── upsert cluster (create) ───────────────────────────────────────────
    let nodes = vec![
        K8sNodeInfo {
            name: "node-1".into(),
            cpu_cores: 8.0,
            memory_gb: 32.0,
            region: Some("cn-hangzhou".into()),
            provider: "on-prem".into(),
        },
        K8sNodeInfo {
            name: "node-2".into(),
            cpu_cores: 4.0,
            memory_gb: 16.0,
            region: Some("cn-hangzhou".into()),
            provider: "on-prem".into(),
        },
    ];
    let cluster_id = upsert_cluster(&pool, org, account_id, "prod-cluster", &nodes, 0.04, 0.005)
        .await
        .unwrap();
    let row: (i32, f64, f64) = sqlx::query_as(
        "SELECT node_count, total_vcpu::float8, total_memory_gb::float8 FROM k8s_clusters WHERE id = $1",
    )
    .bind(cluster_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, 2, "node_count");
    assert_eq!(row.1, 12.0, "total_vcpu");
    assert_eq!(row.2, 48.0, "total_memory_gb");

    // ── upsert workloads (create + update requests) ───────────────────────
    let wl = |cpu: i64, mem: i64, usage: Option<(f64, f64)>| K8sWorkload {
        namespace: "prod".into(),
        name: "web".into(),
        kind: "Deployment".into(),
        cpu_request_m: cpu,
        mem_request_mi: mem,
        cpu_limit_m: None,
        mem_limit_mi: None,
        pod_names: vec!["web-abc".into()],
        usage,
    };
    let workloads = vec![wl(1000, 1024, Some((600.0, 800.0)))];
    let ids = upsert_workloads(&pool, org, cluster_id, &workloads).await.unwrap();
    assert_eq!(ids.len(), 1, "one workload id");

    // ── samples + recompute ───────────────────────────────────────────────
    let inserted = record_samples(&pool, org, cluster_id, &workloads, &ids).await.unwrap();
    assert_eq!(inserted, 1, "one sample inserted");
    let updated = recompute_recommendations(&pool, cluster_id, &workloads, &ids, 0.04, 0.005, 14)
        .await
        .unwrap();
    assert_eq!(updated, 1, "one workload recomputed");

    let row: (f64, f64, i32, i32, f64, f64) = sqlx::query_as(
        "SELECT cpu_p95_m::float8, mem_p95_mi::float8, cpu_rec_m, mem_rec_mi,
                monthly_cost::float8, potential_savings::float8
         FROM k8s_workload_metrics WHERE cluster_id = $1 AND workload_name = 'web'",
    )
    .bind(cluster_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, 600.0, "cpu_p95_m (1 sample -> latest)");
    assert_eq!(row.2, 600, "cpu_rec_m");
    assert!((row.4 - 32.85).abs() < 0.01, "monthly_cost {}, want ~32.85", row.4);
    assert!(row.5 > 0.0, "potential_savings {}", row.5);

    // ── no-usage path (metrics-server absent) leaves rec columns NULL ─────
    let workloads2 = vec![K8sWorkload {
        namespace: "prod".into(),
        name: "worker".into(),
        kind: "Job".into(),
        cpu_request_m: 200,
        mem_request_mi: 256,
        cpu_limit_m: None,
        mem_limit_mi: None,
        pod_names: vec![],
        usage: None,
    }];
    let ids2 = upsert_workloads(&pool, org, cluster_id, &workloads2).await.unwrap();
    let updated2 =
        recompute_recommendations(&pool, cluster_id, &workloads2, &ids2, 0.04, 0.005, 14)
            .await
            .unwrap();
    assert_eq!(updated2, 0, "no samples -> skipped");

    // ── pure math sanity (unit behaviour double-checked here) ─────────────
    let samples = vec![100.0, 200.0, 300.0, 400.0, 500.0, 600.0];
    let (p95_cpu, p95_mem, rec_cpu, rec_mem, cost, savings) =
        compute_recommendation(1000, 1024, &samples, &samples, 0.04, 0.005);
    assert_eq!(p95_cpu, 600.0);
    assert_eq!(p95_mem, 600.0);
    assert_eq!(rec_cpu, 600);
    assert_eq!(rec_mem, 600);
    assert!((cost - 32.85).abs() < 1e-9, "cost {cost}");
    assert!(savings > 10.0 && savings < 15.0, "savings {savings}");
}