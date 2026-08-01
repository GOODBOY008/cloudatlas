#!/usr/bin/env bash
# CloudAtlas PostgreSQL backup (custom-format pg_dump).
# Usage: ./scripts/backup.sh [DATABASE_URL]
set -euo pipefail

URL="${1:-${DATABASE_URL:?DATABASE_URL is required}}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$DIR/backups"
mkdir -p "$OUT_DIR"

TS=$(date +%Y%m%d-%H%M%S)
OUT="$OUT_DIR/cloudatlas-$TS.dump"

pg_dump --dbname="$URL" --format=custom --no-owner --no-privileges -f "$OUT"
echo "✅ Backup written: $OUT ($(du -h "$OUT" | cut -f1))"

# Retention: keep the 14 most recent dumps.
ls -1t "$OUT_DIR"/cloudatlas-*.dump 2>/dev/null | tail -n +15 | xargs -r rm --
echo "Retention applied (14 dumps kept)"
