use axum::{
    http::StatusCode,
    extract::{Extension, Path, State},
    Json,
};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use super::{
    dto::{CreateOrgRequest, MemberResponse, OrganizationResponse, UpdateOrgRequest},
    models::Organization,
    service::{make_slug, Claims},
};

// ─── List organizations for current user ─────────────────────────────────────

#[utoipa::path(
    get,
    path = "/api/v1/organizations",
    responses(
        (status = 200, description = "List of organizations the user belongs to"),
    ),
    security(("bearer_auth" = [])),
    tag = "organizations"
)]
pub async fn list_orgs(
    Extension(claims): Extension<Claims>,
    State(state): State<AppState>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;

    let orgs = sqlx::query_as::<_, Organization>(
        r#"
        SELECT o.id, o.name, o.slug, o.description, o.settings, o.created_at, o.updated_at
        FROM organizations o
        JOIN organization_members om ON om.organization_id = o.id
        WHERE om.user_id = $1
        ORDER BY o.name
        "#,
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    let items: Vec<_> = orgs.into_iter().map(org_to_response).collect();
    Ok(Json(json!({ "data": items })))
}

// ─── Create organization ──────────────────────────────────────────────────────

#[utoipa::path(
    post,
    path = "/api/v1/organizations",
    request_body = CreateOrgRequest,
    responses(
        (status = 201, description = "Organization created", body = OrganizationResponse),
        (status = 409, description = "Slug already taken"),
        (status = 422, description = "Validation error"),
    ),
    security(("bearer_auth" = [])),
    tag = "organizations"
)]
pub async fn create_org(
    Extension(claims): Extension<Claims>,
    State(state): State<AppState>,
    Json(body): Json<CreateOrgRequest>,
) -> AppResult<(axum::http::StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;

    crate::utils::validate::name(&body.name, 100, "Organization name").map_err(AppError::Validation)?;

    let name = body.name.trim().to_string();
    let slug = body
        .slug
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(make_slug)
        .unwrap_or_else(|| make_slug(&name));

    // Ensure slug uniqueness
    let taken = sqlx::query("SELECT id FROM organizations WHERE slug = $1")
        .bind(&slug)
        .fetch_optional(&state.db)
        .await?;

    if taken.is_some() {
        return Err(AppError::Conflict(format!(
            "Organization slug '{slug}' is already taken"
        )));
    }

    let org_id = Uuid::new_v4();
    let now = Utc::now();

    let org = sqlx::query_as::<_, Organization>(
        r#"
        INSERT INTO organizations (id, name, slug, description, settings, created_at, updated_at)
        VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $5)
        RETURNING id, name, slug, description, settings, created_at, updated_at
        "#,
    )
    .bind(org_id)
    .bind(&name)
    .bind(&slug)
    .bind(body.description.as_deref())
    .bind(now)
    .fetch_one(&state.db)
    .await?;

    // Creator becomes a member
    sqlx::query(
        r#"
        INSERT INTO organization_members (id, organization_id, user_id, joined_at)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(org_id)
    .bind(user_id)
    .bind(now)
    .execute(&state.db)
    .await?;

    // Create the builtin roles for the new org and assign the creator as Owner
    // (required by RBAC enforcement — see middleware/rbac.rs).
    let builtin_roles: [(&str, &str); 5] = [
        ("Owner", "Organization owner with full access"),
        ("Admin", "Organization administrator"),
        ("FinOps", "FinOps access: costs, recommendations"),
        ("CMDB Editor", "Create and update configuration items"),
        ("Member", "Read-only organization member"),
    ];
    for (role_name, role_desc) in builtin_roles {
        let role_id = Uuid::new_v4();
        sqlx::query(
            r#"INSERT INTO roles (id, organization_id, name, description, is_builtin)
               VALUES ($1, $2, $3, $4, true)"#,
        )
        .bind(role_id)
        .bind(org_id)
        .bind(role_name)
        .bind(role_desc)
        .execute(&state.db)
        .await?;

        if role_name == "Owner" {
            sqlx::query(
                r#"INSERT INTO user_roles (user_id, role_id, organization_id, assigned_at)
                   VALUES ($1, $2, $3, NOW())"#,
            )
            .bind(user_id)
            .bind(role_id)
            .bind(org_id)
            .execute(&state.db)
            .await?;
        }
    }

    let response = org_to_response(org);
    Ok((
        axum::http::StatusCode::CREATED,
        Json(json!({ "data": response })),
    ))
}

