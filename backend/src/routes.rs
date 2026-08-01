use axum::{
    middleware,
    routing::{delete, get, patch, post, put},
    Router,
};
use tower_http::{
    compression::CompressionLayer,
    cors::{Any, CorsLayer},
    request_id::{MakeRequestUuid, SetRequestIdLayer},
    timeout::TimeoutLayer,
    trace::TraceLayer,
};
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

use crate::{
    metrics::{metrics_handler, metrics_middleware},
    middleware::auth::auth_middleware,
    middleware::rate_limit::rate_limit_middleware,
    middleware::rbac_middleware::rbac_middleware,
    middleware::security_headers::security_headers_middleware,
    modules::{ai, alert, api_keys, auth, bi_export, billing, cloud, cmdb, constraints, expense, health, integrations, jobs, k8s, lifecycle, notifications, power_schedule, recommendation, resources, rules, shared_env, tagging, webhook},
    state::AppState,
};

pub fn build_router(state: AppState) -> Router {
    // CORS — restricted to the origins configured via CORS_ALLOWED_ORIGINS.
    let origins: Vec<axum::http::HeaderValue> = state
        .config
        .cors_origins
        .iter()
        .filter_map(|o| axum::http::HeaderValue::from_str(o).ok())
        .collect();
    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods(Any)
        .allow_headers(Any);

    // Public routes (no auth)
    let public = Router::new()
        .route("/health",       get(health::liveness))
        .route("/health/ready", get(health::readiness))
        .route("/metrics",      get(metrics_handler))
        .route("/api/v1/auth/register", post(auth::handlers::register))
        .route("/api/v1/auth/login",    post(auth::handlers::login))
        .route("/api/v1/auth/refresh",  post(auth::handlers::refresh_token))
        .route("/api/v1/auth/2fa/enroll",   post(auth::handlers::enroll_2fa))
        .route("/api/v1/auth/2fa/verify",   post(auth::handlers::verify_2fa))
        .route("/api/v1/auth/2fa/disable",  post(auth::handlers::disable_2fa))
        .route("/api/v1/auth/forgot-password",  post(auth::handlers::forgot_password))
        .route("/api/v1/auth/reset-password",   post(auth::handlers::reset_password))
        .route("/api/v1/auth/verify-email",     post(auth::handlers::verify_email))
        .route("/api/v1/auth/send-verification", post(auth::handlers::send_verification_email))
        .route("/api/v1/auth/oidc/config",   get(auth::oidc::oidc_config))
        .route("/api/v1/auth/oidc/start",    get(auth::oidc::oidc_start))
        .route("/api/v1/auth/oidc/callback", get(auth::oidc::oidc_callback))
        .route("/api/v1/auth/accept-invite",  post(auth::org_handlers::accept_invite));

    // Protected routes (require JWT)
    let protected = Router::new()
        // Auth
        .route("/api/v1/auth/me",     get(auth::handlers::me))
        .route("/api/v1/auth/logout", post(auth::handlers::logout))
        // Organizations
        .route("/api/v1/organizations",                            get(auth::org_handlers::list_orgs).post(auth::org_handlers::create_org))
        .route("/api/v1/organizations/:org_id",                    get(auth::org_handlers::get_org))
        .route("/api/v1/organizations/:org_id",                    put(auth::org_handlers::update_org))
        .route("/api/v1/organizations/:org_id/members",            get(auth::org_handlers::list_members))
        .route("/api/v1/organizations/:org_id/members",            post(auth::org_handlers::invite_member))
        .route("/api/v1/organizations/:org_id/members/:user_id",   delete(auth::org_handlers::remove_member))
        .route("/api/v1/orgs/:org_id/members/:user_id/role",       put(auth::org_handlers::update_member_role))
        .route("/api/v1/orgs/:org_id/invites",                      get(auth::org_handlers::list_invites).post(auth::org_handlers::create_invite))
        .route("/api/v1/orgs/:org_id/invites/:invite_id/revoke",    post(auth::org_handlers::revoke_invite))
        // Cloud Accounts
        .route("/api/v1/orgs/:org_id/cloud-accounts",              get(cloud::handlers::list_accounts))
        .route("/api/v1/orgs/:org_id/cloud-accounts",              post(cloud::handlers::create_account))
        .route("/api/v1/orgs/:org_id/cloud-accounts/:id",          get(cloud::handlers::get_account))
        .route("/api/v1/orgs/:org_id/cloud-accounts/:id",          put(cloud::handlers::update_account))
        .route("/api/v1/orgs/:org_id/cloud-accounts/:id",          delete(cloud::handlers::delete_account))
        .route("/api/v1/orgs/:org_id/cloud-accounts/:id/test",     post(cloud::handlers::test_connection))
        .route("/api/v1/orgs/:org_id/cloud-accounts/:id/sync",     post(cloud::handlers::trigger_sync))
        .route("/api/v1/orgs/:org_id/cloud-accounts/:id/sync-jobs", get(cloud::handlers::list_sync_jobs))
        // Expenses
        .route("/api/v1/orgs/:org_id/expenses",                    get(expense::handlers::list_expenses))
        .route("/api/v1/orgs/:org_id/expenses/summary",            get(expense::handlers::summary))
        .route("/api/v1/orgs/:org_id/expenses/by-cloud",           get(expense::handlers::by_cloud))
        .route("/api/v1/orgs/:org_id/expenses/by-pool",            get(expense::handlers::by_pool))
        .route("/api/v1/orgs/:org_id/expenses/by-region",          get(expense::handlers::by_region))
        .route("/api/v1/orgs/:org_id/expenses/by-service",         get(expense::handlers::by_service))
        .route("/api/v1/orgs/:org_id/expenses/trend",              get(expense::handlers::trend))
        .route("/api/v1/orgs/:org_id/expenses/top-resources",      get(expense::handlers::top_resources))
        .route("/api/v1/orgs/:org_id/expenses/forecast",           get(expense::handlers::forecast_expenses))
        .route("/api/v1/orgs/:org_id/expenses/anomalies",          get(expense::handlers::expense_anomalies))
        .route("/api/v1/orgs/:org_id/expenses/export",             get(expense::handlers::export_expenses))
        .route("/api/v1/orgs/:org_id/expenses/heatmap",            get(expense::handlers::expense_heatmap))
        .route("/api/v1/orgs/:org_id/expenses/by-tag-breakdown",   get(expense::handlers::expenses_by_tag_breakdown))
        .route("/api/v1/orgs/:org_id/expenses/resources/:resource_id/history", get(expense::handlers::resource_expense_history))
        .route("/api/v1/orgs/:org_id/ri-coverage",                 get(expense::handlers::ri_coverage))
        .route("/api/v1/orgs/:org_id/showback",                    get(expense::handlers::showback_report))
        .route("/api/v1/orgs/:org_id/expenses/cost-map",          get(expense::handlers::cost_map))
        .route("/api/v1/orgs/:org_id/expenses/unit-economics",    get(expense::handlers::unit_economics))
        .route("/api/v1/orgs/:org_id/expenses/region-expenses",   get(expense::handlers::region_expenses))
        // Pools
        .route("/api/v1/orgs/:org_id/pools",                       get(expense::pool_handlers::list_pools))
        .route("/api/v1/orgs/:org_id/pools",                       post(expense::pool_handlers::create_pool))
        .route("/api/v1/orgs/:org_id/pools/tree",                  get(expense::pool_handlers::get_pool_tree))
        .route("/api/v1/orgs/:org_id/pools/budget-matrix",        get(expense::pool_handlers::budget_matrix))
        .route("/api/v1/orgs/:org_id/pools/:id",                   get(expense::pool_handlers::get_pool))
        .route("/api/v1/orgs/:org_id/pools/:id",                   put(expense::pool_handlers::update_pool))
        .route("/api/v1/orgs/:org_id/pools/:id",                   delete(expense::pool_handlers::delete_pool))
        .route("/api/v1/orgs/:org_id/pools/:id/trend",             get(expense::pool_handlers::pool_expense_trend))
        .route("/api/v1/orgs/:org_id/pools/:id/top-resources",     get(expense::pool_handlers::pool_top_resources))
        .route("/api/v1/orgs/:org_id/pools/:id/parent",            patch(expense::pool_handlers::move_pool))
        // Cost Centers
        .route("/api/v1/orgs/:org_id/cost-centers",                get(expense::cost_center_handlers::list_cost_centers))
        .route("/api/v1/orgs/:org_id/cost-centers",                post(expense::cost_center_handlers::create_cost_center))
        .route("/api/v1/cost-centers/:id",                         get(expense::cost_center_handlers::get_cost_center))
        .route("/api/v1/cost-centers/:id",                         put(expense::cost_center_handlers::update_cost_center))
        .route("/api/v1/cost-centers/:id",                         delete(expense::cost_center_handlers::delete_cost_center))
        .route("/api/v1/cost-centers/:id/expenses",                get(expense::cost_center_handlers::cost_center_expenses))
        // Business Capabilities (T17)
        .route("/api/v1/orgs/:org_id/business-capabilities",       get(expense::cost_center_handlers::list_business_capabilities).post(expense::cost_center_handlers::create_business_capability))
        .route("/api/v1/business-capabilities/:id",                put(expense::cost_center_handlers::update_business_capability).delete(expense::cost_center_handlers::delete_business_capability))
        .route("/api/v1/orgs/:org_id/ci-types/:type_id/attributes",            get(cmdb::handlers::list_ci_attributes).post(cmdb::handlers::create_ci_attribute))
        .route("/api/v1/orgs/:org_id/ci-types/:type_id/attributes/:attr_id",   delete(cmdb::handlers::delete_ci_attribute))
        // CMDB — Unique Constraints (T2)
        .route("/api/v1/orgs/:org_id/ci-types/:type_id/unique-constraints",   get(cmdb::model_handlers::list_unique_constraints).post(cmdb::model_handlers::create_unique_constraint))
        .route("/api/v1/orgs/:org_id/unique-constraints/:id",                 delete(cmdb::model_handlers::delete_unique_constraint))
        // CMDB — Association metadata
        .route("/api/v1/orgs/:org_id/ci-association-kinds",                    get(cmdb::handlers::list_ci_association_kinds))
        .route("/api/v1/orgs/:org_id/ci-object-associations",                  get(cmdb::handlers::list_ci_object_associations))
        // CMDB — CI Types
        .route("/api/v1/orgs/:org_id/ci-types",                    get(cmdb::handlers::list_ci_types))
        .route("/api/v1/orgs/:org_id/ci-types",                    post(cmdb::handlers::create_ci_type))
        .route("/api/v1/orgs/:org_id/ci-types/:id",                get(cmdb::handlers::get_ci_type))
        .route("/api/v1/orgs/:org_id/ci-types/:id",                put(cmdb::handlers::update_ci_type))
        .route("/api/v1/orgs/:org_id/ci-types/:id",                delete(cmdb::handlers::delete_ci_type))
        // CMDB — CIs
        .route("/api/v1/orgs/:org_id/cis",                         get(cmdb::handlers::list_cis))
        .route("/api/v1/orgs/:org_id/cis",                         post(cmdb::handlers::create_ci))
        .route("/api/v1/orgs/:org_id/cis/:id",                     get(cmdb::handlers::get_ci))
        .route("/api/v1/orgs/:org_id/cis/:id",                     put(cmdb::handlers::update_ci))
        .route("/api/v1/orgs/:org_id/cis/:id",                     delete(cmdb::handlers::delete_ci))
        .route("/api/v1/orgs/:org_id/cis/:id/associations",        get(cmdb::handlers::list_associations))
        .route("/api/v1/orgs/:org_id/cis/:id/associations",        post(cmdb::handlers::create_association))
        .route("/api/v1/orgs/:org_id/cis/:ci_id/associations/:assoc_id", delete(cmdb::handlers::delete_association))
        .route("/api/v1/orgs/:org_id/cis/:id/history",             get(cmdb::handlers::ci_history))
        .route("/api/v1/orgs/:org_id/cis/:id/topology",            get(cmdb::handlers::ci_topology))
        .route("/api/v1/orgs/:org_id/cis/:id/impact",              get(cmdb::handlers::ci_impact))
        .route("/api/v1/orgs/:org_id/cis/:ci_id/tags",             patch(cmdb::handlers::patch_ci_tags))
        .route("/api/v1/orgs/:org_id/cis/:id/lifecycle",           patch(cmdb::handlers::transition_ci_lifecycle))
        // CMDB — Events / Import / Export (T6/T7)
        .route("/api/v1/orgs/:org_id/cmdb/events",                 get(cmdb::analytics_handlers::list_ci_events))
        .route("/api/v1/orgs/:org_id/ci-types/:type_id/import-template", get(cmdb::import_export::ci_import_template))
        .route("/api/v1/orgs/:org_id/cis/import",                  post(cmdb::import_export::cis_import_csv))
        .route("/api/v1/orgs/:org_id/cis/export",                  get(cmdb::import_export::cis_export_csv))
        .route("/api/v1/orgs/:org_id/cis/search",                  get(cmdb::handlers::search_cis))
        .route("/api/v1/orgs/:org_id/cis/batch-update",            post(cmdb::handlers::batch_update_cis))
        .route("/api/v1/orgs/:org_id/cis/batch-delete",            post(cmdb::handlers::batch_delete_cis))
        .route("/api/v1/orgs/:org_id/cis/:id/clone",               post(cmdb::handlers::clone_ci))
        // CMDB — Field template binding & CI forest (T10/T11)
        .route("/api/v1/orgs/:org_id/field-templates/:id/bind",    post(cmdb::model_handlers::bind_field_template))
        .route("/api/v1/orgs/:org_id/field-templates/:id/unbind",  delete(cmdb::model_handlers::unbind_field_template))
        .route("/api/v1/orgs/:org_id/field-templates/:id/types",   get(cmdb::model_handlers::field_template_bound_types))
        .route("/api/v1/orgs/:org_id/field-templates/:id/diff/:type_id", get(cmdb::model_handlers::field_template_diff))
        .route("/api/v1/orgs/:org_id/field-templates/:id/apply",   post(cmdb::model_handlers::apply_field_template))
        .route("/api/v1/orgs/:org_id/ci-forest",                   get(cmdb::handlers::ci_forest))
        // CMDB — Dynamic Groups
        .route("/api/v1/orgs/:org_id/ci-groups",                   get(cmdb::handlers::list_dynamic_groups))
        .route("/api/v1/orgs/:org_id/ci-groups",                   post(cmdb::handlers::create_dynamic_group))
        .route("/api/v1/orgs/:org_id/ci-groups/:id",               put(cmdb::handlers::update_dynamic_group))
        .route("/api/v1/orgs/:org_id/ci-groups/:id",               delete(cmdb::handlers::delete_dynamic_group))
        .route("/api/v1/orgs/:org_id/ci-groups/:id/execute",       post(cmdb::handlers::execute_dynamic_group))
        // CMDB — Audit Logs
        .route("/api/v1/orgs/:org_id/cmdb/audit-logs",             get(cmdb::analytics_handlers::list_cmdb_audit_logs))
        // CMDB — Services
        .route("/api/v1/orgs/:org_id/services",                    get(cmdb::service_handlers::list_services))
        .route("/api/v1/orgs/:org_id/services",                    post(cmdb::service_handlers::create_service))
        .route("/api/v1/orgs/:org_id/services/:id",                get(cmdb::service_handlers::get_service))
        .route("/api/v1/orgs/:org_id/services/:id",                put(cmdb::service_handlers::update_service))
        .route("/api/v1/orgs/:org_id/services/:id",                delete(cmdb::service_handlers::delete_service))
        .route("/api/v1/orgs/:org_id/services/:id/cis",            get(cmdb::service_handlers::list_service_cis))
        .route("/api/v1/orgs/:org_id/services/:id/cis",            post(cmdb::service_handlers::add_service_ci))
        .route("/api/v1/orgs/:org_id/services/:id/cis/:ci_id",     delete(cmdb::service_handlers::remove_service_ci))
        .route("/api/v1/orgs/:org_id/services/:id/costs",          get(cmdb::service_handlers::get_service_costs))
        // Recommendations
        .route("/api/v1/orgs/:org_id/recommendations",             get(recommendation::handlers::list))
        .route("/api/v1/orgs/:org_id/recommendations/summary",     get(recommendation::handlers::summary))
        .route("/api/v1/orgs/:org_id/recommendations/checklist",   get(recommendation::handlers::checklist_status))
        .route("/api/v1/orgs/:org_id/recommendations/checklist",   patch(recommendation::handlers::patch_checklist_modules))
        .route("/api/v1/orgs/:org_id/recommendations/run",         post(recommendation::handlers::trigger_run))
        .route("/api/v1/orgs/:org_id/recommendations/:id",         get(recommendation::handlers::get))
        .route("/api/v1/orgs/:org_id/recommendations/:id/dismiss",     post(recommendation::handlers::dismiss))
        .route("/api/v1/orgs/:org_id/recommendations/:id/reactivate",  post(recommendation::handlers::reactivate))
        .route("/api/v1/orgs/:org_id/recommendations/:id/apply",     post(recommendation::handlers::apply_recommendation))
        .route("/api/v1/orgs/:org_id/recommendations/:id/verify",    post(recommendation::handlers::verify_recommendation))
        // Alerts
        .route("/api/v1/orgs/:org_id/alerts",                      get(alert::handlers::list_alerts))
        .route("/api/v1/orgs/:org_id/alerts",                      post(alert::handlers::create_alert))
        .route("/api/v1/orgs/:org_id/alerts/evaluate",             post(alert::handlers::evaluate_alerts))
        .route("/api/v1/orgs/:org_id/alerts/:id",                  put(alert::handlers::update_alert).delete(alert::handlers::delete_alert))
        .route("/api/v1/orgs/:org_id/events",                      get(alert::handlers::list_events))
        .route("/api/v1/orgs/:org_id/alert-events",                get(alert::handlers::list_alert_events))
        // Webhooks
        .route("/api/v1/orgs/:org_id/webhooks",                    get(webhook::handlers::list_webhooks))
        .route("/api/v1/orgs/:org_id/webhooks",                    post(webhook::handlers::create_webhook))
        .route("/api/v1/orgs/:org_id/webhooks/:id",                put(webhook::handlers::update_webhook))
        .route("/api/v1/orgs/:org_id/webhooks/:id",                delete(webhook::handlers::delete_webhook))
        .route("/api/v1/orgs/:org_id/webhook-events",              get(webhook::handlers::list_webhook_events))
        // Assignment Rules
        .route("/api/v1/orgs/:org_id/assignment-rules",            get(rules::handlers::list_rules))
        .route("/api/v1/orgs/:org_id/assignment-rules",            post(rules::handlers::create_rule))
        .route("/api/v1/orgs/:org_id/assignment-rules/apply",      post(rules::handlers::apply_rules))
        .route("/api/v1/orgs/:org_id/assignment-rules/:id",        put(rules::handlers::update_rule))
        .route("/api/v1/orgs/:org_id/assignment-rules/:id",        delete(rules::handlers::delete_rule))
        // Constraints
        .route("/api/v1/orgs/:org_id/constraints",                 get(constraints::handlers::list_constraints))
        .route("/api/v1/orgs/:org_id/constraints",                 post(constraints::handlers::create_constraint))
        .route("/api/v1/orgs/:org_id/constraints/evaluate",        post(constraints::handlers::evaluate_constraints))
        .route("/api/v1/orgs/:org_id/constraints/:id",             put(constraints::handlers::update_constraint))
        .route("/api/v1/orgs/:org_id/constraints/:id",             delete(constraints::handlers::delete_constraint))
        // Power Schedules
        .route("/api/v1/orgs/:org_id/power-schedules",             get(power_schedule::handlers::list_schedules))
        .route("/api/v1/orgs/:org_id/power-schedules",             post(power_schedule::handlers::create_schedule))
        .route("/api/v1/orgs/:org_id/power-schedules/:id",         put(power_schedule::handlers::update_schedule))
        .route("/api/v1/orgs/:org_id/power-schedules/:id",         delete(power_schedule::handlers::delete_schedule))
        .route("/api/v1/orgs/:org_id/power-schedules/:id/triggers", get(power_schedule::handlers::list_triggers))
        .route("/api/v1/orgs/:org_id/power-schedules/:id/triggers", post(power_schedule::handlers::create_trigger))
        .route("/api/v1/orgs/:org_id/power-schedules/:id/triggers/:trigger_id", delete(power_schedule::handlers::delete_trigger))
        // Tagging
        .route("/api/v1/orgs/:org_id/tagging-policies",            get(tagging::handlers::list_policies))
        .route("/api/v1/orgs/:org_id/tagging-policies",            post(tagging::handlers::create_policy))
        .route("/api/v1/orgs/:org_id/tagging-policies/:id",        put(tagging::handlers::update_policy))
        .route("/api/v1/orgs/:org_id/tagging-policies/:id",        delete(tagging::handlers::delete_policy))
        .route("/api/v1/orgs/:org_id/expenses/by-tag",             get(tagging::handlers::expenses_by_tag))
        .route("/api/v1/orgs/:org_id/tagging/coverage",            get(tagging::handlers::tag_coverage_analysis))
        // CMDB — Compliance
        .route("/api/v1/orgs/:org_id/compliance-policies",         get(cmdb::compliance_handlers::list_compliance_policies))
        .route("/api/v1/orgs/:org_id/compliance-policies",         post(cmdb::compliance_handlers::create_compliance_policy))
        .route("/api/v1/orgs/:org_id/compliance-policies/:id",     put(cmdb::compliance_handlers::update_compliance_policy).delete(cmdb::compliance_handlers::delete_compliance_policy))
        .route("/api/v1/orgs/:org_id/compliance/run",              post(cmdb::compliance_handlers::run_compliance_check))
        .route("/api/v1/orgs/:org_id/compliance/results",          get(cmdb::compliance_handlers::list_compliance_results))
        .route("/api/v1/orgs/:org_id/compliance/last-run",          get(cmdb::compliance_handlers::compliance_last_run))
        // CMDB — Baselines & Drift
        .route("/api/v1/orgs/:org_id/ci-baselines",                get(cmdb::compliance_handlers::list_baselines))
        .route("/api/v1/orgs/:org_id/ci-baselines",                post(cmdb::compliance_handlers::create_baseline))
        .route("/api/v1/orgs/:org_id/ci-drift",                    get(cmdb::compliance_handlers::list_drift))
        .route("/api/v1/orgs/:org_id/ci-drift/:id/acknowledge",    post(cmdb::compliance_handlers::acknowledge_drift))
        .route("/api/v1/orgs/:org_id/ci-drift/:id/resolve",        post(cmdb::compliance_handlers::resolve_drift))
        .route("/api/v1/orgs/:org_id/ci-drift/:id/ignore",         post(cmdb::compliance_handlers::ignore_drift))
        // CMDB — Discovery
        .route("/api/v1/orgs/:org_id/cmdb/discovery",              post(cmdb::compliance_handlers::trigger_discovery))
        // CMDB — External CMDB
        .route("/api/v1/orgs/:org_id/external-cmdb",               get(cmdb::compliance_handlers::list_external_cmdb))
        .route("/api/v1/orgs/:org_id/external-cmdb",               post(cmdb::compliance_handlers::create_external_cmdb))
        .route("/api/v1/orgs/:org_id/external-cmdb/:id/sync",      post(cmdb::external_sync::trigger_external_sync))
        .route("/api/v1/orgs/:org_id/external-cmdb/:id/dry-run",   get(cmdb::external_sync::external_sync_dry_run))
        .route("/api/v1/orgs/:org_id/external-cmdb/:id/logs",      get(cmdb::external_sync::external_sync_logs))
        // CMDB — CI Classifications
        .route("/api/v1/orgs/:org_id/ci-classifications",                      get(cmdb::classification_handlers::list_ci_classifications))
        .route("/api/v1/orgs/:org_id/ci-classifications",                      post(cmdb::classification_handlers::create_ci_classification))
        .route("/api/v1/orgs/:org_id/ci-classifications/:id",                  put(cmdb::classification_handlers::update_ci_classification))
        .route("/api/v1/orgs/:org_id/ci-classifications/:id",                  delete(cmdb::classification_handlers::delete_ci_classification))
        // CMDB — Association Kinds (CRUD — extends the existing list-only route)
        .route("/api/v1/orgs/:org_id/ci-association-kinds",                    post(cmdb::association_handlers::create_association_kind))
        .route("/api/v1/orgs/:org_id/ci-association-kinds/:id",                put(cmdb::association_handlers::update_association_kind))
        .route("/api/v1/orgs/:org_id/ci-association-kinds/:id",                delete(cmdb::association_handlers::delete_association_kind))
        // CMDB — Object Associations (CI Type ↔ CI Type via kind)
        .route("/api/v1/orgs/:org_id/ci-object-associations",                  post(cmdb::association_handlers::create_object_association))
        .route("/api/v1/orgs/:org_id/ci-object-associations/:id",              delete(cmdb::association_handlers::delete_object_association))
        // CMDB — Analytics (stats, model topology, bulk import)
        .route("/api/v1/orgs/:org_id/cmdb/stats",                              get(cmdb::analytics_handlers::cmdb_stats))
        .route("/api/v1/orgs/:org_id/cmdb/stats/trends",                       get(cmdb::analytics_handlers::cmdb_stats_trends))
        .route("/api/v1/orgs/:org_id/cmdb/model-topology",                     get(cmdb::analytics_handlers::model_topology))
        .route("/api/v1/orgs/:org_id/cis/bulk-import",                         post(cmdb::analytics_handlers::bulk_import_cis))
        // CMDB — Service Templates
        .route("/api/v1/orgs/:org_id/service-templates",                       get(cmdb::model_handlers::list_service_templates))
        .route("/api/v1/orgs/:org_id/service-templates",                       post(cmdb::model_handlers::create_service_template))
        .route("/api/v1/orgs/:org_id/service-templates/:id",                   get(cmdb::model_handlers::get_service_template))
        .route("/api/v1/orgs/:org_id/service-templates/:id",                   put(cmdb::model_handlers::update_service_template))
        .route("/api/v1/orgs/:org_id/service-templates/:id",                   delete(cmdb::model_handlers::delete_service_template))
        .route("/api/v1/orgs/:org_id/service-templates/:id/items",             post(cmdb::model_handlers::add_template_item))
        .route("/api/v1/orgs/:org_id/service-templates/:id/items/:item_id",    delete(cmdb::model_handlers::remove_template_item))
        // CMDB — CI Apply Rules (Host Apply)
        .route("/api/v1/orgs/:org_id/ci-apply-rules",                          get(cmdb::model_handlers::list_ci_apply_rules))
        .route("/api/v1/orgs/:org_id/ci-apply-rules",                          post(cmdb::model_handlers::create_ci_apply_rule))
        .route("/api/v1/orgs/:org_id/ci-apply-rules/:id",                      put(cmdb::model_handlers::update_ci_apply_rule))
        .route("/api/v1/orgs/:org_id/ci-apply-rules/:id",                      delete(cmdb::model_handlers::delete_ci_apply_rule))
        .route("/api/v1/orgs/:org_id/ci-apply-rules/:id/execute",              post(cmdb::model_handlers::execute_ci_apply_rule))
        // CMDB — Field Templates
        .route("/api/v1/orgs/:org_id/field-templates",                         get(cmdb::model_handlers::list_field_templates))
        .route("/api/v1/orgs/:org_id/field-templates",                         post(cmdb::model_handlers::create_field_template))
        .route("/api/v1/orgs/:org_id/field-templates/:id",                     put(cmdb::model_handlers::update_field_template))
        .route("/api/v1/orgs/:org_id/field-templates/:id",                     delete(cmdb::model_handlers::delete_field_template))
        // Billing import
        .route("/api/v1/orgs/:org_id/billing/import",              post(billing::handlers::trigger_import))
        .route("/api/v1/orgs/:org_id/billing/history",             get(billing::handlers::list_import_history))
        // Currency FX rates
        .route("/api/v1/orgs/:org_id/exchange-rates",              get(billing::handlers::list_exchange_rates).put(billing::handlers::upsert_exchange_rates))
        // BI Export
        .route("/api/v1/orgs/:org_id/bi-exports",                  get(bi_export::handlers::list_exports).post(bi_export::handlers::create_export))
        .route("/api/v1/orgs/:org_id/bi-exports/:id",              put(bi_export::handlers::update_export).delete(bi_export::handlers::delete_export))
        .route("/api/v1/orgs/:org_id/bi-exports/:id/run",          post(bi_export::handlers::run_export))
        .route("/api/v1/orgs/:org_id/bi-exports/:id/runs",         get(bi_export::handlers::list_runs))
        .route("/api/v1/orgs/:org_id/bi-exports/:id/download",     get(bi_export::handlers::download_run))
        // Integrations
        .route("/api/v1/orgs/:org_id/integrations",                get(integrations::handlers::list_integrations).post(integrations::handlers::create_integration))
        .route("/api/v1/orgs/:org_id/integrations/:id",            put(integrations::handlers::update_integration).delete(integrations::handlers::delete_integration))
        .route("/api/v1/orgs/:org_id/integrations/:id/test",       post(integrations::handlers::test_integration))
        // AI features
        .route("/api/v1/orgs/:org_id/ai/settings",                get(ai::handlers::get_ai_settings).put(ai::handlers::update_ai_settings))
        .route("/api/v1/orgs/:org_id/ai/provider",               get(ai::handlers::get_ai_provider).put(ai::handlers::update_ai_provider))
        .route("/api/v1/orgs/:org_id/ai/provider/test",          post(ai::handlers::test_ai_provider))
        .route("/api/v1/orgs/:org_id/ai/chat",                    post(ai::handlers::chat))
        .route("/api/v1/orgs/:org_id/ai/explain/:rec_id",         post(ai::handlers::explain_recommendation))
        .route("/api/v1/orgs/:org_id/ai/forecast",                post(ai::handlers::forecast))
        .route("/api/v1/orgs/:org_id/ai/anomalies",               post(ai::handlers::anomalies))
        .route("/api/v1/orgs/:org_id/ai/notes",                   get(ai::handlers::list_notes).post(ai::handlers::create_note))
        .route("/api/v1/orgs/:org_id/ai/notes/search",            post(ai::handlers::search_notes))
        .route("/api/v1/orgs/:org_id/ai/copilot/chat",            post(ai::handlers::chat_copilot))
        .route("/api/v1/orgs/:org_id/ai/conversations",           get(ai::handlers::list_conversations).post(ai::handlers::create_conversation))
        .route("/api/v1/orgs/:org_id/ai/conversations/:conv_id",  delete(ai::handlers::delete_conversation))
        .route("/api/v1/orgs/:org_id/ai/conversations/:conv_id/messages", get(ai::handlers::list_conversation_messages))
        .route("/api/v1/orgs/:org_id/ai/anomalies/:event_id/explain", post(ai::handlers::explain_anomaly))
        .route("/api/v1/orgs/:org_id/ai/analysis-runs",           get(ai::handlers::list_analysis_runs))
        .route("/api/v1/orgs/:org_id/ai/resources/embed",         post(ai::handlers::embed_resources))
        .route("/api/v1/orgs/:org_id/ai/resources/search",        get(ai::handlers::search_resources))
        // API keys (I1)
        .route("/api/v1/orgs/:org_id/api-keys",                     get(api_keys::handlers::list_api_keys).post(api_keys::handlers::create_api_key))
        .route("/api/v1/orgs/:org_id/api-keys/:key_id",             patch(api_keys::handlers::update_api_key).delete(api_keys::handlers::revoke_api_key))
        // Notifications inbox (G11)
        .route("/api/v1/orgs/:org_id/notifications",              get(notifications::handlers::list_notifications).post(notifications::handlers::create_notification_endpoint))
        .route("/api/v1/orgs/:org_id/notifications/read-all",     post(notifications::handlers::mark_all_read))
        .route("/api/v1/orgs/:org_id/notifications/:notification_id/read", patch(notifications::handlers::mark_read))
        // Async jobs (discovery + billing import)
        .route("/api/v1/orgs/:org_id/jobs",                        get(jobs::list_jobs))
        .route("/api/v1/orgs/:org_id/jobs/:job_id",                get(jobs::get_job))
        .route("/api/v1/orgs/:org_id/jobs/:job_id/cancel",         post(jobs::cancel_job))
        // Resources
        .route("/api/v1/orgs/:org_id/resources",                   get(resources::handlers::list_resources))
        .route("/api/v1/orgs/:org_id/resources/:resource_id",      get(resources::handlers::get_resource))
        .route("/api/v1/orgs/:org_id/resources/:resource_id/raw-expenses", get(expense::handlers::raw_expenses_by_resource))
        .route("/api/v1/orgs/:org_id/resources/:resource_id/pool", patch(resources::handlers::patch_resource_pool))
        .route("/api/v1/orgs/:org_id/resources/:resource_id/tags", patch(resources::handlers::patch_resource_tags))
        .route("/api/v1/orgs/:org_id/s3-duplicates",              get(resources::handlers::s3_duplicate_analysis))
        .route("/api/v1/orgs/:org_id/resources/:resource_id/recommendations", get(resources::handlers::resource_recommendations))
        .route("/api/v1/orgs/:org_id/metrics",                        post(resources::handlers::ingest_metrics).get(resources::handlers::list_metrics))
        .route("/api/v1/orgs/:org_id/search",                         get(resources::handlers::global_search))
        .route("/api/v1/orgs/:org_id/demo-data",                      post(resources::handlers::seed_demo_data))
        // Shared Environments
        .route("/api/v1/orgs/:org_id/shared-environments",                                          get(shared_env::handlers::list_environments).post(shared_env::handlers::create_environment))
        .route("/api/v1/orgs/:org_id/shared-environments/:id",                                      delete(shared_env::handlers::delete_environment))
        .route("/api/v1/orgs/:org_id/shared-environments/:id/book",                                 post(shared_env::handlers::book_environment))
        .route("/api/v1/orgs/:org_id/shared-environments/:id/release",                              post(shared_env::handlers::release_environment))
        .route("/api/v1/orgs/:org_id/shared-environments/:id/bookings",                             get(shared_env::handlers::list_bookings))
        // Resource Lifecycle
        .route("/api/v1/orgs/:org_id/lifecycle-policies",                                           get(lifecycle::handlers::list_policies).post(lifecycle::handlers::create_policy))
        .route("/api/v1/orgs/:org_id/lifecycle-policies/:id",                                       delete(lifecycle::handlers::delete_policy))
        .route("/api/v1/orgs/:org_id/lifecycle-policies/:id/evaluate",                              post(lifecycle::handlers::evaluate_policy))
        .route("/api/v1/orgs/:org_id/lifecycle-events",                                             get(lifecycle::handlers::list_events))
        // K8s Rightsizing
        .route("/api/v1/orgs/:org_id/k8s/clusters",                                                 get(k8s::handlers::list_clusters).post(k8s::handlers::upsert_cluster))
        .route("/api/v1/orgs/:org_id/k8s/workloads",                                                get(k8s::handlers::list_workloads).post(k8s::handlers::upsert_workload))
        .route("/api/v1/orgs/:org_id/k8s/summary",                                                  get(k8s::handlers::rightsizing_summary))
        // auth runs FIRST (outer), then rbac reads the injected claims (inner).
        // api_key middleware is outermost: it authenticates ca_ tokens and
        // injects claims so auth_middleware passes them through.
        .layer(middleware::from_fn_with_state(
            state.clone(),
            rbac_middleware,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            api_keys::middleware::api_key_middleware,
        ));

    // OpenAPI docs
    let openapi = Router::new()
        .merge(SwaggerUi::new("/swagger-ui").url("/api-docs/openapi.json", ApiDoc::openapi()));

    // Capture state pieces before `state` is moved into the router.
    let rate_limiter = state.rate_limiter.clone();
    let security_state = state.clone();
    let metrics_handle = state.metrics.clone();

    // Request-id is attached BEFORE the trace span is created so the span
    // (and every log line inside it) carries the id end-to-end.
    let trace = TraceLayer::new_for_http().make_span_with(|request: &axum::http::Request<axum::body::Body>| {
        let request_id = request
            .headers()
            .get("x-request-id")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("unknown");
        tracing::info_span!(
            "http_request",
            method = %request.method(),
            uri = %request.uri(),
            request_id = %request_id,
        )
    });

    Router::new()
        .merge(public)
        .merge(protected)
        .merge(openapi)
        .with_state(state)
        .layer(trace)
        .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
        .layer(CompressionLayer::new())
        .layer(TimeoutLayer::new(std::time::Duration::from_secs(60)))
        .layer(middleware::from_fn_with_state(
            rate_limiter,
            rate_limit_middleware,
        ))
        .layer(middleware::from_fn_with_state(
            security_state,
            security_headers_middleware,
        ))
        // 2 MiB request body ceiling for JSON APIs.
        .layer(axum::extract::DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(
            metrics_handle,
            metrics_middleware,
        ))
        .layer(cors)
}

