#!/usr/bin/env bash
set -euo pipefail

# Generates strong secrets and a ready-to-use .env for local or Dokploy deployments.
# Usage: ./scripts/init-secrets.sh [admin_password]

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_PASS="${1:-}"

if [[ -z "$ADMIN_PASS" ]]; then
  read -rsp "Enter new Panel Admin password: " ADMIN_PASS
  echo
fi

PG_PASS="$(openssl rand -hex 20)"
PGB_PASS="$(openssl rand -hex 20)"
MASTER_KEY="$(openssl rand -hex 32)"
BACKUP_KEY="$(openssl rand -hex 32)"

if command -v bun >/dev/null 2>&1; then
  ADMIN_HASH="$(bun -e "console.log(await Bun.password.hash(process.argv[1], { algorithm: 'argon2id' }))" "$ADMIN_PASS")"
  ADMIN_HASH_B64="$(bun -e "console.log(Buffer.from(process.argv[1]).toString('base64'))" "$ADMIN_HASH")"
else
  echo "Error: bun is required to generate Argon2id password hash." >&2
  exit 1
fi

cat > "$ROOT_DIR/.env" <<EOF
PG_SUPERUSER_PASSWORD=$PG_PASS
PGBOUNCER_AUTH_PASSWORD=$PGB_PASS
PANEL_ADMIN_PASSWORD_HASH='$ADMIN_HASH'
PANEL_ADMIN_PASSWORD_HASH_B64=$ADMIN_HASH_B64
MASTER_KEY=$MASTER_KEY
BACKUP_ENCRYPTION_KEY=$BACKUP_KEY

S3_ENDPOINT=
S3_BUCKET=pg-backups
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=

NTFY_URL=
ALERT_WEBHOOK_URL=
ALLOW_INTERNAL_URLS=true

PANEL_BIND_IP=127.0.0.1
PANEL_PORT=4310
PGB_BIND_IP=0.0.0.0
PGB_PORT=6432
PGB_TLS_MODE=allow
DATA_DIR=/app/data
PUBLIC_DB_HOST=localhost
EOF

chmod 600 "$ROOT_DIR/.env"
echo "[init-secrets] Generated .env with Argon2id hash, MASTER_KEY, and BACKUP_ENCRYPTION_KEY"
