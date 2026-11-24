use crate::{
    error::{AppError, AppResult},
    middleware::rbac::{require_permission, Permission},
    modules::auth::{org_handlers::ensure_member, service::Claims},
    state::AppState,
    utils::pagination::{page_meta_json, PageQuery},
};
use axum::{
    extract::{Extension, Path, Query, State},
    Json,
};
use chrono::{Days, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

pub mod inventory;

#[derive(Default, Deserialize)]
pub struct StorageQuery {
    start_date: Option<NaiveDate>,
    end_date: Option<NaiveDate>,
    account_id: Option<Uuid>,
    service_id: Option<Uuid>,
    bucket_id: Option<Uuid>,
    #[serde(default)]
    search: String,
    #[serde(default)]
    ownership: String,
    #[serde(default)]
    billed: bool,
    #[serde(default)]
    allocation: String,
    #[serde(flatten)]
    page: PageQuery,
}
impl StorageQuery {
    fn period(&self) -> AppResult<(NaiveDate, NaiveDate)> {
        let end = self.end_date.unwrap_or_else(|| Utc::now().date_naive());
        let start = self
            .start_date
            .or_else(|| end.checked_sub_days(Days::new(29)))
            .ok_or_else(|| AppError::Validation("Invalid billing period".into()))?;
        if start > end {
            return Err(AppError::Validation(
                "Start date must precede end date".into(),
            ));
        }
        Ok((start, end))
    }
}
async fn currency(db: &PgPool, org: Uuid) -> AppResult<String> {
    Ok(sqlx::query_scalar(
        "SELECT COALESCE(settings->>'currency','USD') FROM organizations WHERE id=$1",
    )
    .bind(org)
    .fetch_one(db)
    .await?)
}
async fn allowed(db: &PgPool, org: Uuid, user: Uuid, p: Permission) -> AppResult<bool> {
    match require_permission(db, user, org, p).await {
        Ok(()) => Ok(true),
        Err(AppError::Forbidden(_)) => Ok(false),
        Err(e) => Err(e),
    }
}
async fn bucket_name(db: &PgPool, org: Uuid, id: Uuid) -> AppResult<String> {
    sqlx::query_scalar(
        "SELECT native_name FROM storage_bucket_assets WHERE id=$1 AND organization_id=$2",
    )
    .bind(id)
    .bind(org)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::NotFound("Bucket not found in this environment".into()))
}
#[utoipa::path(get,path="/api/v1/orgs/{org_id}/object-storage",tag="object-storage",security(("bearer_auth"=[])),responses((status=200,description="Scoped bucket inventory and reconciled period costs")))]
pub async fn overview(
    State(s): State<AppState>,
    Extension(c): Extension<Claims>,
    Path(org): Path<Uuid>,
    Query(q): Query<StorageQuery>,
) -> AppResult<Json<Value>> {
    let user = c.user_id()?;
    ensure_member(&s.db, org, user).await?;
    let (start, end) = q.period()?;
    let cur = currency(&s.db, org).await?;
    let page = q.page.resolve(20, 100);
    if !matches!(q.ownership.as_str(), "" | "shared" | "unclaimed" | "owned") {
        return Err(AppError::Validation("Unknown ownership filter".into()));
    }
    let mut v: Value = sqlx::query_scalar(include_str!("overview.sql"))
        .bind(org)
        .bind(start)
        .bind(end)
        .bind(&cur)
        .bind(q.account_id)
        .bind(q.search.trim())
        .bind(q.ownership)
        .bind(q.billed)
        .bind(page.limit)
        .bind(page.offset)
        .bind(q.service_id)
        .fetch_one(&s.db)
        .await?;
    let total = v["filtered_count"].as_i64().unwrap_or_default();
    v["currency"] = json!(cur);
    v["start_date"] = json!(start);
    v["end_date"] = json!(end);
    v["can_bind"] = json!(allowed(&s.db, org, user, Permission::ManageCmdb).await?);
    v["can_import"] = json!(allowed(&s.db, org, user, Permission::ManageCloudAccounts).await?);
    v["can_allocate"] = json!(allowed(&s.db, org, user, Permission::ManagePools).await?);
    Ok(Json(json!({"data":v,"meta":page_meta_json(total,&page)})))
}
#[utoipa::path(get,path="/api/v1/orgs/{org_id}/object-storage/buckets/{id}",tag="object-storage",security(("bearer_auth"=[])),responses((status=200,description="Bucket ownership, coverage and cost trend")))]
pub async fn detail(
    State(s): State<AppState>,
    Extension(c): Extension<Claims>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Query(q): Query<StorageQuery>,
) -> AppResult<Json<Value>> {
    ensure_member(&s.db, org, c.user_id()?).await?;
    let (start, end) = q.period()?;
    let cur = currency(&s.db, org).await?;
    let data: Value = sqlx::query_scalar(include_str!("detail.sql"))
        .bind(org)
        .bind(id)
        .bind(start)
        .bind(end)
        .bind(&cur)
        .fetch_optional(&s.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Bucket not found".into()))?;
    Ok(Json(
        json!({"data":data,"currency":cur,"start_date":start,"end_date":end}),
    ))
}
#[utoipa::path(get,path="/api/v1/orgs/{org_id}/object-storage/bills",tag="object-storage",security(("bearer_auth"=[])),responses((status=200,description="Attributed and pending bill evidence")))]
pub async fn bills(
    State(s): State<AppState>,
    Extension(c): Extension<Claims>,
    Path(org): Path<Uuid>,
    Query(q): Query<StorageQuery>,
) -> AppResult<Json<Value>> {
    ensure_member(&s.db, org, c.user_id()?).await?;
    if let Some(id) = q.bucket_id {
        bucket_name(&s.db, org, id).await?;
    }
    let (start, end) = q.period()?;
    let page = q.page.resolve(20, 100);
    let cur = currency(&s.db, org).await?;
    let v: Value = sqlx::query_scalar(include_str!("bills.sql"))
        .bind(org)
        .bind(start)
        .bind(end)
        .bind(cur)
        .bind(q.account_id)
        .bind(q.bucket_id)
        .bind(q.allocation)
        .bind(page.limit)
        .bind(page.offset)
        .fetch_one(&s.db)
        .await?;
    Ok(Json(
        json!({"data":v["items"],"meta":page_meta_json(v["total"].as_i64().unwrap_or_default(),&page)}),
    ))
}
#[derive(Deserialize)]
pub struct OpportunityQuery {
    #[serde(default)]
    group_id: String,
    #[serde(flatten)]
    page: PageQuery,
}
#[utoipa::path(get,path="/api/v1/orgs/{org_id}/object-storage/buckets/{id}/opportunities",tag="object-storage",security(("bearer_auth"=[])),responses((status=200,description="Object and bucket similarity evidence")))]
pub async fn opportunities(
    State(s): State<AppState>,
    Extension(c): Extension<Claims>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Query(q): Query<OpportunityQuery>,
) -> AppResult<Json<Value>> {
    ensure_member(&s.db, org, c.user_id()?).await?;
    bucket_name(&s.db, org, id).await?;
    let cur = currency(&s.db, org).await?;
    let page = q.page.resolve(10, 100);
    let more = !q.group_id.is_empty();
    let data: Value = sqlx::query_scalar(include_str!("opportunities.sql"))
        .bind(org)
        .bind(id)
        .bind(&cur)
        .bind(&q.group_id)
        .bind(if more { 1 } else { page.limit })
        .bind(if more { 0 } else { page.offset })
        .bind(if more { page.limit } else { 3 })
        .bind(if more { page.offset } else { 0 })
        .fetch_one(&s.db)
        .await?;
    let names: Value = if more {
        json!([])
    } else {
        sqlx::query_scalar(include_str!("names.sql"))
            .bind(org)
            .bind(id)
            .fetch_one(&s.db)
            .await?
    };
    let total = if more {
        &data["groups"][0]["copies"]
    } else {
        &data["total"]
    };
    Ok(Json(
        json!({"data":{"groups":data["groups"],"names":names,"currency":cur},"meta":page_meta_json(total.as_i64().unwrap_or_default(),&page)}),
    ))
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct AllocationInput {
    effective_from: NaiveDate,
    weights: std::collections::BTreeMap<Uuid, i32>,
}
#[utoipa::path(put,path="/api/v1/orgs/{org_id}/object-storage/buckets/{id}/allocations",tag="object-storage",request_body=AllocationInput,security(("bearer_auth"=[])),responses((status=204,description="Set service shares effective on a billing date")))]
pub async fn allocate(
    State(s): State<AppState>,
    Extension(c): Extension<Claims>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(input): Json<AllocationInput>,
) -> AppResult<axum::http::StatusCode> {
    let user = c.user_id()?;
    require_permission(&s.db, user, org, Permission::ManagePools).await?;
    let mut tx = s.db.begin().await?;
    sqlx::query("SELECT id FROM resources WHERE id=$1 AND organization_id=$2 AND resource_type='bucket' AND active FOR UPDATE").bind(id).bind(org).fetch_optional(&mut *tx).await?.ok_or_else(||AppError::NotFound("Bucket not found".into()))?;
    let owners=sqlx::query_scalar::<_,Uuid>("SELECT DISTINCT service_id FROM storage_bucket_owners WHERE organization_id=$1 AND bucket_id=$2").bind(org).bind(id).fetch_all(&mut *tx).await?;
    if owners.len() < 2
        || owners.len() != input.weights.len()
        || owners.iter().any(|s| !input.weights.contains_key(s))
        || input.weights.values().any(|v| !(1..=10000).contains(v))
        || input.weights.values().map(|n| i64::from(*n)).sum::<i64>() != 10000
    {
        return Err(AppError::Validation(
            "Include all linked services with positive shares totaling 100%".into(),
        ));
    }
    sqlx::query("INSERT INTO storage_allocation_rules(bucket_id,effective_from,weights,updated_by) VALUES ($1,$2,$3,$4) ON CONFLICT(bucket_id,effective_from) DO UPDATE SET weights=excluded.weights,updated_by=excluded.updated_by,updated_at=now()")
        .bind(id).bind(input.effective_from).bind(json!(input.weights)).bind(user).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}
