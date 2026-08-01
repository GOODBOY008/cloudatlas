use axum::{
    extract::{Extension, Path, State},
    http::StatusCode,
    Json,
};
use chrono::Utc;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    crypto,
    error::{AppError, AppResult},
    modules::auth::service::Claims,
    state::AppState,
};

use super::{
    adapters::{
        create_adapter,
        kubernetes::{parse_kubeconfig, KubernetesAdapter},
        CloudAdapter, DiscoveredResource,
    },
    credentials::{credentials_have_content, encrypted_has_credentials, validate_credentials},
    dto::{
        CloudAccountResponse, ConnectionTestResponse, CreateCloudAccountRequest,
        SyncJobResponse, UpdateCloudAccountRequest,
    },
    models::{CloudAccount, SyncJob},
};

// ─── Shared helpers ───────────────────────────────────────────────────────────

const ACCOUNT_SELECT: &str = r#"
    SELECT
        id, organization_id, name,
        provider::text  AS provider,
        credentials_enc, config, is_active,
        last_sync_at,
        last_sync_status::text AS last_sync_status,
        currency,
        resource_count, created_at, updated_at
    FROM cloud_accounts
"#;

const SYNC_JOB_SELECT: &str = r#"
    SELECT
        id, cloud_account_id, organization_id,
        status::text AS status,
        started_at, completed_at,
        resources_discovered, resources_created,
        resources_updated, resources_deleted,
        error_message, triggered_by, created_at
    FROM sync_jobs
"#;

/// Abort with Forbidden if the caller is not a member of `org_id`.
async fn ensure_org_member(
    db: &sqlx::PgPool,
    org_id: Uuid,
    user_id: Uuid,
) -> AppResult<()> {
    let row = sqlx::query(
        "SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;

    if row.is_none() {
        return Err(AppError::Forbidden(
            "You are not a member of this organization".into(),
        ));
    }
    Ok(())
}

/// Map a cloud account provider to a value the `cis.cloud_provider` enum
/// accepts (mock-backed providers like "other" sync as 'mock').
fn ci_provider_for(provider: &str) -> &'static str {
    match provider {
        "aws" => "aws",
        "alibaba" => "alibaba",
        "azure" => "azure",
        "gcp" => "gcp",
        "mock" => "mock",
        _ => "mock",
    }
}

/// Map a discovered `resource_type` string to the seeded builtin CI type UUID.
fn resource_type_to_ci_type_id(resource_type: &str) -> Uuid {
    match resource_type {
        "instance"       => uuid::uuid!("20000000-0000-0000-0000-000000000001"),
        "rds_instance"   => uuid::uuid!("20000000-0000-0000-0000-000000000002"),
        "volume"         => uuid::uuid!("20000000-0000-0000-0000-000000000003"),
        "snapshot"       => uuid::uuid!("20000000-0000-0000-0000-000000000004"),
        "bucket"         => uuid::uuid!("20000000-0000-0000-0000-000000000005"),
        "load_balancer"  => uuid::uuid!("20000000-0000-0000-0000-000000000006"),
        "ip_address"     => uuid::uuid!("20000000-0000-0000-0000-000000000007"),
        _                => uuid::uuid!("20000000-0000-0000-0000-000000000001"),
    }
}

/// Map a discovered resource_type to a billing service name for the
/// `resources.service_name` column (used by expense by-service rollups).
/// Names are provider-aware: Alibaba resources must not be labelled as AWS
/// services (previously every provider got "Amazon S3"/"Amazon EC2"...).
fn service_name_for_type(resource_type: &str, provider: &str) -> &'static str {
    if provider == "alibaba" {
        return match resource_type {
            "instance"        => "Aliyun ECS",
            "rds_instance"    => "Aliyun RDS",
            "volume"          => "Aliyun Disk",
            "snapshot"        => "Aliyun Snapshot",
            "snapshot_chain"  => "Aliyun Snapshot",
            "bucket"          => "Aliyun OSS",
            "load_balancer"   => "Aliyun SLB",
            "ip_address"      => "Aliyun EIP",
            "k8s_pod"         => "Aliyun ACK",
            "k8s_cluster"     => "Aliyun ACK",
            "reserved_instance" => "Aliyun Reserved Instance",
            "savings_plan"    => "Aliyun Savings Plan",
            _                 => "Other",
        };
    }
    match resource_type {
        "instance"        => "Amazon EC2",
        "rds_instance"    => "Amazon RDS",
        "volume"          => "Amazon EBS",
        "snapshot"        => "Amazon EBS",
        "snapshot_chain"  => "Amazon EBS",
        "bucket"          => "Amazon S3",
        "load_balancer"   => "AWS ELB",
        "ip_address"      => "Amazon EC2",
        "k8s_pod"         => "Amazon EKS",
        "k8s_cluster"     => "Kubernetes",
        "reserved_instance" => "Amazon EC2",
        "savings_plan"    => "Savings Plan",
        _                 => "Other",
    }
}

