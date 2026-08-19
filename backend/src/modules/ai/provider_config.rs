//! Effective AI provider resolution (spec 2026-08-14-ai-provider-config-ui-design.md §4.2):
//! org row → env → local. All fields fall back to defaults when NULL at the winning layer.

use crate::state::AppState;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

pub const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
pub const DEFAULT_CHAT_MODEL: &str = "gpt-4o-mini";
pub const DEFAULT_EMBED_MODEL: &str = "text-embedding-3-small";

#[derive(Debug, Clone, PartialEq)]
pub enum ProviderSource {
    Org,
    Env,
    Local,
}

impl ProviderSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderSource::Org => "org",
            ProviderSource::Env => "env",
            ProviderSource::Local => "local",
        }
    }
}

/// The effective provider a request should use.
#[derive(Debug, Clone)]
pub struct ResolvedProvider {
    pub enabled: bool,
    pub base_url: String,
    pub api_key: Option<String>,
    pub chat_model: String,
    pub embed_model: String,
    pub source: ProviderSource,
}

/// What the org's ai_settings row stores (pre-resolution, key decrypted).
#[derive(Debug, Clone, Default)]
pub struct StoredProvider {
    pub enabled: bool,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub chat_model: Option<String>,
    pub embed_model: Option<String>,
}

/// What the .env layer provides.
#[derive(Debug, Clone, Default)]
pub struct EnvProvider {
    pub enabled: bool,
    pub api_key: Option<String>,
    pub chat_model: Option<String>,
    pub embed_model: Option<String>,
}

/// Precedence: enabled org row with a key → enabled env with a key → local.
pub fn pick(org: &Option<StoredProvider>, env: &EnvProvider) -> ResolvedProvider {
    if let Some(o) = org {
        if o.enabled {
            if let Some(key) = o.api_key.as_deref() {
                if !key.is_empty() {
                    return ResolvedProvider {
                        enabled: true,
                        base_url: o
                            .base_url
                            .clone()
                            .unwrap_or_else(|| DEFAULT_BASE_URL.into()),
                        api_key: Some(key.to_string()),
                        chat_model: o
                            .chat_model
                            .clone()
                            .unwrap_or_else(|| DEFAULT_CHAT_MODEL.into()),
                        embed_model: o
                            .embed_model
                            .clone()
                            .unwrap_or_else(|| DEFAULT_EMBED_MODEL.into()),
                        source: ProviderSource::Org,
                    };
                }
            }
        }
    }
    if env.enabled {
        if let Some(key) = env.api_key.as_deref() {
            if !key.is_empty() {
                return ResolvedProvider {
                    enabled: true,
                    base_url: DEFAULT_BASE_URL.into(),
                    api_key: Some(key.to_string()),
                    chat_model: env
                        .chat_model
                        .clone()
                        .unwrap_or_else(|| DEFAULT_CHAT_MODEL.into()),
                    embed_model: env
                        .embed_model
                        .clone()
                        .unwrap_or_else(|| DEFAULT_EMBED_MODEL.into()),
                    source: ProviderSource::Env,
                };
            }
        }
    }
    ResolvedProvider {
        enabled: false,
        base_url: DEFAULT_BASE_URL.into(),
        api_key: None,
        chat_model: DEFAULT_CHAT_MODEL.into(),
        embed_model: DEFAULT_EMBED_MODEL.into(),
        source: ProviderSource::Local,
    }
}

/// Load the org's stored provider config (key decrypted when possible;
/// an undecryptable envelope degrades to None → env fallback).
pub async fn load_stored(state: &AppState, org_id: Uuid) -> Option<StoredProvider> {
    let row = sqlx::query(
        r#"SELECT ai_provider_enabled, ai_base_url, ai_api_key_enc, ai_chat_model, ai_embed_model
           FROM ai_settings WHERE organization_id = $1"#,
    )
    .bind(org_id)
    .fetch_optional(&state.db)
    .await
    .ok()??;

    let key = crate::crypto::key_from_hex(&state.config.encryption_key).unwrap_or([0u8; 32]);
    let api_key = row
        .try_get::<Option<String>, _>("ai_api_key_enc")
        .ok()
        .flatten()
        .and_then(|enc| crate::crypto::decrypt(&key, &enc))
        .and_then(|b| String::from_utf8(b).ok())
        .filter(|s| !s.is_empty());

    Some(StoredProvider {
        enabled: row
            .try_get::<bool, _>("ai_provider_enabled")
            .unwrap_or(false),
        base_url: row
            .try_get::<Option<String>, _>("ai_base_url")
            .ok()
            .flatten(),
        api_key,
        chat_model: row
            .try_get::<Option<String>, _>("ai_chat_model")
            .ok()
            .flatten(),
        embed_model: row
            .try_get::<Option<String>, _>("ai_embed_model")
            .ok()
            .flatten(),
    })
}

