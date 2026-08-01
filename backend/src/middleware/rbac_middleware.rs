//! Centralized RBAC enforcement middleware.
//!
//! Runs after `auth_middleware` (claims are in request extensions). Maps
//! (method, path) → required [`Permission`] for every mutating endpoint and
//! rejects with 403 when the caller's role level is insufficient.
//!
//! Route matching is pure ([`required_permission`]) so the map is unit-testable.

use axum::{
    extract::{Request, State},
    http::Method,
    middleware::Next,
    response::Response,
};
use uuid::Uuid;

use crate::{
    error::AppError,
    middleware::rbac::Permission,
    modules::auth::service::Claims,
    state::AppState,
};

/// Map a request (method + path segments) to the permission it requires, or
/// `None` when the route is open to any member.
pub fn required_permission(method: &Method, segments: &[&str]) -> Option<Permission> {
    use Permission::*;

    // Normalize: find the org segment (orgs/:org_id/... or organizations/:org_id/...)
    let org_idx = segments
        .iter()
        .position(|s| *s == "orgs" || *s == "organizations")?;
    let after_org = org_idx + 2; // index of the first segment after the org id
    let rest = if after_org <= segments.len() {
        &segments[after_org..]
    } else {
        &[]
    };
    let resource = rest.first().copied().unwrap_or("");

    let mutating = matches!(method, &Method::POST | &Method::PUT | &Method::PATCH | &Method::DELETE);

    // Org-level mutation with no resource segment: PUT /organizations/:org_id
    // (creating an org at POST /organizations is open to any member).
    if resource.is_empty()
        && segments[org_idx] == "organizations"
        && after_org == segments.len()
        && mutating
    {
        return Some(AdminOrg);
    }

    match resource {
        // ── Organization administration ─────────────────────────────────────
        "members" if mutating => Some(AdminOrg), // invite / remove / role
        "cost-centers" if mutating => Some(AdminOrg),

        // ── Pools & budgets ─────────────────────────────────────────────────
        "pools" | "budgets" if mutating => Some(ManagePools),
        "alerts" | "alert-events" if mutating => Some(ManagePools),

        // ── Cloud accounts & billing ────────────────────────────────────────
        "cloud-accounts" if mutating => Some(ManageCloudAccounts),
        "billing" if mutating => Some(ManageCloudAccounts), // import
        "power-schedules" if mutating => Some(ManageCloudAccounts),
        "k8s" if mutating => Some(ManageCloudAccounts),
        "resources" if mutating => Some(ManagePools), // pool/tags patches
        "shared-environments" if mutating => Some(ManagePools), // book/release/delete

        // ── CMDB ────────────────────────────────────────────────────────────
        "cis" | "ci-types" | "ci-classifications" | "ci-association-kinds"
        | "ci-object-associations" | "ci-groups" | "services" | "compliance-policies"
        | "ci-baselines" | "external-cmdb" | "service-templates" | "ci-apply-rules"
            if mutating =>
        {
            Some(ManageCmdb)
        }
        "cmdb" if mutating => Some(ManageCmdb), // discovery, stats
        "ci-drift" if rest.get(2).copied() == Some("acknowledge") => Some(ManageCmdb),
        "compliance" if mutating => Some(ManageCmdb), // run

        // ── FinOps governance ───────────────────────────────────────────────
        "rules" | "assignment-rules" if mutating => Some(ManageRules),
        "constraints" if mutating => Some(ManageRules),
        "tagging-policies" if mutating => Some(ManageRules),
        "lifecycle-policies" if mutating => Some(ManageRules),
        "recommendations" if mutating => Some(ManageRules), // dismiss/reactivate/run/checklist-patch

        // ── Webhooks & integrations ─────────────────────────────────────────
        "webhooks" | "integrations" if mutating => Some(ManageWebhooks),

        _ => None,
    }
}