/// Upsert a discovered resource into both the CMDB `cis` table and the FinOps
/// `resources` mirror. Returns `true` when the `cis` row was newly inserted.
/// Shared by the main discovery loop and per-ACK-cluster pod discovery.
async fn upsert_discovered_resource(
    db: &sqlx::PgPool,
    org_id: Uuid,
    account_id: Uuid,
    provider: &str,
    res: &DiscoveredResource,
    now: chrono::DateTime<Utc>,
) -> AppResult<bool> {
    let ci_id = Uuid::new_v4();
    let ci_type_id = resource_type_to_ci_type_id(&res.resource_type);

    let result = sqlx::query(
        r#"
        INSERT INTO cis
            (id, organization_id, ci_type_id, cloud_account_id,
             cloud_resource_id, cloud_provider, cloud_region,
             name, display_name, meta, tags,
             lifecycle_state, discovered_at, created_at, updated_at)
        VALUES
            ($1, $2, $3, $4,
             $5, $6::cloud_provider, $7,
             $8, $8, $9, $10,
             'active', $11, $11, $11)
        ON CONFLICT (organization_id, cloud_account_id, cloud_resource_id)
        DO UPDATE SET
            name          = EXCLUDED.name,
            display_name  = EXCLUDED.display_name,
            cloud_region  = EXCLUDED.cloud_region,
            meta          = EXCLUDED.meta,
            tags          = EXCLUDED.tags,
            lifecycle_state = 'active',
            discovered_at = EXCLUDED.discovered_at,
            updated_at    = EXCLUDED.updated_at
        "#,
    )
    .bind(ci_id)
    .bind(org_id)
    .bind(ci_type_id)
    .bind(account_id)
    .bind(&res.cloud_resource_id)
    .bind(ci_provider_for(provider))
    .bind(res.region.as_deref())
    .bind(&res.resource_name)
    .bind(&res.meta)
    .bind(&res.tags)
    .bind(now)
    .execute(db)
    .await;

    let created = match result {
        Ok(r) => r.rows_affected() == 1,
        Err(e) => {
            tracing::warn!(resource_id = %res.cloud_resource_id, error = %e, "CI upsert failed");
            return Ok(false);
        }
    };

    // FinOps mirror: same discovery result into the `resources` table so cost
    // pages / assignment rules / tag policies have data (AGENTS.md §15).
    let resource_insert = sqlx::query(
        r#"
        INSERT INTO resources
            (organization_id, cloud_account_id, cloud_resource_id,
             resource_type, service_name, name, cloud_region,
             tags, meta, pool_id, owner_id,
             first_seen, last_seen, active,
             total_cost, last_month_cost, recommendations, dismissed_recs,
             created_at, updated_at)
        VALUES
            ($1, $2, $3,
             CASE WHEN $4 IN ('instance','rds_instance','k8s_pod','k8s_cluster','volume','snapshot',
                              'bucket','snapshot_chain','image','ip_address',
                              'load_balancer','reserved_instance','savings_plan')
                  THEN $4::resource_type ELSE 'other' END,
             $5, $6, $7,
             $8, $9, NULL, NULL,
             $10, $10, TRUE,
             0, 0, '[]'::jsonb, '[]'::jsonb,
             $10, $10)
        ON CONFLICT (organization_id, cloud_account_id, cloud_resource_id)
        DO UPDATE SET
            name          = EXCLUDED.name,
            service_name  = EXCLUDED.service_name,
            cloud_region  = EXCLUDED.cloud_region,
            tags          = EXCLUDED.tags,
            meta          = EXCLUDED.meta,
            active        = TRUE,
            last_seen     = EXCLUDED.last_seen,
            updated_at    = EXCLUDED.updated_at
        "#,
    )
    .bind(org_id)
    .bind(account_id)
    .bind(&res.cloud_resource_id)
    .bind(&res.resource_type)
    .bind(service_name_for_type(&res.resource_type, provider))
    .bind(&res.resource_name)
    .bind(res.region.as_deref())
    .bind(&res.tags)
    .bind(&res.meta)
    .bind(now)
    .execute(db)
    .await;

    if let Err(e) = resource_insert {
        tracing::warn!(resource_id = %res.cloud_resource_id, error = %e, "resources upsert failed");
    }

    Ok(created)
}

