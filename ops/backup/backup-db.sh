#!/usr/bin/env bash
set -euo pipefail

# Back up the DeployKit Postgres database using pg_dump (custom format) inside
# the running postgres container. Non-destructive: writes a timestamped dump to
# a backups directory and prints the resulting path. Safe to run against a live
# stack — pg_dump takes a consistent snapshot without blocking writes.
#
# Usage:
#   ops/backup/backup-db.sh [output-dir]
#
# Environment (loaded from ./.env if present):
#   POSTGRES_USER   database user (default: deploykit)
#   POSTGRES_DB     database name (default: deploykit)
#
# A cron example for scheduled backups is documented in README.md ("Database
# backup and restore").

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Load .env so POSTGRES_USER / POSTGRES_DB are available without exposing them.
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
fi

POSTGRES_USER="${POSTGRES_USER:-deploykit}"
POSTGRES_DB="${POSTGRES_DB:-deploykit}"

OUTPUT_DIR="${1:-$REPO_ROOT/backups}"
CONTAINER="deploykit-postgres"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILE="$OUTPUT_DIR/deploykit-$STAMP.dump"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "postgres container '$CONTAINER' is not running; start the stack first" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

echo "backing up $POSTGRES_DB (user $POSTGRES_USER) -> $BACKUP_FILE"
docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T \
  postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc >"$BACKUP_FILE"

# Sanity check: a pg_dump custom dump is non-empty and starts with a PGDMP
# magic marker. An empty or malformed file indicates a failed dump.
if [ ! -s "$BACKUP_FILE" ]; then
  echo "backup file is empty; dump likely failed" >&2
  rm -f "$BACKUP_FILE"
  exit 1
fi
if ! head -c 5 "$BACKUP_FILE" | grep -q "PGDMP"; then
  echo "backup file does not look like a pg_dump custom archive" >&2
  rm -f "$BACKUP_FILE"
  exit 1
fi

BYTES="$(wc -c <"$BACKUP_FILE" | tr -d ' ')"
echo "backup ok: $BACKUP_FILE ($BYTES bytes)"
echo "$BACKUP_FILE"
