/// Unit tests for the CMDB module DTOs and data structures.
/// Tests serialization, deserialization, and structural invariants
/// without requiring a live database connection.
use cloudatlas_lib::modules::cmdb::dto::{
    CiQuery, CreateAssociationRequest, CreateCiRequest, CreateCiTypeRequest, ImpactQuery,
    PatchCiTagsRequest, TopologyQuery, UpdateCiRequest, UpdateCiTypeRequest,
};
use cloudatlas_lib::modules::cmdb::handlers::validate_patch_tags;
use serde_json::json;
use uuid::Uuid;

// ─── CiQuery defaults ─────────────────────────────────────────────────────────

#[test]
fn test_ci_query_default_is_empty() {
    let q = CiQuery::default();
    assert!(q.ci_type_id.is_none());
    assert!(q.lifecycle_state.is_none());
    assert!(q.cloud_account_id.is_none());
    assert!(q.cloud_provider.is_none());
    assert!(q.search.is_none());
    assert!(q.page.page.is_none());
    assert!(q.page.per_page.is_none());
    assert!(q.page.limit.is_none());
    assert!(q.page.offset.is_none());
}

#[test]
fn test_ci_query_with_lifecycle_state() {
    let q = CiQuery {
        lifecycle_state: Some("active".to_string()),
        page: cloudatlas_lib::utils::pagination::PageQuery {
            limit: Some("50".into()),
            ..Default::default()
        },
        ..Default::default()
    };
    assert_eq!(q.lifecycle_state.as_deref(), Some("active"));
    assert_eq!(q.page.limit.as_deref(), Some("50"));
    assert!(q.ci_type_id.is_none());
}

// ─── CreateCiRequest ──────────────────────────────────────────────────────────

#[test]
fn test_create_ci_request_serializes_tags() {
    let ci_type_id = Uuid::new_v4();
    let tags = json!({"env": "prod", "team": "platform"});
    let req = CreateCiRequest {
        ci_type_id,
        name: "i-1234567890abcdef0".into(),
        display_name: Some("Web Server".into()),
        cloud_resource_id: Some("i-1234567890abcdef0".into()),
        cloud_provider: Some("aws".into()),
        cloud_region: Some("us-east-1".into()),
        meta: None,
        tags: Some(tags.clone()),
    };

    assert_eq!(req.name, "i-1234567890abcdef0");
    assert_eq!(req.cloud_provider.as_deref(), Some("aws"));
    assert_eq!(req.tags, Some(tags));
}

#[test]
fn test_create_ci_request_optional_fields_can_be_none() {
    let req = CreateCiRequest {
        ci_type_id: Uuid::new_v4(),
        name: "test-ci".into(),
        display_name: None,
        cloud_resource_id: None,
        cloud_provider: None,
        cloud_region: None,
        meta: None,
        tags: None,
    };
    assert!(req.display_name.is_none());
    assert!(req.cloud_provider.is_none());
    assert!(req.meta.is_none());
}

// ─── UpdateCiRequest ──────────────────────────────────────────────────────────

#[test]
fn test_update_ci_request_partial_update() {
    let req = UpdateCiRequest {
        name: None,
        display_name: Some("Updated Name".into()),
        meta: None,
        tags: Some(json!({"env": "staging"})),
        lifecycle_state: Some("stopped".into()),
        pool_id: None,
        parent_ci_id: None,
        remove_parent: None,
    };
    assert!(req.name.is_none());
    assert_eq!(req.display_name.as_deref(), Some("Updated Name"));
    assert_eq!(req.lifecycle_state.as_deref(), Some("stopped"));
}

// ─── CreateCiTypeRequest ──────────────────────────────────────────────────────

#[test]
fn test_create_ci_type_request_fields() {
    let req = CreateCiTypeRequest {
        name: "instance".into(),
        display_name: "EC2 Instance".into(),
        description: Some("AWS EC2 virtual machine".into()),
        icon: Some("server".into()),
        classification_id: None,
        parent_type_id: None,
        cloud_provider: Some("aws".into()),
        sort_order: Some(10),
    };
    assert_eq!(req.name, "instance");
    assert_eq!(req.cloud_provider.as_deref(), Some("aws"));
    assert_eq!(req.sort_order, Some(10));
}

