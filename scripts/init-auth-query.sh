#!/usr/bin/env bash
set -euo pipefail

PGB_AUTH_PASS="${PGBOUNCER_AUTH_PASSWORD:-pgbouncer_auth_default_change_me}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v pgb_pass="$PGB_AUTH_PASS" <<'EOSQL'
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgbouncer_auth') THEN
    CREATE ROLE pgbouncer_auth WITH LOGIN;
  END IF;
END
$$;

ALTER ROLE pgbouncer_auth WITH PASSWORD :'pgb_pass';

CREATE SCHEMA IF NOT EXISTS pgbouncer AUTHORIZATION pgbouncer_auth;

CREATE OR REPLACE FUNCTION pgbouncer.user_lookup(in i_username text)
RETURNS TABLE(usename name, passwd text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
    SELECT rolname, rolpassword
    FROM pg_authid
    WHERE rolcanlogin = true
      AND rolname = i_username;
$$;

REVOKE ALL ON FUNCTION pgbouncer.user_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pgbouncer.user_lookup(text) TO pgbouncer_auth;
EOSQL
