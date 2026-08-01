//! AI feature endpoints: chat assistant (SSE), smart recommendation
//! explanations, Holt-Winters forecasting, z-score anomaly detection, a RAG
//! notes corpus, and per-org feature settings.

use axum::{
    body::Body,
    extract::{Extension, Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    modules::auth::service::Claims,
    state::AppState,
};

use futures_util::StreamExt;

use super::{analytics, provider};

async fn ensure_org_member(db: &sqlx::PgPool, org_id: Uuid, user_id: Uuid) -> AppResult<()> {
    sqlx::query(
        "SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::Forbidden("Not a member of this organization".into()))?;
    Ok(())
}

// ─── AI settings ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct UpdateAiSettingsRequest {
    pub assistant_enabled: Option<bool>,
    pub smart_recs_enabled: Option<bool>,
    pub forecast_enabled: Option<bool>,
    pub anomaly_enabled: Option<bool>,
    pub rag_enabled: Option<bool>,
}

pub async fn get_ai_settings(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let row = sqlx::query(
        r#"SELECT assistant_enabled, smart_recs_enabled, forecast_enabled,
                  anomaly_enabled, rag_enabled, updated_at
           FROM ai_settings WHERE organization_id = $1"#,
    )
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?;

    let settings = match row {
        Some(r) => json!({
            "assistant_enabled": r.get::<bool, _>("assistant_enabled"),
            "smart_recs_enabled": r.get::<bool, _>("smart_recs_enabled"),
            "forecast_enabled": r.get::<bool, _>("forecast_enabled"),
            "anomaly_enabled": r.get::<bool, _>("anomaly_enabled"),
            "rag_enabled": r.get::<bool, _>("rag_enabled"),
            "updated_at": r.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
        }),
        None => json!({
            "assistant_enabled": true,
            "smart_recs_enabled": true,
            "forecast_enabled": true,
            "anomaly_enabled": true,
            "rag_enabled": true,
            "updated_at": Value::Null,
        }),
    };

    Ok(Json(json!({ "data": settings })))
}

pub async fn update_ai_settings(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(req): Json<UpdateAiSettingsRequest>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    sqlx::query(
        r#"INSERT INTO ai_settings
               (organization_id, assistant_enabled, smart_recs_enabled,
                forecast_enabled, anomaly_enabled, rag_enabled)
           VALUES ($1, COALESCE($2, true), COALESCE($3, true),
                   COALESCE($4, true), COALESCE($5, true), COALESCE($6, true))
           ON CONFLICT (organization_id) DO UPDATE SET
               assistant_enabled = COALESCE($2, ai_settings.assistant_enabled),
               smart_recs_enabled = COALESCE($3, ai_settings.smart_recs_enabled),
               forecast_enabled = COALESCE($4, ai_settings.forecast_enabled),
               anomaly_enabled = COALESCE($5, ai_settings.anomaly_enabled),
               rag_enabled = COALESCE($6, ai_settings.rag_enabled),
               updated_at = NOW()"#,
    )
    .bind(org_id)
    .bind(req.assistant_enabled)
    .bind(req.smart_recs_enabled)
    .bind(req.forecast_enabled)
    .bind(req.anomaly_enabled)
    .bind(req.rag_enabled)
    .execute(&state.db)
    .await?;

    let row = sqlx::query(
        "SELECT assistant_enabled, smart_recs_enabled, forecast_enabled, anomaly_enabled, rag_enabled FROM ai_settings WHERE organization_id = $1",
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(json!({
        "data": {
            "assistant_enabled": row.get::<bool, _>("assistant_enabled"),
            "smart_recs_enabled": row.get::<bool, _>("smart_recs_enabled"),
            "forecast_enabled": row.get::<bool, _>("forecast_enabled"),
            "anomaly_enabled": row.get::<bool, _>("anomaly_enabled"),
            "rag_enabled": row.get::<bool, _>("rag_enabled"),
        }
    })))
}

// ─── AI Assistant (SSE) ──────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ChatRequest {
    pub message: String,
}

/// POST /orgs/:org_id/ai/chat — Server-Sent Events stream.
///
/// Streams the assistant reply (single event when AI is disabled or the
/// upstream call fails — the client treats both the same way).
pub async fn chat(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(req): Json<ChatRequest>,
) -> AppResult<Response> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let system = "You are CloudAtlas Copilot, a FinOps + CMDB assistant. Answer concisely about cloud costs, budgets, recommendations, and infrastructure. When asked about data you cannot see, suggest the relevant CloudAtlas page.";
    let reply = provider::chat_completion(&state, org_id, system, &req.message).await.unwrap_or_else(|| {
        "AI assistant is not configured (set OPENAI_API_KEY and AI_ENABLED=true). Meanwhile, try the Cost Explorer, Recommendations, or CMDB pages for answers.".to_string()
    });

    let body = format!(
        "data: {}\n\n",
        serde_json::to_string(&json!({ "reply": reply })).unwrap_or_default()
    );

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        Body::from(body),
    )
        .into_response())
}

// ─── Smart Recommendations ───────────────────────────────────────────────────

