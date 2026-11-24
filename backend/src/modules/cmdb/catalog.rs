//! Shared business definitions and their environment-local operational deployments.
use axum::{
    extract::{Extension, Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    middleware::rbac::{require_permission, Permission},
    modules::auth::service::Claims,
    state::AppState,
};

#[derive(FromRow)]
struct Scope {
    workspace_id: Uuid,
    editor: bool,
}

async fn scope(db: &PgPool, org: Uuid, user: Uuid) -> AppResult<Scope> {
    sqlx::query_as(
        "SELECT e.workspace_id, EXISTS (SELECT 1 FROM workspace_catalog_editors ce
         WHERE ce.workspace_id=e.workspace_id AND ce.user_id=$2) AS editor
         FROM workspace_environments e JOIN organization_members m ON m.organization_id=e.organization_id
         WHERE e.organization_id=$1 AND m.user_id=$2",
    ).bind(org).bind(user).fetch_optional(db).await?
        .ok_or_else(|| AppError::NotFound("Business workspace not found".into()))
}

async fn editor(db: &PgPool, org: Uuid, user: Uuid) -> AppResult<Uuid> {
    let s = scope(db, org, user).await?;
    if !s.editor {
        return Err(AppError::Forbidden(
            "Shared catalog editor permission required".into(),
        ));
    }
    Ok(s.workspace_id)
}

fn missing() -> AppError {
    AppError::NotFound("Catalog record or environment deployment not found".into())
}

fn write_error(err: sqlx::Error) -> AppError {
    if let sqlx::Error::Database(ref db) = err {
        if db.is_unique_violation() {
            return AppError::Conflict("The name or deployment is already in use".into());
        }
        if db.is_foreign_key_violation() {
            return AppError::Conflict(
                "The record is in use or the selected reference is unavailable".into(),
            );
        }
    }
    err.into()
}

fn name(value: &str) -> AppResult<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 160 {
        return Err(AppError::Validation(
            "A name of 1–160 characters is required".into(),
        ));
    }
    Ok(trimmed)
}

#[utoipa::path(get, path="/api/v1/orgs/{org_id}/catalog", tag="cmdb", security(("bearer_auth"=[])),
    responses((status=200,description="Shared definitions and current environment deployments")))]
pub async fn get(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let user = claims.user_id()?;
    let s = scope(&state.db, org, user).await?;
    let writable = match require_permission(&state.db, user, org, Permission::ManageCmdb).await {
        Ok(()) => true,
        Err(AppError::Forbidden(_)) => false,
        Err(err) => return Err(err),
    };
    let data: Value = sqlx::query_scalar(r#"
        WITH local_deployments AS (
            SELECT d.id, d.name, d.display_name, d.description, m.catalog_service_id, COALESCE(m.is_default,false) AS is_default,
                (SELECT count(*) FROM service_cis sc JOIN cis c ON c.id=sc.ci_id
                 WHERE sc.service_id=d.id AND c.organization_id=$2 AND c.deleted_at IS NULL) AS ci_count
            FROM services d LEFT JOIN workspace_service_deployments m ON m.deployment_id=d.id
            WHERE d.organization_id=$2 AND d.deleted_at IS NULL
        )
        SELECT jsonb_build_object(
            'teams', COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name,id)
                FROM workspace_teams WHERE workspace_id=$1),'[]'),
            'services', COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,
                'team_id',team_id,'system_name',system_name) ORDER BY name,id)
                FROM workspace_services WHERE workspace_id=$1),'[]'),
            'deployments', COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.name,d.id) FROM local_deployments d),'[]'),
            'can_edit_catalog',$3::boolean,'can_edit_deployments',$4::boolean)
        "#).bind(s.workspace_id).bind(org).bind(s.editor && writable).bind(writable)
        .fetch_one(&state.db).await?;
    Ok(Json(json!({"data":data})))
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct TeamInput {
    pub name: String,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct ServiceInput {
    pub name: String,
    pub team_id: Option<Uuid>,
    pub system_name: Option<String>,
}

#[utoipa::path(post, path="/api/v1/orgs/{org_id}/catalog/teams",request_body=TeamInput,tag="cmdb",security(("bearer_auth"=[])),responses((status=201,description="Team created")))]
pub async fn create_team(
    State(s): State<AppState>,
    Extension(c): Extension<Claims>,
    Path(org): Path<Uuid>,
    Json(body): Json<TeamInput>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let ws = editor(&s.db, org, c.user_id()?).await?;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO workspace_teams(workspace_id,name) VALUES ($1,$2) RETURNING id",
    )
    .bind(ws)
    .bind(name(&body.name)?)
    .fetch_one(&s.db)
    .await
    .map_err(write_error)?;
    Ok((StatusCode::CREATED, Json(json!({"data":{"id":id}}))))
}

