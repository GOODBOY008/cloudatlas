---
description: "Use when writing Rust backend code for CloudAtlas: Axum handlers, sqlx queries, AppError, AppState, middleware, modules, OpenAPI annotations. Covers handler patterns, DB access, error handling, and module structure."
applyTo: "backend/src/**/*.rs"
---

# Rust Backend Patterns

## Module Structure

Every module under `src/modules/<name>/` follows this layout:
```
modules/<name>/
├── mod.rs       # pub use, router() fn, OpenApiRouter registration
├── handlers.rs  # Axum handler functions
├── models.rs    # DB row structs (sqlx::FromRow)
├── dto.rs       # Request/response structs (serde, utoipa::ToSchema)
└── service.rs   # Business logic (if complex enough to extract)
```

## Handler Signature

```rust
// Standard authenticated handler pattern
pub async fn list_resources(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,  // from JWT middleware
    Path(org_id): Path<Uuid>,
    Query(q): Query<ResourceQuery>,
) -> AppResult<Json<Value>> {
    require_permission(&state.db, claims.sub, org_id, Permission::ViewExpenses).await?;
    // ... query DB ...
    Ok(Json(json!({ "data": rows, "total": total })))
}
```

## Error Handling

```rust
// Return AppResult<T> everywhere — use ? operator, never unwrap()
pub type AppResult<T> = Result<T, AppError>;

// AppError variants map to HTTP status codes
// DB not found → 404, validation → 400, auth → 401/403
let row = sqlx::query_as::<_, Foo>("SELECT ... WHERE id = $1 AND deleted_at = 0")
    .bind(id)
    .fetch_optional(&state.db).await?
    .ok_or(AppError::NotFound("Resource not found".into()))?;
```

## Database Queries

```rust
// Always use bind params — never format! with user data
let rows = sqlx::query_as::<_, Resource>(
    "SELECT * FROM resources
     WHERE organization_id = $1 AND deleted_at = 0
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3"
)
.bind(org_id)
.bind(limit)
.bind(offset)
.fetch_all(&state.db).await?;

// Soft delete
sqlx::query("UPDATE resources SET deleted_at = $1 WHERE id = $2 AND organization_id = $3")
    .bind(chrono::Utc::now().timestamp())
    .bind(id)
    .bind(org_id)
    .execute(&state.db).await?;

// JSONB: use serde_json::Value in structs
pub struct Ci {
    pub id: Uuid,
    pub meta: serde_json::Value,  // JSONB column
}
```

## OpenAPI Annotations

```rust
// All public handlers must have #[utoipa::path(...)]
#[utoipa::path(
    get,
    path = "/api/v1/orgs/{org_id}/resources",
    params(("org_id" = Uuid, Path, description = "Organization ID")),
    responses(
        (status = 200, description = "Resource list", body = ResourceListResponse),
        (status = 401, description = "Unauthorized"),
        (status = 403, description = "Forbidden"),
    ),
    security(("bearer_auth" = [])),
    tag = "resources"
)]
pub async fn list_resources(...) -> AppResult<Json<ResourceListResponse>> { ... }

// DTO structs need ToSchema
#[derive(Serialize, Deserialize, utoipa::ToSchema)]
pub struct ResourceListResponse {
    pub data: Vec<ResourceDto>,
    pub total: i64,
}
```

## Logging

```rust
// Use tracing macros with structured fields (JSON in production)
tracing::info!(org_id = %org_id, user_id = %claims.sub, "Resources listed");
tracing::warn!(error = %e, resource_id = %id, "Resource sync failed");
tracing::error!(error = %e, "Unexpected DB error");
// Never log secrets, credentials, or PII
```

## Conventions

- Timestamps: `chrono::Utc::now().timestamp()` → i64 UNIX seconds
- Pagination: `limit: i64` + `offset: i64` query params, default limit=50, max=200
- Multi-tenancy: every query MUST include `WHERE organization_id = $N`
- Partial indexes: queries use `AND deleted_at = 0` matching the index definition
- No `clone()` on large structs in hot paths — prefer references or `Arc`
- Use `#[serde(rename_all = "camelCase")]` on all DTO response structs
