#!/usr/bin/env bash
set -euo pipefail

# Generates strong secrets, .env, init-auth-query.sql, and pgbouncer/userlist.txt
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
else
  echo "Error: bun is required to generate Argon2id password hash." >&2
  exit 1
fi

cat > "$ROOT_DIR/.env" <<EOF
PG_SUPERUSER_PASSWORD=$PG_PASS
PGBOUNCER_AUTH_PASSWORD=$PGB_PASS
PANEL_ADMIN_PASSWORD_HASH='$ADMIN_HASH'
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
DATA_DIR=/app/data
PUBLIC_DB_HOST=localhost
PGB_BIND_IP=0.0.0.0
PGB_PORT=6432
PGB_TLS_MODE=allow
EOF

mkdir -p "$ROOT_DIR/pgbouncer/tls"
if [[ ! -f "$ROOT_DIR/pgbouncer/tls/server.crt" ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$ROOT_DIR/pgbouncer/tls/server.key" \
    -out "$ROOT_DIR/pgbouncer/tls/server.crt" \
    -subj "/CN=pgbouncer" \
    -addext "subjectAltName=DNS:localhost,DNS:pgbouncer,IP:127.0.0.1" 2>/dev/null
  chmod 644 "$ROOT_DIR/pgbouncer/tls/server.crt" "$ROOT_DIR/pgbouncer/tls/server.key"
fi

cat > "$ROOT_DIR/init-auth-query.sql" <<EOF
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

CREATE ROLE pgbouncer_auth WITH LOGIN PASSWORD '$PGB_PASS';

CREATE SCHEMA IF NOT EXISTS pgbouncer AUTHORIZATION pgbouncer_auth;

CREATE OR REPLACE FUNCTION pgbouncer.user_lookup(in i_username text)
RETURNS TABLE(usename name, passwd text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS \$\$
    SELECT rolname, rolpassword
    FROM pg_authid
    WHERE rolcanlogin = true
      AND rolname = i_username;
\$\$;

REVOKE ALL ON FUNCTION pgbouncer.user_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pgbouncer.user_lookup(text) TO pgbouncer_auth;
EOF

mkdir -p "$ROOT_DIR/pgbouncer"
cat > "$ROOT_DIR/pgbouncer/userlist.txt" <<EOF
"pgbouncer_auth" "$PGB_PASS"
"postgres" "$PG_PASS"
EOF

chmod 600 "$ROOT_DIR/.env"
chmod 644 "$ROOT_DIR/pgbouncer/userlist.txt"
echo "[init-secrets] Generated .env, init-auth-query.sql, and pgbouncer/userlist.txt"