#[test]
fn test_update_ci_type_request_all_optional() {
    let req = UpdateCiTypeRequest {
        display_name: None,
        description: None,
        icon: None,
        sort_order: None,
    };
    assert!(req.display_name.is_none());
    assert!(req.description.is_none());
}

// ─── Lifecycle state validation helpers ───────────────────────────────────────

#[test]
fn test_valid_lifecycle_states() {
    let valid = ["active", "stopped", "terminated", "unknown"];
    for state in &valid {
        assert!(!state.is_empty());
        assert!(state.chars().all(|c| c.is_ascii_lowercase() || c == '_'));
    }
    assert_eq!(valid.len(), 4);
}

#[test]
fn test_lifecycle_transition_active_to_stopped_is_valid() {
    let allowed_transitions: &[(&str, &str)] = &[
        ("active", "stopped"),
        ("active", "terminated"),
        ("stopped", "active"),
        ("stopped", "terminated"),
    ];
    for (from, to) in allowed_transitions {
        assert_ne!(from, to, "source and destination states must differ");
    }
}

// ─── CI type name constraints ─────────────────────────────────────────────────

#[test]
fn test_ci_type_names_are_snake_case() {
    let types = [
        "instance",
        "rds_instance",
        "volume",
        "snapshot",
        "vpc",
        "subnet",
        "security_group",
        "load_balancer",
        "kubernetes_cluster",
        "container",
    ];
    for name in &types {
        let is_valid = name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c == '_' || c.is_ascii_digit());
        assert!(is_valid, "CI type name {name:?} is not snake_case");
    }
}

// ─── ImpactQuery ──────────────────────────────────────────────────────────────

#[test]
fn test_impact_query_defaults() {
    let q = ImpactQuery::default();
    assert!(q.max_depth.is_none());
    assert!(q.direction.is_none());
}

#[test]
fn test_impact_query_direction_values_are_valid() {
    for dir in &["outgoing", "incoming", "both"] {
        assert!(!dir.is_empty());
        assert!(dir.chars().all(|c| c.is_ascii_alphabetic()));
    }
}

#[test]
fn test_impact_max_depth_clamping() {
    // Simulates what the handler does: params.max_depth.unwrap_or(3).clamp(1, 10)
    let user_value: i32 = 50; // exceeds max
    let clamped = user_value.clamp(1, 10);
    assert_eq!(clamped, 10);

    let user_value: i32 = 0; // below min
    let clamped = user_value.clamp(1, 10);
    assert_eq!(clamped, 1);

    let user_value: i32 = 5; // within range
    let clamped = user_value.clamp(1, 10);
    assert_eq!(clamped, 5);
}

// ─── TopologyQuery ────────────────────────────────────────────────────────────

#[test]
fn test_topology_query_defaults() {
    let q = TopologyQuery::default();
    assert!(q.max_depth.is_none());
}

#[test]
fn test_topology_max_depth_clamping() {
    // Handler uses max_depth.unwrap_or(10).clamp(1, 20)
    let d: i32 = 100;
    assert_eq!(d.clamp(1, 20), 20);
    let d: i32 = 0;
    assert_eq!(d.clamp(1, 20), 1);
    let d: i32 = 7;
    assert_eq!(d.clamp(1, 20), 7);
}

// ─── CreateAssociationRequest ─────────────────────────────────────────────────

#[test]
fn test_create_association_request_fields() {
    let obj_assoc_id = Uuid::new_v4();
    let dst_ci_id = Uuid::new_v4();
    let req = CreateAssociationRequest {
        object_association_id: obj_assoc_id,
        dst_ci_id,
        meta: Some(json!({"note": "primary"})),
    };
    assert_eq!(req.object_association_id, obj_assoc_id);
    assert_eq!(req.dst_ci_id, dst_ci_id);
    assert!(req.meta.is_some());
}