/// POST /orgs/:org_id/ai/explain/:rec_id — LLM explanation of a recommendation,
/// cached in `details.ai_explanation`.
pub async fn explain_recommendation(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, rec_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let row = sqlx::query(
        r#"SELECT title, description, rec_type, status, potential_savings,
                  current_monthly_cost, details
           FROM recommendations
           WHERE id = $1 AND organization_id = $2"#,
    )
    .bind(rec_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("Recommendation {rec_id} not found")))?;

    let title: String = row.get("title");
    let description: String = row.get("description");
    let rec_type: String = row.get("rec_type");
    let savings: f64 = row.get("potential_savings");
    let cost: f64 = row.get("current_monthly_cost");
    let mut details: Value = row.get("details");

    // Serve from cache when present.
    if let Some(cached) = details.get("ai_explanation").and_then(|v| v.as_str()) {
        return Ok(Json(json!({ "data": { "explanation": cached, "cached": true } })));
    }

    let prompt = format!(
        "Explain this cloud cost recommendation in 3-4 sentences for a non-expert:\n\
         Title: {title}\nDescription: {description}\nType: {rec_type}\n\
         Current monthly cost: ${cost:.2}\nPotential monthly savings: ${savings:.2}\n\
         What should the user do and why?"
    );

    let explanation = provider::chat_completion(&state, org_id, "You are a cloud cost analyst.", &prompt)
        .await
        .unwrap_or_else(|| {
            format!(
                "{description} — this {rec_type} finding is worth ${savings:.2}/month in potential savings (current cost ${cost:.2}/month). Review it in the Recommendations page and dismiss or act accordingly."
            )
        });

    // Cache in details JSONB.
    if let Some(obj) = details.as_object_mut() {
        obj.insert("ai_explanation".into(), Value::String(explanation.clone()));
        let _ = sqlx::query("UPDATE recommendations SET details = $2 WHERE id = $1")
            .bind(rec_id)
            .bind(&details)
            .execute(&state.db)
            .await;
    }

    Ok(Json(json!({ "data": { "explanation": explanation, "cached": false } })))
}

// ─── Forecasting ─────────────────────────────────────────────────────────────

/// POST /orgs/:org_id/ai/forecast?pool_id=…&service=… — Holt-Winters forecast
/// of daily spend, optionally scoped to a pool or service (A2).
pub async fn forecast(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let pool_id = q.get("pool_id").and_then(|v| Uuid::parse_str(v).ok());
    let service = q.get("service").cloned();

    let days = if let Some(pid) = pool_id {
        sqlx::query(
            r#"SELECT date, SUM(cost) AS total
               FROM expenses
               WHERE organization_id = $1 AND pool_id = $2 AND date >= CURRENT_DATE - 90
               GROUP BY date ORDER BY date"#,
        )
        .bind(org_id)
        .bind(pid)
        .fetch_all(&state.db)
        .await?
    } else if let Some(svc) = service.as_deref() {
        sqlx::query(
            r#"SELECT date, SUM(cost) AS total
               FROM expenses
               WHERE organization_id = $1 AND service_name = $2 AND date >= CURRENT_DATE - 90
               GROUP BY date ORDER BY date"#,
        )
        .bind(org_id)
        .bind(svc)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query(
            r#"SELECT date, SUM(cost) AS total
               FROM expenses
               WHERE organization_id = $1 AND date >= CURRENT_DATE - 90
               GROUP BY date ORDER BY date"#,
        )
        .bind(org_id)
        .fetch_all(&state.db)
        .await?
    };

    let series: Vec<f64> = days.iter().map(|r| r.get::<f64, _>("total")).collect();
    let forecast = analytics::holt_winters_forecast(&series, 14, 7);

    let last_date = days
        .last()
        .map(|r| r.get::<chrono::NaiveDate, _>("date"))
        .unwrap_or_else(|| chrono::Utc::now().date_naive());

    let points: Vec<Value> = forecast
        .iter()
        .enumerate()
        .map(|(i, v)| {
            json!({
                "date": (last_date + chrono::Duration::days(i as i64 + 1)).to_string(),
                "forecast": (v * 100.0).round() / 100.0,
            })
        })
        .collect();

    let total: f64 = series.iter().sum();
    let projected: f64 = forecast.iter().sum();

    let result = json!({
        "horizon_days": forecast.len(),
        "points": points,
        "summary": {
            "historical_total": (total * 100.0).round() / 100.0,
            "projected_total_next_14d": (projected * 100.0).round() / 100.0,
            "model": "holt-winters (additive trend + seasonality, 7-day)",
        },
    });

    // Persist the run for history (G9).
    let _ = sqlx::query(
        r#"INSERT INTO ai_analysis_runs (organization_id, kind, params, result)
           VALUES ($1, 'forecast', $2, $3)"#,
    )
    .bind(org_id)
    .bind(json!({ "horizon_days": forecast.len() }))
    .bind(&result)
    .execute(&state.db)
    .await;

    Ok(Json(json!({ "data": result })))
}

// ─── Anomaly Detection ───────────────────────────────────────────────────────

/// POST /orgs/:org_id/ai/anomalies — z-score spikes/drops on daily spend.
pub async fn anomalies(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let days = sqlx::query(
        r#"SELECT date, SUM(cost) AS total
           FROM expenses
           WHERE organization_id = $1 AND date >= CURRENT_DATE - 60
           GROUP BY date ORDER BY date"#,
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let series: Vec<(chrono::NaiveDate, f64)> = days
        .iter()
        .map(|r| (r.get::<chrono::NaiveDate, _>("date"), r.get::<f64, _>("total")))
        .collect();

    let found = analytics::zscore_anomalies(&series, 2.5, 10.0);

    let anomalies: Vec<Value> = found
        .iter()
        .map(|(date, value, z, direction)| {
            let z_abs = z.abs();
            let severity = if z_abs >= 5.0 {
                "critical"
            } else if z_abs >= 3.0 {
                "high"
            } else {
                "medium"
            };
            json!({
                "date": date.to_string(),
                "value": (value * 100.0).round() / 100.0,
                "z_score": (z * 100.0).round() / 100.0,
                "direction": direction,
                "severity": severity,
            })
        })
        .collect();

    let result = json!({
        "anomalies": anomalies,
        "checked_days": series.len(),
        "threshold_z": 2.5,
    });

    // Persist the run for history (G9).
    let _ = sqlx::query(
        r#"INSERT INTO ai_analysis_runs (organization_id, kind, params, result)
           VALUES ($1, 'anomaly', $2, $3)"#,
    )
    .bind(org_id)
    .bind(json!({ "checked_days": series.len(), "threshold_z": 2.5 }))
    .bind(&result)
    .execute(&state.db)
    .await;

    Ok(Json(json!({ "data": result })))
}

// ─── RAG notes corpus ────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateNoteRequest {
    pub title: String,
    pub body: String,
}

