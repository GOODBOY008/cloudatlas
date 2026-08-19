use axum::{
    extract::{Extension, Path, State},
    http::StatusCode,
    Json,
};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    modules::auth::service::Claims,
    state::AppState,
};

async fn ensure_org_member(db: &sqlx::PgPool, org_id: Uuid, user_id: Uuid) -> AppResult<()> {
    sqlx::query("SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2")
        .bind(org_id)
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::Forbidden("Not a member of this organization".into()))?;
    Ok(())
}

// ─── DTOs ─────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateEnvironmentRequest {
    pub name: String,
    pub description: Option<String>,
    pub resource_id: Option<Uuid>,
    pub cloud_account_id: Option<Uuid>,
    pub auto_release_hours: Option<i32>,
}

#[derive(Deserialize)]
pub struct BookEnvironmentRequest {
    pub start_time: chrono::DateTime<Utc>,
    pub end_time: chrono::DateTime<Utc>,
    pub notes: Option<String>,
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/// GET /api/v1/orgs/{org_id}/shared-environments
pub async fn list_environments(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT e.id, e.name, e.description, e.resource_id, e.cloud_account_id,
                  e.auto_release_hours, e.status, e.meta, e.created_by, e.created_at,
                  -- active booking info
                  b.id AS booking_id,
                  b.booked_by,
                  b.start_time,
                  b.end_time,
                  u.display_name AS booked_by_name
           FROM shared_environments e
           LEFT JOIN environment_bookings b
               ON b.environment_id = e.id AND b.status = 'active'
           LEFT JOIN users u ON u.id = b.booked_by
           WHERE e.organization_id = $1
           ORDER BY e.name ASC, e.id ASC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM shared_environments WHERE organization_id = $1")
            .bind(org_id)
            .fetch_one(&state.db)
            .await
            .unwrap_or(0);

    let data: Vec<Value> = rows.iter().map(|r| json!({
        "id":                   r.try_get::<Uuid, _>("id").ok(),
        "name":                 r.try_get::<String, _>("name").unwrap_or_default(),
        "description":          r.try_get::<Option<String>, _>("description").unwrap_or(None),
        "resource_id":          r.try_get::<Option<Uuid>, _>("resource_id").unwrap_or(None),
        "cloud_account_id":     r.try_get::<Option<Uuid>, _>("cloud_account_id").unwrap_or(None),
        "auto_release_hours":   r.try_get::<i32, _>("auto_release_hours").unwrap_or(8),
        "status":               r.try_get::<String, _>("status").unwrap_or_default(),
        "meta":                 r.try_get::<Value, _>("meta").unwrap_or(json!({})),
        "created_at":           r.try_get::<chrono::DateTime<Utc>, _>("created_at").ok(),
        "booking": if r.try_get::<Option<Uuid>, _>("booking_id").unwrap_or(None).is_some() {
            json!({
                "id":             r.try_get::<Option<Uuid>, _>("booking_id").unwrap_or(None),
                "booked_by":      r.try_get::<Option<Uuid>, _>("booked_by").unwrap_or(None),
                "booked_by_name": r.try_get::<Option<String>, _>("booked_by_name").unwrap_or(None),
                "start_time":     r.try_get::<Option<chrono::DateTime<Utc>>, _>("start_time").unwrap_or(None),
                "end_time":       r.try_get::<Option<chrono::DateTime<Utc>>, _>("end_time").unwrap_or(None),
            })
        } else {
            json!(null)
        },
    })).collect();

    Ok(Json(
        json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) }),
    ))
}

/// POST /api/v1/orgs/{org_id}/shared-environments
pub async fn create_environment(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<CreateEnvironmentRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.name.trim().is_empty() {
        return Err(AppError::Validation("name is required".into()));
    }

    let row = sqlx::query(
        r#"INSERT INTO shared_environments
               (organization_id, name, description, resource_id, cloud_account_id, auto_release_hours, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, name, status, created_at"#,
    )
    .bind(org_id)
    .bind(body.name.trim())
    .bind(body.description.as_deref())
    .bind(body.resource_id)
    .bind(body.cloud_account_id)
    .bind(body.auto_release_hours.unwrap_or(8))
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id":         row.try_get::<Uuid, _>("id").ok(),
                "name":       row.try_get::<String, _>("name").unwrap_or_default(),
                "status":     row.try_get::<String, _>("status").unwrap_or_default(),
                "created_at": row.try_get::<chrono::DateTime<Utc>, _>("created_at").ok(),
            }
        })),
    ))
}

