#!/usr/bin/env bash
# CloudAtlas environment variable validator
# Usage: ./scripts/check_env.sh [path/to/.env]

set -euo pipefail
ENV_FILE="${1:-.env}"

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'; BOLD='\033[1m'
ERRORS=0; WARNINGS=0

error()   { echo -e "${RED}❌ ERROR${NC}: $1";   ((ERRORS++)); }
warn()    { echo -e "${YELLOW}⚠️  WARN${NC}:  $1"; ((WARNINGS++)); }
ok()      { echo -e "${GREEN}✅ OK${NC}:    $1"; }
section() { echo -e "\n${BOLD}──── $1 ────${NC}"; }

if [ ! -f "$ENV_FILE" ]; then
  error "File not found: $ENV_FILE (copy from .env.example)"
  exit 1
fi

# shellcheck disable=SC2046
export $(grep -v '^#' "$ENV_FILE" | grep -v '^$' | xargs)

section "Database"
if [ -z "${DATABASE_URL:-}" ]; then
  error "DATABASE_URL is not set"
else
  ok "DATABASE_URL is set"
  if echo "$DATABASE_URL" | grep -q 'password\|postgres'; then
    ok "DATABASE_URL looks like a PostgreSQL URL"
  else
    warn "DATABASE_URL does not look like a PostgreSQL URL"
  fi
fi

section "Authentication"
if [ -z "${JWT_SECRET:-}" ]; then
  error "JWT_SECRET is not set"
elif [ "${#JWT_SECRET}" -lt 32 ]; then
  error "JWT_SECRET is too short (${#JWT_SECRET} chars, minimum 32, recommend 64)"
elif [ "${#JWT_SECRET}" -lt 64 ]; then
  warn "JWT_SECRET is short (${#JWT_SECRET} chars, recommend 64+)"
else
  ok "JWT_SECRET length OK (${#JWT_SECRET} chars)"
fi

if [ -z "${ENCRYPTION_KEY:-}" ]; then
  error "ENCRYPTION_KEY is not set"
elif [ "${#ENCRYPTION_KEY}" -ne 64 ]; then
  error "ENCRYPTION_KEY should be 64 hex chars (32 bytes); got ${#ENCRYPTION_KEY}"
else
  ok "ENCRYPTION_KEY length OK"
fi

JWT_EXP="${JWT_ACCESS_TOKEN_EXPIRY:-3600}"
if [ "$JWT_EXP" -gt 86400 ]; then
  warn "JWT_ACCESS_TOKEN_EXPIRY is $JWT_EXP seconds (> 24h). Consider shorter for production."
else
  ok "JWT_ACCESS_TOKEN_EXPIRY: ${JWT_EXP}s"
fi

section "Server"
HOST="${API_HOST:-0.0.0.0}"
PORT="${API_PORT:-8080}"
ok "Bind address: $HOST:$PORT"

if [ "${RUST_LOG:-}" = "debug" ] || [ "${RUST_LOG:-}" = "trace" ]; then
  warn "RUST_LOG=${RUST_LOG} — verbose logging enabled. Use 'info' for production."
else
  ok "RUST_LOG: ${RUST_LOG:-info}"
fi

CORS="${CORS_ALLOWED_ORIGINS:-}"
if [ -z "$CORS" ]; then
  warn "CORS_ALLOWED_ORIGINS is not set (defaults to *)"
elif echo "$CORS" | grep -q '\*'; then
  warn "CORS_ALLOWED_ORIGINS contains wildcard (*). Restrict in production."
else
  ok "CORS_ALLOWED_ORIGINS: $CORS"
fi

section "Cloud"
if [ "${CLOUD_MOCK_ENABLED:-false}" = "true" ]; then
  warn "CLOUD_MOCK_ENABLED=true. Disable in production."
else
  ok "CLOUD_MOCK_ENABLED: disabled"
fi

section "Summary"
echo ""
if [ $ERRORS -gt 0 ]; then
  echo -e "${RED}${BOLD}FAILED: $ERRORS error(s), $WARNINGS warning(s)${NC}"
  exit 1
elif [ $WARNINGS -gt 0 ]; then
  echo -e "${YELLOW}${BOLD}OK with warnings: $WARNINGS warning(s)${NC}"
  exit 0
else
  echo -e "${GREEN}${BOLD}All checks passed!${NC}"
  exit 0
fi