/// POST /orgs/:org_id/ai/notes — store a note; embeds it when AI is enabled.
pub async fn create_note(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(req): Json<CreateNoteRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;
    crate::utils::validate::name(&req.title, 255, "Note title").map_err(AppError::Validation)?;
    if req.body.trim().is_empty() {
        return Err(AppError::Validation("Note body is required".into()));
    }

    let embedding = provider::embed_text(&state, org_id, &format!("{} {}", req.title, req.body)).await;
    let embedded = embedding.is_some();
    let embedding_json = serde_json::to_value(embedding.unwrap_or_default()).unwrap_or(json!([]));

    let row = sqlx::query(
        r#"INSERT INTO ai_notes (organization_id, title, body, embedding, created_by)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, created_at"#,
    )
    .bind(org_id)
    .bind(&req.title)
    .bind(&req.body)
    .bind(embedding_json)
    .bind(claims.user_id()?)
    .fetch_one(&state.db)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id": row.get::<Uuid, _>("id"),
                "embedded": embedded,
                "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            }
        })),
    ))
}

#[derive(Deserialize)]
pub struct SearchNotesRequest {
    pub query: String,
    pub limit: Option<i64>,
}

/// POST /orgs/:org_id/ai/notes/search — semantic search over embedded notes.
/// Falls back to ILIKE keyword search when embeddings are unavailable.
/// Shared notes-search logic used by the HTTP handler and the copilot tool.
/// Returns (results, mode) where mode is "semantic" or "keyword".
pub async fn search_notes_query(
    state: &AppState,
    org_id: Uuid,
    query: &str,
    limit: i64,
) -> (Vec<Value>, String) {
    let limit = limit.clamp(1, 20);

    if let Some(query_emb) = provider::embed_text(state, org_id, query).await {
        let rows = sqlx::query(
            "SELECT id, title, body, embedding FROM ai_notes WHERE organization_id = $1",
        )
        .bind(org_id)
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();

        let mut scored: Vec<(f64, Value)> = Vec::new();
        for r in rows {
            let emb: Value = r.get("embedding");
            let vec: Vec<f64> = emb
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_f64()).collect())
                .unwrap_or_default();
            let score = provider::cosine_similarity(&query_emb, &vec);
            if score > 0.0 {
                scored.push((
                    score,
                    json!({
                        "id": r.get::<Uuid, _>("id"),
                        "title": r.get::<String, _>("title"),
                        "body": r.get::<String, _>("body"),
                        "score": (score * 1000.0).round() / 1000.0,
                    }),
                ));
            }
        }
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let results: Vec<Value> = scored.into_iter().take(limit as usize).map(|(_, v)| v).collect();
        return (results, "semantic".into());
    }

    // Fallback: keyword search.
    let pattern = format!("%{query}%");
    let rows = sqlx::query(
        r#"SELECT id, title, body FROM ai_notes
           WHERE organization_id = $1 AND (title ILIKE $2 OR body ILIKE $2)
           ORDER BY created_at DESC LIMIT $3"#,
    )
    .bind(org_id)
    .bind(&pattern)
    .bind(limit)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    let results: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "title": r.get::<String, _>("title"),
                "body": r.get::<String, _>("body"),
                "score": 1.0,
            })
        })
        .collect();

    (results, "keyword".into())
}

pub async fn search_notes(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(req): Json<SearchNotesRequest>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let (results, mode) = search_notes_query(&state, org_id, &req.query, req.limit.unwrap_or(5)).await;
    Ok(Json(json!({ "data": results, "mode": mode })))
}

pub async fn list_notes(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT id, title, body, created_at FROM ai_notes
           WHERE organization_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_notes WHERE organization_id = $1")
        .bind(org_id)
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "title": r.get::<String, _>("title"),
                "body": r.get::<String, _>("body"),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) })))
}

// ─── Copilot ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CopilotMessage {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct CopilotRequest {
    pub messages: Vec<CopilotMessage>,
    /// Optional conversation to persist history into (G3).
    pub conversation_id: Option<Uuid>,
    /// Frontend hint: the route the user is viewing (≤ 200 chars). Optional.
    #[serde(default)]
    pub page_context: Option<String>,
}

/// POST /orgs/:org_id/ai/copilot/chat — SSE copilot conversation.
///
/// LLM mode: context digest + tool calling loop, then streamed answer.
/// Local mode: deterministic digest-based answer. Same SSE protocol both ways.
pub async fn chat_copilot(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(req): Json<CopilotRequest>,
) -> AppResult<Response> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    if req.messages.is_empty() {
        return Ok(super::copilot::stream_text(
            "Ask me anything about your cloud spend, budgets or recommendations.",
        ));
    }
    if req.messages.len() > 20 {
        return Err(AppError::Validation("Too many messages (max 20)".into()));
    }
    let user_message = req
        .messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default();
    if user_message.len() > super::copilot::MAX_MESSAGE_LEN {
        return Err(AppError::Validation("Message too long".into()));
    }
    if let Some(pc) = req.page_context.as_deref() {
        if pc.len() > 200 {
            return Err(AppError::Validation("page_context too long (max 200 chars)".into()));
        }
    }

    let digest = super::copilot::build_context_digest(&state.db, org_id).await;

    // Persist the conversation + user message (G3).
    let conv_id = persist_conversation(&state, org_id, claims.user_id()?, req.conversation_id, &user_message)
        .await;

    // LLM mode: tool calling + token streaming (org provider → env → local).
    let provider = super::provider_config::resolve(&state, org_id).await;
    if provider.enabled {
        if let Some(resp) = llm_copilot_stream(
            &state,
            org_id,
            claims.user_id()?,
            &req.messages,
            &digest,
            conv_id,
            req.page_context.as_deref(),
            &provider,
        )
        .await
        {
            return Ok(resp);
        }
        // Fall through to local mode on any LLM failure.
    }

    let reply = super::copilot::local_copilot_reply(&digest, &user_message);
    persist_assistant_message(&state, org_id, conv_id, &reply).await;

    // Emit the conversation id first so the UI can resume history (G3).
    let mut body = String::new();
    if let Some(id) = conv_id {
        body.push_str(&format!("data: {}\n\n", json!({ "conversation_id": id })));
    }
    body.push_str(&format!("data: {}\n\n", json!({ "delta": reply })));
    body.push_str("data: {\"done\":true}\n\n");
    Ok(super::copilot::sse_response(body))
}

