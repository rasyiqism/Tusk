CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Ganti password atau jalankan ./scripts/init-secrets.sh sebelum deploy pertama
CREATE ROLE pgbouncer_auth WITH LOGIN PASSWORD 'CHANGE_ME_PGBOUNCER_AUTH_PASSWORD';

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
