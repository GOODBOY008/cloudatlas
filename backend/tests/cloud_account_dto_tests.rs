/// Regression tests for the cloud-account create DTO (defect D-1):
/// `credentials` and `config` must deserialize with defaults so the UI's
/// `{name, provider, external_id}` payload is accepted for mock/local
/// accounts, while real providers can still send full credentials.
use cloudatlas_lib::modules::cloud::dto::CreateCloudAccountRequest;
use serde_json::json;

#[test]
fn create_account_request_minimal_payload_deserializes() {
    // Exactly what the frontend sends today (D-1 fix contract).
    let body: CreateCloudAccountRequest =
        serde_json::from_value(json!({ "name": "Dev", "provider": "aws", "external_id": "123" }))
            .expect("minimal payload must deserialize");
    assert_eq!(body.name, "Dev");
    assert_eq!(body.provider, "aws");
    assert_eq!(body.credentials, serde_json::json!({}));
    assert_eq!(body.config, serde_json::json!({}));
    assert!(body.currency.is_none());
}

#[test]
fn create_account_request_full_payload_deserializes() {
    let body: CreateCloudAccountRequest = serde_json::from_value(json!({
        "name": "AWS Prod",
        "provider": "aws",
        "credentials": { "access_key_id": "AKIA...", "secret_access_key": "s3cr3t" },
        "config": { "region": "us-east-1" },
        "currency": "USD"
    }))
    .expect("full payload must deserialize");
    assert_eq!(body.credentials["access_key_id"], "AKIA...");
    assert_eq!(body.config["region"], "us-east-1");
    assert_eq!(body.currency.as_deref(), Some("USD"));
}

#[test]
fn create_account_request_null_credentials_still_deserializes() {
    // Explicit nulls deserialize as JSON null (Value::Null) — the handler
    // serializes whatever it gets back to JSON for encryption, so this is
    // accepted; the point is it must not be a hard 400.
    let body: CreateCloudAccountRequest = serde_json::from_value(
        json!({ "name": "N", "provider": "mock", "credentials": null, "config": null }),
    )
    .expect("null credentials should not break deserialization");
    assert!(body.credentials.is_null());
}

// ─── Credential validation (spec 2026-08-17 §4.2) ────────────────────────────

use cloudatlas_lib::modules::cloud::credentials::{credentials_have_content, validate_credentials};

#[test]
fn credentials_have_content_detects_real_objects_only() {
    assert!(credentials_have_content(
        &json!({ "access_key_id": "AKIA" })
    ));
    assert!(!credentials_have_content(&json!({})));
    assert!(!credentials_have_content(&serde_json::Value::Null));
    assert!(!credentials_have_content(&serde_json::json!("__CLEAR__")));
}

#[test]
fn validate_credentials_accepts_complete_aws_payload() {
    let creds = json!({ "access_key_id": "AKIA123", "secret_access_key": "s3cr3t" });
    assert!(validate_credentials("aws", &creds).is_ok());
}

#[test]
fn validate_credentials_rejects_missing_secret() {
    let creds = json!({ "access_key_id": "AKIA123" });
    let err = validate_credentials("aws", &creds).unwrap_err().to_string();
    assert!(err.contains("secret_access_key"), "got: {err}");
}

#[test]
fn validate_credentials_rejects_empty_string_values() {
    let creds = json!({ "access_key_id": "AKIA123", "secret_access_key": "" });
    assert!(validate_credentials("aws", &creds).is_err());
}

#[test]
fn validate_credentials_covers_azure_and_gcp_shapes() {
    assert!(validate_credentials(
        "azure",
        &json!({ "client_id": "c", "client_secret": "s", "tenant_id": "t", "subscription_id": "sub" })
    )
    .is_ok());
    assert!(validate_credentials("azure", &json!({ "client_id": "c" })).is_err());
    assert!(
        validate_credentials("gcp", &json!({ "access_token": "t", "project_id": "p" })).is_ok()
    );
    assert!(validate_credentials("gcp", &json!({ "access_token": "t" })).is_err());
}

#[test]
fn validate_credentials_is_permissive_for_mock_and_other() {
    assert!(validate_credentials("mock", &json!({})).is_ok());
    assert!(validate_credentials("other", &json!({ "anything": 1 })).is_ok());
}

#[test]
fn validate_credentials_rejects_non_object_values() {
    let err = validate_credentials("aws", &json!("garbage"))
        .unwrap_err()
        .to_string();
    assert!(err.contains("object"), "got: {err}");
}

#[test]
fn update_request_deserializes_credentials_and_clear_sentinel() {
    use cloudatlas_lib::modules::cloud::dto::UpdateCloudAccountRequest;
    let body: UpdateCloudAccountRequest = serde_json::from_value(json!({
        "name": "Renamed",
        "credentials": { "access_key_id": "AKIA9" },
        "currency": "EUR"
    }))
    .expect("payload with credentials must deserialize");
    assert_eq!(body.name.as_deref(), Some("Renamed"));
    assert_eq!(body.credentials.as_ref().unwrap()["access_key_id"], "AKIA9");

    let clear: UpdateCloudAccountRequest = serde_json::from_value(json!({
        "credentials": "__CLEAR__"
    }))
    .expect("__CLEAR__ must deserialize");
    assert_eq!(clear.credentials, Some(serde_json::json!("__CLEAR__")));

    let minimal: UpdateCloudAccountRequest =
        serde_json::from_value(json!({})).expect("empty payload must deserialize");
    assert!(minimal.credentials.is_none());
}