/// Prepend a `conversation_id` SSE frame to a streamed body (G3).
fn prepend_conversation_frame(body: &mut String, conv_id: Option<Uuid>) {
    if let Some(id) = conv_id {
        let frame = json!({ "conversation_id": id });
        let mut with_id = format!("data: {frame}\n\n");
        with_id.push_str(body);
        *body = with_id;
    }
}

/// Upsert the conversation row and store the user message. Returns the
/// conversation id (None when persistence fails — chat still works).
async fn persist_conversation(
    state: &AppState,
    org_id: Uuid,
    user_id: Uuid,
    conversation_id: Option<Uuid>,
    user_message: &str,
) -> Option<Uuid> {
    let conv_id = match conversation_id {
        Some(id) => {
            // Verify ownership, then touch updated_at.
            let _ = sqlx::query(
                "UPDATE ai_conversation SET updated_at = NOW() WHERE id = $1 AND organization_id = $2 AND user_id = $3",
            )
            .bind(id)
            .bind(org_id)
            .bind(user_id)
            .execute(&state.db)
            .await;
            // Title from the first user message when unset.
            let _ = sqlx::query(
                "UPDATE ai_conversation SET title = COALESCE(title, $4) WHERE id = $1 AND organization_id = $2 AND user_id = $3 AND title IS NULL",
            )
            .bind(id)
            .bind(org_id)
            .bind(user_id)
            .bind(user_message.chars().take(80).collect::<String>())
            .execute(&state.db)
            .await;
            Some(id)
        }
        None => {
            sqlx::query(
                r#"INSERT INTO ai_conversation (organization_id, user_id, title)
                   VALUES ($1, $2, $3) RETURNING id"#,
            )
            .bind(org_id)
            .bind(user_id)
            .bind(user_message.chars().take(80).collect::<String>())
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten()
            .map(|r| r.try_get::<Uuid, _>("id").unwrap_or(Uuid::new_v4()))
        }
    };

    if let Some(id) = conv_id {
        let _ = sqlx::query(
            r#"INSERT INTO ai_message (conversation_id, role, content)
               VALUES ($1, 'user', $2)"#,
        )
        .bind(id)
        .bind(user_message)
        .execute(&state.db)
        .await;
    }
    conv_id
}

async fn persist_assistant_message(state: &AppState, org_id: Uuid, conv_id: Option<Uuid>, reply: &str) {
    if let Some(id) = conv_id {
        let _ = sqlx::query(
            r#"INSERT INTO ai_message (conversation_id, role, content)
               VALUES ($1, 'assistant', $2)"#,
        )
        .bind(id)
        .bind(reply)
        .execute(&state.db)
        .await;
        let _ = sqlx::query(
            "UPDATE ai_conversation SET updated_at = NOW() WHERE id = $1 AND organization_id = $2",
        )
        .bind(id)
        .bind(org_id)
        .execute(&state.db)
        .await;
    }
}

