//! At-rest credential encryption (AES-256-GCM) with a versioned envelope.
//!
//! Credentials are stored in `cloud_accounts.credentials_enc` as a string:
//! - `v1:<base64(nonce || ciphertext)>` — AES-256-GCM encrypted (current)
//! - `<base64(json)>` — legacy plain base64 from before encryption (still
//!   readable via the fallback in [`decrypt`], so existing accounts keep working)
//!
//! The key comes from the 64-hex-char `ENCRYPTION_KEY` environment variable.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rand::RngCore;

/// Versioned envelope prefix marking AES-256-GCM ciphertext.
const ENVELOPE_V1: &str = "v1:";

/// Parse a 64-hex-char ENCRYPTION_KEY into a 32-byte AES-256 key.
/// Returns None for anything that is not exactly 64 hex digits.
pub fn key_from_hex(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut key = [0u8; 32];
    for (i, byte) in key.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(key)
}

/// Encrypt `plaintext` with a fresh random 96-bit nonce; returns a `v1:` envelope.
pub fn encrypt(key: &[u8; 32], plaintext: &[u8]) -> String {
    let cipher = Aes256Gcm::new_from_slice(key).expect("AES-256-GCM accepts 32-byte keys");
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .expect("AES-256-GCM encryption of in-memory buffer cannot fail");

    let mut blob = Vec::with_capacity(12 + ciphertext.len());
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ciphertext);
    format!("{ENVELOPE_V1}{}", BASE64.encode(blob))
}

/// Decrypt a `v1:` envelope. Falls back to plain base64 decode for legacy
/// records created before encryption was introduced.
pub fn decrypt(key: &[u8; 32], data: &str) -> Option<Vec<u8>> {
    if let Some(rest) = data.strip_prefix(ENVELOPE_V1) {
        let blob = BASE64.decode(rest).ok()?;
        if blob.len() < 12 {
            return None;
        }
        let (nonce_bytes, ciphertext) = blob.split_at(12);
        let cipher = Aes256Gcm::new_from_slice(key).ok()?;
        cipher
            .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
            .ok()
    } else {
        BASE64.decode(data).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> [u8; 32] {
        key_from_hex("0000000000000000000000000000000000000000000000000000000000000000")
            .expect("64 zeros parse")
    }

    #[test]
    fn key_from_hex_validates_length_and_hex() {
        assert!(key_from_hex("ab".repeat(32).as_str()).is_some());
        assert!(key_from_hex("zz".repeat(32).as_str()).is_none());
        assert!(key_from_hex("ab").is_none());
        assert!(key_from_hex("ab".repeat(31).as_str()).is_none());
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let key = test_key();
        let secret = b"{\"access_key\":\"AKIA...\",\"secret\":\"s3cr3t\"}";
        let envelope = encrypt(&key, secret);
        assert!(envelope.starts_with(ENVELOPE_V1));
        assert_eq!(decrypt(&key, &envelope).as_deref(), Some(secret.as_slice()));
    }

    #[test]
    fn decrypt_legacy_base64_fallback() {
        let key = test_key();
        let legacy = BASE64.encode(b"{\"legacy\":true}");
        assert_eq!(decrypt(&key, &legacy).as_deref(), Some(b"{\"legacy\":true}".as_slice()));
    }

    #[test]
    fn decrypt_wrong_key_fails() {
        let key = test_key();
        let other = key_from_hex("11".repeat(32).as_str()).unwrap();
        let envelope = encrypt(&key, b"secret");
        assert!(decrypt(&other, &envelope).is_none());
    }

    #[test]
    fn unique_nonces_per_encryption() {
        let key = test_key();
        let a = encrypt(&key, b"same");
        let b = encrypt(&key, b"same");
        assert_ne!(a, b);
    }
}
