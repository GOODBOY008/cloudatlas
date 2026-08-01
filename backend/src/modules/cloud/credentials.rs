//! Credential shape validation + state helpers for cloud accounts.
//!
//! Mirrors the per-provider adapter contracts (adapters/aws.rs, aliyun.rs,
//! azure.rs, gcp.rs) so create/update fail fast with the same messages the
//! adapters use at test/sync time.

use serde_json::Value;

use crate::error::{AppError, AppResult};

/// True when `creds` is a non-empty JSON object — i.e. someone actually sent
/// credential material. `null`, `{}`, arrays and strings mean "no credentials".
pub fn credentials_have_content(creds: &Value) -> bool {
    matches!(creds, Value::Object(o) if !o.is_empty())
}

/// Validate the shape of a credentials value against the provider's adapter
/// contract. `null` / empty object → no-op (no credentials supplied).
/// Any other non-object value (e.g. a bare string like "__CLEAR__" outside
/// the update handler's sentinel arm) is rejected.
pub fn validate_credentials(provider: &str, creds: &Value) -> AppResult<()> {
    match creds {
        Value::Object(map) if map.is_empty() => Ok(()),
        Value::Object(map) => {
            let label = match provider {
                "aws" => "AWS",
                "alibaba" => "Alibaba",
                "azure" => "Azure",
                "gcp" => "GCP",
                _ => provider,
            };
            let required: &[&str] = match provider {
                "aws" => &["access_key_id", "secret_access_key"],
                "alibaba" => &["access_key_id", "access_key_secret"],
                "azure" => &["client_id", "client_secret", "tenant_id", "subscription_id"],
                "gcp" => &["access_token", "project_id"],
                _ => &[],
            };
            for key in required {
                match map.get(*key) {
                    Some(Value::String(s)) if !s.trim().is_empty() => {}
                    _ => {
                        return Err(AppError::Validation(format!(
                            "{label} credentials missing '{key}'"
                        )))
                    }
                }
            }
            Ok(())
        }
        Value::Null => Ok(()),
        _ => Err(AppError::Validation(
            "credentials must be a JSON object".into(),
        )),
    }
}

/// Derive the response flag `has_credentials` from the stored encrypted blob:
/// true when it decrypts to a non-empty JSON object. Decrypt failure (e.g. a
/// changed ENCRYPTION_KEY) reads as false rather than erroring.
pub fn encrypted_has_credentials(enc: &str, key: &[u8; 32]) -> bool {
    crate::crypto::decrypt(key, enc)
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .map(|v| credentials_have_content(&v))
        .unwrap_or(false)
}