// ─── Get organization ─────────────────────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/api/v1/organizations/{org_id}",
    params(("org_id" = Uuid, Path, description = "Organization ID")),
    responses(
        (status = 200, description = "Organization details", body = OrganizationResponse),
        (status = 403, description = "Not a member"),
        (status = 404, description = "Organization not found"),
    ),
    security(("bearer_auth" = [])),
    tag = "organizations"
)]
pub async fn get_org(
    Extension(claims): Extension<Claims>,
    State(state): State<AppState>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_member(&state.db, org_id, user_id).await?;

    let org = sqlx::query_as::<_, Organization>(
        r#"
        SELECT id, name, slug, description, settings, created_at, updated_at
        FROM organizations
        WHERE id = $1
        "#,
    )
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("Organization {org_id} not found")))?;

    Ok(Json(json!({ "data": org_to_response(org) })))
}

// ─── Update organization ──────────────────────────────────────────────────────

#[utoipa::path(
    put,
    path = "/api/v1/organizations/{org_id}",
    params(("org_id" = Uuid, Path, description = "Organization ID")),
    request_body = UpdateOrgRequest,
    responses(
        (status = 200, description = "Organization updated", body = OrganizationResponse),
        (status = 403, description = "Not a member"),
        (status = 404, description = "Organization not found"),
    ),
    security(("bearer_auth" = [])),
    tag = "organizations"
)]
pub async fn update_org(
    Extension(claims): Extension<Claims>,
    State(state): State<AppState>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<UpdateOrgRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_member(&state.db, org_id, user_id).await?;

    let now = Utc::now();

    // COALESCE preserves the existing value when the caller passes null.
    // Currency is stored in settings.currency (D2).
    let org = sqlx::query_as::<_, Organization>(
        r#"
        UPDATE organizations
        SET
            name        = COALESCE($2, name),
            description = COALESCE($3, description),
            settings    = CASE WHEN $4::text IS NULL
                              THEN settings
                              ELSE jsonb_set(settings, '{currency}', to_jsonb($4::text)) END,
            updated_at  = $5
        WHERE id = $1
        RETURNING id, name, slug, description, settings, created_at, updated_at
        "#,
    )
    .bind(org_id)
    .bind(body.name.as_deref())
    .bind(body.description.as_deref())
    .bind(body.currency.as_deref())
    .bind(now)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("Organization {org_id} not found")))?;

    Ok(Json(json!({ "data": org_to_response(org) })))
}

// ─── List members ─────────────────────────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/api/v1/organizations/{org_id}/members",
    params(("org_id" = Uuid, Path, description = "Organization ID")),
    responses(
        (status = 200, description = "Organization member list", body = Vec<MemberResponse>),
        (status = 403, description = "Not a member"),
        (status = 404, description = "Organization not found"),
    ),
    security(("bearer_auth" = [])),
    tag = "organizations"
)]
pub async fn list_members(
    Extension(claims): Extension<Claims>,
    State(state): State<AppState>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_member(&state.db, org_id, user_id).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"
        SELECT
            u.id          AS user_id,
            u.email,
            u.display_name,
            om.joined_at
        FROM organization_members om
        JOIN users u ON u.id = om.user_id
        WHERE om.organization_id = $1
        ORDER BY om.joined_at ASC, u.id ASC
        LIMIT $2 OFFSET $3
        "#,
    )
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_members WHERE organization_id = $1",
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    // One role query for the whole page (was one query per member).
    let role_rows = sqlx::query(
        r#"
        SELECT ur.user_id, r.name
        FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id
        WHERE ur.organization_id = $1
        "#,
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    let mut roles_by_user: std::collections::HashMap<Uuid, Vec<String>> = Default::default();
    for rr in &role_rows {
        let uid: Uuid = rr.try_get("user_id").unwrap_or_default();
        let name: String = rr.try_get("name").unwrap_or_default();
        roles_by_user.entry(uid).or_default().push(name);
    }

    let members: Vec<MemberResponse> = rows
        .iter()
        .map(|r| {
            let member_user_id: Uuid = r.try_get("user_id").unwrap_or_default();
            MemberResponse {
                user_id: member_user_id,
                email: r.try_get("email").unwrap_or_default(),
                display_name: r.try_get("display_name").unwrap_or_default(),
                joined_at: r.try_get("joined_at").unwrap_or_else(|_| Utc::now()),
                roles: roles_by_user.get(&member_user_id).cloned().unwrap_or_default(),
            }
        })
        .collect();

    Ok(Json(json!({
        "data": members,
        "meta": crate::utils::pagination::page_meta_json(total, &bounds)
    })))
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Return `Forbidden` if `user_id` is not a member of `org_id`.
async fn ensure_member(
    db: &sqlx::PgPool,
    org_id: Uuid,
    user_id: Uuid,
) -> AppResult<()> {
    sqlx::query(
        "SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::Forbidden("You are not a member of this organization".into()))?;
    Ok(())
}

fn org_to_response(org: Organization) -> OrganizationResponse {
    OrganizationResponse {
        id: org.id,
        name: org.name,
        slug: org.slug,
        description: org.description,
        created_at: org.created_at,
    }
}

// ─── Invite (add) member ──────────────────────────────────────────────────────

pub async fn invite_member(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<serde_json::Value>,
) -> AppResult<(axum::http::StatusCode, Json<Value>)> {
    let caller_id = claims.user_id()?;
    ensure_member(&state.db, org_id, caller_id).await?;

    let target_user_id_str = body["user_id"]
        .as_str()
        .ok_or_else(|| AppError::Validation("user_id is required".into()))?;
    let target_user_id = Uuid::parse_str(target_user_id_str)
        .map_err(|_| AppError::Validation("user_id must be a valid UUID".into()))?;

    // Verify the target user exists
    let exists = sqlx::query("SELECT id FROM users WHERE id = $1")
        .bind(target_user_id)
        .fetch_optional(&state.db)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!("User {target_user_id} not found")));
    }

    // Insert — ignore if already a member
    sqlx::query(
        "INSERT INTO organization_members (organization_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(org_id)
    .bind(target_user_id)
    .execute(&state.db)
    .await?;

    // Invite email (G10): best-effort — never fails the request when SMTP is
    // unconfigured.
    if let Ok((email, org_name)) = sqlx::query_as::<_, (String, String)>(
        r#"SELECT u.email, o.name FROM users u, organizations o
           WHERE u.id = $1 AND o.id = $2"#,
    )
    .bind(target_user_id)
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    {
        let _ = crate::utils::email::send_email(
            &state,
            &email,
            &format!("You've been invited to {org_name} on CloudAtlas"),
            &format!(
                "Hello,\n\nYou have been added to the organization \"{org_name}\" on CloudAtlas.\n\nSign in at the CloudAtlas URL to get started."
            ),
        )
        .await;
    }

    Ok((
        axum::http::StatusCode::CREATED,
        Json(json!({
            "data": {
                "organization_id": org_id,
                "user_id": target_user_id,
                "invited_at": Utc::now(),
            }
        })),
    ))
}

