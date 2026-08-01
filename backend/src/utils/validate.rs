//! Shared input validators for request payloads.
//!
//! Handlers use these instead of ad-hoc checks so validation rules are
//! consistent across the API surface. All functions return `Result<(), String>`
//! with a user-facing error message.

/// Validate an email address: exactly one `@`, non-empty local part, and a
/// dotted domain without spaces/control characters.
pub fn email(value: &str) -> Result<(), String> {
    let v = value.trim();
    if v.is_empty() || v.len() > 254 {
        return Err("Email is required (max 254 characters)".into());
    }
    let mut parts = v.split('@');
    let local = parts.next().unwrap_or_default();
    let domain = parts.next().unwrap_or_default();
    if local.is_empty() || domain.is_empty() || parts.next().is_some() {
        return Err("Invalid email format".into());
    }
    if !domain.contains('.') || domain.starts_with('.') || domain.ends_with('.') {
        return Err("Invalid email domain".into());
    }
    if local.chars().any(char::is_whitespace) || domain.chars().any(char::is_whitespace) {
        return Err("Email must not contain whitespace".into());
    }
    Ok(())
}

/// Password policy: >= 8 chars with at least one letter and one digit.
pub fn password(value: &str) -> Result<(), String> {
    if value.len() < 8 {
        return Err("Password must be at least 8 characters".into());
    }
    if value.len() > 128 {
        return Err("Password must be at most 128 characters".into());
    }
    if !value.chars().any(|c| c.is_alphabetic()) || !value.chars().any(|c| c.is_ascii_digit()) {
        return Err("Password must contain at least one letter and one digit".into());
    }
    Ok(())
}

/// Display / resource names: non-empty, trimmed, bounded, no control chars.
pub fn name(value: &str, max: usize, label: &str) -> Result<(), String> {
    let v = value.trim();
    if v.is_empty() {
        return Err(format!("{label} is required"));
    }
    if v.len() > max {
        return Err(format!("{label} must be at most {max} characters"));
    }
    if v.chars().any(char::is_control) {
        return Err(format!("{label} must not contain control characters"));
    }
    Ok(())
}

/// HTTP(S) webhook endpoint URLs.
pub fn webhook_url(value: &str) -> Result<(), String> {
    let v = value.trim();
    if !(v.starts_with("http://") || v.starts_with("https://")) {
        return Err("URL must start with http:// or https://".into());
    }
    let rest = v
        .strip_prefix("https://")
        .or_else(|| v.strip_prefix("http://"))
        .unwrap_or_default();
    if rest.is_empty() || rest.starts_with('/') || rest.contains(char::is_whitespace) {
        return Err("URL must include a valid host".into());
    }
    Ok(())
}

/// Exactly one of a whitelisted set of string values.
pub fn one_of<'a, I>(value: &str, allowed: I, label: &str) -> Result<(), String>
where
    I: IntoIterator<Item = &'a str>,
{
    if allowed.into_iter().any(|a| a == value) {
        Ok(())
    } else {
        Err(format!("{label} has an invalid value"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_accepts_valid_rejects_invalid() {
        assert!(email("ops@acme.com").is_ok());
        assert!(email("a.b+c@sub.example.io").is_ok());
        assert!(email("").is_err());
        assert!(email("no-at").is_err());
        assert!(email("a@b").is_err());
        assert!(email("two@at@signs.com").is_err());
        assert!(email("has space@x.com").is_err());
        assert!(email("x@.starts-dot.com").is_err());
    }

    #[test]
    fn password_policy() {
        assert!(password("abc12345").is_ok());
        assert!(password("short1").is_err());
        assert!(password("allletters").is_err());
        assert!(password("12345678").is_err());
        assert!(password(&"a1".repeat(70)).is_err()); // > 128
    }

    #[test]
    fn name_rules() {
        assert!(name("prod-cluster", 64, "Name").is_ok());
        assert!(name("  ", 64, "Name").is_err());
        assert!(name(&"x".repeat(65), 64, "Name").is_err());
        assert!(name("bad\u{0007}name", 64, "Name").is_err());
    }

    #[test]
    fn url_rules() {
        assert!(webhook_url("https://hooks.slack.com/services/abc").is_ok());
        assert!(webhook_url("http://localhost:8080/hook").is_ok());
        assert!(webhook_url("ftp://x.com").is_err());
        assert!(webhook_url("https://").is_err());
        assert!(webhook_url("https://exa mple.com").is_err());
    }

    #[test]
    fn one_of_rule() {
        assert!(one_of("aws", ["aws", "gcp"], "provider").is_ok());
        assert!(one_of("azure", ["aws", "gcp"], "provider").is_err());
    }
}