/// Run the tool-calling loop (non-streaming) and then stream the final answer.
/// Returns None when the upstream call fails (caller falls back to local).
async fn llm_copilot_stream(
    state: &AppState,
    org_id: Uuid,
    user_id: Uuid,
    messages: &[CopilotMessage],
    digest: &Value,
    conv_id: Option<Uuid>,
    page_context: Option<&str>,
    provider: &super::provider_config::ResolvedProvider,
) -> Option<Response> {
    let key = provider.api_key.as_deref()?;
    let client = reqwest::Client::new();
    let url = format!("{}/chat/completions", provider.base_url);

    let mut system = format!(
        "You are CloudAtlas Copilot, a FinOps + CMDB assistant inside the CloudAtlas platform. \
         Answer concisely in the user's language. Use the provided tools to answer data questions; \
         never invent numbers. If a tool returns empty data, say so plainly.\n\n{}",
        super::copilot::digest_prompt(digest)
    );
    if let Some(pc) = page_context {
        system.push_str(&format!(
            "\n\nCurrent page: {} (the user is viewing this page; prefer answers relevant to it).",
            pc
        ));
    }

    let mut api_messages: Vec<Value> = vec![json!({ "role": "system", "content": system })];
    for m in messages {
        let role = if m.role == "assistant" { "assistant" } else { "user" };
        api_messages.push(json!({ "role": role, "content": m.content }));
    }

    // Tool-call loop (non-streaming rounds).
    for _ in 0..super::copilot::MAX_TOOL_ROUNDS {
        let payload = json!({
            "model": provider.chat_model,
            "messages": api_messages,
            "tools": super::copilot::tool_definitions(),
            "tool_choice": "auto",
            "temperature": 0.2,
        });

        let resp = client
            .post(&url)
            .bearer_auth(key)
            .json(&payload)
            .timeout(std::time::Duration::from_secs(60))
            .send()
            .await
            .ok()?;

        let body: Value = resp.json().await.ok()?;
        let message = &body["choices"][0]["message"];
        let tool_calls = message["tool_calls"].as_array().cloned().unwrap_or_default();

        if tool_calls.is_empty() {
            api_messages.push(message.clone());
            break;
        }

        api_messages.push(message.clone());
        for call in &tool_calls {
            let call_id = call["id"].as_str().unwrap_or("call_0");
            let fn_name = call["function"]["name"].as_str().unwrap_or("");
            let fn_args: Value = serde_json::from_str(
                call["function"]["arguments"].as_str().unwrap_or("{}"),
            )
            .unwrap_or_else(|_| json!({}));

            let result = super::copilot::execute_tool(state, org_id, user_id, fn_name, &fn_args).await;
            api_messages.push(json!({
                "role": "tool",
                "tool_call_id": call_id,
                "content": serde_json::to_string(&result).unwrap_or_else(|_| "{}".into()),
            }));
        }
    }

    // Final streaming round for the answer.
    let payload = json!({
        "model": provider.chat_model,
        "messages": api_messages,
        "stream": true,
        "temperature": 0.2,
    });

    let resp = client
        .post(&url)
        .bearer_auth(key)
        .json(&payload)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    // Forward OpenAI deltas as our own SSE frames.
    let mut stream = resp.bytes_stream();
    let mut body = String::new();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(_) => break,
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim().to_string();
            buffer.drain(..=pos);
            if let Some(data) = line.strip_prefix("data: ") {
                if data == "[DONE]" {
                    break;
                }
                if let Ok(v) = serde_json::from_str::<Value>(data) {
                    if let Some(delta) = v["choices"][0]["delta"]["content"].as_str() {
                        let frame = json!({ "delta": delta });
                        body.push_str(&format!("data: {frame}\n\n"));
                    }
                }
            }
        }
    }
    body.push_str("data: {\"done\":true}\n\n");

    // Persist the assistant reply assembled from the streamed deltas.
    let full_reply = extract_streamed_text(&body);
    if !full_reply.is_empty() {
        persist_assistant_message(state, org_id, conv_id, &full_reply).await;
    }

    prepend_conversation_frame(&mut body, conv_id);

    Some(super::copilot::sse_response(body))
}

/// Reassemble plain text from our own SSE delta frames.
fn extract_streamed_text(sse_body: &str) -> String {
    let mut out = String::new();
    for line in sse_body.lines() {
        if let Some(data) = line.trim().strip_prefix("data: ") {
            if let Ok(v) = serde_json::from_str::<Value>(data) {
                if let Some(delta) = v["delta"].as_str() {
                    out.push_str(delta);
                }
            }
        }
    }
    out
}

// ─── Conversations (persistent copilot history) ──────────────────────────────

#[derive(Deserialize)]
pub struct CreateConversationRequest {
    pub title: Option<String>,
}

/// GET /orgs/:id/ai/conversations — list the caller's conversations (newest first).
pub async fn list_conversations(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT c.id, c.title, c.created_at, c.updated_at,
                  (SELECT COUNT(*) FROM ai_message m WHERE m.conversation_id = c.id) AS message_count
           FROM ai_conversation c
           WHERE c.organization_id = $1 AND c.user_id = $2
           ORDER BY c.updated_at DESC, c.id DESC
           LIMIT $3 OFFSET $4"#,
    )
    .bind(org_id)
    .bind(claims.user_id()?)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ai_conversation WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(org_id)
    .bind(claims.user_id()?)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "title": r.get::<Option<String>, _>("title"),
                "message_count": r.get::<i64, _>("message_count"),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
                "updated_at": r.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) })))
}

/// POST /orgs/:id/ai/conversations — start a new conversation.
pub async fn create_conversation(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(req): Json<CreateConversationRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let row = sqlx::query(
        r#"INSERT INTO ai_conversation (organization_id, user_id, title)
           VALUES ($1, $2, $3)
           RETURNING id, title, created_at"#,
    )
    .bind(org_id)
    .bind(claims.user_id()?)
    .bind(req.title.as_deref())
    .fetch_one(&state.db)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id": row.get::<Uuid, _>("id"),
                "title": row.get::<Option<String>, _>("title"),
                "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            }
        })),
    ))
}

/// GET /orgs/:id/ai/conversations/:conv_id/messages — history for resume.
/// Newest-first pages (`created_at DESC`); clients that need chronological
/// order reverse the page(s) they load.
pub async fn list_conversation_messages(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, conv_id)): Path<(Uuid, Uuid)>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let owns = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM ai_conversation WHERE id = $1 AND organization_id = $2 AND user_id = $3",
    )
    .bind(conv_id)
    .bind(org_id)
    .bind(claims.user_id()?)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    if owns == 0 {
        return Err(AppError::NotFound(format!("Conversation {conv_id} not found")));
    }

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT id, role, content, created_at
           FROM ai_message WHERE conversation_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(conv_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_message WHERE conversation_id = $1")
        .bind(conv_id)
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "role": r.get::<String, _>("role"),
                "content": r.get::<String, _>("content"),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) })))
}

/// DELETE /orgs/:id/ai/conversations/:conv_id — remove a conversation.
pub async fn delete_conversation(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, conv_id)): Path<(Uuid, Uuid)>,
) -> AppResult<(StatusCode, Json<Value>)> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let result = sqlx::query(
        "DELETE FROM ai_conversation WHERE id = $1 AND organization_id = $2 AND user_id = $3",
    )
    .bind(conv_id)
    .bind(org_id)
    .bind(claims.user_id()?)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Conversation {conv_id} not found")));
    }

    Ok((StatusCode::NO_CONTENT, Json(json!({}))))
}

// ─── Anomaly root-cause explanation (G4) ─────────────────────────────────────

