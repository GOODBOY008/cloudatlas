//! CMDB write-path validation (gap closure T1/T2/T3).
//!
//! - [`validate_meta`] enforces `ci_attributes` definitions (type / required /
//!   enum / regex) on every CI write. Unknown meta keys are deliberately
//!   allowed: discovery sync writes transient provider fields.
//! - [`allowed_transitions`] is the global lifecycle state machine.
//! - [`check_unique_constraints`] enforces `ci_unique_constraints` rows plus
//!   single-field `ci_attributes.is_unique` flags.

use std::net::IpAddr;
use std::str::FromStr;

use axum::http::StatusCode;
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

// ─── Attribute validation (T1) ────────────────────────────────────────────────

/// A `ci_attributes` row projected onto what validation needs.
#[derive(Debug, Clone)]
pub struct AttrDef {
    pub name: String,
    pub attribute_type: String,
    pub is_required: bool,
    pub is_unique: bool,
    pub enum_values: Option<Value>,
    pub validation_rule: Option<String>,
    /// `ci_attributes.default_value` (TEXT) — used by the CSV template as the
    /// example value for the column.
    pub stored_default: Option<String>,
}

/// Load all attribute definitions for a CI type (builtin + custom — the table
/// is keyed by ci_type_id only).
pub async fn load_attr_defs(db: &sqlx::PgPool, ci_type_id: Uuid) -> AppResult<Vec<AttrDef>> {
    let rows = sqlx::query(
        r#"SELECT name, attribute_type::text AS attribute_type, is_required, is_unique,
                  enum_values, validation_rule
           FROM ci_attributes WHERE ci_type_id = $1"#,
    )
    .bind(ci_type_id)
    .fetch_all(db)
    .await?;

    Ok(rows
        .iter()
        .map(|r| AttrDef {
            name: r.try_get::<String, _>("name").unwrap_or_default(),
            attribute_type: r.try_get::<String, _>("attribute_type").unwrap_or_default(),
            is_required: r.try_get::<bool, _>("is_required").unwrap_or(false),
            is_unique: r.try_get::<bool, _>("is_unique").unwrap_or(false),
            enum_values: r.try_get::<Option<Value>, _>("enum_values").unwrap_or(None),
            validation_rule: r.try_get::<Option<String>, _>("validation_rule").unwrap_or(None),
            stored_default: r.try_get::<Option<String>, _>("default_value").unwrap_or(None),
        })
        .collect())
}

/// One validation failure, serialized as `{"attribute": ..., "message": ...}`.
#[derive(Debug, Clone)]
pub struct AttrValidationError {
    pub attribute: String,
    pub message: String,
}

impl AttrValidationError {
    fn new(attribute: &str, message: impl Into<String>) -> Self {
        Self {
            attribute: attribute.to_string(),
            message: message.into(),
        }
    }

    pub fn to_json(&self) -> Value {
        serde_json::json!({ "attribute": self.attribute, "message": self.message })
    }
}

/// Build the 422 `ERR_VALIDATION` error from a list of per-attribute failures.
pub fn validation_error(errors: Vec<AttrValidationError>) -> AppError {
    let details: Vec<Value> = errors.iter().map(|e| e.to_json()).collect();
    AppError::Structured(
        StatusCode::UNPROCESSABLE_ENTITY,
        "ERR_VALIDATION".into(),
        "CI attribute validation failed".into(),
        serde_json::json!({ "errors": details }),
    )
}

