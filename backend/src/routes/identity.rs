//! Identity HTTP endpoints. Authentication is applied once by the parent router.

use crate::{
    modules::{api_keys, auth, notifications},
    state::AppState,
};
use axum::{
    routing::{delete, get, patch, post, put},
    Router,
};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        // These account actions require the caller Claims injected by auth.
        .route("/api/v1/auth/2fa/enroll", post(auth::handlers::enroll_2fa))
        .route("/api/v1/auth/2fa/verify", post(auth::handlers::verify_2fa))
        .route(
            "/api/v1/auth/2fa/disable",
            post(auth::handlers::disable_2fa),
        )
        .route(
            "/api/v1/auth/send-verification",
            post(auth::handlers::send_verification_email),
        )
        .route(
            "/api/v1/auth/accept-invite",
            post(auth::org_handlers::accept_invite),
        )
        .route("/api/v1/auth/me", get(auth::handlers::me))
        .route("/api/v1/auth/logout", post(auth::handlers::logout))
        .route(
            "/api/v1/organizations",
            get(auth::org_handlers::list_orgs).post(auth::org_handlers::create_org),
        )
        .route(
            "/api/v1/organizations/{org_id}",
            get(auth::org_handlers::get_org),
        )
        .route(
            "/api/v1/organizations/{org_id}",
            put(auth::org_handlers::update_org),
        )
        .route(
            "/api/v1/organizations/{org_id}/members",
            get(auth::org_handlers::list_members),
        )
        .route(
            "/api/v1/organizations/{org_id}/members",
            post(auth::org_handlers::invite_member),
        )
        .route(
            "/api/v1/organizations/{org_id}/members/{user_id}",
            delete(auth::org_handlers::remove_member),
        )
        .route(
            "/api/v1/orgs/{org_id}/members/{user_id}/role",
            put(auth::org_handlers::update_member_role),
        )
        .route(
            "/api/v1/orgs/{org_id}/invites",
            get(auth::org_handlers::list_invites).post(auth::org_handlers::create_invite),
        )
        .route(
            "/api/v1/orgs/{org_id}/invites/{invite_id}/revoke",
            post(auth::org_handlers::revoke_invite),
        )
        .route(
            "/api/v1/orgs/{org_id}/api-keys",
            get(api_keys::handlers::list_api_keys).post(api_keys::handlers::create_api_key),
        )
        .route(
            "/api/v1/orgs/{org_id}/api-keys/{key_id}",
            patch(api_keys::handlers::update_api_key).delete(api_keys::handlers::revoke_api_key),
        )
        .route(
            "/api/v1/orgs/{org_id}/notifications",
            get(notifications::handlers::list_notifications)
                .post(notifications::handlers::create_notification_endpoint),
        )
        .route(
            "/api/v1/orgs/{org_id}/notifications/read-all",
            post(notifications::handlers::mark_all_read),
        )
        .route(
            "/api/v1/orgs/{org_id}/notifications/{notification_id}/read",
            patch(notifications::handlers::mark_read),
        )
}
