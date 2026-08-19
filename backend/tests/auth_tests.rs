/// Integration tests for the auth module.
/// Unit-style tests for JWT creation/verification and password hashing.
use cloudatlas_lib::modules::auth::service::{hash_password, verify_password, Claims};
use uuid::Uuid;

// ─── JWT round-trip ──────────────────────────────────────────────────────────

#[test]
fn test_jwt_access_token_roundtrip() {
    let user_id = Uuid::new_v4();
    let email = "test@cloudatlas.dev";
    let secret = "super_secret_test_key_at_least_32_chars";
    let expiry_secs = 3600u64;

    let claims = Claims::new_access(user_id, email, expiry_secs);
    let token = claims.encode_token(secret).expect("should encode token");
    assert!(!token.is_empty());

    let decoded = Claims::verify(&token, secret).expect("should verify token");
    assert_eq!(decoded.sub, user_id.to_string());
    assert_eq!(decoded.email, email);
    assert_eq!(decoded.token_type, "access");
}

#[test]
fn test_jwt_refresh_token_roundtrip() {
    let user_id = Uuid::new_v4();
    let email = "refresh@cloudatlas.dev";
    let secret = "super_secret_test_key_at_least_32_chars";

    let claims = Claims::new_refresh(user_id, email, 86400);
    let token = claims
        .encode_token(secret)
        .expect("should encode refresh token");

    let decoded = Claims::verify_refresh(&token, secret).expect("should verify refresh token");
    assert_eq!(decoded.token_type, "refresh");
}

#[test]
fn test_jwt_wrong_secret_rejected() {
    let user_id = Uuid::new_v4();
    let secret = "super_secret_test_key_at_least_32_chars";
    let wrong = "wrong_secret_key_also_at_least_32_cha!";

    let token = Claims::new_access(user_id, "x@y.com", 3600)
        .encode_token(secret)
        .expect("encode");

    assert!(Claims::verify(&token, wrong).is_err());
}

#[test]
fn test_claims_user_id_parse() {
    let user_id = Uuid::new_v4();
    let claims = Claims::new_access(user_id, "x@y.com", 3600);
    let parsed = claims.user_id().expect("should parse user_id");
    assert_eq!(parsed, user_id);
}

#[test]
fn test_claims_invalid_user_id_returns_error() {
    let claims = Claims {
        sub: "not-a-uuid".into(),
        jti: Uuid::new_v4().to_string(),
        email: "x@y.com".into(),
        exp: 9999999999,
        iat: 0,
        token_type: "access".into(),
    };
    assert!(claims.user_id().is_err());
}

// ─── Password hashing ────────────────────────────────────────────────────────

#[test]
fn test_password_hash_and_verify() {
    let password = "Str0ng!Password#2024";
    let hash = hash_password(password).expect("should hash password");

    assert!(verify_password(password, &hash).expect("should verify"));
    assert!(!verify_password("wrong_password", &hash).expect("should not match"));
}
