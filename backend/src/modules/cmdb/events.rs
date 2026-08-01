//! CMDB change event fan-out (gap closure T6).
//!
//! Every CI write path calls [`emit_ci_event`], which:
//! 1. appends a row to the `ci_events` polling stream (cursor-paged via
//!    `GET /orgs/:id/cmdb/events?after=<id>`), and
//! 2. enqueues the event for delivery to active webhooks subscribed to it.

use serde_json::{json, Value};
use uuid::Uuid;

use super::models::Ci;

/// Event types emitted by CI write paths.
pub const EVENT_CI_CREATED: &str = "ci.created";
pub const EVENT_CI_UPDATED: &str = "ci.updated";
pub const EVENT_CI_DELETED: &str = "ci.deleted";
pub const EVENT_CI_LIFECYCLE_CHANGED: &str = "ci.lifecycle_changed";
pub const EVENT_CI_ASSOCIATION_CHANGED: &str = "ci.association_changed";

/// Append to the event stream and enqueue webhook delivery.
///
/// `extra` carries operation-specific fields (e.g. `from_state`/`to_state` for
/// lifecycle changes, the changed-field diff for updates).
pub async fn emit_ci_event(
    db: &sqlx::PgPool,
    org_id: Uuid,
    event_type: &str,
    ci: &Ci,
    extra: Value,
) {
    let payload = json!({
        "ci_id": ci.id,
        "ci_name": ci.name,
        "display_name": ci.display_name,
        "ci_type_id": ci.ci_type_id,
        "lifecycle_state": ci.lifecycle_state,
        "cloud_provider": ci.cloud_provider,
        "cloud_region": ci.cloud_region,
        "extra": extra,
    });

    // 1. Polling stream. Failures are logged and swallowed: an event-stream
    //    hiccup must never fail the business write that triggered it.
    let inserted = sqlx::query(
        r#"INSERT INTO ci_events (organization_id, event_type, ci_id, ci_name, payload)
           VALUES ($1, $2, $3, $4, $5)"#,
    )
    .bind(org_id)
    .bind(event_type)
    .bind(ci.id)
    .bind(ci.name.as_str())
    .bind(&payload)
    .execute(db)
    .await;

    if let Err(e) = inserted {
        tracing::warn!(org_id = %org_id, ci_id = %ci.id, event = event_type, error = %e, "ci_events insert failed");
    }

    // 2. Webhook fan-out.
    crate::modules::webhook::handlers::enqueue_event(db, org_id, event_type, payload).await;
}

/// Variant for deletes: the CI row is soft-deleted by the time we emit, so the
/// payload is assembled from the last-known snapshot instead of a live row.
pub async fn emit_ci_deleted(
    db: &sqlx::PgPool,
    org_id: Uuid,
    ci: &Ci,
) {
    let payload = json!({
        "ci_id": ci.id,
        "ci_name": ci.name,
        "display_name": ci.display_name,
        "ci_type_id": ci.ci_type_id,
        "lifecycle_state": ci.lifecycle_state,
        "cloud_provider": ci.cloud_provider,
        "cloud_region": ci.cloud_region,
        "extra": {},
    });

    let inserted = sqlx::query(
        r#"INSERT INTO ci_events (organization_id, event_type, ci_id, ci_name, payload)
           VALUES ($1, $2, $3, $4, $5)"#,
    )
    .bind(org_id)
    .bind(EVENT_CI_DELETED)
    .bind(ci.id)
    .bind(ci.name.as_str())
    .bind(&payload)
    .execute(db)
    .await;

    if let Err(e) = inserted {
        tracing::warn!(org_id = %org_id, ci_id = %ci.id, error = %e, "ci_events insert failed");
    }

    crate::modules::webhook::handlers::enqueue_event(db, org_id, EVENT_CI_DELETED, payload).await;
}