/// POST /orgs/:id/ai/anomalies/:event_id/explain — LLM root-cause analysis of
/// an alert event, cached in `alert_events.ai_explanation`.
pub async fn explain_anomaly(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, event_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let row = sqlx::query(
        r#"SELECT message, threshold::float8, actual_value::float8, alert_type::text,
                  ai_explanation
           FROM alert_events
           WHERE id = $1 AND organization_id = $2"#,
    )
    .bind(event_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("Alert event {event_id} not found")))?;

    if let Some(cached) = row.get::<Option<String>, _>("ai_explanation") {
        return Ok(Json(json!({ "data": { "explanation": cached, "cached": true } })));
    }

    let message: String = row.get("message");
    let threshold: f64 = row.get("threshold");
    let actual: f64 = row.get("actual_value");
    let alert_type: String = row.get("alert_type");

    let prompt = format!(
        "Analyze this cloud budget alert in 3-4 sentences for a non-expert: \
         '{message}' (threshold {threshold}, actual {actual}, type {alert_type}). \
         What are likely root causes and what should the user check first?"
    );

    let explanation = provider::chat_completion(
        &state,
        org_id,
        "You are a cloud cost analyst explaining budget alerts.",
        &prompt,
    )
    .await
    .unwrap_or_else(|| {
        format!(
            "This {alert_type} alert fired because spend ({actual:.2}) crossed the threshold ({threshold:.2}). \
             Check the Alerts page for the affected pool, review recent expense trends on the Cost Explorer, \
             and look for new resources or traffic spikes in that period."
        )
    });

    let _ = sqlx::query("UPDATE alert_events SET ai_explanation = $2 WHERE id = $1")
        .bind(event_id)
        .bind(&explanation)
        .execute(&state.db)
        .await;

    Ok(Json(json!({ "data": { "explanation": explanation, "cached": false } })))
}

// ─── Analysis run history (G9) ───────────────────────────────────────────────

/// GET /orgs/:id/ai/analysis-runs?kind=forecast — persisted forecast/anomaly runs.
pub async fn list_analysis_runs(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let kind = q.get("kind").map(String::as_str).unwrap_or("");
    let bounds = crate::utils::pagination::PageQuery {
        page: q.get("page").cloned(),
        per_page: q.get("per_page").cloned(),
        limit: q.get("limit").cloned(),
        offset: q.get("offset").cloned(),
    }
    .resolve(50, 200);

    let rows = if kind.is_empty() {
        sqlx::query(
            r#"SELECT id, kind, params, result, created_at
               FROM ai_analysis_runs WHERE organization_id = $1
               ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3"#,
        )
        .bind(org_id)
        .bind(bounds.limit)
        .bind(bounds.offset)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query(
            r#"SELECT id, kind, params, result, created_at
               FROM ai_analysis_runs WHERE organization_id = $1 AND kind = $2
               ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4"#,
        )
        .bind(org_id)
        .bind(kind)
        .bind(bounds.limit)
        .bind(bounds.offset)
        .fetch_all(&state.db)
        .await?
    };

    let total: i64 = if kind.is_empty() {
        sqlx::query_scalar("SELECT COUNT(*) FROM ai_analysis_runs WHERE organization_id = $1")
            .bind(org_id)
            .fetch_one(&state.db)
            .await
            .unwrap_or(0)
    } else {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM ai_analysis_runs WHERE organization_id = $1 AND kind = $2",
        )
        .bind(org_id)
        .bind(kind)
        .fetch_one(&state.db)
        .await
        .unwrap_or(0)
    };

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "kind": r.get::<String, _>("kind"),
                "params": r.get::<Value, _>("params"),
                "result": r.get::<Value, _>("result"),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) })))
}

// ─── RAG over resources (G5) ─────────────────────────────────────────────────

