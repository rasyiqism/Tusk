#!/usr/bin/env bash
set -euo pipefail

# Cold Disaster Recovery (DR) Script for PG Control Panel
# Restores a Shared pg_dump (.dump.enc) or Dedicated WAL-G archive onto a fresh VPS.
# Usage:
#   ./scripts/cold-dr.sh shared <backup_file_or_s3_key> <target_db_url>
#   ./scripts/cold-dr.sh dedicated <pgdata_dir> [target_pitr_time]

MODE="${1:-}"
if [[ -z "$MODE" ]]; then
  echo "Usage:"
  echo "  $0 shared <local_dump_enc_file> <target_postgres_url>"
  echo "  $0 dedicated <pgdata_dir> [pitr_timestamp_iso]"
  exit 1
fi

if [[ "$MODE" == "shared" ]]; then
  DUMP_FILE="${2:?Missing local .dump.enc file}"
  TARGET_URL="${3:?Missing target postgres URL}"
  : "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY must be set}"

  echo "[Cold-DR] Decrypting and restoring $DUMP_FILE..."
  openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_ENCRYPTION_KEY -in "$DUMP_FILE" \
    | pg_restore --clean --if-exists --no-owner -d "$TARGET_URL"
  echo "[Cold-DR] Shared database restore completed."

elif [[ "$MODE" == "dedicated" ]]; then
  PGDATA_DIR="${2:?Missing target PGDATA directory}"
  PITR_TIME="${3:-LATEST}"
  : "${WALG_S3_PREFIX:?WALG_S3_PREFIX must be set}"

  echo "[Cold-DR] Fetching base backup from $WALG_S3_PREFIX into $PGDATA_DIR..."
  mkdir -p "$PGDATA_DIR"
  wal-g backup-fetch "$PGDATA_DIR" "$PITR_TIME"

  touch "$PGDATA_DIR/recovery.signal"
  {
    echo "restore_command = 'wal-g wal-fetch %f %p'"
    if [[ "$PITR_TIME" != "LATEST" ]]; then
      echo "recovery_target_time = '$PITR_TIME'"
      echo "recovery_target_action = 'promote'"
    fi
  } >> "$PGDATA_DIR/postgresql.auto.conf"

  echo "[Cold-DR] Dedicated PITR recovery prepared in $PGDATA_DIR. Start PostgreSQL to complete recovery."
else
  echo "Unknown mode: $MODE (expected 'shared' or 'dedicated')"
  exit 1
fi