// ─── Remove member ────────────────────────────────────────────────────────────

pub async fn remove_member(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, target_user_id)): Path<(Uuid, Uuid)>,
) -> AppResult<(axum::http::StatusCode, Json<Value>)> {
    let caller_id = claims.user_id()?;
    ensure_member(&state.db, org_id, caller_id).await?;

    let result = sqlx::query(
        "DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(org_id)
    .bind(target_user_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!(
            "User {target_user_id} is not a member of this organization"
        )));
    }

    Ok((axum::http::StatusCode::NO_CONTENT, Json(json!({}))))
}

#[derive(Deserialize)]
pub struct UpdateMemberRoleRequest {
    pub role_name: String,
}

pub async fn update_member_role(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, target_user_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateMemberRoleRequest>,
) -> AppResult<Json<Value>> {
    let caller_id = claims.user_id()?;
    ensure_member(&state.db, org_id, caller_id).await?;
    ensure_member(&state.db, org_id, target_user_id).await?;

    let role_name = body.role_name.trim();
    if role_name.is_empty() {
        return Err(AppError::Validation("role_name is required".into()));
    }

    let role = sqlx::query(
        r#"SELECT id, name
           FROM roles
           WHERE organization_id = $1 AND lower(name) = lower($2)
           LIMIT 1"#,
    )
    .bind(org_id)
    .bind(role_name)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("Role '{role_name}' not found in organization")))?;

    let role_id: Uuid = role.get("id");
    let resolved_role_name: String = role.get("name");

    let mut tx = state.db.begin().await?;

    sqlx::query(
        "DELETE FROM user_roles WHERE user_id = $1 AND organization_id = $2",
    )
    .bind(target_user_id)
    .bind(org_id)
    .execute(tx.as_mut())
    .await?;

    sqlx::query(
        r#"INSERT INTO user_roles (user_id, role_id, organization_id, assigned_at, assigned_by)
           VALUES ($1, $2, $3, NOW(), $4)"#,
    )
    .bind(target_user_id)
    .bind(role_id)
    .bind(org_id)
    .bind(caller_id)
    .execute(tx.as_mut())
    .await?;

    tx.commit().await?;

    Ok(Json(json!({
        "data": {
            "organization_id": org_id,
            "user_id": target_user_id,
            "role_name": resolved_role_name,
            "updated_at": Utc::now(),
        }
    })))
}


// ─── Invites (product gap C1) ─────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateInviteRequest {
    pub email: String,
    #[serde(default = "default_invite_role")]
    pub role: String,
}

fn default_invite_role() -> String {
    "Member".into()
}