// ─── list_accounts ────────────────────────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/api/v1/orgs/{org_id}/cloud-accounts",
    params(("org_id" = Uuid, Path, description = "Organization ID")),
    responses(
        (status = 200, description = "List of cloud accounts"),
        (status = 401, description = "Unauthorized"),
        (status = 403, description = "Forbidden"),
    ),
    security(("bearer_auth" = [])),
    tag = "cloud-accounts"
)]
pub async fn list_accounts(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let bounds = page.resolve(50, 200);

    let accounts = sqlx::query_as::<_, CloudAccount>(&format!(
        "{ACCOUNT_SELECT} WHERE organization_id = $1 AND deleted_at IS NULL \
         ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3"
    ))
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM cloud_accounts WHERE organization_id = $1 AND deleted_at IS NULL",
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let key = crypto::key_from_hex(&state.config.encryption_key).unwrap_or([0u8; 32]);
    let data: Vec<CloudAccountResponse> = accounts
        .into_iter()
        .map(|a| {
            let has = encrypted_has_credentials(&a.credentials_enc, &key);
            CloudAccountResponse::from_account(a, has)
        })
        .collect();
    Ok(Json(json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) })))
}

// ─── create_account ───────────────────────────────────────────────────────────

#[utoipa::path(
    post,
    path = "/api/v1/orgs/{org_id}/cloud-accounts",
    params(("org_id" = Uuid, Path, description = "Organization ID")),
    request_body = CreateCloudAccountRequest,
    responses(
        (status = 201, description = "Cloud account created"),
        (status = 401, description = "Unauthorized"),
        (status = 403, description = "Forbidden"),
        (status = 409, description = "Account name already exists"),
    ),
    security(("bearer_auth" = [])),
    tag = "cloud-accounts"
)]
pub async fn create_account(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<CreateCloudAccountRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    crate::utils::validate::name(&body.name, 100, "Account name").map_err(AppError::Validation)?;
    crate::utils::validate::one_of(
        &body.provider,
        ["aws", "alibaba", "azure", "gcp", "mock", "kubernetes", "other"],
        "Provider",
    )
    .map_err(AppError::Validation)?;
    validate_credentials(&body.provider, &body.credentials)?;

    // Encrypt credentials JSON at rest with AES-256-GCM (ENCRYPTION_KEY).
    let creds_json = serde_json::to_string(&body.credentials)
        .map_err(|e| AppError::Validation(format!("Invalid credentials JSON: {e}")))?;
    let key = crypto::key_from_hex(&state.config.encryption_key).ok_or_else(|| {
        AppError::Validation("ENCRYPTION_KEY must be 64 hex characters".into())
    })?;
    let credentials_enc = crypto::encrypt(&key, creds_json.as_bytes());

    let now = Utc::now();
    let account_id = Uuid::new_v4();

    let account = sqlx::query_as::<_, CloudAccount>(&format!(
        r#"
        INSERT INTO cloud_accounts
            (id, organization_id, name, provider, credentials_enc, config, is_active, currency, created_at, updated_at)
        VALUES ($1, $2, $3, $4::cloud_provider, $5, $6, true, $8, $7, $7)
        RETURNING {cols}
        "#,
        cols = "id, organization_id, name, provider::text AS provider, credentials_enc, config,
                is_active, last_sync_at, last_sync_status::text AS last_sync_status,
                currency, resource_count, created_at, updated_at"
    ))
    .bind(account_id)
    .bind(org_id)
    .bind(body.name.trim())
    .bind(&body.provider)
    .bind(&credentials_enc)
    .bind(&body.config)
    .bind(now)
    .bind(body.currency.as_deref().unwrap_or(if body.provider == "alibaba" { "CNY" } else { "USD" }))
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        if e.to_string().contains("unique") || e.to_string().contains("duplicate") {
            AppError::Conflict("An account with this name already exists".into())
        } else {
            AppError::Database(e)
        }
    })?;

    let key = crypto::key_from_hex(&state.config.encryption_key).unwrap_or([0u8; 32]);
    let has_credentials = encrypted_has_credentials(&account.credentials_enc, &key);
    let resp = CloudAccountResponse::from_account(account, has_credentials);
    Ok((StatusCode::CREATED, Json(json!({ "data": resp }))))
}

