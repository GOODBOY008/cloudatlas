//! Tag key/value validation (product gap C3) — K8s-label-compatible syntax.

use crate::error::{AppError, AppResult};
use serde_json::Value;

/// Validate a tags object: flat map, keys match `^[a-zA-Z][a-z0-9A-Z\-_.]{0,62}$`,
/// values are non-empty strings.
pub fn validate_tags(tags: &Value) -> AppResult<()> {
    let obj = tags
        .as_object()
        .ok_or_else(|| AppError::Validation("tags must be a JSON object".into()))?;

    for (key, value) in obj {
        validate_key(key)?;
        let v = value
            .as_str()
            .ok_or_else(|| AppError::Validation(format!("tag '{key}' must be a string value")))?;
        if v.trim().is_empty() {
            return Err(AppError::Validation(format!(
                "tag '{key}' must not be empty"
            )));
        }
    }
    Ok(())
}

fn validate_key(key: &str) -> AppResult<()> {
    let re_ok = key.len() <= 63
        && key
            .chars()
            .next()
            .map(|c| c.is_ascii_alphabetic())
            .unwrap_or(false)
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.');
    if re_ok {
        Ok(())
    } else {
        Err(AppError::Validation(format!(
            "invalid tag key '{key}': must start with a letter and contain only letters, digits, '-', '_', '.' (max 63 chars)"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_keys() {
        assert!(
            validate_tags(&serde_json::json!({ "env": "prod", "team.name": "platform" })).is_ok()
        );
        assert!(validate_tags(&serde_json::json!({ "k8s-label_1": "x" })).is_ok());
    }

    #[test]
    fn rejects_invalid_keys() {
        assert!(validate_tags(&serde_json::json!({ "1starts-with-digit": "x" })).is_err());
        assert!(validate_tags(&serde_json::json!({ "has space": "x" })).is_err());
        assert!(validate_tags(&serde_json::json!({ "has/char": "x" })).is_err());
        assert!(validate_tags(&serde_json::json!({ "x".repeat(64): "v" })).is_err());
        assert!(validate_tags(&serde_json::json!({ "ok": 42 })).is_err());
        assert!(validate_tags(&serde_json::json!({ "ok": "" })).is_err());
        assert!(validate_tags(&serde_json::json!(["a"])).is_err());
    }
}