/// POST /orgs/:id/ai/resources/embed — (re)build embeddings for all active
/// resources. Each resource's summary (name/type/service/region/tags) is
/// embedded and stored in `resource_embeddings`. No-op rows when AI is off.
pub async fn embed_resources(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let rows = sqlx::query(
        r#"SELECT id, name, resource_type, service_name, cloud_region, tags
           FROM resources
           WHERE organization_id = $1 AND active = true
           LIMIT 2000"#,
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let mut embedded = 0u32;
    for r in &rows {
        let resource_id: Uuid = r.get("id");
        let name: Option<String> = r.get("name");
        let resource_type: Option<String> = r.get("resource_type");
        let service: Option<String> = r.get("service_name");
        let region: Option<String> = r.get("cloud_region");
        let tags: Value = r.get("tags");

        let summary = format!(
            "{} {} service={} region={} tags={}",
            name.as_deref().unwrap_or("resource"),
            resource_type.as_deref().unwrap_or("other"),
            service.as_deref().unwrap_or(""),
            region.as_deref().unwrap_or(""),
            tags
        );

        if let Some(embedding) = provider::embed_text(&state, org_id, &summary).await {
            let embedding_json =
                serde_json::to_value(embedding).unwrap_or_else(|_| json!([]));
            let _ = sqlx::query(
                r#"INSERT INTO resource_embeddings (resource_id, organization_id, embedding)
                   VALUES ($1, $2, $3)
                   ON CONFLICT (resource_id) DO UPDATE SET embedding = $3, updated_at = NOW()"#,
            )
            .bind(resource_id)
            .bind(org_id)
            .bind(embedding_json)
            .execute(&state.db)
            .await;
            embedded += 1;
        }
    }

    Ok(Json(json!({
        "data": { "embedded": embedded, "total_resources": rows.len() }
    })))
}

/// GET /orgs/:id/ai/resources/search?q=… — semantic resource search with a
/// keyword fallback (same contract as the copilot tool).
pub async fn search_resources(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let query = q.get("q").cloned().unwrap_or_default();
    if query.trim().is_empty() {
        return Ok(Json(json!({ "data": [], "mode": "keyword" })));
    }
    let limit: i64 = q.get("limit").and_then(|v| v.parse().ok()).unwrap_or(5).clamp(1, 20);

    let (results, mode) = search_resources_query(&state, org_id, &query, limit).await;
    Ok(Json(json!({ "data": results, "mode": mode })))
}

/// Shared resource search used by the HTTP endpoint and the copilot tool.
pub async fn search_resources_query(
    state: &AppState,
    org_id: Uuid,
    query: &str,
    limit: i64,
) -> (Vec<Value>, String) {
    let limit = limit.clamp(1, 20);

    if let Some(query_emb) = provider::embed_text(state, org_id, query).await {
        let rows = sqlx::query(
            r#"SELECT re.resource_id, re.embedding, r.name, r.resource_type,
                      r.service_name, r.cloud_region, r.total_cost::float8 AS total_cost
               FROM resource_embeddings re
               JOIN resources r ON r.id = re.resource_id
               WHERE re.organization_id = $1 AND r.active = true"#,
        )
        .bind(org_id)
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();

        let mut scored: Vec<(f64, Value)> = Vec::new();
        for r in rows {
            let emb: Value = r.get("embedding");
            let vec: Vec<f64> = emb
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_f64()).collect())
                .unwrap_or_default();
            let score = provider::cosine_similarity(&query_emb, &vec);
            if score > 0.0 {
                scored.push((
                    score,
                    json!({
                        "resource_id": r.get::<Uuid, _>("resource_id"),
                        "name": r.get::<Option<String>, _>("name"),
                        "resource_type": r.get::<Option<String>, _>("resource_type"),
                        "service": r.get::<Option<String>, _>("service_name"),
                        "region": r.get::<Option<String>, _>("cloud_region"),
                        "total_cost": r.get::<f64, _>("total_cost"),
                        "score": (score * 1000.0).round() / 1000.0,
                    }),
                ));
            }
        }
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let results: Vec<Value> = scored.into_iter().take(limit as usize).map(|(_, v)| v).collect();
        if !results.is_empty() {
            return (results, "semantic".into());
        }
    }

    // Keyword fallback over resources.
    let pattern = format!("%{query}%");
    let rows = sqlx::query(
        r#"SELECT id AS resource_id, name, resource_type, service_name, cloud_region, total_cost::float8 AS total_cost
           FROM resources
           WHERE organization_id = $1 AND active = true
             AND (name ILIKE $2 OR service_name ILIKE $2 OR cloud_region ILIKE $2)
           ORDER BY total_cost DESC LIMIT $3"#,
    )
    .bind(org_id)
    .bind(&pattern)
    .bind(limit)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    let results: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "resource_id": r.get::<Uuid, _>("resource_id"),
                "name": r.get::<Option<String>, _>("name"),
                "resource_type": r.get::<Option<String>, _>("resource_type"),
                "service": r.get::<Option<String>, _>("service_name"),
                "region": r.get::<Option<String>, _>("cloud_region"),
                "total_cost": r.get::<f64, _>("total_cost"),
                "score": 1.0,
            })
        })
        .collect();

    (results, "keyword".into())
}

// ── AI provider config (spec 2026-08-14-ai-provider-config-ui-design §4.4) ──

#[derive(Deserialize)]
pub struct UpdateAiProviderRequest {
    pub ai_provider_enabled: Option<bool>,
    pub ai_base_url: Option<String>,
    /// Write-only: non-empty ⇒ store; "__CLEAR__" ⇒ unset; absent/empty ⇒ unchanged.
    pub api_key: Option<String>,
    pub ai_chat_model: Option<String>,
    pub ai_embed_model: Option<String>,
}

fn validate_provider_fields(
    base_url: Option<&str>,
    chat: Option<&str>,
    embed: Option<&str>,
    key: Option<&str>,
) -> AppResult<()> {
    for (name, v, max) in [
        ("base_url", base_url, 500usize),
        ("chat_model", chat, 100),
        ("embed_model", embed, 100),
        ("api_key", key, 400),
    ] {
        if let Some(v) = v {
            if v.len() > max {
                return Err(AppError::Validation(format!("{name} too long (max {max} chars)")));
            }
        }
    }
    if let Some(u) = base_url {
        let ok = (u.starts_with("https://") || u.starts_with("http://")) && u.len() > 8;
        if !ok {
            return Err(AppError::Validation("base_url must start with http:// or https://".into()));
        }
    }
    Ok(())
}

/// In-memory rate limiter for /provider/test: 5/min/org (spec §4.4).
static TEST_LIMITER: std::sync::OnceLock<tokio::sync::Mutex<std::collections::HashMap<Uuid, Vec<std::time::Instant>>>> =
    std::sync::OnceLock::new();

/// GET /orgs/:org_id/ai/provider — effective + stored config; key never returned.
pub async fn get_ai_provider(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;
    let stored = super::provider_config::load_stored(&state, org_id).await;
    let effective = super::provider_config::resolve(&state, org_id).await;
    let env_present = state.config.ai_enabled && state.config.openai_api_key.is_some();
    Ok(Json(json!({ "data": super::provider_config::masked_json(&stored, &effective, env_present) })))
}

