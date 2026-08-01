//! TOTP two-factor helpers (RFC 6238, SHA-1, 6 digits, 30s step).
//! Secrets are base32 strings; verification tolerates ±1 time step.

use base32::Alphabet;
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha1::Sha1;

type HmacSha1 = Hmac<Sha1>;

const STEP_SECS: u64 = 30;
const DIGITS: u32 = 6;

/// Generate a new base32 secret (20 random bytes).
pub fn generate_secret() -> String {
    let mut bytes = [0u8; 20];
    rand::thread_rng().fill_bytes(&mut bytes);
    base32::encode(Alphabet::Rfc4648 { padding: false }, &bytes)
}

/// RFC 6238 TOTP code for a secret at a given unix timestamp.
pub fn code_for(secret_b32: &str, ts_secs: u64) -> Option<String> {
    let bytes = base32::decode(Alphabet::Rfc4648 { padding: false }, secret_b32)?;
    let counter = ts_secs / STEP_SECS;
    let mut mac = HmacSha1::new_from_slice(&bytes).ok()?;
    mac.update(&counter.to_be_bytes());
    let result = mac.finalize().into_bytes();
    let offset = (result[19] & 0x0f) as usize;
    let bin_code = u32::from_be_bytes([result[offset], result[offset + 1], result[offset + 2], result[offset + 3]]) & 0x7fff_ffff;
    Some(format!("{:0width$}", bin_code % 10u32.pow(DIGITS), width = DIGITS as usize))
}

/// Verify a code against the current and adjacent time steps (±1 window).
pub fn verify_code(secret_b32: &str, code: &str, now_secs: u64) -> bool {
    let code = code.trim();
    (0..=2).any(|w| {
        let ts = now_secs.saturating_sub(w * STEP_SECS);
        code_for(secret_b32, ts).map(|c| c == code).unwrap_or(false)
    })
}

/// otpauth:// URI for authenticator apps.
pub fn otpauth_uri(secret_b32: &str, account: &str, issuer: &str) -> String {
    format!(
        "otpauth://totp/{issuer}:{account}?secret={secret_b32}&issuer={issuer}&digits={DIGITS}&period={STEP_SECS}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_roundtrip_and_code() {
        let secret = generate_secret();
        assert!(secret.len() >= 32);
        let ts = 1_700_000_000u64;
        let code = code_for(&secret, ts).expect("code generated");
        assert_eq!(code.len(), 6);
        // Same window → same code.
        assert_eq!(code_for(&secret, ts + 9), Some(code.clone()));
        // Verify accepts the code; rejects a wrong one.
        assert!(verify_code(&secret, &code, ts));
        assert!(!verify_code(&secret, "000000", ts));
        // Previous window still accepted (clock drift tolerance).
        let prev = code_for(&secret, ts - STEP_SECS).unwrap();
        assert!(verify_code(&secret, &prev, ts));
    }

    #[test]
    fn otpauth_uri_shape() {
        let uri = otpauth_uri("ABCDEF", "user@x.com", "CloudAtlas");
        assert!(uri.starts_with("otpauth://totp/CloudAtlas:user@x.com"));
        assert!(uri.contains("secret=ABCDEF"));
    }
}
