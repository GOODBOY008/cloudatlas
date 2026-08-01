#!/usr/bin/env bash
# CloudAtlas API smoke test suite
# Usage: ./scripts/smoke_test.sh [BASE_URL]
# Default BASE_URL: http://localhost:8080

set -euo pipefail

BASE="${1:-http://localhost:8080}"
PASS=0; FAIL=0

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'; BOLD='\033[1m'

check() {
  local name="$1"; local code="$2"; local expected="${3:-200}"
  if [ "$code" = "$expected" ]; then
    echo -e "${GREEN}✅ PASS${NC}: $name (HTTP $code)"
    PASS=$((PASS+1))
  else
    echo -e "${RED}❌ FAIL${NC}: $name (expected $expected, got $code)"
    FAIL=$((FAIL+1))
  fi
}

section() { echo -e "\n${BOLD}──── $1 ────${NC}"; }

# ─── Health ───────────────────────────────────────────────────────────────────
section "Health"
check "/health" "$(curl -so/dev/null -w '%{http_code}' $BASE/health)"
check "/health/ready" "$(curl -so/dev/null -w '%{http_code}' $BASE/health/ready)"
check "/swagger-ui/" "$(curl -so/dev/null -w '%{http_code}' $BASE/swagger-ui/)"
check "/api-docs/openapi.json" "$(curl -so/dev/null -w '%{http_code}' $BASE/api-docs/openapi.json)"

# ─── Auth ─────────────────────────────────────────────────────────────────────
section "Auth"

# Register unique user
TS=$(date +%s)
REG=$(curl -s -w '\n%{http_code}' -X POST $BASE/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"smoke_${TS}@test.com\",\"password\":\"Password123!\",\"display_name\":\"Smoke $TS\"}")
REG_CODE=$(echo "$REG" | tail -1)
check "POST /auth/register" "$REG_CODE" "201"

# Login with seed admin
LOGIN=$(curl -s -X POST $BASE/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@acme.com","password":"Password123!"}')
LOGIN_CODE=$(echo "$LOGIN" | python3 -c "import sys,json; d=json.load(sys.stdin); print('200' if 'access_token' in d.get('data',{}) else '500')" 2>/dev/null || echo "500")
check "POST /auth/login" "$LOGIN_CODE"

TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['access_token'])" 2>/dev/null || echo "")
if [ -z "$TOKEN" ]; then
  echo -e "${RED}FATAL: Could not obtain token. Remaining tests will fail.${NC}"
  echo "LOGIN response: $LOGIN"
  exit 1
fi
AUTH="Authorization: Bearer $TOKEN"
ORG="a0000000-0000-0000-0000-000000000001"

check "GET /auth/me" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" $BASE/api/v1/auth/me)"

# ─── Organizations ────────────────────────────────────────────────────────────
section "Organizations"
check "GET /organizations/:id" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" $BASE/api/v1/organizations/$ORG)"
check "GET /organizations/:id/members" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" $BASE/api/v1/organizations/$ORG/members)"

# ─── Cloud Accounts ───────────────────────────────────────────────────────────
section "Cloud Accounts"
ACCT="d0000000-0000-0000-0000-000000000001"
check "GET /cloud-accounts" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/cloud-accounts")"
check "GET /cloud-accounts/:id" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/cloud-accounts/$ACCT")"
check "POST /cloud-accounts/:id/test" "$(curl -so/dev/null -w '%{http_code}' -X POST -H "$AUTH" "$BASE/api/v1/orgs/$ORG/cloud-accounts/$ACCT/test")"
check "POST /cloud-accounts/:id/sync" "$(curl -so/dev/null -w '%{http_code}' -X POST -H "$AUTH" "$BASE/api/v1/orgs/$ORG/cloud-accounts/$ACCT/sync")" "202"
check "GET /cloud-accounts/:id/sync-jobs" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/cloud-accounts/$ACCT/sync-jobs")"

# ─── CMDB ─────────────────────────────────────────────────────────────────────
section "CMDB"
CI="f0000000-0000-0000-0000-000000000001"
check "GET /ci-types" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/ci-types")"
check "GET /cis" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/cis")"
check "GET /cis/:id" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/cis/$CI")"
check "GET /cis/:id/associations" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/cis/$CI/associations")"
check "GET /cis/:id/history" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/cis/$CI/history")"

# ─── Expenses ─────────────────────────────────────────────────────────────────
section "Expenses"
check "GET /expenses" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/expenses")"
check "GET /expenses/summary" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/expenses/summary")"
check "GET /expenses/trend" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/expenses/trend")"
check "GET /expenses/by-service" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/expenses/by-service")"
check "GET /expenses/by-cloud" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/expenses/by-cloud")"
check "GET /expenses/by-pool" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/expenses/by-pool")"
check "GET /expenses/top-resources" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/expenses/top-resources")"

# Cost Map endpoints (Loop 1 additions)
check "GET /expenses/region-expenses" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/expenses/region-expenses")"
check "GET /expenses/cost-map?primary_dim=service" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/expenses/cost-map?primary_dim=service")"
check "GET /expenses/cost-map?primary_dim=cloud&secondary_dim=region" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/expenses/cost-map?primary_dim=cloud&secondary_dim=region")"
check "GET /expenses/unit-economics" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/expenses/unit-economics")"

# ─── Pools ────────────────────────────────────────────────────────────────────
section "Pools"
check "GET /pools" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/pools")"

NEW_POOL=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/pools" \
  -d "{\"name\":\"smoke-pool-${TS}\",\"pool_type\":\"project\"}")
POOL_ID=$(echo "$NEW_POOL" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('id',''))" 2>/dev/null)
[ -n "$POOL_ID" ] && check "POST /pools" "200" || check "POST /pools" "500"
if [ -n "$POOL_ID" ]; then
  check "GET /pools/:id" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/pools/$POOL_ID")"
fi

# Budget Matrix (Loop 1 addition)
check "GET /pools/budget-matrix" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/pools/budget-matrix")"

# ─── Recommendations ──────────────────────────────────────────────────────────
section "Recommendations"
check "GET /recommendations" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/recommendations")"

# ─── Webhooks ─────────────────────────────────────────────────────────────────
section "Webhooks"
check "GET /webhooks" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/webhooks")"
NEW_HOOK=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/webhooks" \
  -d "{\"name\":\"smoke-hook-${TS}\",\"url\":\"https://example.com/smoke\",\"events\":[\"budget.exceeded\"]}")
HOOK_ID=$(echo "$NEW_HOOK" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null)
[ -n "$HOOK_ID" ] && check "POST /webhooks" "201" "201" || check "POST /webhooks" "500"
if [ -n "$HOOK_ID" ]; then
  check "PUT /webhooks/:id" "$(curl -so/dev/null -w '%{http_code}' -X PUT -H "$AUTH" -H "Content-Type: application/json" "$BASE/api/v1/orgs/$ORG/webhooks/$HOOK_ID" -d '{"is_active":false}')"
  check "DELETE /webhooks/:id" "$(curl -so/dev/null -w '%{http_code}' -X DELETE -H "$AUTH" "$BASE/api/v1/orgs/$ORG/webhooks/$HOOK_ID")" "204"
fi
check "GET /webhook-events" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/webhook-events")"

# ─── Constraints ──────────────────────────────────────────────────────────────
section "Constraints"
check "GET /constraints" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/constraints")"
check "POST /constraints/evaluate" "$(curl -so/dev/null -w '%{http_code}' -X POST -H "$AUTH" "$BASE/api/v1/orgs/$ORG/constraints/evaluate")"

# ─── Checklist & Events ───────────────────────────────────────────────────────
section "Checklist & Events"
check "GET /recommendations/checklist" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/recommendations/checklist")"
check "PATCH /recommendations/checklist" "$(curl -so/dev/null -w '%{http_code}' -X PATCH -H "$AUTH" -H "Content-Type: application/json" "$BASE/api/v1/orgs/$ORG/recommendations/checklist" -d '{"modules_config":{"abandoned_volume":{"enabled":false}}}')"
check "GET /events?limit=10" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/events?limit=10")"
check "GET /alert-events?limit=10" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/alert-events?limit=10")"

# ─── CMDB Extended ────────────────────────────────────────────────────────────
section "CMDB Extended"
check "GET /ci-types" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/ci-types")"
check "GET /ci-baselines" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/ci-baselines")"
check "GET /ci-drift" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/ci-drift")"
check "GET /compliance/results" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/compliance/results")"
check "POST /compliance/run" "$(curl -so/dev/null -w '%{http_code}' -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{}' "$BASE/api/v1/orgs/$ORG/compliance/run")"
check "GET /external-cmdb" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/external-cmdb")"
check "POST /cmdb/discovery" "$(curl -so/dev/null -w '%{http_code}' -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{}' "$BASE/api/v1/orgs/$ORG/cmdb/discovery")" "202"
check "GET /tagging-policies" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/tagging-policies")"

# ─── Billing ──────────────────────────────────────────────────────────────────
section "Billing"
check "GET /billing/history" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/billing/history")"

# Async billing import (spec 2026-09-09): 202 + job handle → poll to terminal.
# Dedicated aws account (mock data under CLOUD_MOCK_ENABLED) keeps this isolated.
B_ACC=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/cloud-accounts" \
  -d "{\"name\":\"smoke-billing-$TS\",\"provider\":\"aws\",\"external_id\":\"smoke\",\"credentials\":{},\"config\":{}}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
BI=$(curl -s -w '\n%{http_code}' -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/billing/import" -d "{\"cloud_account_id\":\"$B_ACC\",\"days\":30}")
check "POST /billing/import → 202 (async job)" "$(echo "$BI" | tail -1)" "202"
BI_JOB=$(echo "$BI" | head -1 | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)

# Duplicate manual trigger while the job is active → 409 + existing job id.
# (Assigned first — nested quotes inside "$(curl -d '...')" mis-parse.)
DUP_CODE=$(curl -so/dev/null -w '%{http_code}' -X POST -H "$AUTH" -H "Content-Type: application/json" "$BASE/api/v1/orgs/$ORG/billing/import" -d "{\"cloud_account_id\":\"$B_ACC\",\"days\":5}")
check "duplicate /billing/import while active → 409" "$DUP_CODE" "409"

check "GET /orgs/:id/jobs (unified list)" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/jobs?kind=billing_import&active=true")"
check "GET /orgs/:id/jobs/:job_id" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/jobs/$BI_JOB")"

# Poll the job to a terminal state, then assert the result numbers.
BI_STATUS=""
for _ in $(seq 1 60); do
  BI_STATUS=$(curl -s -H "$AUTH" "$BASE/api/v1/orgs/$ORG/jobs/$BI_JOB" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['status'])" 2>/dev/null)
  case "$BI_STATUS" in succeeded|failed|cancelled) break ;; esac
  sleep 1
done
[ "$BI_STATUS" = "succeeded" ] && check "billing job reaches succeeded" "200" || check "billing job reaches succeeded (got '$BI_STATUS')" "500"
BI_ROWS=$(curl -s -H "$AUTH" "$BASE/api/v1/orgs/$ORG/jobs/$BI_JOB" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['result'].get('raw_rows_inserted',0))" 2>/dev/null)
[ "${BI_ROWS:-0}" -gt 0 ] 2>/dev/null && check "billing job result raw_rows_inserted>0 (rows=$BI_ROWS)" "200" || check "billing job result raw_rows_inserted>0" "500"
# Cancelling an already-terminal job → 409 (no resurrection).
check "POST /jobs/:id/cancel on terminal job → 409" "$(curl -so/dev/null -w '%{http_code}' -X POST -H "$AUTH" "$BASE/api/v1/orgs/$ORG/jobs/$BI_JOB/cancel")" "409"
[ -n "$B_ACC" ] && curl -s -o /dev/null -X DELETE -H "$AUTH" "$BASE/api/v1/orgs/$ORG/cloud-accounts/$B_ACC"

# Phase 1 rec types — run engine then verify list filtering works
# 202 Accepted: the engine runs asynchronously
check "POST /recommendations/run" "$(curl -so/dev/null -w '%{http_code}' -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{}' "$BASE/api/v1/orgs/$ORG/recommendations/run")" "202"
check "GET /recommendations?rec_type=short_living_instance" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/recommendations?rec_type=short_living_instance")"
check "GET /recommendations?rec_type=insecure_security_group" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/recommendations?rec_type=insecure_security_group")"

# ─── Defect regression (2026-08-15 fixes D-1/D-3/D-8/D-9/D-11 + legacy) ───────
section "Defect Regression (D-1/D-3/D-8/D-9/D-11)"

# D-1: account create with the exact frontend payload (no credentials field)
D1=$(curl -s -w '\n%{http_code}' -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/cloud-accounts" \
  -d "{\"name\":\"smoke-d1-$TS\",\"provider\":\"aws\",\"external_id\":\"smoke\",\"credentials\":{},\"config\":{}}")
D1_CODE=$(echo "$D1" | tail -1); D1_ID=$(echo "$D1" | head -1 | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
check "D-1 POST /cloud-accounts (frontend payload)" "$D1_CODE" "201"

# D-3: sync the new account, then resources must be populated
check "D-3 POST sync" "$(curl -so/dev/null -w '%{http_code}' -X POST -H "$AUTH" "$BASE/api/v1/orgs/$ORG/cloud-accounts/$D1_ID/sync")" "202"
sleep 3
RES_TOTAL=$(curl -s -H "$AUTH" "$BASE/api/v1/orgs/$ORG/resources" | python3 -c "import sys,json; print(json.load(sys.stdin)['meta']['total'])" 2>/dev/null)
[ "$RES_TOTAL" -gt 0 ] 2>/dev/null && check "D-3 resources populated by sync (total=$RES_TOTAL)" "200" || check "D-3 resources populated by sync" "500"
# cleanup the D-1/D-3 account's data + account
curl -s -o /dev/null -X DELETE -H "$AUTH" "$BASE/api/v1/orgs/$ORG/cloud-accounts/$D1_ID"

# D-8: lifecycle transition to 'stopped' (UI sends this state)
D8_CI=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/cis" \
  -d '{"name":"smoke-d8","cloud_provider":"aws","ci_type_id":"20000000-0000-0000-0000-000000000001"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
D8_STATE=$(curl -s -X PUT -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/cis/$D8_CI" -d '{"lifecycle_state":"stopped"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['lifecycle_state'])" 2>/dev/null)
[ "$D8_STATE" = "stopped" ] && check "D-8 lifecycle transition to stopped" "200" || check "D-8 lifecycle transition to stopped" "500"
curl -s -o /dev/null -X DELETE -H "$AUTH" "$BASE/api/v1/orgs/$ORG/cis/$D8_CI"

# ─── gap closure Round 1 (T1–T5) ─────────────────────────────────────
section "Gap Closure R1 (T1-T5)"

# T1: attribute validation — cpu_count must be an integer (422 ERR_VALIDATION)
T1_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/cis" \
  -d '{"name":"smoke-t1-bad","ci_type_id":"20000000-0000-0000-0000-000000000001","meta":{"cpu_count":"not-a-number"}}')
check "T1 invalid attribute value → 422" "$T1_CODE" "422"

# T2: composite unique constraint — create, violate (409), delete
T2_CID=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/ci-types/20000000-0000-0000-0000-000000000001/unique-constraints" \
  -d '{"name":"smoke-uniq-'$TS'","attr_names":["os_type","os_version"]}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
[ -n "$T2_CID" ] && check "T2 create unique constraint" "200" || check "T2 create unique constraint" "500"
curl -s -o /dev/null -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/cis" \
  -d '{"name":"smoke-t2-a","ci_type_id":"20000000-0000-0000-0000-000000000001","meta":{"os_type":"linux","os_version":"9.9"}}'
T2_DUP=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/cis" \
  -d '{"name":"smoke-t2-b","ci_type_id":"20000000-0000-0000-0000-000000000001","meta":{"os_type":"linux","os_version":"9.9"}}')
check "T2 duplicate CI → 409 ERR_DUPLICATE" "$T2_DUP" "409"
check "T2 delete unique constraint" "$(curl -so/dev/null -w '%{http_code}' -X DELETE -H "$AUTH" "$BASE/api/v1/orgs/$ORG/unique-constraints/$T2_CID")" "204"

# T3: lifecycle matrix — legal PATCH 200, illegal PATCH 422
T3_CI=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/cis" \
  -d '{"name":"smoke-t3","ci_type_id":"20000000-0000-0000-0000-000000000001"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
T3_OK=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/cis/$T3_CI/lifecycle" -d '{"to_state":"maintenance","reason":"smoke"}')
check "T3 PATCH lifecycle legal (active→maintenance)" "$T3_OK" "200"
T3_BAD=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/cis/$T3_CI/lifecycle" -d '{"to_state":"retired"}')
check "T3 PATCH lifecycle illegal (maintenance→retired) → 422" "$T3_BAD" "422"
curl -s -o /dev/null -X DELETE -H "$AUTH" "$BASE/api/v1/orgs/$ORG/cis/$T3_CI"

# T4: model-layer audit rows filterable by resource_type
T4_COUNT=$(curl -s -H "$AUTH" "$BASE/api/v1/orgs/$ORG/cmdb/audit-logs?resource_type=ci_type&per_page=1" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['meta']['total'])" 2>/dev/null)
[ "${T4_COUNT:-0}" -ge 1 ] 2>/dev/null && check "T4 model audit rows (resource_type=ci_type, total=$T4_COUNT)" "200" || check "T4 model audit rows present" "500"

# T5: real discovery trigger returns 202 with job_ids
T5_RESP=$(curl -s -w '\n%{http_code}' -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/cmdb/discovery" -d '{}')
T5_CODE=$(echo "$T5_RESP" | tail -1)
T5_JOBS=$(echo "$T5_RESP" | head -1 | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print(len(d.get('job_ids',[])))" 2>/dev/null)
check "T5 POST /cmdb/discovery → 202" "$T5_CODE" "202"
[ "${T5_JOBS:-0}" -ge 1 ] 2>/dev/null && check "T5 discovery enqueued real jobs (count=$T5_JOBS)" "200" || check "T5 discovery enqueued real jobs" "500"

# ─── gap closure Round 2 (T6–T12) ────────────────────────────────────
section "Gap Closure R2 (T6-T12)"

# T6: event stream cursor + type filter
T6_LATEST=$(curl -s -H "$AUTH" "$BASE/api/v1/orgs/$ORG/cmdb/events?limit=1" | python3 -c "import sys,json; print(json.load(sys.stdin)['meta']['latest_id'])" 2>/dev/null)
[ "${T6_LATEST:-0}" -ge 1 ] 2>/dev/null && check "T6 GET /cmdb/events stream (latest_id=$T6_LATEST)" "200" || check "T6 GET /cmdb/events stream" "500"
T6_F=$(curl -s -H "$AUTH" "$BASE/api/v1/orgs/$ORG/cmdb/events?limit=5&types=ci.created" | python3 -c "
import sys, json
d = json.load(sys.stdin)['data']
print('200' if all(e['event_type']=='ci.created' for e in d) else '500')" 2>/dev/null)
check "T6 events type filter" "$T6_F"

# T7: template download
T7_TMPL=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/ci-types/20000000-0000-0000-0000-000000000001/import-template")
check "T7 GET import-template" "$T7_TMPL" "200"

# T7: multipart CSV import (skip strategy)
printf "name,display_name,cloud_region,cpu_count,os_type\nsmoke-t7-row-$TS,Smoke T7,us-east-1,4,linux\n" > /tmp/smoke_t7.csv
T7_IMPORT=$(curl -s -H "$AUTH" -X POST -F "file=@/tmp/smoke_t7.csv" -F "ci_type_id=20000000-0000-0000-0000-000000000001" -F "conflict_strategy=skip" \
  "$BASE/api/v1/orgs/$ORG/cis/import" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['created'])" 2>/dev/null)
[ "${T7_IMPORT:-0}" -ge 1 ] 2>/dev/null && check "T7 POST /cis/import created=$T7_IMPORT" "200" || check "T7 POST /cis/import" "500"
# re-import same file with skip → skipped (not duplicate-created)
T7_SKIP=$(curl -s -H "$AUTH" -X POST -F "file=@/tmp/smoke_t7.csv" -F "ci_type_id=20000000-0000-0000-0000-000000000001" -F "conflict_strategy=skip" \
  "$BASE/api/v1/orgs/$ORG/cis/import" | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print('200' if d['created']==0 else '500')" 2>/dev/null)
check "T7 re-import with skip strategy" "$T7_SKIP"

# T7: CSV export
T7_EXPORT=$(curl -s -H "$AUTH" "$BASE/api/v1/orgs/$ORG/cis/export?format=csv&limit=5" | head -1)
[ "${T7_EXPORT:0:2}" = "id" ] && check "T7 GET /cis/export CSV header" "200" || check "T7 GET /cis/export CSV header" "500"

# T8: fulltext search endpoint
T8_SEARCH=$(curl -s -H "$AUTH" "$BASE/api/v1/orgs/$ORG/cis/search?q=prod" | python3 -c "import sys,json; print('200' if json.load(sys.stdin)['meta']['total']>=0 else '500')" 2>/dev/null)
check "T8 GET /cis/search" "$T8_SEARCH"

# T9: batch update / clone / batch delete
T9_CI1=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" "$BASE/api/v1/orgs/$ORG/cis" \
  -d '{"name":"smoke-t9-a","ci_type_id":"20000000-0000-0000-0000-000000000001"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
T9_CI2=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" "$BASE/api/v1/orgs/$ORG/cis" \
  -d '{"name":"smoke-t9-b","ci_type_id":"20000000-0000-0000-0000-000000000001"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
T9_UPD=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" "$BASE/api/v1/orgs/$ORG/cis/batch-update" \
  -d "{\"ids\":[\"$T9_CI1\",\"$T9_CI2\"],\"lifecycle_state\":\"maintenance\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['updated'])" 2>/dev/null)
[ "${T9_UPD:-0}" = "2" ] 2>/dev/null && check "T9 batch-update (2 rows)" "200" || check "T9 batch-update" "500"
T9_CLONE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/cis/$T9_CI1/clone" -d '{"new_name":"smoke-t9-clone"}')
check "T9 clone CI" "$T9_CLONE" "201"
T9_DEL=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" "$BASE/api/v1/orgs/$ORG/cis/batch-delete" \
  -d "{\"ids\":[\"$T9_CI1\",\"$T9_CI2\"]}" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['deleted'])" 2>/dev/null)
[ "${T9_DEL:-0}" = "2" ] 2>/dev/null && check "T9 batch-delete (2 rows)" "200" || check "T9 batch-delete" "500"
curl -s -o /dev/null -X POST -H "$AUTH" -H "Content-Type: application/json" "$BASE/api/v1/orgs/$ORG/cis/smoke-nonexist/clone" -d '{"new_name":"x"}' >/dev/null 2>&1

# T12: compliance last-run
curl -s -o /dev/null -X POST -H "$AUTH" "$BASE/api/v1/orgs/$ORG/compliance/run" -m 120
T12_LAST=$(curl -s -H "$AUTH" "$BASE/api/v1/orgs/$ORG/compliance/last-run" | python3 -c "
import sys, json
d = json.load(sys.stdin)['data']
print('200' if d and d.get('result',{}).get('trigger') in ('manual','scheduled') else '500')" 2>/dev/null)
check "T12 GET /compliance/last-run" "$T12_LAST"

# ─── gap closure Round 3 (T10/T11) ───────────────────────────────────
section "Gap Closure R3 (T10-T11)"

# T10: field template bind → diff → dry-run → apply → unbind
T10_FT=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/field-templates" \
  -d "{\"name\":\"smoke-ft-$TS\",\"attributes\":[{\"name\":\"smoke_ft_field_$TS\",\"display_name\":\"Smoke FT Field\",\"attribute_type\":\"string\"}]}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
[ -n "$T10_FT" ] && check "T10 create field template" "200" || check "T10 create field template" "500"
curl -s -o /dev/null -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/field-templates/$T10_FT/bind" \
  -d '{"ci_type_ids":["20000000-0000-0000-0000-000000000001"]}'
T10_DIFF=$(curl -s -H "$AUTH" "$BASE/api/v1/orgs/$ORG/field-templates/$T10_FT/diff/20000000-0000-0000-0000-000000000001" \
  | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print('200' if any(a['name']=='smoke_ft_field_$TS' for a in d['added']) else '500')" 2>/dev/null)
check "T10 diff shows template attribute as added" "$T10_DIFF"
curl -s -o /dev/null -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/field-templates/$T10_FT/apply" \
  -d '{"ci_type_ids":["20000000-0000-0000-0000-000000000001"]}'
T10_ATTR=$(curl -s -H "$AUTH" "$BASE/api/v1/orgs/$ORG/ci-types/20000000-0000-0000-0000-000000000001/attributes" \
  | python3 -c "import sys,json; print('200' if any(a['name']=='smoke_ft_field_$TS' for a in json.load(sys.stdin)['data']) else '500')" 2>/dev/null)
check "T10 apply created attribute on type" "$T10_ATTR"
curl -s -o /dev/null -X DELETE -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/field-templates/$T10_FT/unbind" \
  -d '{"ci_type_ids":["20000000-0000-0000-0000-000000000001"]}'

# T11: parent set + cycle rejection + forest
T11_ROOT=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" "$BASE/api/v1/orgs/$ORG/cis" \
  -d '{"name":"smoke-t11-root-'$TS'","ci_type_id":"20000000-0000-0000-0000-000000000001"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
T11_CHILD=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" "$BASE/api/v1/orgs/$ORG/cis" \
  -d '{"name":"smoke-t11-child-'$TS'","ci_type_id":"20000000-0000-0000-0000-000000000001"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
T11_SET=$(curl -s -X PUT -H "$AUTH" -H "Content-Type: application/json" "$BASE/api/v1/orgs/$ORG/cis/$T11_CHILD" \
  -d "{\"parent_ci_id\":\"$T11_ROOT\"}" \
  | python3 -c "import sys,json; print('200' if json.load(sys.stdin)['data']['parent_ci_id'] else '500')" 2>/dev/null)
check "T11 set parent_ci_id" "$T11_SET"
T11_CYCLE=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/cis/$T11_ROOT" -d "{\"parent_ci_id\":\"$T11_CHILD\"}")
check "T11 cycle rejected → 422" "$T11_CYCLE" "422"
T11_FOREST=$(curl -s -H "$AUTH" "$BASE/api/v1/orgs/$ORG/ci-forest?ci_type_id=20000000-0000-0000-0000-000000000001" \
  | python3 -c "import sys,json; print('200' if json.load(sys.stdin)['data']['total_nodes']>=1 else '500')" 2>/dev/null)
check "T11 GET /ci-forest" "$T11_FOREST"

# ─── gap closure Round 4 (T13–T17) ───────────────────────────────────
section "Gap Closure R4 (T13-T17)"

# T13: external CMDB config with new fields + logs endpoint + dry-run error path
T13_CFG=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/external-cmdb" \
  -d "{\"name\":\"smoke-ext-$TS\",\"provider\":\"rest\",\"config\":{\"base_url\":\"http://localhost:9/api\",\"ci_type_id\":\"20000000-0000-0000-0000-000000000001\",\"sync_direction\":\"pull\",\"field_mapping\":{\"external_id\":\"id\",\"name\":\"name\"}}}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
[ -n "$T13_CFG" ] && check "T13 create external config (with ci_type_id)" "200" || check "T13 create external config" "500"
T13_LIST=$(curl -s -H "$AUTH" "$BASE/api/v1/orgs/$ORG/external-cmdb" | python3 -c "
import sys, json
d = json.load(sys.stdin)['data']
row = next((c for c in d if c['id'] == '$T13_CFG'), None)
print('200' if row and row.get('ci_type_id') and row.get('sync_direction') == 'pull' else '500')" 2>/dev/null)
check "T13 config exposes ci_type_id + sync_direction" "$T13_LIST"
T13_LOGS=$(curl -s -H "$AUTH" "$BASE/api/v1/orgs/$ORG/external-cmdb/$T13_CFG/logs" | python3 -c "
import sys, json
print('200' if 'meta' in json.load(sys.stdin) else '500')" 2>/dev/null)
check "T13 GET sync logs (paginated)" "$T13_LOGS"
T13_DRY=$(curl -so/dev/null -w '%{http_code}' -m 45 -H "$AUTH" "$BASE/api/v1/orgs/$ORG/external-cmdb/$T13_CFG/dry-run")
check "T13 dry-run unreachable endpoint → 502 CLOUD_ERROR" "$T13_DRY" "502"

# T14: stats trends (snapshots today on read)
T14_TREND=$(curl -s -H "$AUTH" "$BASE/api/v1/orgs/$ORG/cmdb/stats/trends?days=7" | python3 -c "
import sys, json
d = json.load(sys.stdin)['data']
print('200' if len(d['points']) >= 1 and d['points'][-1]['total_cis'] >= 1 else '500')" 2>/dev/null)
check "T14 GET /cmdb/stats/trends" "$T14_TREND"

# T15: k8s builtin CI types registered
T15_TYPES=$(curl -s -H "$AUTH" "$BASE/api/v1/orgs/$ORG/ci-types" | python3 -c "
import sys, json
names = {t['name'] for t in json.load(sys.stdin)['data']}
need = {'k8s_cluster','k8s_namespace','k8s_node','k8s_workload','k8s_pod'}
print('200' if need <= names else '500')" 2>/dev/null)
check "T15 k8s builtin CI types present" "$T15_TYPES"

# T16: dynamic group SQL pushdown + compliance targeting
T16_GRP=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/ci-groups" \
  -d "{\"name\":\"smoke-t16-$TS\",\"conditions\":[{\"field\":\"lifecycle_state\",\"operator\":\"\$eq\",\"value\":\"active\"}]}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
T16_EXEC=$(curl -s -X POST -H "$AUTH" "$BASE/api/v1/orgs/$ORG/ci-groups/$T16_GRP/execute?per_page=5" | python3 -c "
import sys, json
r = json.load(sys.stdin)
print('200' if r['meta']['total'] >= 0 and len(r['data']) <= 5 else '500')" 2>/dev/null)
check "T16 dynamic group SQL pushdown + pagination" "$T16_EXEC"
T16_POL=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/compliance-policies" \
  -d "{\"name\":\"smoke-t16-pol-$TS\",\"rules\":[{\"field\":\"tags.nonexistent_t16\",\"op\":\"exists\"}],\"target_type\":\"dynamic_group\",\"target_group_id\":\"$T16_GRP\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
[ -n "$T16_POL" ] && check "T16 policy targets dynamic group" "200" || check "T16 policy targets dynamic group" "500"
T16_RUN=$(curl -so/dev/null -w '%{http_code}' -m 55 -X POST -H "$AUTH" "$BASE/api/v1/orgs/$ORG/compliance/run")
check "T16 compliance run with group target (batched < 60s)" "$T16_RUN" "200"

# T17: business capability CRUD
T17_CC=$(curl -s -H "$AUTH" "$BASE/api/v1/orgs/$ORG/cost-centers" | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print(d[0]['id'] if d else '')" 2>/dev/null)
T17_CAP=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/business-capabilities" \
  -d "{\"name\":\"Smoke Capability $TS\",\"cost_center_id\":\"$T17_CC\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
[ -n "$T17_CAP" ] && check "T17 create business capability" "200" || check "T17 create business capability" "500"
T17_LIST=$(curl -s -H "$AUTH" "$BASE/api/v1/orgs/$ORG/business-capabilities" | python3 -c "
import sys, json
d = json.load(sys.stdin)['data']
print('200' if any(c['id'] == '$T17_CAP' and c.get('cost_center_id') for c in d) else '500')" 2>/dev/null)
check "T17 capability carries cost center" "$T17_LIST"
check "T17 delete capability" "$(curl -so/dev/null -w '%{http_code}' -X DELETE -H "$AUTH" "$BASE/api/v1/business-capabilities/$T17_CAP")" "204"

# D-9: alert creation with pool_id (UI payload) on the seed account's pool budget
D9_POOL_BUDGET=$(curl -s -H "$AUTH" "$BASE/api/v1/orgs/$ORG/pools" | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; pool=[p['id'] for p in d if p.get('name')=='Root Pool'][0]; print(pool)" 2>/dev/null)
D9=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/alerts" \
  -d "{\"pool_id\":\"$D9_POOL_BUDGET\",\"alert_type\":\"PERCENTAGE\",\"threshold\":80}")
check "D-9 POST /alerts with pool_id" "$D9" "201"
# teardown the alert just created (newest for the org)
D9_ID=$(curl -s -H "$AUTH" "$BASE/api/v1/orgs/$ORG/alerts" | python3 -c "import sys,json; print(json.load(sys.stdin)['data'][0]['id'])" 2>/dev/null)
[ -n "$D9_ID" ] && curl -s -o /dev/null -X DELETE -H "$AUTH" "$BASE/api/v1/orgs/$ORG/alerts/$D9_ID"

# D-11: deleting a CI type soft-deletes instead of FK-500 when only
# soft-deleted CIs reference it (an ACTIVE CI must still block with 422)
D11_TYPE=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/ci-types" \
  -d "{\"name\":\"smoke_d11_$TS\",\"display_name\":\"Smoke D11\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
D11_CI=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/v1/orgs/$ORG/cis" \
  -d "{\"name\":\"smoke-d11-ci\",\"cloud_provider\":\"aws\",\"ci_type_id\":\"$D11_TYPE\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
check "D-11 active CI blocks type delete (422 guard)" "$(curl -so/dev/null -w '%{http_code}' -X DELETE -H "$AUTH" "$BASE/api/v1/orgs/$ORG/ci-types/$D11_TYPE")" "422"
curl -s -o /dev/null -X DELETE -H "$AUTH" "$BASE/api/v1/orgs/$ORG/cis/$D11_CI"   # soft-delete the CI
check "D-11 DELETE /ci-types/:id soft-deletes (CI deleted)" "$(curl -so/dev/null -w '%{http_code}' -X DELETE -H "$AUTH" "$BASE/api/v1/orgs/$ORG/ci-types/$D11_TYPE")" "204"

# Legacy: per-resource recommendations must not panic on enum columns
LEGACY_RES=$(curl -s -H "$AUTH" "$BASE/api/v1/orgs/$ORG/resources" | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print(d[0]['id'] if d else '')" 2>/dev/null)
[ -n "$LEGACY_RES" ] && check "Legacy GET /resources/:id/recommendations" "$(curl -so/dev/null -w '%{http_code}' -H "$AUTH" "$BASE/api/v1/orgs/$ORG/resources/$LEGACY_RES/recommendations")"

# ─── Pagination (spec 2026-09-10: unified {data, meta} envelope) ──────────────
section "Pagination"

# page=1&per_page=2 → ≤2 rows, echo'd page/per_page, total_pages == ceil(total/2)
pg_check() {
  local name="$1"; local path="$2"
  local verdict
  verdict=$(curl -s -H "$AUTH" "$BASE/api/v1/orgs/$ORG$path?page=1&per_page=2" | python3 -c "
import sys, json
try:
    r = json.load(sys.stdin)
    m, d = r['meta'], r['data']
    ok = (len(d) <= 2 and m['page'] == 1 and m['per_page'] == 2
          and m['total_pages'] == (m['total'] + 1) // 2)
    print('200' if ok else '500')
except Exception:
    print('500')" 2>/dev/null)
  check "$name (page=1&per_page=2 envelope)" "$verdict"
}

pg_check "GET /resources" "/resources"
pg_check "GET /cis" "/cis"
pg_check "GET /events" "/events"

# Alias compatibility: limit/offset still accepted, page derived from them.
PG_ALIAS=$(curl -s -H "$AUTH" "$BASE/api/v1/orgs/$ORG/resources?limit=2&offset=2" | python3 -c "
import sys, json
try:
    m = json.load(sys.stdin)['meta']
    print('200' if (m['limit'] == 2 and m['offset'] == 2 and m['page'] == 2) else '500')
except Exception:
    print('500')" 2>/dev/null)
check "GET /resources legacy limit/offset alias → page=2" "$PG_ALIAS"

# Beyond-last page: empty data with the real total, never an error.
PG_BEYOND=$(curl -s -H "$AUTH" "$BASE/api/v1/orgs/$ORG/resources?page=99999&per_page=50" | python3 -c "
import sys, json
try:
    r = json.load(sys.stdin)
    print('200' if (r['data'] == [] and r['meta']['page'] == 99999 and r['meta']['total'] >= 0) else '500')
except Exception:
    print('500')" 2>/dev/null)
check "GET /resources beyond-last page → empty data, real total" "$PG_BEYOND"

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}════════════════════════════════════════${NC}"
echo -e "${BOLD}  TOTAL: ${GREEN}${PASS} passed${NC}${BOLD}, ${RED}${FAIL} failed${NC}"
echo -e "${BOLD}════════════════════════════════════════${NC}"

[ $FAIL -eq 0 ] && exit 0 || exit 1