/// DELETE /api/v1/orgs/{org_id}/shared-environments/{id}
pub async fn delete_environment(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, env_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    sqlx::query("DELETE FROM shared_environments WHERE id = $1 AND organization_id = $2")
        .bind(env_id)
        .bind(org_id)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/v1/orgs/{org_id}/shared-environments/{id}/book
pub async fn book_environment(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, env_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<BookEnvironmentRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.end_time <= body.start_time {
        return Err(AppError::Validation(
            "end_time must be after start_time".into(),
        ));
    }

    // Check if environment is available
    let env = sqlx::query(
        "SELECT status FROM shared_environments WHERE id = $1 AND organization_id = $2",
    )
    .bind(env_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Environment not found".into()))?;

    let status: String = env.try_get("status").unwrap_or_default();
    if status == "booked" {
        return Err(AppError::Validation("Environment is already booked".into()));
    }

    // Create booking in a transaction
    let mut tx = state.db.begin().await?;

    let booking = sqlx::query(
        r#"INSERT INTO environment_bookings
               (environment_id, organization_id, booked_by, start_time, end_time, notes)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, start_time, end_time, status"#,
    )
    .bind(env_id)
    .bind(org_id)
    .bind(user_id)
    .bind(body.start_time)
    .bind(body.end_time)
    .bind(body.notes.as_deref())
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE shared_environments SET status = 'booked', updated_at = NOW() WHERE id = $1",
    )
    .bind(env_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id":         booking.try_get::<Uuid, _>("id").ok(),
                "status":     booking.try_get::<String, _>("status").unwrap_or_default(),
                "start_time": booking.try_get::<chrono::DateTime<Utc>, _>("start_time").ok(),
                "end_time":   booking.try_get::<chrono::DateTime<Utc>, _>("end_time").ok(),
            }
        })),
    ))
}

/// POST /api/v1/orgs/{org_id}/shared-environments/{id}/release
pub async fn release_environment(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, env_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let mut tx = state.db.begin().await?;

    sqlx::query(
        r#"UPDATE environment_bookings
           SET status = 'released', updated_at = NOW()
           WHERE environment_id = $1 AND booked_by = $2 AND status = 'active'"#,
    )
    .bind(env_id)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query("UPDATE shared_environments SET status = 'available', updated_at = NOW() WHERE id = $1 AND organization_id = $2")
        .bind(env_id).bind(org_id).execute(&mut *tx).await?;

    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// GET /api/v1/orgs/{org_id}/shared-environments/{id}/bookings
pub async fn list_bookings(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, env_id)): Path<(Uuid, Uuid)>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT b.id, b.booked_by, b.start_time, b.end_time, b.status, b.notes, b.created_at,
                  u.display_name AS booked_by_name
           FROM environment_bookings b
           JOIN users u ON u.id = b.booked_by
           WHERE b.environment_id = $1 AND b.organization_id = $2
           ORDER BY b.created_at DESC, b.id DESC
           LIMIT $3 OFFSET $4"#,
    )
    .bind(env_id)
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM environment_bookings WHERE environment_id = $1 AND organization_id = $2",
    )
    .bind(env_id).bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id":             r.try_get::<Uuid, _>("id").ok(),
                "booked_by":      r.try_get::<Uuid, _>("booked_by").ok(),
                "booked_by_name": r.try_get::<Option<String>, _>("booked_by_name").unwrap_or(None),
                "start_time":     r.try_get::<chrono::DateTime<Utc>, _>("start_time").ok(),
                "end_time":       r.try_get::<chrono::DateTime<Utc>, _>("end_time").ok(),
                "status":         r.try_get::<String, _>("status").unwrap_or_default(),
                "notes":          r.try_get::<Option<String>, _>("notes").unwrap_or(None),
                "created_at":     r.try_get::<chrono::DateTime<Utc>, _>("created_at").ok(),
            })
        })
        .collect();

    Ok(Json(
        json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) }),
    ))
}