fn env_provider(state: &AppState) -> EnvProvider {
    EnvProvider {
        enabled: state.config.ai_enabled,
        api_key: state.config.openai_api_key.clone(),
        chat_model: Some(state.config.openai_model.clone()).filter(|m| !m.is_empty()),
        embed_model: Some(state.config.openai_embedding_model.clone()).filter(|m| !m.is_empty()),
    }
}

/// Resolve the effective provider for an org (org → env → local).
pub async fn resolve(state: &AppState, org_id: Uuid) -> ResolvedProvider {
    let stored = load_stored(state, org_id).await;
    let env = env_provider(state);
    pick(&stored, &env)
}

/// JSON summary for GET/PUT responses — never includes key material.
pub fn masked_json(
    stored: &Option<StoredProvider>,
    effective: &ResolvedProvider,
    env_present: bool,
) -> serde_json::Value {
    let s = stored.as_ref();
    let hint = s.and_then(|x| x.api_key.as_deref()).map(|k| {
        let chars: Vec<char> = k.chars().collect();
        format!(
            "…{}",
            chars[chars.len().saturating_sub(4)..]
                .iter()
                .collect::<String>()
        )
    });
    json!({
        "source": effective.source.as_str(),
        "api_key_set": hint.is_some(),
        "api_key_hint": hint,
        "env_present": env_present,
        "stored": {
            "ai_provider_enabled": s.map(|x| x.enabled).unwrap_or(false),
            "ai_base_url": s.and_then(|x| x.base_url.clone()),
            "ai_chat_model": s.and_then(|x| x.chat_model.clone()),
            "ai_embed_model": s.and_then(|x| x.embed_model.clone()),
        },
        "effective": {
            "base_url": effective.base_url,
            "chat_model": effective.chat_model,
            "embed_model": effective.embed_model,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn org_stored() -> StoredProvider {
        StoredProvider {
            enabled: true,
            base_url: Some("https://relay.example.com/v1".into()),
            api_key: Some("sk-org".into()),
            chat_model: Some("glm-4o".into()),
            embed_model: None,
        }
    }

    #[test]
    fn org_row_wins_when_enabled_with_key() {
        let env = EnvProvider {
            enabled: true,
            api_key: Some("sk-env".into()),
            chat_model: None,
            embed_model: None,
        };
        let r = pick(&Some(org_stored()), &env);
        assert!(r.enabled);
        assert_eq!(r.source, ProviderSource::Org);
        assert_eq!(r.base_url, "https://relay.example.com/v1");
        assert_eq!(r.api_key.as_deref(), Some("sk-org"));
        assert_eq!(r.chat_model, "glm-4o");
        assert_eq!(r.embed_model, "text-embedding-3-small"); // NULL → default
    }

    #[test]
    fn env_used_when_org_absent_or_disabled_or_keyless() {
        let env = EnvProvider {
            enabled: true,
            api_key: Some("sk-env".into()),
            chat_model: Some("gpt-4o".into()),
            embed_model: None,
        };
        assert_eq!(pick(&None, &env).source, ProviderSource::Env);
        assert_eq!(pick(&None, &env).chat_model, "gpt-4o");

        let mut disabled = org_stored();
        disabled.enabled = false;
        assert_eq!(pick(&Some(disabled), &env).source, ProviderSource::Env);

        let mut keyless = org_stored();
        keyless.api_key = None;
        assert_eq!(pick(&Some(keyless), &env).source, ProviderSource::Env);
    }

    #[test]
    fn local_when_nothing_configured() {
        let r = pick(&None, &EnvProvider::default());
        assert!(!r.enabled);
        assert_eq!(r.source, ProviderSource::Local);
        assert_eq!(r.base_url, "https://api.openai.com/v1");
        assert_eq!(r.chat_model, "gpt-4o-mini");
        assert!(r.api_key.is_none());
    }

    #[test]
    fn masked_json_hides_key_and_takes_last4() {
        let env = EnvProvider::default();
        let r = pick(&Some(org_stored()), &env);
        let v = masked_json(&Some(org_stored()), &r, false);
        assert_eq!(v["source"], "org");
        assert_eq!(v["api_key_set"], true);
        assert_eq!(v["api_key_hint"].as_str().unwrap(), "…-org");
        assert!(v.to_string().find("sk-org-full").is_none());
    }
}