// OpenAPI documentation aggregation
#[derive(OpenApi)]
#[openapi(
    info(
        title = "CloudAtlas API",
        version = "1.0.0",
        description = "Unified FinOps + CMDB Platform API — combining cloud cost optimization (FinOps) and configuration management (CMDB) in a single modular monolith."
    ),
    paths(
        // ── Health ──────────────────────────────────────────────────────────
        health::liveness,
        health::readiness,
        // ── Auth ────────────────────────────────────────────────────────────
        auth::handlers::register,
        auth::handlers::login,
        auth::handlers::me,
        auth::handlers::logout,
        // ── Organizations ────────────────────────────────────────────────────
        auth::org_handlers::list_orgs,
        auth::org_handlers::create_org,
        auth::org_handlers::get_org,
        auth::org_handlers::update_org,
        auth::org_handlers::list_members,
        // ── Cloud Accounts ───────────────────────────────────────────────────
        cloud::handlers::list_accounts,
        cloud::handlers::create_account,
        cloud::handlers::get_account,
        // ── Expenses ─────────────────────────────────────────────────────────
        expense::handlers::list_expenses,
        expense::handlers::summary,
        // ── CMDB ─────────────────────────────────────────────────────────────
        cmdb::handlers::list_cis,
        cmdb::handlers::create_ci,
        cmdb::handlers::get_ci,
        cmdb::handlers::patch_ci_tags,
        cmdb::handlers::transition_ci_lifecycle,
        cmdb::model_handlers::list_unique_constraints,
        cmdb::model_handlers::create_unique_constraint,
        cmdb::model_handlers::delete_unique_constraint,
        cmdb::compliance_handlers::trigger_discovery,
        cmdb::analytics_handlers::list_ci_events,
        cmdb::import_export::ci_import_template,
        cmdb::import_export::cis_import_csv,
        cmdb::import_export::cis_export_csv,
        cmdb::handlers::search_cis,
        cmdb::handlers::batch_update_cis,
        cmdb::handlers::batch_delete_cis,
        cmdb::handlers::clone_ci,
        cmdb::compliance_handlers::compliance_last_run,
        cmdb::model_handlers::bind_field_template,
        cmdb::model_handlers::unbind_field_template,
        cmdb::model_handlers::field_template_bound_types,
        cmdb::model_handlers::field_template_diff,
        cmdb::model_handlers::apply_field_template,
        cmdb::handlers::ci_forest,
        cmdb::external_sync::trigger_external_sync,
        cmdb::external_sync::external_sync_dry_run,
        cmdb::external_sync::external_sync_logs,
        cmdb::analytics_handlers::cmdb_stats_trends,
        expense::cost_center_handlers::list_business_capabilities,
        expense::cost_center_handlers::create_business_capability,
        expense::cost_center_handlers::update_business_capability,
        expense::cost_center_handlers::delete_business_capability,
        // ── Recommendations ───────────────────────────────────────────────────
        recommendation::handlers::list,
        recommendation::handlers::summary,
    ),
    components(schemas(
        auth::dto::RegisterRequest,
        auth::dto::LoginRequest,
        auth::dto::AuthResponse,
        auth::dto::UserResponse,
        cloud::dto::CreateCloudAccountRequest,
        cloud::dto::CloudAccountResponse,
        cmdb::dto::CreateCiRequest,
        cmdb::dto::PatchCiTagsRequest,
        cmdb::dto::CiResponse,
        cmdb::handlers::LifecycleTransitionRequest,
        cmdb::model_handlers::CreateUniqueConstraintRequest,
        cmdb::handlers::BatchUpdateCiRequest,
        cmdb::handlers::BatchDeleteCiRequest,
        cmdb::handlers::CloneCiRequest,
        cmdb::model_handlers::BindFieldTemplateRequest,
        cmdb::handlers::CiForestQuery,
        cmdb::external_sync::TriggerSyncRequest,
        expense::cost_center_handlers::CreateBusinessCapabilityRequest,
        cmdb::compliance_handlers::TriggerDiscoveryRequest,
        expense::dto::ExpenseSummaryResponse,
        recommendation::dto::RecommendationResponse,
        recommendation::dto::RecommendationSummaryResponse,
    )),
    tags(
        (name = "health",           description = "Health and readiness probes"),
        (name = "auth",             description = "Authentication and session management"),
        (name = "organizations",    description = "Organization and member management"),
        (name = "cloud-accounts",   description = "Cloud provider account management"),
        (name = "expenses",         description = "Cost and expense analytics"),
        (name = "cmdb",             description = "Configuration Management Database"),
        (name = "recommendations",  description = "Cost optimization recommendations"),
        (name = "alerts",           description = "Budget alerts and notifications"),
        (name = "webhooks",         description = "Webhook delivery"),
        (name = "rules",            description = "Cost allocation rules"),
        (name = "constraints",      description = "Resource constraints"),
        (name = "power-schedules",  description = "Power schedule management"),
        (name = "tagging",          description = "Resource tagging policies"),
        (name = "billing",          description = "Cloud billing import (CUR/BSS)"),
        (name = "compliance",       description = "CMDB compliance and drift detection"),
    )
)]
struct ApiDoc;