// ─── get_account ──────────────────────────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/api/v1/orgs/{org_id}/cloud-accounts/{id}",
    params(
        ("org_id" = Uuid, Path, description = "Organization ID"),
        ("id"     = Uuid, Path, description = "Cloud account ID"),
    ),
    responses(
        (status = 200, description = "Cloud account details"),
        (status = 403, description = "Forbidden"),
        (status = 404, description = "Not found"),
    ),
    security(("bearer_auth" = [])),
    tag = "cloud-accounts"
)]
pub async fn get_account(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, account_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let account = sqlx::query_as::<_, CloudAccount>(&format!(
        "{ACCOUNT_SELECT} WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL"
    ))
    .bind(account_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Cloud account not found".into()))?;

    let key = crypto::key_from_hex(&state.config.encryption_key).unwrap_or([0u8; 32]);
    let has_credentials = encrypted_has_credentials(&account.credentials_enc, &key);
    let resp = CloudAccountResponse::from_account(account, has_credentials);
    Ok(Json(json!({ "data": resp })))
}

// ─── update_account ───────────────────────────────────────────────────────────

pub async fn update_account(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, account_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateCloudAccountRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let mut account = sqlx::query_as::<_, CloudAccount>(&format!(
        r#"
        UPDATE cloud_accounts
        SET
            name       = COALESCE($3, name),
            config     = COALESCE($4, config),
            sync_interval_hours = COALESCE($5, sync_interval_hours),
            currency   = COALESCE($6, currency),
            updated_at = NOW()
        WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
        RETURNING {cols}
        "#,
        cols = "id, organization_id, name, provider::text AS provider, credentials_enc, config,
                is_active, last_sync_at, last_sync_status::text AS last_sync_status,
                currency, resource_count, created_at, updated_at"
    ))
    .bind(account_id)
    .bind(org_id)
    .bind(body.name.as_deref())
    .bind(body.config.as_ref())
    .bind(body.sync_interval_hours)
    .bind(body.currency.as_deref())
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Cloud account not found".into()))?;

    // Write-only credential rotation / clear: "__CLEAR__" clears, a non-empty
    // object replaces (validated), anything else leaves credentials untouched.
    if let Some(creds) = body.credentials.as_ref() {
        let key = crypto::key_from_hex(&state.config.encryption_key).ok_or_else(|| {
            AppError::Validation("ENCRYPTION_KEY must be 64 hex characters".into())
        })?;
        let new_enc: Option<String> = match creds {
            Value::String(s) if s == "__CLEAR__" => Some(crypto::encrypt(&key, b"{}")),
            v if credentials_have_content(v) => {
                validate_credentials(&account.provider, v)?;
                let creds_json = serde_json::to_string(v)
                    .map_err(|e| AppError::Validation(format!("Invalid credentials JSON: {e}")))?;
                Some(crypto::encrypt(&key, creds_json.as_bytes()))
            }
            Value::String(_) => {
                return Err(AppError::Validation(
                    "credentials must be a JSON object".into(),
                ))
            }
            _ => None, // null / {} / absent → unchanged
        };
        if let Some(enc) = new_enc {
            account = sqlx::query_as::<_, CloudAccount>(&format!(
                r#"
                UPDATE cloud_accounts
                SET credentials_enc = $3, updated_at = NOW()
                WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
                RETURNING {cols}
                "#,
                cols = "id, organization_id, name, provider::text AS provider, credentials_enc, config,
                        is_active, last_sync_at, last_sync_status::text AS last_sync_status,
                        currency, resource_count, created_at, updated_at"
            ))
            .bind(account_id)
            .bind(org_id)
            .bind(&enc)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| AppError::NotFound("Cloud account not found".into()))?;
        }
    }

    let key = crypto::key_from_hex(&state.config.encryption_key).unwrap_or([0u8; 32]);
    let has_credentials = encrypted_has_credentials(&account.credentials_enc, &key);
    let resp = CloudAccountResponse::from_account(account, has_credentials);
    Ok(Json(json!({ "data": resp })))
}