/// Validate a CI's `meta` object against its type's attribute definitions.
///
/// - `is_required` attrs must be present (and non-null) in `meta`.
/// - Known keys are type-checked against the 11 builtin `ci_attribute_type`
///   values (with lenient string coercion for CSV import paths).
/// - `enum_values` (when non-empty) restricts the allowed values.
/// - `validation_rule` (when set) is a regex the string form must match.
/// - Unknown keys pass through untouched (discovery writes transient fields).
pub fn validate_meta(attrs: &[AttrDef], meta: &Value) -> Result<(), Vec<AttrValidationError>> {
    let mut errors = Vec::new();

    let obj = match meta.as_object() {
        Some(o) => o,
        None => {
            return Err(vec![AttrValidationError::new(
                "meta",
                "meta must be a JSON object",
            )])
        }
    };

    for attr in attrs {
        let value = obj.get(&attr.name);
        let present = value.map(|v| !v.is_null()).unwrap_or(false);

        if attr.is_required && !present {
            errors.push(AttrValidationError::new(
                &attr.name,
                format!("required attribute '{}' is missing", attr.name),
            ));
            continue;
        }
        if !present {
            continue;
        }
        let value = value.unwrap_or(&Value::Null);

        if let Err(msg) = check_type(&attr.attribute_type, value) {
            errors.push(AttrValidationError::new(
                &attr.name,
                format!("attribute '{}' must be a valid {}: {msg}", attr.name, attr.attribute_type),
            ));
            continue;
        }

        // Enum membership applies to any scalar the user sent.
        if let Some(ev) = attr.enum_values.as_ref().and_then(|v| v.as_array()) {
            if !ev.is_empty() {
                let ok = match value {
                    Value::String(s) => ev.iter().any(|c| c.as_str() == Some(s.as_str())),
                    other => ev.iter().any(|c| c == other),
                };
                if !ok {
                    errors.push(AttrValidationError::new(
                        &attr.name,
                        format!(
                            "attribute '{}' must be one of the allowed enum values",
                            attr.name
                        ),
                    ));
                    continue;
                }
            }
        }

        // Regex rule matches against the string form of the value.
        if let Some(rule) = attr.validation_rule.as_deref() {
            if !rule.trim().is_empty() {
                let s = match value {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                match regex::Regex::new(rule) {
                    Ok(re) => {
                        if !re.is_match(&s) {
                            errors.push(AttrValidationError::new(
                                &attr.name,
                                format!(
                                    "attribute '{}' does not match the validation rule /{rule}/",
                                    attr.name
                                ),
                            ));
                        }
                    }
                    Err(_) => {
                        // A broken rule in the definition is a config problem —
                        // fail soft rather than blocking every CI write.
                        tracing::warn!(attribute = %attr.name, rule = %rule, "invalid validation_rule regex — skipped");
                    }
                }
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

/// Type check for one of the 11 `ci_attribute_type` values. Numbers / booleans
/// accept string coercions so CSV imports and form fields stay usable.
fn check_type(attr_type: &str, value: &Value) -> Result<(), String> {
    match attr_type {
        "string" => {
            if !value.is_string() {
                return Err("expected a string".into());
            }
        }
        "integer" | "long" => {
            let ok = match value {
                Value::Number(n) => n.as_i64().is_some() || n.as_u64().is_some(),
                Value::String(s) => s.parse::<i64>().is_ok(),
                _ => false,
            };
            if !ok {
                return Err("expected an integer".into());
            }
        }
        "float" => {
            let ok = match value {
                Value::Number(_) => true,
                Value::String(s) => s.parse::<f64>().is_ok(),
                _ => false,
            };
            if !ok {
                return Err("expected a number".into());
            }
        }
        "bool" | "boolean" => {
            let ok = matches!(value, Value::Bool(_))
                || matches!(value, Value::String(s) if s == "true" || s == "false");
            if !ok {
                return Err("expected a boolean".into());
            }
        }
        "datetime" | "date" => {
            if let Value::String(s) = value {
                let ok = chrono::DateTime::parse_from_rfc3339(s).is_ok()
                    || chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok();
                if !ok {
                    return Err("expected an RFC3339 datetime or YYYY-MM-DD date".into());
                }
            } else {
                return Err("expected a datetime string".into());
            }
        }
        "enum" => {
            // Membership is checked by the caller against enum_values.
            if !value.is_string() {
                return Err("expected one of the enum values".into());
            }
        }
        "list" => {
            if !value.is_array() {
                return Err("expected a list".into());
            }
        }
        "json" | "object" => {
            if !value.is_object() && !value.is_array() {
                return Err("expected a JSON object or array".into());
            }
        }
        "url" => {
            if let Value::String(s) = value {
                if !(s.starts_with("http://") || s.starts_with("https://")) {
                    return Err("expected an http(s) URL".into());
                }
            } else {
                return Err("expected a URL string".into());
            }
        }
        "ip_address" => {
            if let Value::String(s) = value {
                if IpAddr::from_str(s).is_err() {
                    return Err("expected an IPv4/IPv6 address".into());
                }
            } else {
                return Err("expected an IP address string".into());
            }
        }
        "cidr" => {
            if let Value::String(s) = value {
                let ok = match s.split_once('/') {
                    Some((ip, prefix)) => {
                        IpAddr::from_str(ip).is_ok() && prefix.parse::<u8>().is_ok()
                    }
                    None => false,
                };
                if !ok {
                    return Err("expected a CIDR block like 10.0.0.0/8".into());
                }
            } else {
                return Err("expected a CIDR string".into());
            }
        }
        // Unknown attribute types (user-defined enum values added later) —
        // nothing to check beyond presence.
        _ => {}
    }
    Ok(())
}

/// Update-path variant of [`validate_meta`]. `meta` is the *full replacement*
/// object (update_ci replaces meta wholesale). Required attributes may be
/// grandfathered when they were already absent before the write (pre-validation
/// data), but a required attribute that existed in `old_meta` can never be
/// dropped or nulled.
pub fn validate_meta_update(
    attrs: &[AttrDef],
    old_meta: &Value,
    new_meta: &Value,
) -> Result<(), Vec<AttrValidationError>> {
    let effective: Vec<AttrDef> = attrs
        .iter()
        .map(|a| {
            let old_had_it = old_meta
                .as_object()
                .and_then(|o| o.get(&a.name))
                .map(|v| !v.is_null())
                .unwrap_or(false);
            // Required only if the attr is required AND the CI currently has a
            // value for it (or the incoming meta provides one).
            let mut a2 = a.clone();
            a2.is_required = a.is_required && (old_had_it || new_meta.as_object().map(|o| o.contains_key(&a.name)).unwrap_or(false));
            a2
        })
        .collect();
    validate_meta(&effective, new_meta)
}

// ─── Lifecycle state machine (T3) ─────────────────────────────────────────────

/// Global lifecycle transition matrix. Terminal states (`retired`,
/// `terminated`) have no successors. States present in the DB enum but absent
/// from the spec matrix (`failed`, `decommissioning`) get recovery paths.
pub fn allowed_transitions(from: &str) -> &'static [&'static str] {
    match from {
        "provisioning" => &["active", "maintenance", "decommissioned", "failed"],
        "active" => &["maintenance", "stopped", "decommissioned", "failed"],
        "maintenance" => &["active", "stopped", "decommissioned"],
        "stopped" => &["active", "maintenance", "decommissioned"],
        "decommissioning" => &["decommissioned", "active"],
        "decommissioned" => &["retired", "terminated"],
        "failed" => &["active", "maintenance", "decommissioned"],
        // retired / terminated are terminal
        _ => &[],
    }
}

/// All lifecycle states accepted on the wire (mirrors the `ci_lifecycle_state`
/// enum after migration 026).
pub const LIFECYCLE_STATES: &[&str] = &[
    "provisioning",
    "active",
    "maintenance",
    "decommissioning",
    "decommissioned",
    "retired",
    "failed",
    "stopped",
    "terminated",
];

/// Validate a `from → to` lifecycle transition. Errors carry the legal
/// successor list as `details.allowed`.
pub fn validate_transition(from: &str, to: &str) -> AppResult<()> {
    if from == to {
        return Ok(());
    }
    if !LIFECYCLE_STATES.contains(&to) {
        return Err(AppError::Validation(format!(
            "Unknown lifecycle state '{to}'. Valid states: {LIFECYCLE_STATES:?}"
        )));
    }
    let allowed = allowed_transitions(from);
    if allowed.contains(&to) {
        Ok(())
    } else {
        Err(AppError::Structured(
            StatusCode::UNPROCESSABLE_ENTITY,
            "ERR_INVALID_TRANSITION".into(),
            format!("Lifecycle transition {from} → {to} is not allowed"),
            serde_json::json!({ "from": from, "to": to, "allowed": allowed }),
        ))
    }
}

// ─── Unique constraints (T2) ──────────────────────────────────────────────────

/// A composite uniqueness rule for a CI type.
#[derive(Debug, Clone)]
pub struct UniqueConstraint {
    pub id: Uuid,
    pub name: String,
    pub attr_names: Vec<String>,
}

/// Load the effective unique constraints for a CI type: rows from
/// `ci_unique_constraints` plus implicit single-field constraints from
/// `ci_attributes.is_unique`.
pub async fn load_unique_constraints(
    db: &sqlx::PgPool,
    org_id: Uuid,
    ci_type_id: Uuid,
) -> AppResult<Vec<UniqueConstraint>> {
    let mut result = Vec::new();

    let rows = sqlx::query(
        r#"SELECT id, name, attr_names
           FROM ci_unique_constraints
           WHERE organization_id = $1 AND ci_type_id = $2 AND deleted_at = 0"#,
    )
    .bind(org_id)
    .bind(ci_type_id)
    .fetch_all(db)
    .await?;

    for r in rows {
        let id: Uuid = r.try_get("id")?;
        let name: String = r.try_get("name")?;
        let attr_names: Vec<String> = r
            .try_get::<Vec<String>, _>("attr_names")
            .unwrap_or_default();
        result.push(UniqueConstraint { id, name, attr_names });
    }

    // is_unique attributes behave as single-field constraints (same check path,
    // no need to persist a row for them).
    for attr in load_attr_defs(db, ci_type_id).await? {
        if attr.is_unique {
            result.push(UniqueConstraint {
                id: Uuid::nil(),
                name: format!("attr:{}", attr.name),
                attr_names: vec![attr.name],
            });
        }
    }

    Ok(result)
}

/// `meta->>'k'` text form of a JSON value — matches how Postgres renders it.
fn meta_text_form(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Attribute names may only be [A-Za-z0-9_]+ — required so constraint keys can
/// be interpolated into `meta->>'key'` expressions safely.
fn is_safe_attr_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 100
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Check every unique constraint of the CI type against `meta`. A constraint
/// only applies when ALL of its attribute keys are present and non-null
/// (SQL NULL semantics: partial matches can't collide).
///
/// `exclude_ci_id` skips the CI being updated.
pub async fn check_unique_constraints(
    db: &sqlx::PgPool,
    org_id: Uuid,
    ci_type_id: Uuid,
    meta: &Value,
    exclude_ci_id: Option<Uuid>,
) -> AppResult<()> {
    let constraints = load_unique_constraints(db, org_id, ci_type_id).await?;
    if constraints.is_empty() {
        return Ok(());
    }
    let obj = meta.as_object();

    for constraint in &constraints {
        // Resolve every attribute's text form; skip constraint if any key missing.
        let mut values: Vec<(String, String)> = Vec::with_capacity(constraint.attr_names.len());
        let mut all_present = true;
        for key in &constraint.attr_names {
            match obj.and_then(|o| o.get(key)).and_then(meta_text_form) {
                Some(v) => values.push((key.clone(), v)),
                None => {
                    all_present = false;
                    break;
                }
            }
        }
        if !all_present || values.is_empty() {
            continue;
        }

        // SELECT 1 FROM cis WHERE org=$1 AND type=$2 AND deleted_at IS NULL
        //   AND id <> $self AND meta->>'k1' = $v1 AND ... LIMIT 1
        // Attribute names are safe to interpolate (identifier charset enforced
        // below); values are bound parameters.
        let mut conditions = Vec::with_capacity(values.len());
        for (i, (key, _)) in values.iter().enumerate() {
            if !is_safe_attr_key(key) {
                tracing::warn!(constraint = %constraint.name, key = %key, "skipping unsafe attribute key in unique constraint");
                continue;
            }
            conditions.push(format!("meta->>'{key}' = ${}", i + 4));
        }
        if conditions.is_empty() {
            continue;
        }
        let exclude_clause = match exclude_ci_id {
            Some(_) => " AND id <> $3",
            None => " AND $3::uuid IS NULL",
        };
        let sql = format!(
            r#"SELECT id FROM cis
               WHERE organization_id = $1 AND ci_type_id = $2 AND deleted_at IS NULL{exclude_clause}
                 AND {}
               LIMIT 1"#,
            conditions.join(" AND ")
        );

        let mut q = sqlx::query_scalar::<_, Uuid>(&sql)
            .bind(org_id)
            .bind(ci_type_id)
            .bind(exclude_ci_id);
        for (_, v) in &values {
            q = q.bind(v);
        }

        if let Ok(Some(existing)) = q.fetch_optional(db).await {
            return Err(AppError::Structured(
                StatusCode::CONFLICT,
                "ERR_DUPLICATE".into(),
                format!(
                    "violates unique constraint '{}': another CI of this type already has {}",
                    constraint.name,
                    constraint
                        .attr_names
                        .iter()
                        .map(|k| k.clone())
                        .collect::<Vec<_>>()
                        .join(" + ")
                ),
                serde_json::json!({
                    "constraint": constraint.name,
                    "attr_names": constraint.attr_names,
                    "existing_ci_id": existing,
                }),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn attr(name: &str, ty: &str, required: bool) -> AttrDef {
        AttrDef {
            name: name.into(),
            attribute_type: ty.into(),
            is_required: required,
            is_unique: false,
            enum_values: None,
            validation_rule: None,
            stored_default: None,
        }
    }

    #[test]
    fn validates_all_eleven_types() {
        let attrs = vec![
            attr("s", "string", false),
            attr("i", "integer", false),
            attr("f", "float", false),
            attr("b", "bool", false),
            attr("dt", "datetime", false),
            attr("e", "enum", false),
            attr("l", "list", false),
            attr("j", "json", false),
            attr("u", "url", false),
            attr("ip", "ip_address", false),
            attr("cidr", "cidr", false),
        ];
        let good = json!({
            "s": "hello",
            "i": 42,
            "f": 3.14,
            "b": true,
            "dt": "2026-09-12T10:00:00Z",
            "e": "a",
            "l": [1, 2],
            "j": {"k": "v"},
            "u": "https://example.com",
            "ip": "10.0.0.1",
            "cidr": "10.0.0.0/8",
        });
        assert!(validate_meta(&attrs, &good).is_ok(), "all-valid meta must pass");

        let bad = json!({
            "s": 123,
            "i": 1.5,
            "f": "not-a-number",
            "b": "yes",
            "dt": "12/09/2026",
            "e": 7,
            "l": "nope",
            "j": "scalar",
            "u": "ftp://x",
            "ip": "999.1.1.1",
            "cidr": "10.0.0.0",
        });
        let errors = validate_meta(&attrs, &bad).unwrap_err();
        assert_eq!(errors.len(), 11, "every attribute should fail: {errors:?}");
    }

    #[test]
    fn string_coercion_for_numbers_and_bools() {
        let attrs = vec![attr("i", "integer", false), attr("b", "bool", false)];
        assert!(validate_meta(&attrs, &json!({"i": "7", "b": "true"})).is_ok());
    }

    #[test]
    fn date_only_datetime_accepted() {
        let attrs = vec![attr("dt", "datetime", false)];
        assert!(validate_meta(&attrs, &json!({"dt": "2026-09-12"})).is_ok());
    }

    #[test]
    fn required_missing_and_null_rejected() {
        let attrs = vec![attr("hostname", "string", true)];
        assert!(validate_meta(&attrs, &json!({})).is_err());
        assert!(validate_meta(&attrs, &json!({"hostname": null})).is_err());
        assert!(validate_meta(&attrs, &json!({"hostname": "web-1"})).is_ok());
    }

    #[test]
    fn enum_membership_enforced() {
        let mut a = attr("env", "enum", false);
        a.enum_values = Some(json!(["prod", "staging", "dev"]));
        assert!(validate_meta(&attrs_of(a.clone()), &json!({"env": "prod"})).is_ok());
        assert!(validate_meta(&attrs_of(a), &json!({"env": "qa"})).is_err());
    }

    #[test]
    fn regex_rule_enforced_and_broken_rule_fails_soft() {
        let mut a = attr("code", "string", false);
        a.validation_rule = Some("^[A-Z]{3}-\\d+$".into());
        let attrs = attrs_of(a.clone());
        assert!(validate_meta(&attrs, &json!({"code": "ABC-123"})).is_ok());
        assert!(validate_meta(&attrs, &json!({"code": "abc"})).is_err());

        let mut broken = attr("x", "string", false);
        broken.validation_rule = Some("[".into()); // invalid regex
        assert!(validate_meta(&attrs_of(broken), &json!({"x": "any"})).is_ok());
    }

    #[test]
    fn unknown_keys_pass_through() {
        let attrs = vec![attr("known", "string", false)];
        // Discovery writes transient fields — they must not be rejected.
        assert!(validate_meta(&attrs, &json!({"known": "v", "_temp_provider_field": 42})).is_ok());
    }

    #[test]
    fn non_object_meta_rejected() {
        let attrs = vec![];
        assert!(validate_meta(&attrs, &json!([1, 2])).is_err());
    }

    fn attrs_of(a: AttrDef) -> Vec<AttrDef> {
        vec![a]
    }

    // ─── lifecycle matrix ────────────────────────────────────────────────────

    #[test]
    fn spec_matrix_transitions_valid() {
        for (from, to) in [
            ("provisioning", "active"),
            ("provisioning", "maintenance"),
            ("provisioning", "decommissioned"),
            ("active", "maintenance"),
            ("active", "stopped"),
            ("active", "decommissioned"),
            ("maintenance", "active"),
            ("maintenance", "stopped"),
            ("stopped", "active"),
            ("stopped", "decommissioned"),
            ("decommissioned", "retired"),
            ("decommissioned", "terminated"),
        ] {
            assert!(validate_transition(from, to).is_ok(), "{from} → {to} must be legal");
        }
    }

    #[test]
    fn illegal_transitions_rejected() {
        for (from, to) in [
            ("provisioning", "retired"),
            ("active", "provisioning"),
            ("active", "retired"),
            ("stopped", "terminated"),
            ("decommissioned", "active"),
            ("retired", "active"),
            ("terminated", "retired"),
        ] {
            let err = validate_transition(from, to).unwrap_err();
            match err {
                AppError::Structured(_, code, _, details) => {
                    assert_eq!(code, "ERR_INVALID_TRANSITION");
                    assert!(details.get("allowed").is_some(), "details must carry allowed list");
                }
                other => panic!("expected Structured error, got {other:?}"),
            }
        }
    }

    #[test]
    fn same_state_is_noop_legal() {
        assert!(validate_transition("active", "active").is_ok());
    }

    #[test]
    fn unknown_target_state_rejected() {
        assert!(validate_transition("active", "hibernating").is_err());
    }

    #[test]
    fn meta_text_form_matches_pg_jsonb_extraction() {
        assert_eq!(meta_text_form(&json!("x")), Some("x".into()));
        assert_eq!(meta_text_form(&json!(4)), Some("4".into()));
        assert_eq!(meta_text_form(&json!(true)), Some("true".into()));
        assert_eq!(meta_text_form(&json!({"a": 1})), None);
    }
}