#[utoipa::path(put, path="/api/v1/orgs/{org_id}/catalog/teams/{id}",request_body=TeamInput,tag="cmdb",security(("bearer_auth"=[])),responses((status=204,description="Team updated")))]
pub async fn update_team(
    State(s): State<AppState>,
    Extension(c): Extension<Claims>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(body): Json<TeamInput>,
) -> AppResult<StatusCode> {
    let ws = editor(&s.db, org, c.user_id()?).await?;
    sqlx::query_scalar::<_, Uuid>(
        "UPDATE workspace_teams SET name=$3 WHERE workspace_id=$1 AND id=$2 RETURNING id",
    )
    .bind(ws)
    .bind(id)
    .bind(name(&body.name)?)
    .fetch_optional(&s.db)
    .await
    .map_err(write_error)?
    .ok_or_else(missing)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(delete, path="/api/v1/orgs/{org_id}/catalog/teams/{id}",tag="cmdb",security(("bearer_auth"=[])),responses((status=204,description="Unused team deleted")))]
pub async fn delete_team(
    State(s): State<AppState>,
    Extension(c): Extension<Claims>,
    Path((org, id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    let ws = editor(&s.db, org, c.user_id()?).await?;
    sqlx::query_scalar::<_, Uuid>(
        "DELETE FROM workspace_teams WHERE workspace_id=$1 AND id=$2 RETURNING id",
    )
    .bind(ws)
    .bind(id)
    .fetch_optional(&s.db)
    .await
    .map_err(write_error)?
    .ok_or_else(missing)?;
    Ok(StatusCode::NO_CONTENT)
}

impl ServiceInput {
    fn system(&self) -> AppResult<Option<&str>> {
        self.system_name
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(name)
            .transpose()
    }
}

#[utoipa::path(post, path="/api/v1/orgs/{org_id}/catalog/services",request_body=ServiceInput,tag="cmdb",security(("bearer_auth"=[])),responses((status=201,description="Logical service created")))]
pub async fn create_service(
    State(s): State<AppState>,
    Extension(c): Extension<Claims>,
    Path(org): Path<Uuid>,
    Json(body): Json<ServiceInput>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let ws = editor(&s.db, org, c.user_id()?).await?;
    let id:Uuid=sqlx::query_scalar("INSERT INTO workspace_services(workspace_id,name,team_id,system_name) VALUES ($1,$2,$3,$4) RETURNING id")
        .bind(ws).bind(name(&body.name)?).bind(body.team_id).bind(body.system()?).fetch_one(&s.db).await.map_err(write_error)?;
    Ok((StatusCode::CREATED, Json(json!({"data":{"id":id}}))))
}

#[utoipa::path(put, path="/api/v1/orgs/{org_id}/catalog/services/{id}",request_body=ServiceInput,tag="cmdb",security(("bearer_auth"=[])),responses((status=204,description="Logical service updated")))]
pub async fn update_service(
    State(s): State<AppState>,
    Extension(c): Extension<Claims>,
    Path((org, id)): Path<(Uuid, Uuid)>,
    Json(body): Json<ServiceInput>,
) -> AppResult<StatusCode> {
    let ws = editor(&s.db, org, c.user_id()?).await?;
    sqlx::query_scalar::<_,Uuid>("UPDATE workspace_services SET name=$3,team_id=$4,system_name=$5 WHERE workspace_id=$1 AND id=$2 RETURNING id")
        .bind(ws).bind(id).bind(name(&body.name)?).bind(body.team_id).bind(body.system()?).fetch_optional(&s.db).await.map_err(write_error)?.ok_or_else(missing)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(delete, path="/api/v1/orgs/{org_id}/catalog/services/{id}",tag="cmdb",security(("bearer_auth"=[])),responses((status=204,description="Undeployed logical service deleted")))]
pub async fn delete_service(
    State(s): State<AppState>,
    Extension(c): Extension<Claims>,
    Path((org, id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    let ws = editor(&s.db, org, c.user_id()?).await?;
    sqlx::query_scalar::<_, Uuid>(
        "DELETE FROM workspace_services WHERE workspace_id=$1 AND id=$2 RETURNING id",
    )
    .bind(ws)
    .bind(id)
    .fetch_optional(&s.db)
    .await
    .map_err(write_error)?
    .ok_or_else(missing)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(put, path="/api/v1/orgs/{org_id}/catalog/services/{id}/deployments/{deployment_id}",tag="cmdb",security(("bearer_auth"=[])),responses((status=204,description="Map an existing environment deployment")))]
pub async fn map_deployment(
    State(s): State<AppState>,
    Extension(c): Extension<Claims>,
    Path((org, service, deployment)): Path<(Uuid, Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    let ws = scope(&s.db, org, c.user_id()?).await?.workspace_id;
    let id=sqlx::query_scalar::<_,Uuid>("INSERT INTO workspace_service_deployments(workspace_id,organization_id,catalog_service_id,deployment_id)
        SELECT $1,$2,cs.id,d.id FROM workspace_services cs JOIN services d ON d.organization_id=$2 AND d.id=$4 AND d.deleted_at IS NULL
        WHERE cs.workspace_id=$1 AND cs.id=$3
        ON CONFLICT(deployment_id) DO UPDATE SET catalog_service_id=excluded.catalog_service_id
        WHERE workspace_service_deployments.catalog_service_id=excluded.catalog_service_id
        RETURNING deployment_id")
        .bind(ws).bind(org).bind(service).bind(deployment).fetch_optional(&s.db).await.map_err(write_error)?;
    id.ok_or_else(missing)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct BindingInput {
    pub ci_id: Uuid,
    pub deployment_id: Option<Uuid>,
    pub role: Option<String>,
}

#[utoipa::path(post,path="/api/v1/orgs/{org_id}/catalog/services/{id}/cis",request_body=BindingInput,tag="cmdb",security(("bearer_auth"=[])),responses((status=201,description="Link an environment CI")))]
pub async fn bind_ci(
    State(s): State<AppState>,
    Extension(c): Extension<Claims>,
    Path((org, service)): Path<(Uuid, Uuid)>,
    Json(body): Json<BindingInput>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user = c.user_id()?;
    let ws = scope(&s.db, org, user).await?.workspace_id;
    if body
        .role
        .as_deref()
        .is_some_and(|v| v.chars().count() > 100)
    {
        return Err(AppError::Validation(
            "Role is limited to 100 characters".into(),
        ));
    }
    let mut tx = s.db.begin().await?;
    // Serializes concurrent first bindings so there is exactly one default deployment per scope.
    sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM workspace_services WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(ws)
    .bind(service)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(missing)?;
    sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM cis WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE",
    )
    .bind(org)
    .bind(body.ci_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(missing)?;
    let deployment = if let Some(id) = body.deployment_id {
        sqlx::query_scalar::<_,Uuid>("SELECT d.id FROM workspace_service_deployments m JOIN services d ON d.id=m.deployment_id
            WHERE m.organization_id=$1 AND m.catalog_service_id=$2 AND d.id=$3 AND d.deleted_at IS NULL FOR SHARE OF d,m")
            .bind(org).bind(service).bind(id).fetch_optional(&mut *tx).await?.ok_or_else(missing)?
    } else {
        let existing=sqlx::query_scalar::<_,Uuid>("SELECT d.id FROM workspace_service_deployments m JOIN services d ON d.id=m.deployment_id
            WHERE m.organization_id=$1 AND m.catalog_service_id=$2 AND m.is_default AND d.deleted_at IS NULL FOR SHARE OF d,m")
            .bind(org).bind(service).fetch_optional(&mut *tx).await?;
        if let Some(id) = existing {
            id
        } else {
            let id = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO services(id,organization_id,name,created_by) VALUES ($1,$2,$3,$4)",
            )
            .bind(id)
            .bind(org)
            .bind(format!("deployment-{id}"))
            .bind(user)
            .execute(&mut *tx)
            .await?;
            sqlx::query("INSERT INTO workspace_service_deployments(workspace_id,organization_id,catalog_service_id,deployment_id,is_default) VALUES ($1,$2,$3,$4,true)")
                .bind(ws).bind(org).bind(service).bind(id).execute(&mut *tx).await?;
            id
        }
    };
    sqlx::query(
        "INSERT INTO service_cis(service_id,ci_id,role) VALUES ($1,$2,$3)
        ON CONFLICT(service_id,ci_id) DO UPDATE SET role=COALESCE(excluded.role,service_cis.role)",
    )
    .bind(deployment)
    .bind(body.ci_id)
    .bind(body.role.as_deref())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    super::handlers::write_model_audit_log(
        &s.db,
        org,
        Some(user),
        "service",
        "add_ci",
        &deployment.to_string(),
        "",
        None,
        Some(&json!({"ci_id":body.ci_id,"catalog_service_id":service})),
    )
    .await;
    Ok((
        StatusCode::CREATED,
        Json(json!({"data":{"deployment_id":deployment,"ci_id":body.ci_id}})),
    ))
}