/// Extract the org id from `/api/v1/orgs/:org_id/...` or
/// `/api/v1/organizations/:org_id/...`.
fn org_id_from_segments(segments: &[&str]) -> Option<Uuid> {
    let idx = segments
        .iter()
        .position(|s| *s == "orgs" || *s == "organizations")?;
    segments
        .get(idx + 1)
        .and_then(|s| Uuid::parse_str(s).ok())
}

/// RBAC middleware: 403 when the caller's role cannot perform the mutation.
pub async fn rbac_middleware(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let claims = req
        .extensions()
        .get::<Claims>()
        .cloned()
        .ok_or_else(|| AppError::Unauthorized("Missing claims".into()))?;

    let path = req.uri().path();
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    if let Some(permission) = required_permission(req.method(), &segments) {
        if let Some(org_id) = org_id_from_segments(&segments) {
            crate::middleware::rbac::require_permission(
                &state.db,
                claims.user_id()?,
                org_id,
                permission,
            )
            .await?;
        }
    }

    Ok(next.run(req).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segs(path: &str) -> Vec<&str> {
        path.split('/').filter(|s| !s.is_empty()).collect()
    }

    #[test]
    fn admin_org_endpoints() {
        let path = segs("/api/v1/organizations/org-1");
        assert_eq!(
            required_permission(&Method::PUT, &path),
            Some(Permission::AdminOrg)
        );
        assert_eq!(
            required_permission(&Method::GET, &path),
            None,
            "GET is read-only"
        );
        let members = segs("/api/v1/orgs/org-1/members");
        assert_eq!(
            required_permission(&Method::POST, &members),
            Some(Permission::AdminOrg)
        );
    }

    #[test]
    fn pools_and_budgets() {
        let pools = segs("/api/v1/orgs/org-1/pools");
        assert_eq!(
            required_permission(&Method::POST, &pools),
            Some(Permission::ManagePools)
        );
        assert_eq!(required_permission(&Method::GET, &pools), None);
    }

    #[test]
    fn cmdb_mutations() {
        let cis = segs("/api/v1/orgs/org-1/cis");
        assert_eq!(
            required_permission(&Method::POST, &cis),
            Some(Permission::ManageCmdb)
        );
        let ci_delete = segs("/api/v1/orgs/org-1/cis/abc-123");
        assert_eq!(
            required_permission(&Method::DELETE, &ci_delete),
            Some(Permission::ManageCmdb)
        );
        let drift_ack = segs("/api/v1/orgs/org-1/ci-drift/abc/acknowledge");
        assert_eq!(
            required_permission(&Method::POST, &drift_ack),
            Some(Permission::ManageCmdb)
        );
    }

    #[test]
    fn governance_and_webhooks() {
        let rules = segs("/api/v1/orgs/org-1/rules");
        assert_eq!(
            required_permission(&Method::POST, &rules),
            Some(Permission::ManageRules)
        );
        let webhooks = segs("/api/v1/orgs/org-1/webhooks");
        assert_eq!(
            required_permission(&Method::POST, &webhooks),
            Some(Permission::ManageWebhooks)
        );
        let webhook_events = segs("/api/v1/orgs/org-1/webhook-events");
        assert_eq!(required_permission(&Method::GET, &webhook_events), None);
    }

    #[test]
    fn read_endpoints_are_open() {
        for path in [
            "/api/v1/orgs/org-1/expenses/summary",
            "/api/v1/orgs/org-1/recommendations",
            "/api/v1/orgs/org-1/resources",
            "/api/v1/orgs/org-1/events",
            "/api/v1/orgs/org-1/ai/copilot/chat",
        ] {
            assert_eq!(
                required_permission(&Method::GET, &segs(path)),
                None,
                "{path}"
            );
        }
    }

    #[test]
    fn org_id_extraction() {
        assert_eq!(
            org_id_from_segments(&segs("/api/v1/orgs/org-1/pools")),
            None,
            "non-uuid org id is skipped (middleware falls back to handler checks)"
        );
    }
}
