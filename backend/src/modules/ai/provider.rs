//! OpenAI-compatible LLM/embedding client.
//!
//! All calls degrade gracefully: when no provider resolves (neither org
//! config nor env), [`chat_completion`] returns `None` and callers fall back
//! to deterministic behavior — the UI always works, LLM answers are a bonus.

use crate::state::AppState;
use uuid::Uuid;

/// Request a chat completion using the org's resolved provider (org → env →
/// local). Returns the assistant text, or `None` when disabled / the upstream
/// call fails (failure is logged, not fatal).
pub async fn chat_completion(
    state: &AppState,
    org_id: Uuid,
    system: &str,
    user: &str,
) -> Option<String> {
    let p = super::provider_config::resolve(state, org_id).await;
    if !p.enabled {
        return None;
    }
    let key = p.api_key.as_deref()?;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/chat/completions", p.base_url))
        .bearer_auth(key)
        .json(&serde_json::json!({
            "model": p.chat_model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user },
            ],
            "temperature": 0.3,
        }))
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await;

    match resp {
        Ok(r) => {
            let body: serde_json::Value = match r.json().await {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(error = %e, "AI: chat response parse failed");
                    return None;
                }
            };
            body["choices"][0]["message"]["content"]
                .as_str()
                .map(|s| s.trim().to_string())
        }
        Err(e) => {
            tracing::warn!(error = %e, "AI: chat request failed");
            None
        }
    }
}

/// Embed a text with the resolved embedding model. Returns `None` when
/// disabled or the call fails.
pub async fn embed_text(state: &AppState, org_id: Uuid, text: &str) -> Option<Vec<f64>> {
    let p = super::provider_config::resolve(state, org_id).await;
    if !p.enabled {
        return None;
    }
    let key = p.api_key.as_deref()?;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/embeddings", p.base_url))
        .bearer_auth(key)
        .json(&serde_json::json!({
            "model": p.embed_model,
            "input": text,
        }))
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await;

    match resp {
        Ok(r) => {
            let body: serde_json::Value = match r.json().await {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(error = %e, "AI: embedding parse failed");
                    return None;
                }
            };
            body["data"][0]["embedding"]
                .as_array()
                .map(|arr| arr.iter().filter_map(|v| v.as_f64()).collect())
        }
        Err(e) => {
            tracing::warn!(error = %e, "AI: embedding request failed");
            None
        }
    }
}

/// Cosine similarity between two embedding vectors.
pub fn cosine_similarity(a: &[f64], b: &[f64]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let dot: f64 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let na: f64 = a.iter().map(|x| x * x).sum::<f64>().sqrt();
    let nb: f64 = b.iter().map(|x| x * x).sum::<f64>().sqrt();
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na * nb)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cosine_identical_vectors() {
        let v = vec![1.0, 0.0, 0.0];
        assert!((cosine_similarity(&v, &v) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn cosine_orthogonal_vectors() {
        let a = vec![1.0, 0.0];
        let b = vec![0.0, 1.0];
        assert!(cosine_similarity(&a, &b).abs() < 1e-9);
    }

    #[test]
    fn cosine_mismatched_lengths() {
        assert_eq!(cosine_similarity(&[1.0], &[1.0, 2.0]), 0.0);
        assert_eq!(cosine_similarity(&[], &[]), 0.0);
    }
}
