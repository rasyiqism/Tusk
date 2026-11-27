# HTTP & SSE API Reference

All API routes are mounted under `/api` and served on container port `3000` (default host `http://127.0.0.1:4310`).

---

## Authentication & CSRF Rules

* **Authentication:** Protected endpoints require the `pg_panel_session` HttpOnly cookie issued by `POST /api/auth/login` (in production / `REQUIRE_AUTH=true`, missing cookies return `401 Unauthorized`).
* **CSRF Protection:** Any mutating request (`POST`, `PUT`, `PATCH`, `DELETE`) must satisfy same-origin checks (`Origin` matches `Host` / `X-Forwarded-Host` or `CORS_ORIGIN`, and `Sec-Fetch-Site` is not `cross-site`), otherwise returns `403 Forbidden`.
* **Error Envelope:** Error responses typically return JSON `{ "error": "<message>" }` or `{ "ok": false, "error": "<message>" }` with appropriate HTTP status (`400`, `401`, `403`, `404`, `429`, `500`, `503`).

---

## 1. Health & Authentication

### `GET /api/health`
Public liveness check used by Docker healthcheck and load balancers.
* **Response `200`:** `{ "ok": true, "time": "2026-11-27T12:00:00.000Z" }`

### `GET /api/auth/me`
Public session & configuration status check.
* **Response `200`:**
  ```json
  {
    "authenticated": true,
    "authConfigured": true,
    "totpRequired": false
  }
  ```