// ─── delete_account ───────────────────────────────────────────────────────────

pub async fn delete_account(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, account_id)): Path<(Uuid, Uuid)>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let result = sqlx::query(
        "UPDATE cloud_accounts SET deleted_at = $1 WHERE id = $2 AND organization_id = $3 AND deleted_at IS NULL",
    )
    .bind(Utc::now())
    .bind(account_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Cloud account not found".into()));
    }

    Ok((StatusCode::OK, Json(json!({ "data": { "message": "Account deleted" } }))))
}

// ─── test_connection ──────────────────────────────────────────────────────────

pub async fn test_connection(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, account_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    // Fetch account to get provider / config.
    let account = sqlx::query_as::<_, CloudAccount>(&format!(
        "{ACCOUNT_SELECT} WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL"
    ))
    .bind(account_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Cloud account not found".into()))?;

    let key = crypto::key_from_hex(&state.config.encryption_key).unwrap_or([0u8; 32]);
    let creds: Value = crypto::decrypt(&key, &account.credentials_enc)
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);

    let adapter = create_adapter(
        &account.provider,
        &creds,
        &account.config,
        state.config.cloud_mock_enabled,
    )?;

    let (success, message, region_count) = adapter.test_connection().await?;

    Ok(Json(json!({
        "data": ConnectionTestResponse { success, message, region_count: Some(region_count) }
    })))
}

// ─── trigger_sync ─────────────────────────────────────────────────────────────

pub async fn trigger_sync(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, account_id)): Path<(Uuid, Uuid)>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let Some(job) = launch_sync(&state, org_id, account_id, &user_id.to_string()).await? else {
        // Manual triggers 409 on an active discovery job; None is scheduler-only.
        return Err(AppError::Internal(anyhow::anyhow!(
            "manual sync launch returned no job"
        )));
    };
    Ok((StatusCode::ACCEPTED, Json(json!({ "data": crate::modules::jobs::job_to_json(&job) }))))
}

