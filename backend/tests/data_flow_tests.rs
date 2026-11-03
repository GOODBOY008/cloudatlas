//! Regression tests against an isolated, migrated PostgreSQL database.
//! TEST_DATABASE_URL must point to a disposable test database.
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use chrono::Utc;
use cloudatlas_lib::{
    config::Config,
    modules::{
        auth::service::Claims,
        billing::{aliyun_bss, aws_cur},
        expense::reporting,
    },
    routes,
    state::AppState,
};
use serde_json::{json, Value};
use sqlx::Row;
use tower::ServiceExt;
use uuid::Uuid;

async fn fixture() -> Option<(AppState, Uuid, Uuid, Uuid)> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("SKIP: set TEST_DATABASE_URL to run data-flow DB regressions");
        return None;
    };
    let db = sqlx::PgPool::connect(&url).await.expect("test database");
    sqlx::migrate!("./migrations")
        .run(&db)
        .await
        .expect("migrations");
    let state = AppState::new(db, Config::from_env().expect("test config"));
    let org: Uuid = sqlx::query_scalar("INSERT INTO organizations (name, slug, settings) VALUES ('Flow test', $1, '{\"currency\":\"CNY\"}') RETURNING id")
        .bind(Uuid::new_v4().to_string()).fetch_one(&state.db).await.unwrap();
    let account = account(&state, org, "Account A").await;
    let user: Uuid = sqlx::query_scalar("INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'not-a-login', 'Flow tester') RETURNING id")
        .bind(format!("{}@test.invalid", Uuid::new_v4())).fetch_one(&state.db).await.unwrap();
    sqlx::query("INSERT INTO organization_members (organization_id, user_id) VALUES ($1, $2)")
        .bind(org)
        .bind(user)
        .execute(&state.db)
        .await
        .unwrap();
    Some((state, org, account, user))
}

async fn account(state: &AppState, org: Uuid, name: &str) -> Uuid {
    sqlx::query_scalar("INSERT INTO cloud_accounts (organization_id, name, provider, credentials_enc) VALUES ($1, $2, 'aws', 'test') RETURNING id")
        .bind(org).bind(name).fetch_one(&state.db).await.unwrap()
}
async fn cleanup(state: &AppState, org: Uuid, user: Uuid) {
    sqlx::query("DELETE FROM organizations WHERE id = $1")
        .bind(org)
        .execute(&state.db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user)
        .execute(&state.db)
        .await
        .unwrap();
    state.db.close().await;
}
fn line(resource: &str, service: &str, amount: f64) -> aws_cur::CurLineItem {
    aws_cur::CurLineItem {
        resource_id: resource.into(),
        resource_name: Some(resource.into()),
        service_name: service.into(),
        usage_date: Utc::now().date_naive(),
        region: Some("region-a".into()),
        resource_type: None,
        cost_usd: amount,
        currency: "CNY".into(),
        tags: json!({"team":"platform"}),
    }
}