### `POST /api/auth/login`
Authenticates the operator and sets the `pg_panel_session` cookie (7-day TTL, `HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS). Rate-limited to **5 failed attempts per IP per 15 minutes** (`429 Too Many Requests`).
* **Body:** `{ "password": "string", "totpCode": "123456" }` (`totpCode` required only if `PANEL_TOTP_SECRET` is configured)
* **Responses:**
  * `200`: `{ "ok": true }`
  * `401`: `{ "ok": false, "error": "Invalid password" }`
  * `429`: `{ "ok": false, "error": "..." }`
  * `503`: `{ "ok": false, "error": "PANEL_ADMIN_PASSWORD_HASH is not configured on the server" }`

### `POST /api/auth/logout`
Revokes the active token server-side (`revoked_tokens`) and clears the session cookie.
* **Response `200`:** `{ "ok": true }`

---

## 2. Database Instances (`/api/instances`)

All routes below require authentication.

### `GET /api/instances`
Lists managed database instances (omits `encrypted_password` and `remote_admin_url_enc`; exposes `has_saved_password` and `is_remote` booleans).
* **Query Params:** `include_deleted=1` (include soft-deleted instances in Trash).

### `POST /api/instances`
Provisions a new isolated PostgreSQL database and dedicated role with connection and timeout guardrails.
* **Body:**
  ```json
  {
    "name": "my_app_prod",
    "env": "prod",
    "db_name": "my_app_prod",
    "db_username": "my_app_prod_user",
    "retention_days": 14,
    "backup_cron": "0 2 * * *",
    "connection_limit": 25,
    "statement_timeout_sec": 30
  }
  ```
  *Required:* `name` (`^[a-z][a-z0-9_]{1,62}$`), `env` (`"prod" | "staging" | "dev"`).
  *Bounds:* `retention_days` `1..3650`, `connection_limit` `1..500`, `statement_timeout_sec` `1..3600`, valid 5-field `backup_cron`.
* **Response `200`:** `{ "instance": { ... }, "password": "...", "connectionStrings": { "internal", "transaction", "session", "direct" } }`

### `POST /api/instances/external`
Registers an existing external PostgreSQL database (Neon, Supabase, or dedicated VPS) as an instance with `primary_tier: "external"`, while pre-provisioning a companion paused local standby DB slot on Tusk so 1-click Layer 2 mirroring and Failback work out of the box.
* **Body:**
  ```json
  {
    "name": "neon_staging",
    "env": "staging",
    "target_url": "postgres://user:pass@ep-xxx.aws.neon.tech:5432/neondb?sslmode=require",
    "layer2_label": "neon",
    "layer2_sync_mode": "after_backup",
    "retention_days": 14,
    "backup_cron": "0 2 * * *"
  }
  ```

### `PUT /api/instances/:id/layer2` & `DELETE /api/instances/:id/layer2`
* `PUT`: Validates target connectivity and attaches/updates an external PostgreSQL target as Layer 2 standby (`{ target_url, label?, sync_mode?: "after_backup" | "manual" }`).
* `DELETE`: Detaches the external Layer 2 target (rejected with `400` if `primary_tier === "external"` — failback to Tusk first).

### `POST /api/instances/:id/layer2/sync`
Starts an asynchronous snapshot sync (`Local → External` when Tusk is Primary, or reverse `External → Local` when External is Primary). Returns `{ ok: true, jobId }` for `GET /api/backups/jobs/:jobId/stream`.

### `POST /api/instances/:id/layer2/switch`
Bidirectionally switches the active Primary role between `local` and `external` (Promote External → Primary, or Failback External → Tusk Local) with final cutover streaming sync, table parity verification, local role pause/resume management, and alert notification.
* **Body:** `{ "target_tier": "external" | "local", "pause_cutover": true }`
* **Response `200`:** `{ "ok": true, "jobId": "<uuid>" }`

### `GET /api/instances/:id/connections`
Decrypts and returns the active Primary credentials, connection strings, and Layer 2 standby metadata.
* **Response `200`:** `{ "password": "...", "decryptError": false, "primaryTier": "local", "isRemote": false, "standby": { "configured": true, "tier": "external", "target": "ep-xxx:5432/neondb", "label": "neon", "lastSyncAt": "...", "lastSyncStatus": "success" }, "connectionStrings": { ... } }`
  *(If `MASTER_KEY` changed since provisioning, `password` is `"<KEY_MISMATCH_RESET_REQUIRED>"` with `decryptError: true` rather than throwing 500.)*

### `POST /api/instances/:id/reset-password`
Generates a new random 20-byte URL-safe password, executes `ALTER ROLE ... WITH PASSWORD`, and re-encrypts it in SQLite.
* **Response `200`:** `{ "password": "...", "connectionStrings": { ... } }`

### `POST /api/instances/:id/pause` & `POST /api/instances/:id/resume`
Temporarily blocks client logins (`REVOKE CONNECT` + `NOLOGIN`, terminating client backends) or restores login access.

### `POST /api/instances/:id/undelete`
Restores a soft-deleted instance from Trash (`status = 'active'`, `deleted_at = NULL`, `GRANT CONNECT` + `LOGIN`).

### `POST /api/instances/:id/clone`
Creates a new isolated DB/role by non-blocking streaming clone (`pg_dump | pg_restore`).
* **Body:** `{ "target_name": "app_staging", "target_db_name": "app_staging", "env": "staging" }`

### `PATCH /api/instances/:id/limits`
Updates PostgreSQL role guardrails live without restart (`ALTER ROLE ... CONNECTION LIMIT ... SET statement_timeout = ...`). Rejects promoted remote instances.
* **Body:** `{ "connection_limit": 25, "statement_timeout_sec": 30 }`

### `PATCH /api/instances/:id/schedule`
Updates per-instance automated backup cron expression and retention policy.
* **Body:** `{ "backup_cron": "0 */6 * * *", "retention_days": 14 }`

### `POST /api/instances/:id/migrate/preflight`
Tests connectivity to a target external/dedicated PostgreSQL server and inspects version, recovery status, and existing tables.
* **Body:** `{ "target_url": "postgres://user:pass@host:5432/target_db?sslmode=require" }`
* **Response `200`:**
  ```json
  {
    "ok": true,
    "preflight": {
      "targetHost": "host:5432",
      "targetDatabase": "target_db",
      "targetVersion": "PostgreSQL 17.2",
      "sourceTables": 12,
      "targetExistingTables": 0
    }
  }
  ```

### `POST /api/instances/:id/migrate`
Starts an asynchronous streaming `pg_dump | pg_restore` scale-out migration job.
* **Body:** `{ "target_url": "...", "pause_source": true, "promote_remote": false }`
  * Setting `promote_remote: true` promotes `primary_tier = 'external'` and saves `target_url` encrypted in `external_url_enc` on success so future Tusk backups/inspections target the remote server while keeping the local copy as Layer 2 standby.
* **Response `200`:** `{ "ok": true, "jobId": "<uuid>" }` (subscribe via `GET /api/backups/jobs/:jobId/stream`).

### `DELETE /api/instances/:id`
* **Default:** Runs safety `pre_delete` backup (aborts with `500` on failure unless `force=1`), disables role login, and marks `status = 'deleted'` for 14-day grace retention.
* **Permanent Purge (`?purge=1`):** Deletes S3/local backup artifacts, drops local database & role (skipped if `is_remote`), and removes metadata.

---

## 3. Read-Only Table Inspector (`/api/instances/:id/tables`)

* `GET /api/instances/:id/tables` — Lists user tables (`schema_name`, `table_name`, `estimated_rows`, `total_bytes`).
* `GET /api/instances/:id/tables/:schema/:table/columns` — Returns column definitions (`column_name`, `data_type`, `is_nullable`, `column_default`).
* `GET /api/instances/:id/tables/:schema/:table/preview` — Returns up to **25 rows** (`LIMIT 25`).

---

## 4. Backups & Job Streams (`/api/backups`)

* `GET /api/backups` — Lists the latest 100 backup records joined with instance names.
* `POST /api/backups/:id/run` — Runs a manual backup synchronously (returns `{ backup }`), or asynchronously with `?async=1` (returns `{ jobId }`).
* `GET /api/backups/jobs/:jobId/stream` — Server-Sent Events (`text/event-stream`) emitting `data: [ISO] <line>\n\n` for both backup jobs and scale-out migration jobs.
* `POST /api/backups/verify-latest` — Decrypts the latest successful `scheduled`/`manual` backup, verifies archive TOC with `pg_restore --list`, updates `verified_restore = 1`, and sends status alert.
* `GET /api/backups/:id/download` — Streams decrypted `.dump` file (or redirects to 5-minute presigned S3 URL if unencrypted).
* `POST /api/backups/:id/restore` — Captures mandatory `pre_restore` snapshot, pauses active client connections, runs `pg_restore --clean --if-exists --no-owner --role=<db_username>`, and resumes database connections.

---

## 5. Monitoring & Metrics (`/api/monitor`)

* `GET /api/monitor/overview` — Returns live `{ vps, databases, pools, advisories }`, where `advisories` flags `pool_saturation`, `low_cache_hit`, `disk_pressure`, or `ram_pressure`.
* `GET /api/monitor/history?range=24h|7d` — Returns `{ range, samples }` from SQLite `metrics_samples` (capped to 120 points for lightweight charting).
* `GET /api/monitor/connections?db=<optional_db>` — Lists live `client backend` connections from `pg_stat_activity`.
* `POST /api/monitor/kill-pid` — Body `{ "pid": 12345 }`. Calls `pg_terminate_backend` strictly for non-superuser client backends.
* `GET /api/monitor/slow-queries?sort=mean_exec_time|total_exec_time|calls` — Returns top 10 queries from `pg_stat_statements`.

---

## 6. Settings & Audit (`/api/settings`)

* `GET /api/settings` — Returns active panel settings (`ntfy_url`, `alert_webhook_url`, `disk_alert_pct`, `ram_alert_pct`, `public_db_host`, `ssl_mode`).
* `PUT /api/settings` — Updates settings after anti-SSRF validation on URLs (`disk_alert_pct` / `ram_alert_pct` `10..99`, `ssl_mode`: `require | prefer | disable`).
* `POST /api/settings/test-alert` — Triggers test notifications across active `ntfy`, `webhook`, and `smtp` channels.
* `GET /api/settings/audit` — Returns the latest 100 rows from `audit_events`.