/// Create a pending discovery job and spawn the background discovery worker.
/// Shared by the manual sync endpoint and the scheduler.
///
/// Returns `Ok(None)` when a discovery job is already active for the account
/// and the trigger is the scheduler (routine overlap is a silent skip);
/// manual triggers get a 409 carrying `details.existing_job_id`.
pub(crate) async fn launch_sync(
    state: &AppState,
    org_id: Uuid,
    account_id: Uuid,
    triggered_by: &str,
) -> AppResult<Option<crate::modules::jobs::JobRow>> {
    // Verify the account exists.
    let account = sqlx::query_as::<_, CloudAccount>(&format!(
        "{ACCOUNT_SELECT} WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL"
    ))
    .bind(account_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Cloud account not found".into()))?;

    use crate::modules::jobs;
    if let Some(existing) = jobs::find_active_job(&state.db, account_id, jobs::KIND_DISCOVERY).await? {
        if triggered_by == jobs::TRIGGERED_BY_SCHEDULER {
            tracing::debug!(account_id = %account_id, existing_job = %existing, "discovery already active — scheduler skips");
            return Ok(None);
        }
        return Err(AppError::ConflictWithDetails(
            "A sync is already running for this account".into(),
            json!({ "existing_job_id": existing }),
        ));
    }

    let job = jobs::insert_job(&state.db, org_id, account_id, jobs::KIND_DISCOVERY, json!({}), triggered_by).await?;

    // Spawn background discovery task.
    let db = state.db.clone();
    let mock_enabled = state.config.cloud_mock_enabled;
    let provider = account.provider.clone();
    let config = account.config.clone();
    let creds_enc = account.credentials_enc.clone();
    let encryption_key = state.config.encryption_key.clone();
    let job_id = job.id;

    tokio::spawn(async move {
        run_sync(
            db,
            job_id,
            account_id,
            org_id,
            provider,
            creds_enc,
            config,
            mock_enabled,
            encryption_key,
        )
        .await;
    });

    Ok(Some(job))
}

/// Background worker: discovers resources and upserts them as CIs.
/// Phase/progress writes are conditional on `status = 'running'` — a zero
/// rowcount means the job was cancelled and the worker returns without a
/// terminal write (the cancelled state sticks) and without touching
/// `cloud_accounts` (spec 2026-09-09 §4.5).
pub(crate) async fn run_sync(
    db: sqlx::PgPool,
    job_id: Uuid,
    account_id: Uuid,
    org_id: Uuid,
    provider: String,
    creds_enc: String,
    config: Value,
    mock_enabled: bool,
    encryption_key: String,
) {
    use crate::modules::jobs;

    if !jobs::claim_job(&db, job_id).await {
        tracing::info!(job_id = %job_id, "sync cancelled while pending");
        return;
    }
    let job = match jobs::get_job_row(&db, org_id, job_id).await {
        Ok(j) => j,
        Err(e) => {
            tracing::error!(job_id = %job_id, error = %e, "sync worker cannot reload job");
            return;
        }
    };

    let key = crypto::key_from_hex(&encryption_key).unwrap_or([0u8; 32]);
    let creds: Value = crypto::decrypt(&key, &creds_enc)
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);

    // ── Phase: discovering (indeterminate) ────────────────────────────────
    if !jobs::report_progress(&db, job_id, "discovering", None, None).await {
        return;
    }
    let adapter = match create_adapter(&provider, &creds, &config, mock_enabled) {
        Ok(a) => a,
        Err(e) => {
            tracing::error!(job_id = %job_id, error = %e, "Failed to create adapter");
            jobs::finalize_job(&db, &job, "failed", Some(&e.to_string()), json!({}), None).await;
            return;
        }
    };

    let resources = match adapter.discover_resources(None).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(job_id = %job_id, error = %e, "Sync discovery failed");
            jobs::finalize_job(&db, &job, "failed", Some(&e.to_string()), json!({}), None).await;
            return;
        }
    };

    let discovered = resources.len() as i32;
    let mut created = 0i32;
    let mut updated = 0i32;

    // ── Phase: upserting — n/total, write every 20 resources ─────────────
    for (idx, res) in resources.iter().enumerate() {
        if idx % 20 == 0
            && !jobs::report_progress(&db, job_id, "upserting", Some(idx as i32), Some(discovered)).await
        {
            return;
        }
        let now = Utc::now();
        match upsert_discovered_resource(&db, org_id, account_id, &provider, res, now).await {
            Ok(true) => created += 1,
            Ok(false) => updated += 1,
            Err(e) => {
                tracing::warn!(resource_id = %res.cloud_resource_id, error = %e, "discovered resource upsert failed");
                updated += 1;
            }
        }
    }

    // K8s rightsizing pipeline: clusters/workloads/usage samples for
    // kubernetes accounts (spec 2026-08-17). Failures don't fail the job.
    if provider == "kubernetes" {
        if let Err(e) = crate::modules::k8s::pipeline::sync_account(&db, org_id, account_id, &adapter, &config).await
        {
            tracing::warn!(account_id = %account_id, error = %e, "k8s pipeline sync failed");
        }
    }

    // ACK clusters (provider alibaba) are mirrored into `k8s_clusters` too, so
    // cluster tables and rightsizing views can see them. We additionally reach
    // each cluster's apiserver via its kubeconfig to sync pods (as resources)
    // and workloads (into the k8s rightsizing tables) — matching the behavior
    // of a direct `kubernetes` account. Failures don't fail the sync job.
    if provider == "alibaba" {
        let clusters: Vec<&crate::modules::cloud::adapters::DiscoveredResource> = resources
            .iter()
            .filter(|r| r.resource_type == "k8s_cluster")
            .collect();
        let cluster_total = clusters.len();
        for (ci, res) in clusters.into_iter().enumerate() {
            // ── Phase: k8s_clusters — cluster i/n ────────────────────────
            if !jobs::report_progress(&db, job_id, "k8s_clusters", Some(ci as i32 + 1), Some(cluster_total as i32)).await {
                return;
            }
            let node_count = res.meta["node_count"].as_i64().unwrap_or(0) as i32;
            let upsert = sqlx::query(
                r#"INSERT INTO k8s_clusters
                   (organization_id, cloud_account_id, name, region, provider,
                    node_count, total_vcpu, total_memory_gb, monthly_cost, meta,
                    last_synced_at, created_at, updated_at)
                   VALUES ($1, $2, $3, $4, 'alibaba', $5, 0, 0, 0, $6, $7, $7, $7)
                   ON CONFLICT (organization_id, name)
                   DO UPDATE SET
                       region         = EXCLUDED.region,
                       node_count     = EXCLUDED.node_count,
                       meta           = EXCLUDED.meta,
                       last_synced_at = EXCLUDED.last_synced_at,
                       updated_at     = EXCLUDED.updated_at"#,
            )
            .bind(org_id)
            .bind(account_id)
            .bind(&res.resource_name)
            .bind(res.region.as_deref())
            .bind(node_count)
            .bind(&res.meta)
            .bind(Utc::now())
            .execute(&db)
            .await;
            if let Err(e) = upsert {
                tracing::warn!(resource_id = %res.cloud_resource_id, error = %e, "k8s_clusters upsert failed");
            }

            // Discover workloads inside the ACK cluster via its kubeconfig.
            let Some(cluster_id) = res.meta["cluster_id"].as_str().map(str::to_string) else {
                tracing::warn!(cluster = %res.resource_name, "ACK cluster missing cluster_id, skipping workload sync");
                continue;
            };
            let Some(aliyun) = adapter.as_aliyun() else {
                continue;
            };
            match aliyun.fetch_ack_kubeconfig(&cluster_id).await {
                Ok(cfg) => match parse_kubeconfig(&cfg) {
                    Ok(kc) => match KubernetesAdapter::from_kubeconfig(&kc, None) {
                        Ok(k8s_adapter) => {
                            // Pods → `k8s_pod` resources/CIs (same as a direct
                            // kubernetes account's discover_resources).
                            match k8s_adapter.discover_resources(None).await {
                                Ok(pods) => {
                                    for pod in pods {
                                        if let Err(e) = upsert_discovered_resource(
                                            &db, org_id, account_id, &provider, &pod, Utc::now(),
                                        )
                                        .await
                                        {
                                            tracing::warn!(
                                                cluster = %res.resource_name,
                                                resource_id = %pod.cloud_resource_id,
                                                error = %e,
                                                "ACK pod upsert failed"
                                            );
                                        }
                                    }
                                }
                                Err(e) => tracing::warn!(
                                    cluster = %res.resource_name,
                                    error = ?e,
                                    "ACK pod discovery failed"
                                ),
                            }
                            // Workloads → k8s rightsizing tables.
                            if let Err(e) = crate::modules::k8s::pipeline::sync_cluster(
                                &db, org_id, account_id, &k8s_adapter, &res.resource_name, &config,
                            )
                            .await
                            {
                                tracing::warn!(
                                    cluster = %res.resource_name,
                                    error = ?e,
                                    "ACK workload sync failed"
                                );
                            }
                        }
                        Err(e) => tracing::warn!(
                            cluster = %res.resource_name,
                            error = %e,
                            "ACK kubeconfig adapter build failed"
                        ),
                    },
                    Err(e) => tracing::warn!(
                        cluster = %res.resource_name,
                        error = %e,
                        "ACK kubeconfig parse failed"
                    ),
                },
                Err(e) => tracing::warn!(
                    cluster = %res.resource_name,
                    error = %e,
                    "ACK kubeconfig fetch failed"
                ),
            }
        }
    }

    // ── Phase: finalizing (indeterminate) ────────────────────────────────
    if !jobs::report_progress(&db, job_id, "finalizing", None, None).await {
        return;
    }

    jobs::finalize_job(
        &db,
        &job,
        "succeeded",
        None,
        json!({}),
        Some((discovered, created, updated)),
    )
    .await;

    // Refresh resource_count and last_sync on the cloud account.
    let _ = sqlx::query(
        r#"
        UPDATE cloud_accounts
        SET last_sync_at     = $1,
            last_sync_status = 'succeeded',
            resource_count   = (
                SELECT COUNT(*)::int FROM cis
                WHERE cloud_account_id = $2 AND deleted_at IS NULL
            ),
            updated_at = $1
        WHERE id = $2
        "#,
    )
    .bind(Utc::now())
    .bind(account_id)
    .execute(&db)
    .await;

    tracing::info!(
        job_id = %job_id,
        discovered,
        created,
        updated,
        "Sync completed"
    );
}

