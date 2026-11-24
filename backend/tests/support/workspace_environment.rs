//! Exercise the HTTP router with real users and PostgreSQL discovery upserts.
use super::{send, setup};
use axum::{
    http::{Method, StatusCode},
    Router,
};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

pub(super) async fn request(
    app: &Router,
    method: Method,
    path: &str,
    token: &str,
    body: Option<Value>,
    expected: StatusCode,
) -> Value {
    let (status, response) = send(app, method, path, Some(token), body).await;
    assert_eq!(status, expected, "{path}: {response}");
    response["data"].clone()
}

pub(super) async fn identity(app: &Router) -> (Uuid, String) {
    let suffix = Uuid::new_v4();
    let (status, v) = send(
        app,
        Method::POST,
        "/api/v1/auth/register",
        None,
        Some(json!({
        "email":format!("env-{suffix}@example.invalid"),"display_name":"Environment test",
        "password":format!("Aa1!{suffix}")})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    (
        v["data"]["user"]["id"].as_str().unwrap().parse().unwrap(),
        v["data"]["access_token"].as_str().unwrap().into(),
    )
}

pub(super) async fn organization(app: &Router, token: &str) -> Uuid {
    request(
        app,
        Method::POST,
        "/api/v1/organizations",
        token,
        Some(json!({"name":format!("Scope {}",Uuid::new_v4())})),
        StatusCode::CREATED,
    )
    .await["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap()
}

async fn account(app: &Router, org: Uuid, token: &str) -> Uuid {
    // These generated fixtures are stored only in the integration database. No provider call is made.
    let v = request(
        app,
        Method::POST,
        &format!("/api/v1/orgs/{org}/cloud-accounts"),
        token,
        Some(json!({
            "name":"Same account name","provider":"alibaba","credentials":{
                "access_key_id":Uuid::new_v4(),"access_key_secret":Uuid::new_v4()}
        })),
        StatusCode::CREATED,
    )
    .await;
    v["id"].as_str().unwrap().parse().unwrap()
}

pub(super) async fn reader(db: &PgPool, org: Uuid, user: Uuid) {
    sqlx::query("INSERT INTO organization_members(organization_id,user_id) VALUES ($1,$2)")
        .bind(org)
        .bind(user)
        .execute(db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO user_roles(user_id,organization_id,role_id)
        SELECT $2,$1,id FROM roles WHERE name='Member' AND (organization_id IS NULL OR organization_id=$1) ORDER BY organization_id NULLS LAST LIMIT 1")
        .bind(org).bind(user).execute(db).await.unwrap();
}

async fn discovered_ci(db: &PgPool, org: Uuid, account: Uuid, tags: Value) -> (Uuid, Value) {
    sqlx::query_as("INSERT INTO cis(organization_id,cloud_account_id,cloud_resource_id,ci_type_id,name,tags)
        VALUES ($1,$2,'same-provider-resource','20000000-0000-0000-0000-000000000001','Same workload',$3)
        ON CONFLICT(organization_id,cloud_account_id,cloud_resource_id) DO UPDATE SET tags=EXCLUDED.tags RETURNING id,tags")
        .bind(org).bind(account).bind(tags).fetch_one(db).await.unwrap()
}

#[tokio::test]
async fn workspace_catalog_environment_tags_and_access() {
    let Some((app, db)) = setup().await else {
        return;
    };
    let (steward, pre_token) = identity(&app).await;
    let (_, prod_token) = identity(&app).await;
    let (viewer, viewer_token) = identity(&app).await;
    let pre = organization(&app, &pre_token).await;
    let prod = organization(&app, &prod_token).await;
    reader(&db, pre, viewer).await;
    let base = |org| format!("/api/v1/orgs/{org}");
    let ws: Uuid =
        sqlx::query_scalar("INSERT INTO business_workspaces(name) VALUES ($1) RETURNING id")
            .bind(format!("Shared {pre}"))
            .fetch_one(&db)
            .await
            .unwrap();
    let pre_account = account(&app, pre, &pre_token).await;
    let (pre_ci, _) = discovered_ci(&db, pre, pre_account, json!({"owner":"ops"})).await;
    let pre_asset:Uuid=sqlx::query_scalar("INSERT INTO resources(organization_id,cloud_account_id,cloud_resource_id,resource_type,tags) VALUES ($1,$2,'same-provider-resource','instance','{\"owner\":\"ops\"}') RETURNING id")
        .bind(pre).bind(pre_account).fetch_one(&db).await.unwrap();
    sqlx::query("INSERT INTO workspace_environments(workspace_id,organization_id,environment) VALUES ($1,$2,'pre'),($1,$3,'prod')").bind(ws).bind(pre).bind(prod).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO workspace_catalog_editors(workspace_id,user_id) VALUES ($1,$2)")
        .bind(ws)
        .bind(steward)
        .execute(&db)
        .await
        .unwrap();
    let tags: Value = sqlx::query_scalar("SELECT tags FROM resources WHERE id=$1")
        .bind(pre_asset)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(tags, json!({"env":"pre","owner":"ops"}));
    let tags: Value = sqlx::query_scalar("SELECT tags FROM cis WHERE id=$1")
        .bind(pre_ci)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(tags, json!({"env":"pre","owner":"ops"}));
    let (same, after_discovery) = discovered_ci(
        &db,
        pre,
        pre_account,
        json!({"env":"prod","source":"round2"}),
    )
    .await;
    assert_eq!(same, pre_ci);
    assert_eq!(after_discovery, json!({"env":"pre","source":"round2"}));
    let prod_account = account(&app, prod, &prod_token).await;
    let (prod_ci, tags) = discovered_ci(&db, prod, prod_account, json!({"env":"pre"})).await;
    assert_ne!(pre_ci, prod_ci);
    assert_eq!(tags["env"], "prod");
    let prod_asset:(Uuid,Value)=sqlx::query_as("INSERT INTO resources(organization_id,cloud_account_id,cloud_resource_id,resource_type,tags) VALUES ($1,$2,'same-provider-resource','instance',$3) RETURNING id,tags")
        .bind(prod).bind(prod_account).bind(json!({"region":"test"})).fetch_one(&db).await.unwrap();
    assert_eq!(prod_asset.1, json!({"env":"prod","region":"test"}));
    assert!(
        sqlx::query("UPDATE cis SET cloud_account_id=$1 WHERE id=$2")
            .bind(prod_account)
            .bind(pre_ci)
            .execute(&db)
            .await
            .is_err()
    );

    for (org, token, env) in [(pre, &pre_token, "pre"), (prod, &prod_token, "prod")] {
        let orgs = request(
            &app,
            Method::GET,
            "/api/v1/organizations",
            token,
            None,
            StatusCode::OK,
        )
        .await;
        let scopes: Vec<_> = orgs
            .as_array()
            .unwrap()
            .iter()
            .filter(|o| !o["workspace"].is_null())
            .collect();
        assert_eq!(scopes.len(), 1);
        assert_eq!(scopes[0]["workspace"]["id"], ws.to_string());
        assert_eq!(scopes[0]["workspace"]["environment"], env);
        let list = request(
            &app,
            Method::GET,
            &format!("{}/cis", base(org)),
            token,
            None,
            StatusCode::OK,
        )
        .await;
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["tags"]["env"], env);
    }
    for (foreign, token, id) in [(prod, &pre_token, prod_ci), (pre, &prod_token, pre_ci)] {
        for resource in [
            "catalog",
            "cis",
            "ci-forest",
            "cloud-accounts",
            "resources",
            "cmdb/stats",
        ] {
            request(
                &app,
                Method::GET,
                &format!("{}/{resource}", base(foreign)),
                token,
                None,
                StatusCode::FORBIDDEN,
            )
            .await;
        }
        request(
            &app,
            Method::PATCH,
            &format!("{}/cis/{id}/tags", base(foreign)),
            token,
            Some(json!({"tags":{}})),
            StatusCode::FORBIDDEN,
        )
        .await;
    }
    for suffix in ["", "/topology", "/impact"] {
        request(
            &app,
            Method::GET,
            &format!("{}/cis/{prod_ci}{suffix}", base(pre)),
            &pre_token,
            None,
            StatusCode::NOT_FOUND,
        )
        .await;
    }
    let own = request(
        &app,
        Method::PATCH,
        &format!("{}/cis/{pre_ci}/tags", base(pre)),
        &pre_token,
        Some(json!({"tags":{"env":"prod","owner":"changed"}})),
        StatusCode::OK,
    )
    .await;
    assert_eq!(own["tags"], json!({"env":"pre","owner":"changed"}));
    let own = request(
        &app,
        Method::PATCH,
        &format!("{}/resources/{pre_asset}/tags", base(pre)),
        &pre_token,
        Some(json!({"tags":{"env":"prod"}})),
        StatusCode::OK,
    )
    .await;
    assert_eq!(own["tags"]["env"], "pre");
    request(
        &app,
        Method::PATCH,
        &format!("{}/cis/{pre_ci}/tags", base(pre)),
        &viewer_token,
        Some(json!({"tags":{}})),
        StatusCode::FORBIDDEN,
    )
    .await;
    let team = request(
        &app,
        Method::POST,
        &format!("{}/catalog/teams", base(pre)),
        &pre_token,
        Some(json!({"name":"Platform"})),
        StatusCode::CREATED,
    )
    .await;
    let service = request(
        &app,
        Method::POST,
        &format!("{}/catalog/services", base(pre)),
        &pre_token,
        Some(json!({"name":"Resolver","team_id":team["id"],"system_name":"Network"})),
        StatusCode::CREATED,
    )
    .await;
    let service_id = service["id"].as_str().unwrap();
    let bind = |org| format!("{}/catalog/services/{service_id}/cis", base(org));
    request(
        &app,
        Method::POST,
        &bind(pre),
        &pre_token,
        Some(json!({"ci_id":prod_ci})),
        StatusCode::NOT_FOUND,
    )
    .await;
    request(
        &app,
        Method::POST,
        &bind(pre),
        &viewer_token,
        Some(json!({"ci_id":pre_ci})),
        StatusCode::FORBIDDEN,
    )
    .await;
    let first = request(
        &app,
        Method::POST,
        &bind(pre),
        &pre_token,
        Some(json!({"ci_id":pre_ci})),
        StatusCode::CREATED,
    )
    .await;
    let second = request(
        &app,
        Method::POST,
        &bind(pre),
        &pre_token,
        Some(json!({"ci_id":pre_ci})),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(first, second);
    let pre_deployment = first["deployment_id"].as_str().unwrap();
    request(
        &app,
        Method::POST,
        &bind(prod),
        &prod_token,
        Some(json!({"ci_id":prod_ci,"deployment_id":pre_deployment})),
        StatusCode::NOT_FOUND,
    )
    .await;
    request(
        &app,
        Method::GET,
        &format!("{}/services/{pre_deployment}/cis", base(prod)),
        &prod_token,
        None,
        StatusCode::NOT_FOUND,
    )
    .await;
    request(
        &app,
        Method::PUT,
        &format!("{}/catalog/services/{service_id}", base(prod)),
        &prod_token,
        Some(json!({"name":"Denied"})),
        StatusCode::FORBIDDEN,
    )
    .await;
    request(
        &app,
        Method::PUT,
        &format!("{}/catalog/services/{service_id}", base(pre)),
        &pre_token,
        Some(json!({"name":"Managed DNS","team_id":team["id"],"system_name":"Network"})),
        StatusCode::NO_CONTENT,
    )
    .await;
    let prod_view = request(
        &app,
        Method::GET,
        &format!("{}/catalog", base(prod)),
        &prod_token,
        None,
        StatusCode::OK,
    )
    .await;
    assert_eq!(prod_view["teams"][0]["id"], team["id"]);
    assert_eq!(prod_view["services"][0]["id"], service["id"]);
    assert_eq!(prod_view["services"][0]["name"], "Managed DNS");
    assert_eq!(prod_view["deployments"], json!([]));
    let prod_link = request(
        &app,
        Method::POST,
        &bind(prod),
        &prod_token,
        Some(json!({"ci_id":prod_ci})),
        StatusCode::CREATED,
    )
    .await;
    assert_ne!(prod_link["deployment_id"], first["deployment_id"]);
    let viewer_view = request(
        &app,
        Method::GET,
        &format!("{}/catalog", base(pre)),
        &viewer_token,
        None,
        StatusCode::OK,
    )
    .await;
    assert_eq!(viewer_view["deployments"][0]["id"], pre_deployment);
    assert_eq!(viewer_view["deployments"][0]["ci_count"], 1);
    assert_eq!(viewer_view["can_edit_catalog"], false);
    assert_eq!(viewer_view["can_edit_deployments"], false);
    request(
        &app,
        Method::DELETE,
        &format!("{}/catalog/services/{service_id}", base(pre)),
        &pre_token,
        None,
        StatusCode::CONFLICT,
    )
    .await;

    // Grant the actual UI role alongside Member: an editor may write local CIs,
    // while catalog stewardship and cloud credentials are independent permissions.
    sqlx::query(
        "INSERT INTO user_roles(user_id,organization_id,role_id)
        SELECT $2,$1,id FROM roles WHERE organization_id=$1 AND name='CMDB Editor'",
    )
    .bind(pre)
    .bind(viewer)
    .execute(&db)
    .await
    .unwrap();
    request(
        &app,
        Method::PATCH,
        &format!("{}/cis/{pre_ci}/tags", base(pre)),
        &viewer_token,
        Some(json!({"tags":{"env":"prod","team":"editor"}})),
        StatusCode::OK,
    )
    .await;
    request(
        &app,
        Method::POST,
        &format!("{}/cloud-accounts", base(pre)),
        &viewer_token,
        Some(json!({})),
        StatusCode::FORBIDDEN,
    )
    .await;
    request(
        &app,
        Method::POST,
        &format!("{}/catalog/teams", base(pre)),
        &viewer_token,
        Some(json!({"name":"Denied"})),
        StatusCode::FORBIDDEN,
    )
    .await;
    request(
        &app,
        Method::GET,
        &format!("{}/catalog", base(prod)),
        &viewer_token,
        None,
        StatusCode::FORBIDDEN,
    )
    .await;

    // A dual-environment user can edit pre and read prod without a pre-issued API key inheriting prod.
    reader(&db, prod, steward).await;
    request(
        &app,
        Method::GET,
        &format!("{}/cis/{prod_ci}", base(prod)),
        &pre_token,
        None,
        StatusCode::OK,
    )
    .await;
    request(
        &app,
        Method::POST,
        &bind(prod),
        &pre_token,
        Some(json!({"ci_id":prod_ci})),
        StatusCode::FORBIDDEN,
    )
    .await;
    let k = request(
        &app,
        Method::POST,
        &format!("{}/api-keys", base(pre)),
        &pre_token,
        Some(json!({"name":"Scoped integration key"})),
        StatusCode::CREATED,
    )
    .await;
    let key = k["key"].as_str().unwrap();
    request(
        &app,
        Method::GET,
        &format!("{}/cis/{pre_ci}", base(pre)),
        key,
        None,
        StatusCode::OK,
    )
    .await;
    request(
        &app,
        Method::GET,
        &format!("{}/cis/{prod_ci}", base(prod)),
        key,
        None,
        StatusCode::FORBIDDEN,
    )
    .await;
    let list = request(
        &app,
        Method::GET,
        "/api/v1/organizations",
        key,
        None,
        StatusCode::OK,
    )
    .await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["id"], pre.to_string());
}
