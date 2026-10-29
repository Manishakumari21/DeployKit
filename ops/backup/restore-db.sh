#!/usr/bin/env bash
set -euo pipefail

# Restore a DeployKit Postgres backup created by backup-db.sh (pg_dump custom
# format) inside the running postgres container.
#
# By default this RESTORES INTO A NEW DATABASE (default name:
# deploykit_restored_<timestamp>) so nothing existing is touched. This is the
# safe path for verifying a backup. To overwrite the live database you must
# pass --force-live, which drops and recreates the target — this is destructive
# and cannot be undone.
#
# Usage:
#   ops/backup/restore-db.sh <backup-file> [target-db]
#   ops/backup/restore-db.sh <backup-file> <target-db> --force-live
#
# Environment (loaded from ./.env if present):
#   POSTGRES_USER   database user (default: deploykit)
#   POSTGRES_DB     live database name, required only with --force-live

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
fi

POSTGRES_USER="${POSTGRES_USER:-deploykit}"
POSTGRES_DB="${POSTGRES_DB:-deploykit}"
CONTAINER="deploykit-postgres"

BACKUP_FILE="${1:?usage: restore-db.sh <backup-file> [target-db] [--force-live]}"
FORCE_LIVE=""
TARGET_DB=""

for arg in "${@:2}"; do
  case "$arg" in
    --force-live) FORCE_LIVE="1" ;;
    *) TARGET_DB="$arg" ;;
  esac
done

if [ ! -s "$BACKUP_FILE" ]; then
  echo "backup file not found or empty: $BACKUP_FILE" >&2
  exit 1
fi
if ! head -c 5 "$BACKUP_FILE" | grep -q "PGDMP"; then
  echo "file does not look like a pg_dump custom archive: $BACKUP_FILE" >&2
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "postgres container '$CONTAINER' is not running; start the stack first" >&2
  exit 1
fi

compose_exec() {
  docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres "$@"
}

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
if [ -z "$TARGET_DB" ]; then
  TARGET_DB="deploykit_restored_$STAMP"
fi

if [ -n "$FORCE_LIVE" ]; then
  if [ "$TARGET_DB" != "$POSTGRES_DB" ]; then
    echo "--force-live targets the live database ($POSTGRES_DB); refusing to run against '$TARGET_DB'" >&2
    echo "omit the target argument to restore over $POSTGRES_DB, or drop --force-live to restore into a new DB" >&2
    exit 1
  fi
  echo "DANGER: about to DROP and recreate live database '$TARGET_DB' from $BACKUP_FILE" >&2
  echo "All current data in '$TARGET_DB' will be permanently replaced." >&2
  printf "Type the database name '%s' to confirm: " "$TARGET_DB" >&2
  read -r CONFIRM
  if [ "$CONFIRM" != "$TARGET_DB" ]; then
    echo "confirmation did not match; aborting" >&2
    exit 1
  fi
  # Terminate other connections so the DROP is not blocked by open sessions.
  compose_exec psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$TARGET_DB' AND pid <> pg_backend_pid();" >/dev/null
  compose_exec psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$TARGET_DB\";"
  compose_exec createdb -U "$POSTGRES_USER" "$TARGET_DB"
else
  if [ "$TARGET_DB" = "$POSTGRES_DB" ]; then
    echo "refusing to restore into the live database '$TARGET_DB' without --force-live" >&2
    echo "pass a new target-db name, or add --force-live to overwrite the live DB (destructive)" >&2
    exit 1
  fi
  # Create the target if it does not exist; leave any existing copy in place.
  compose_exec psql -U "$POSTGRES_USER" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname = '$TARGET_DB'" | grep -q 1 ||
    compose_exec createdb -U "$POSTGRES_USER" "$TARGET_DB"
fi

echo "restoring $BACKUP_FILE -> $TARGET_DB"
cat "$BACKUP_FILE" | compose_exec pg_restore -U "$POSTGRES_USER" -d "$TARGET_DB" --no-owner --exit-on-error

TABLES="$(compose_exec psql -U "$POSTGRES_USER" -d "$TARGET_DB" -tAc 'SELECT count(*) FROM information_schema.tables WHERE table_schema = '"'"'public'"'"';')"
echo "restore ok: $TARGET_DB now has $TABLES public tables"
echo "target database: $TARGET_DB"