/// POST /organizations/:org_id/invites — email-based invite with accept token.
pub async fn create_invite(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(req): Json<CreateInviteRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let caller_id = claims.user_id()?;
    ensure_member(&state.db, org_id, caller_id).await?;
    crate::utils::validate::email(&req.email).map_err(AppError::Validation)?;

    let token = auth_token();
    let token_hash = auth_token_hash(&token);
    let invite_id = Uuid::new_v4();

    sqlx::query(
        r#"INSERT INTO invites (id, organization_id, email, role_name, token_hash, expires_at, created_by)
           VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '7 days', $6)
           ON CONFLICT (organization_id, email) DO UPDATE SET
               token_hash = $5, status = 'pending', expires_at = NOW() + INTERVAL '7 days', created_at = NOW()"#,
    )
    .bind(invite_id)
    .bind(org_id)
    .bind(&req.email)
    .bind(&req.role)
    .bind(&token_hash)
    .bind(caller_id)
    .execute(&state.db)
    .await?;

    // Best-effort email with the accept link.
    if let Ok(org_name) = sqlx::query_scalar::<_, String>(
        "SELECT name FROM organizations WHERE id = $1",
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    {
        let _ = crate::utils::email::send_email(
            &state,
            &req.email,
            &format!("You're invited to {org_name} on CloudAtlas"),
            &format!(
                "Accept your invitation to {org_name}:\n\n{}/accept-invite?token={}\n\nIt expires in 7 days.",
                state.config.app_url.as_deref().unwrap_or("http://localhost:5173"),
                token
            ),
        )
        .await;
    }

    Ok((
        StatusCode::CREATED,
        Json(json!({ "data": { "id": invite_id, "email": req.email, "status": "pending" } })),
    ))
}

/// GET /organizations/:org_id/invites — pending invites.
pub async fn list_invites(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let caller_id = claims.user_id()?;
    ensure_member(&state.db, org_id, caller_id).await?;

    let rows = sqlx::query(
        r#"SELECT id, email, role_name, status, expires_at, created_at
           FROM invites WHERE organization_id = $1 AND status = 'pending'
           ORDER BY created_at DESC"#,
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "email": r.get::<String, _>("email"),
                "role_name": r.get::<String, _>("role_name"),
                "status": r.get::<String, _>("status"),
                "expires_at": r.get::<chrono::DateTime<chrono::Utc>, _>("expires_at"),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data, "total": data.len() })))
}

/// POST /organizations/:org_id/invites/:invite_id/revoke
pub async fn revoke_invite(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, invite_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    let caller_id = claims.user_id()?;
    ensure_member(&state.db, org_id, caller_id).await?;

    sqlx::query(
        "UPDATE invites SET status = 'declined' WHERE id = $1 AND organization_id = $2",
    )
    .bind(invite_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "data": { "message": "Invite revoked" } })))
}

#[derive(Deserialize)]
pub struct AcceptInviteRequest {
    pub token: String,
}

/// POST /auth/accept-invite — redeem an invite token: join the org with its role.
pub async fn accept_invite(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<AcceptInviteRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;

    let token_hash = auth_token_hash(&req.token);
    let row = sqlx::query(
        r#"SELECT id, organization_id, role_name FROM invites
           WHERE token_hash = $1 AND status = 'pending' AND expires_at > NOW()"#,
    )
    .bind(&token_hash)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::Validation("Invite token is invalid or expired".into()))?;

    let invite_id: Uuid = row.get("id");
    let org_id: Uuid = row.get("organization_id");
    let role_name: String = row.get("role_name");

    // Join the org.
    sqlx::query(
        "INSERT INTO organization_members (id, organization_id, user_id, joined_at)
         VALUES ($1, $2, $3, NOW()) ON CONFLICT DO NOTHING",
    )
    .bind(Uuid::new_v4())
    .bind(org_id)
    .bind(user_id)
    .execute(&state.db)
    .await?;

    // Assign the invited role.
    if let Ok(role) = sqlx::query(
        "SELECT id FROM roles WHERE organization_id = $1 AND name = $2",
    )
    .bind(org_id)
    .bind(&role_name)
    .fetch_optional(&state.db)
    .await
    {
        if let Some(role) = role {
            let role_id: Uuid = role.get("id");
            let _ = sqlx::query(
                "INSERT INTO user_roles (user_id, role_id, organization_id, assigned_at)
                 VALUES ($1, $2, $3, NOW()) ON CONFLICT DO NOTHING",
            )
            .bind(user_id)
            .bind(role_id)
            .bind(org_id)
            .execute(&state.db)
            .await;
        }
    }

    sqlx::query("UPDATE invites SET status = 'accepted' WHERE id = $1")
        .bind(invite_id)
        .execute(&state.db)
        .await?;

    Ok(Json(json!({ "data": { "organization_id": org_id, "message": "Invite accepted" } })))
}

fn auth_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn auth_token_hash(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    hex::encode(h.finalize())
}