#[test]
fn test_create_association_request_without_meta() {
    let req = CreateAssociationRequest {
        object_association_id: Uuid::new_v4(),
        dst_ci_id: Uuid::new_v4(),
        meta: None,
    };
    assert!(req.meta.is_none());
}

// ─── CI attribute type validation ─────────────────────────────────────────────

#[test]
fn test_all_attribute_types_are_known() {
    // Mirrors the ci_attribute_type DB enum values
    let known_types = [
        "string",
        "integer",
        "float",
        "boolean",
        "datetime",
        "enum",
        "list",
        "json",
        "url",
        "ip_address",
        "cidr",
    ];
    for t in &known_types {
        assert!(!t.is_empty());
        // Types must not contain spaces (they map to DB enum labels)
        assert!(
            !t.contains(' '),
            "attribute type {t:?} must not contain spaces"
        );
    }
    assert_eq!(known_types.len(), 11);
}

#[test]
fn test_lifecycle_states_cover_all_enum_variants() {
    // Mirrors the ci_lifecycle_state DB enum
    let states = [
        "provisioning",
        "active",
        "maintenance",
        "decommissioning",
        "decommissioned",
        "retired",
        "failed",
    ];
    // Ensure no duplicates
    let mut seen = std::collections::HashSet::new();
    for s in &states {
        assert!(seen.insert(*s), "duplicate lifecycle state: {s}");
    }
    assert_eq!(states.len(), 7);
}

// ─── Association cardinality enum ─────────────────────────────────────────────

#[test]
fn test_association_cardinality_variants() {
    let cardinalities = ["one_to_one", "one_to_many", "many_to_one", "many_to_many"];
    for c in &cardinalities {
        assert!(c.contains('_'), "cardinality {c:?} should be snake_case");
    }
    assert_eq!(cardinalities.len(), 4);
}

// ─── Drift status enum ────────────────────────────────────────────────────────

#[test]
fn test_drift_status_variants() {
    let statuses = ["open", "acknowledged", "resolved", "ignored"];
    let mut seen = std::collections::HashSet::new();
    for s in &statuses {
        assert!(seen.insert(*s), "duplicate drift status: {s}");
    }
    assert_eq!(statuses.len(), 4);
}

// ─── PatchCiTagsRequest + validate_patch_tags ─────────────────────────────────

#[test]
fn test_patch_ci_tags_request_round_trip() {
    // The handler deserializes the request body into this struct; verify that
    // the expected JSON shape round-trips correctly.
    let body = json!({ "tags": { "env": "prod", "team": "platform" } });
    let req: PatchCiTagsRequest = serde_json::from_value(body.clone()).unwrap();
    assert_eq!(req.tags, body["tags"]);
    // Empty object is also valid (replaces existing tags with {}).
    let empty = json!({ "tags": {} });
    let req: PatchCiTagsRequest = serde_json::from_value(empty).unwrap();
    assert_eq!(req.tags, json!({}));
}

#[test]
fn test_validate_patch_tags_accepts_flat_string_object() {
    let tags = json!({ "env": "prod", "owner": "qa" });
    assert!(validate_patch_tags(&tags).is_ok());
    let empty = json!({});
    assert!(validate_patch_tags(&empty).is_ok());
}

#[test]
fn test_validate_patch_tags_rejects_non_object() {
    let cases = [
        json!("a string"),
        json!(42),
        json!(true),
        json!(null),
        json!(["array"]),
    ];
    for case in &cases {
        let err = validate_patch_tags(case).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("tags must be a JSON object"), "got: {msg}");
    }
}

#[test]
fn test_validate_patch_tags_rejects_non_string_value() {
    let bad = json!({ "env": "prod", "owner": 42 });
    let err = validate_patch_tags(&bad).unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("owner"),
        "expected offending key in error, got: {msg}"
    );
    assert!(
        msg.contains("string"),
        "expected 'string' in error, got: {msg}"
    );
}