// ─── list_sync_jobs ───────────────────────────────────────────────────────────

pub async fn list_sync_jobs(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, account_id)): Path<(Uuid, Uuid)>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let bounds = page.resolve(50, 200);

    let jobs = sqlx::query_as::<_, SyncJob>(&format!(
        r#"
        {SYNC_JOB_SELECT}
        WHERE cloud_account_id = $1 AND organization_id = $2
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4
        "#
    ))
    .bind(account_id)
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sync_jobs WHERE cloud_account_id = $1 AND organization_id = $2",
    )
    .bind(account_id)
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let data: Vec<SyncJobResponse> = jobs.into_iter().map(Into::into).collect();
    Ok(Json(json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ci_provider_maps_unknown_providers_to_mock() {
        // cloud_provider enum has no 'other'/'kubernetes' — the CI insert
        // must use a safe value while the adapter runs the mock backend.
        assert_eq!(ci_provider_for("aws"), "aws");
        assert_eq!(ci_provider_for("alibaba"), "alibaba");
        assert_eq!(ci_provider_for("other"), "mock");
        assert_eq!(ci_provider_for("kubernetes"), "mock");
        assert_eq!(ci_provider_for("mystery"), "mock");
    }

    #[test]
    fn ci_type_id_mapping_covers_discovered_types() {
        // Seeded builtin CI type UUIDs (migration 010) — discovery must map
        // every known resource type to the right CMDB type.
        assert_eq!(
            resource_type_to_ci_type_id("instance"),
            uuid::uuid!("20000000-0000-0000-0000-000000000001")
        );
        assert_eq!(
            resource_type_to_ci_type_id("rds_instance"),
            uuid::uuid!("20000000-0000-0000-0000-000000000002")
        );
        assert_eq!(
            resource_type_to_ci_type_id("bucket"),
            uuid::uuid!("20000000-0000-0000-0000-000000000005")
        );
        // Unknown types fall back to the generic cloud_instance type.
        assert_eq!(
            resource_type_to_ci_type_id("something_new"),
            uuid::uuid!("20000000-0000-0000-0000-000000000001")
        );
    }

    #[test]
    fn service_name_mapping_matches_billing_services() {
        // The FinOps resources mirror derives service_name from resource_type;
        // these must match the services the expense rollups group by.
        assert_eq!(service_name_for_type("instance", "aws"), "Amazon EC2");
        assert_eq!(service_name_for_type("volume", "aws"), "Amazon EBS");
        assert_eq!(service_name_for_type("bucket", "aws"), "Amazon S3");
        assert_eq!(service_name_for_type("rds_instance", "aws"), "Amazon RDS");
        assert_eq!(service_name_for_type("load_balancer", "aws"), "AWS ELB");
        assert_eq!(service_name_for_type("mystery", "aws"), "Other");
        // Alibaba resources must not get AWS service labels.
        assert_eq!(service_name_for_type("bucket", "alibaba"), "Aliyun OSS");
        assert_eq!(service_name_for_type("instance", "alibaba"), "Aliyun ECS");
        assert_eq!(service_name_for_type("rds_instance", "alibaba"), "Aliyun RDS");
        assert_eq!(service_name_for_type("volume", "alibaba"), "Aliyun Disk");
        assert_eq!(service_name_for_type("ip_address", "alibaba"), "Aliyun EIP");
        assert_eq!(service_name_for_type("k8s_cluster", "alibaba"), "Aliyun ACK");
    }
}
