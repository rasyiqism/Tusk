#!/usr/bin/env bash
set -euo pipefail

# Cold Disaster Recovery (DR) Script for PG Control Panel
# Restores an encrypted pg_dump (.dump.enc) onto a fresh PostgreSQL instance.
# Usage:
#   ./scripts/cold-dr.sh <local_dump_enc_file> <target_postgres_url>

if [[ $# -lt 2 ]]; then
  echo "Usage:"
  echo "  $0 <local_dump_enc_file> <target_postgres_url>"
  echo "Example:"
  echo "  BACKUP_ENCRYPTION_KEY=mysecret $0 ./data/backups/my_app_prod.dump.enc postgres://postgres:pass@localhost:5432/my_app_prod"
  exit 1
fi

DUMP_FILE="${1:?Missing local .dump.enc file}"
TARGET_URL="${2:?Missing target postgres URL}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY environment variable must be set}"

if [[ ! -f "$DUMP_FILE" ]]; then
  echo "Error: Backup file '$DUMP_FILE' does not exist."
  exit 1
fi

echo "[Cold-DR] Decrypting and restoring $DUMP_FILE to $TARGET_URL..."
openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_ENCRYPTION_KEY -in "$DUMP_FILE" \
  | pg_restore --clean --if-exists --no-owner -d "$TARGET_URL"

echo "[Cold-DR] Database restore completed successfully."