/// PUT /orgs/:org_id/ai/provider — partial update (AdminOrg). `api_key` is
/// write-only: non-empty stores (encrypted), "__CLEAR__" unsets, absent keeps.
pub async fn update_ai_provider(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(req): Json<UpdateAiProviderRequest>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;
    crate::middleware::rbac::require_permission(
        &state.db,
        claims.user_id()?,
        org_id,
        crate::middleware::rbac::Permission::AdminOrg,
    )
    .await?;

    let key_opt: Option<Option<String>> = match req.api_key.as_deref() {
        None | Some("") => None, // unchanged
        Some("__CLEAR__") => Some(None), // unset
        Some(k) => Some(Some(k.to_string())),
    };
    validate_provider_fields(
        req.ai_base_url.as_deref(),
        req.ai_chat_model.as_deref(),
        req.ai_embed_model.as_deref(),
        key_opt.as_ref().and_then(|k| k.as_deref()),
    )?;

    let key_enc: Option<String> = match &key_opt {
        Some(Some(plain)) => {
            let ck = crate::crypto::key_from_hex(&state.config.encryption_key).ok_or_else(|| {
                AppError::Validation("server ENCRYPTION_KEY not configured (must be 64 hex chars)".into())
            })?;
            Some(crate::crypto::encrypt(&ck, plain.as_bytes()))
        }
        _ => None,
    };
    let key_write = key_enc.is_some() || matches!(key_opt, Some(None));

    sqlx::query(
        r#"INSERT INTO ai_settings
               (organization_id, ai_provider_enabled, ai_base_url, ai_api_key_enc, ai_chat_model, ai_embed_model)
           VALUES ($1, COALESCE($2, false), $3, $4, $5, $6)
           ON CONFLICT (organization_id) DO UPDATE SET
               ai_provider_enabled = COALESCE($2, ai_settings.ai_provider_enabled),
               ai_base_url  = COALESCE($7, ai_settings.ai_base_url),
               ai_api_key_enc  = CASE WHEN $8 THEN $4 ELSE ai_settings.ai_api_key_enc END,
               ai_chat_model  = COALESCE($9, ai_settings.ai_chat_model),
               ai_embed_model = COALESCE($10, ai_settings.ai_embed_model),
               updated_at = NOW()"#,
    )
    .bind(org_id)
    .bind(req.ai_provider_enabled)
    .bind(req.ai_base_url.clone())   // $3
    .bind(&key_enc)                   // $4
    .bind(req.ai_chat_model.clone())  // $5
    .bind(req.ai_embed_model.clone()) // $6
    .bind(req.ai_base_url.clone())    // $7
    .bind(key_write)                  // $8
    .bind(req.ai_chat_model.clone())  // $9
    .bind(req.ai_embed_model.clone()) // $10
    .execute(&state.db)
    .await?;

    // Post-condition: enabling requires a usable key somewhere (spec §4.4).
    let stored = super::provider_config::load_stored(&state, org_id).await;
    let effective = super::provider_config::resolve(&state, org_id).await;
    if matches!(stored, Some(ref s) if s.enabled) && !effective.enabled {
        return Err(AppError::Validation("no API key configured — set one before enabling AI".into()));
    }

    let env_present = state.config.ai_enabled && state.config.openai_api_key.is_some();
    Ok(Json(json!({ "data": super::provider_config::masked_json(&stored, &effective, env_present) })))
}

/// POST /orgs/:org_id/ai/provider/test — 1-token ping against the would-be-saved
/// config (AdminOrg, 5/min/org). Never persists anything.
pub async fn test_ai_provider(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(req): Json<UpdateAiProviderRequest>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;
    crate::middleware::rbac::require_permission(
        &state.db,
        claims.user_id()?,
        org_id,
        crate::middleware::rbac::Permission::AdminOrg,
    )
    .await?;

    // Rate limit: 5/min/org.
    let limiter = TEST_LIMITER.get_or_init(|| tokio::sync::Mutex::new(std::collections::HashMap::new()));
    {
        let mut map = limiter.lock().await;
        let now = std::time::Instant::now();
        let hits = map.entry(org_id).or_default();
        hits.retain(|t| now.duration_since(*t).as_secs() < 60);
        if hits.len() >= 5 {
            return Err(AppError::TooManyRequests("test rate limit exceeded (5 per minute)".into()));
        }
        hits.push(now);
    }

    // Overlay the request's non-empty fields onto the saved row.
    let mut stored = super::provider_config::load_stored(&state, org_id)
        .await
        .unwrap_or_default();
    if let Some(e) = req.ai_provider_enabled {
        stored.enabled = e;
    }
    if let Some(u) = req.ai_base_url.clone().filter(|s| !s.is_empty()) {
        stored.base_url = Some(u);
    }
    match req.api_key.as_deref() {
        Some("__CLEAR__") => stored.api_key = None,
        Some(k) if !k.is_empty() => stored.api_key = Some(k.to_string()),
        _ => {}
    }
    if let Some(m) = req.ai_chat_model.clone().filter(|s| !s.is_empty()) {
        stored.chat_model = Some(m);
    }
    if let Some(m) = req.ai_embed_model.clone().filter(|s| !s.is_empty()) {
        stored.embed_model = Some(m);
    }
    validate_provider_fields(
        stored.base_url.as_deref(),
        stored.chat_model.as_deref(),
        stored.embed_model.as_deref(),
        stored.api_key.as_deref(),
    )?;

    let env = super::provider_config::EnvProvider {
        enabled: state.config.ai_enabled,
        api_key: state.config.openai_api_key.clone(),
        chat_model: Some(state.config.openai_model.clone()).filter(|s| !s.is_empty()),
        embed_model: Some(state.config.openai_embedding_model.clone()).filter(|s| !s.is_empty()),
    };
    let p = super::provider_config::pick(&Some(stored), &env);
    if !p.enabled {
        return Ok(Json(json!({ "data": { "ok": false, "error": "no API key configured" } })));
    }

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/chat/completions", p.base_url))
        .bearer_auth(p.api_key.unwrap_or_default())
        .json(&json!({
            "model": p.chat_model,
            "messages": [{ "role": "user", "content": "ping" }],
            "max_tokens": 1,
        }))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await;

    let (ok, status, error) = match resp {
        Ok(r) => {
            let code = r.status().as_u16();
            if r.status().is_success() {
                (true, Some(code), None)
            } else {
                (false, Some(code), Some(format!("upstream returned {code}")))
            }
        }
        Err(e) => (false, None, Some(e.to_string())),
    };
    Ok(Json(json!({ "data": { "ok": ok, "status": status, "error": error } })))
}