#[tokio::test]
async fn billing_sums_lines_updates_corrections_and_reconciles_resource_costs() {
    let Some((state, org, account, user)) = fixture().await else {
        return;
    };
    let pool: Uuid = sqlx::query_scalar(
        "INSERT INTO pools (organization_id, name) VALUES ($1, 'Engineering') RETURNING id",
    )
    .bind(org)
    .fetch_one(&state.db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO resources (organization_id, cloud_account_id, cloud_resource_id, pool_id) VALUES ($1, $2, 'shared', $3)")
        .bind(org).bind(account).bind(pool).execute(&state.db).await.unwrap();
    let count = aws_cur::import_line_items(
        &state,
        org,
        account,
        vec![
            line("shared", "Compute", 10.0),
            line("shared", "IO", 3.0),
            line("shared", "Compute", 2.0),
            line("shared", "Credit", -1.0),
        ],
        None,
    )
    .await
    .unwrap();
    assert_eq!(count, 1);
    aws_cur::aggregate_to_expenses(&state, org, account)
        .await
        .unwrap();
    let row = sqlx::query(
        "SELECT cost::float8 AS cost, tags, pool_id FROM expenses WHERE organization_id = $1",
    )
    .bind(org)
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(row.get::<f64, _>("cost"), 14.0);
    assert_eq!(row.get::<Uuid, _>("pool_id"), pool);
    assert_eq!(row.get::<Value, _>("tags")["team"], "platform");
    let evidence: Value =
        sqlx::query_scalar("SELECT cloud_specific FROM raw_expenses WHERE organization_id = $1")
            .bind(org)
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(evidence["line_count"], 4);
    assert_eq!(evidence["line_items"][0]["cost_usd"], 10.0);
    for _ in 0..2 {
        aws_cur::import_line_items(
            &state,
            org,
            account,
            vec![line("shared", "Compute", 7.0), line("shared", "IO", 4.0)],
            None,
        )
        .await
        .unwrap();
        aws_cur::aggregate_to_expenses(&state, org, account)
            .await
            .unwrap();
    }
    let totals: (i64, f64) = sqlx::query_as(
        "SELECT COUNT(*), SUM(cost)::float8 FROM expenses WHERE organization_id = $1",
    )
    .bind(org)
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(totals, (1, 11.0));
    let resource_cost: f64 =
        sqlx::query_scalar("SELECT total_cost::float8 FROM resources WHERE organization_id = $1")
            .bind(org)
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(resource_cost, 11.0);

    // Fail before committing any rows when one currency has no configured rate.
    let mut bad = line("bad", "Compute", 5.0);
    bad.currency = "JPY".into();
    assert!(aws_cur::import_line_items(
        &state,
        org,
        account,
        vec![line("would-be-partial", "Compute", 8.0), bad],
        None
    )
    .await
    .is_err());
    let rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM raw_expenses WHERE organization_id = $1")
            .bind(org)
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(rows, 1);
    let mut cancel = |_: usize, _: usize| false;
    aws_cur::import_line_items(
        &state,
        org,
        account,
        vec![line("cancelled", "Compute", 8.0)],
        Some(&mut cancel),
    )
    .await
    .unwrap();
    let rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM raw_expenses WHERE organization_id = $1")
            .bind(org)
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(rows, 1);

    // BSS uses the same aggregation and replacement semantics.
    let bill = |amount| aliyun_bss::BssLineItem {
        instance_id: "bss".into(),
        instance_name: None,
        product_code: "ecs".into(),
        product_name: None,
        bill_date: Utc::now().date_naive(),
        region: None,
        zone: None,
        resource_type: None,
        subscription_type: None,
        billing_item: None,
        pretax_amount: amount,
        currency: "CNY".into(),
        tags: json!({}),
    };
    aliyun_bss::import_line_items(&state, org, account, vec![bill(3.0), bill(4.0)], None)
        .await
        .unwrap();
    aliyun_bss::aggregate_to_expenses(&state, org, account)
        .await
        .unwrap();
    let total: f64 =
        sqlx::query_scalar("SELECT SUM(cost)::float8 FROM expenses WHERE organization_id = $1")
            .bind(org)
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(total, 18.0);
    cleanup(&state, org, user).await;
}

async fn expense(
    state: &AppState,
    org: Uuid,
    account: Uuid,
    resource: &str,
    cost: f64,
    day_offset: i32,
    currency: &str,
    pool: Option<Uuid>,
) {
    sqlx::query("INSERT INTO expenses (organization_id, cloud_account_id, cloud_resource_id, cost, date, currency, pool_id) VALUES ($1,$2,$3,$4,CURRENT_DATE + $5,$6,$7)")
        .bind(org).bind(account).bind(resource).bind(cost).bind(day_offset).bind(currency).bind(pool).execute(&state.db).await.unwrap();
}
async fn ci(state: &AppState, org: Uuid, account: Uuid, name: &str) -> Uuid {
    sqlx::query_scalar("INSERT INTO cis (organization_id, cloud_account_id, cloud_resource_id, name, ci_type_id) VALUES ($1,$2,$3,$3,'20000000-0000-0000-0000-000000000001') RETURNING id")
        .bind(org).bind(account).bind(name).fetch_one(&state.db).await.unwrap()
}
async fn map_service(state: &AppState, org: Uuid, center: Uuid, ci: Uuid, name: &str) {
    sqlx::query("INSERT INTO business_capabilities (organization_id, name, cost_center_id) VALUES ($1,$2,$3)")
        .bind(org).bind(name).bind(center).execute(&state.db).await.unwrap();
    let service: Uuid = sqlx::query_scalar(
        "INSERT INTO services (organization_id, name) VALUES ($1,$2) RETURNING id",
    )
    .bind(org)
    .bind(name)
    .fetch_one(&state.db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO service_cis (service_id, ci_id) VALUES ($1,$2)")
        .bind(service)
        .bind(ci)
        .execute(&state.db)
        .await
        .unwrap();
}
async fn get(state: &AppState, org: Uuid, user: Option<Uuid>) -> (StatusCode, Value) {
    let mut request = Request::builder().uri(format!("/api/v1/orgs/{org}/data-flow"));
    if let Some(user) = user {
        let token = Claims::new_access(user, "flow@test.invalid", 600)
            .encode_token(&state.config.jwt_secret)
            .unwrap();
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = routes::build_router(state.clone())
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn reports_scope_accounts_deduplicate_ownership_and_reconcile_gaps() {
    let Some((state, org, account_a, user)) = fixture().await else {
        return;
    };
    let account_b = account(&state, org, "Account B").await;
    let pool: Uuid = sqlx::query_scalar(
        "INSERT INTO pools (organization_id, name) VALUES ($1,'Active') RETURNING id",
    )
    .bind(org)
    .fetch_one(&state.db)
    .await
    .unwrap();
    let deleted_pool: Uuid = sqlx::query_scalar("INSERT INTO pools (organization_id, name, deleted_at) VALUES ($1,'Deleted',NOW()) RETURNING id")
        .bind(org).fetch_one(&state.db).await.unwrap();
    let center_a: Uuid = sqlx::query_scalar(
        "INSERT INTO cost_centers (organization_id, name, code) VALUES ($1,'A','A') RETURNING id",
    )
    .bind(org)
    .fetch_one(&state.db)
    .await
    .unwrap();
    let center_b: Uuid = sqlx::query_scalar(
        "INSERT INTO cost_centers (organization_id, name, code) VALUES ($1,'B','B') RETURNING id",
    )
    .bind(org)
    .fetch_one(&state.db)
    .await
    .unwrap();
    let shared = ci(&state, org, account_a, "shared-id").await;
    let ambiguous = ci(&state, org, account_a, "ambiguous").await;
    let deleted = ci(&state, org, account_a, "deleted-ci").await;
    map_service(&state, org, center_a, shared, "one").await;
    map_service(&state, org, center_a, shared, "duplicate-path").await;
    map_service(&state, org, center_a, ambiguous, "owner-a").await;
    map_service(&state, org, center_b, ambiguous, "owner-b").await;
    map_service(&state, org, center_a, deleted, "deleted-ci-path").await;
    sqlx::query("UPDATE cis SET deleted_at=NOW() WHERE id=$1")
        .bind(deleted)
        .execute(&state.db)
        .await
        .unwrap();
    for account in [account_a, account_b] {
        sqlx::query("INSERT INTO resources (organization_id, cloud_account_id, cloud_resource_id) VALUES ($1,$2,'shared-id')")
            .bind(org).bind(account).execute(&state.db).await.unwrap();
    }
    expense(
        &state,
        org,
        account_a,
        "shared-id",
        100.0,
        0,
        "CNY",
        Some(pool),
    )
    .await;
    expense(
        &state,
        org,
        account_a,
        "shared-id",
        10.0,
        -29,
        "CNY",
        Some(pool),
    )
    .await;
    expense(
        &state,
        org,
        account_b,
        "shared-id",
        200.0,
        0,
        "CNY",
        Some(deleted_pool),
    )
    .await;
    expense(&state, org, account_a, "ambiguous", 50.0, 0, "CNY", None).await;
    expense(&state, org, account_a, "deleted-ci", 40.0, 0, "CNY", None).await;
    expense(
        &state,
        org,
        account_a,
        "foreign-currency",
        999.0,
        0,
        "USD",
        None,
    )
    .await;
    expense(&state, org, account_a, "shared-id", 999.0, -30, "CNY", None).await;
    expense(&state, org, account_a, "shared-id", 999.0, 1, "CNY", None).await;
    let report = reporting::showback(&state.db, org).await.unwrap();
    assert_eq!(report["currency"], "CNY");
    assert_eq!(report["total_cost"].as_f64(), Some(400.0));
    assert_eq!(report["by_pool"][0]["cost"].as_f64(), Some(110.0));
    assert_eq!(report["by_pool"][0]["resource_count"], 1);
    assert_eq!(report["unallocated_cost"].as_f64(), Some(290.0));
    assert_eq!(report["by_cost_center"][0]["cost"].as_f64(), Some(110.0));
    assert_eq!(report["cost_center_unallocated_cost"].as_f64(), Some(290.0));
    assert_eq!(report["ambiguous_cost"].as_f64(), Some(50.0));
    assert_eq!(report["ambiguous_resources"], 1);
    assert_eq!(report["excluded_currency_rows"], 1);
    let (status, body) = get(&state, org, Some(user)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let accounts = body["data"]["accounts"].as_array().unwrap();
    assert_eq!(accounts.len(), 2);
    assert_eq!(accounts[0]["linked_resources"], 1);
    assert_eq!(accounts[1]["linked_resources"], 0);
    assert_eq!(accounts[0]["total_cost"].as_f64(), Some(200.0));
    assert_eq!(accounts[1]["unmatched_cost"].as_f64(), Some(200.0));
    assert_eq!(accounts[0]["currency_mismatch_rows"], 1);
    assert_eq!(get(&state, org, None).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(
        get(&state, org, Some(Uuid::new_v4())).await.0,
        StatusCode::FORBIDDEN
    );
    // A different workspace is not observable with a valid token from this one.
    assert_eq!(
        get(&state, Uuid::new_v4(), Some(user)).await.0,
        StatusCode::FORBIDDEN
    );
    cleanup(&state, org, user).await;
}
