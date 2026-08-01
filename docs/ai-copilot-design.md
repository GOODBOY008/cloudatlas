# CloudAtlas AI Copilot — Design

> Status: implemented 2026-08-14 · UI redesigned 2026-08-14 (docked panel) · Backend `modules/ai/copilot.rs` · Frontend `components/CopilotPanel.tsx`

## 1. Goals

A conversational assistant embedded in the CloudAtlas UI that answers questions about the
current organization's cloud spend, recommendations, budgets, resources and anomalies —
and that remains **useful without any LLM API key** (local fallback mode).

Non-goals: autonomous actions (no mutations), multi-org switching inside a session.

## 2. Architecture

```
┌──────────────────────────┐        SSE (text/event-stream)        ┌──────────────────────────┐
│  CopilotPanel (React)    │ ───── POST /orgs/:id/ai/copilot/chat ─▶│  chat_copilot handler     │
│  floating slide-over     │ ◀───── data: {"delta":"..."}…[DONE] ──│  modules/ai/copilot.rs     │
└──────────────────────────┘                                        └────────────┬─────────────┘
                                                                                 │
                                                      ┌──────────────────────────┼──────────────────────────┐
                                                      ▼                          ▼                          ▼
                                           OpenAI enabled?              context digest            tool executor
                                           (AI_ENABLED + key)      (org stats snapshot)     (DB-backed, read-only)
                                                      │                          │                          │
                                                      ▼                          ▼                          ▼
                                           chat completions            local copilot              ┌─ expenses summary
                                           + tool calling loop        (intent templates)          ├─ top resources
                                                      │                                          ├─ recommendations
                                                      ▼                                          ├─ budget status
                                           token stream forwarded                              ├─ anomalies
                                           as SSE deltas                                        ├─ forecast
                                                                                                └─ RAG notes search
```

- **Tenant isolation**: every handler starts with `ensure_org_member`; all tool queries are
  `organization_id`-scoped with bound parameters only.
- **Read-only**: tools never INSERT/UPDATE/DELETE.
- **Streaming protocol**: SSE frames `data: {"delta": "<text chunk>"}` followed by
  `data: {"done": true}`. Both modes (LLM + local) speak the same protocol, so the UI is
  mode-agnostic.

## 3. Context digest

`build_context_digest(db, org_id)` returns a compact JSON snapshot the model (and the local
fallback) can reason over:

```json
{
  "org_name": "...",
  "month_to_date_cost": 1234.56,
  "last_30d_cost": 5678.90,
  "trend_direction": "up|down|flat",
  "resource_count": 42,
  "active_recommendations": 7,
  "top_recommendation_savings": 312.50,
  "budget_status": "on_track|warning|over_budget|no_budgets",
  "open_anomalies": 2,
  "projected_30d_cost": 6100.00
}
```

Costs: single aggregated SQL pass per metric, bounded by `CURRENT_DATE - 90`.

## 4. Tools (function calling)

| Tool | Args | Returns |
|---|---|---|
| `get_expense_summary` | `days` (7/30/90) | total, avg/day, by-service top 5 |
| `get_top_resources` | `limit` | name, type, service, cost |
| `get_recommendations` | `limit`, `status?` | title, type, savings, status |
| `get_budget_status` | — | per-pool budget, spend, utilization |
| `get_anomalies` | `days` | date, value, z-score, direction |
| `get_forecast` | `days` (7/14/30) | Holt-Winters projections |
| `search_notes` | `query` | RAG hits (embedding or keyword) |

LLM mode: OpenAI `tools` (JSON-schema) — up to 3 tool-call rounds, tool results appended as
`role: "tool"` messages, then the final answer is streamed.

## 5. Local fallback copilot (no API key)

Intent detection on the user message (keyword scoring over the digest), answering from the
digest with templates:

| Intent | Example prompt | Answer source |
|---|---|---|
| spend | "how much did we spend" | MTD + 30d + trend |
| top | "top resources" | top 5 by cost |
| recommendations | "recommendations/savings" | counts + biggest saving |
| budget | "budget/alert" | budget status per pool |
| anomaly | "anomaly" | open anomaly count |
| forecast | "forecast" | projected cost |
| resources | "how many resources" | resource count |
| default | anything else | summary overview + capability hint |

Deterministic → unit-testable.

## 6. Security

- Org membership required; tools scoped by `organization_id`.
- System prompt forbids acting on data outside the digest/tools; no mutation tools exist.
- Message length capped (4096 chars); SSE responses capped (4k tokens).
- API key stays server-side (env `OPENAI_API_KEY`), never exposed to the client.

## 7. Frontend

- `CopilotPanel` — non-modal right-docked panel (resizable 320–560 px) on desktop,
  bottom sheet from a bottom-right FAB on mobile; entry via the labeled header
  button or Cmd/Ctrl+I. Conversation UI lives in `components/copilot/CopilotChat.tsx`
  (stop/copy/markdown-lite/scroll-pause/page-context pill).
- Streaming via `fetch` + `ReadableStream` parsing of the SSE frames (axios can't stream).
- Panel state is local to the Layout; conversation history kept in React state.

## 8. Provider config (2026-08-14)

LLM provider settings are resolved per organization at request time — no config-file edits or
restarts needed:

- **Resolution order**: org config (Settings → AI Provider) → server `.env`
  (`AI_ENABLED`/`OPENAI_API_KEY`/models) → local template mode.
- **Storage**: `ai_settings` columns (migration 025); the API key is stored AES-256-GCM
  encrypted (`crypto.rs` v1 envelope) and is **never returned** by the API — reads get
  `api_key_set` + a last-4 hint.
- **Endpoints**: `GET/PUT /orgs/:id/ai/provider` (writes require AdminOrg; `api_key` is
  write-only, `"__CLEAR__"` unsets) and `POST /orgs/:id/ai/provider/test` (1-token ping
  against the would-be-saved config, rate-limited 5/min/org).
- Any OpenAI-compatible endpoint works (relay / vLLM / Ollama) via `ai_base_url`.
- Enabling org AI requires a key somewhere; otherwise the PUT fails 422.

## 9. Files

| Area | Files |
|---|---|
| Backend | `backend/src/modules/ai/copilot.rs` (new), `backend/src/modules/ai/handlers.rs` (route fn), `backend/src/routes.rs` |
| Frontend | `frontend/src/components/CopilotPanel.tsx` (new), `frontend/src/components/Layout.tsx`, `frontend/src/i18n/locales/{en,zh}.ts` |
| Docs | `docs/ai-copilot-design.md` (this file) |
