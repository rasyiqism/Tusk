# Production Deployment & Operations Guide

Complete operational manual for deploying, securing, scaling, backing up, upgrading, and troubleshooting **Tusk** on **Dokploy** or a standalone **Linux VPS**.

---

## Table of Contents

1. [Hardware & Capacity Planning](#1-hardware--capacity-planning)
2. [Environment Variables Reference](#2-environment-variables-reference)
3. [Generating Production Secrets](#3-generating-production-secrets)
4. [Dokploy vs Standalone Setup](#4-dokploy-vs-standalone-setup)
5. [Connecting Applications (Internal, External, ORMs)](#5-connecting-applications-internal-external-orms)
6. [Configuring S3 / Cloudflare R2 / MinIO Backups](#6-configuring-s3--cloudflare-r2--minio-backups)
7. [Configuring Alerts (ntfy, Webhook, SMTP)](#7-configuring-alerts-ntfy-webhook-smtp)
8. [Enabling TOTP 2FA (Optional)](#8-enabling-totp-2fa-optional)
9. [Upgrading & Redeploying Safely (Zero Data Loss)](#9-upgrading--redeploying-safely-zero-data-loss)
10. [Scaling Up (Vertical) & Scaling Out (Remote Nodes)](#10-scaling-up-vertical--scaling-out-remote-nodes)
11. [Disaster Recovery (Cold DR)](#11-disaster-recovery-cold-dr)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Hardware & Capacity Planning

Tusk runs 3 lean containers (`postgres:17-alpine`, `pgbouncer`, `pg-panel`). Base stack memory usage when idle is ~150–300 MB (plus Dokploy/Traefik overhead if colocated on the same VPS).

| VPS Size | Recommended Workload (Colocated w/ Dokploy) | Dedicated DB VPS Capacity | Mandatory Recommendation |
| :--- | :--- | :--- | :--- |
| **2 GB RAM, 20–40 GB Disk** | 2–4 small active DBs (< 2 GB total) | 5–8 lightweight DBs | Set `PGB_DEFAULT_POOL_SIZE=10`; enable S3/R2 backups so local disk stays clean. |
| **4 GB RAM, 40–80 GB Disk** | 5–10 active DBs (~5–15 GB total) | 10–15 active DBs | Default Tusk preset fits well here. |
| **8 GB+ RAM, 80+ GB Disk** | 15–25+ active DBs | Multi-GB high-traffic workloads | Bump `PG_SHARED_BUFFERS`, `PG_EFFECTIVE_CACHE_SIZE`, and `PG_MAX_CONNECTIONS`. |

> **Connection Pool Math:** Keep `PG_MAX_CONNECTIONS >= (active_databases × PGB_DEFAULT_POOL_SIZE) + 20`. Leaving 20 spare connections guarantees `pg-panel` admin queries, `pgbouncer_auth`, and `pg_dump` always have room even under heavy app load.

---

## 2. Environment Variables Reference

### Core Required Secrets

| Variable | Required | Default | Purpose |
| :--- | :---: | :--- | :--- |
| `PG_SUPERUSER_PASSWORD` | **Yes** | — | Password for `postgres` superuser on first `pg_shared_data` initialization, used by `pg-panel` & PgBouncer admin. |
| `PGBOUNCER_AUTH_PASSWORD` | **Yes** | `pgbouncer_auth_default_change_me` | Password for restricted `pgbouncer_auth` lookup role created by `scripts/init-auth-query.sh`. |
| `MASTER_KEY` | **Yes** | — | Minimum 16 chars (use 24+ random bytes hex). Derives AES-256-GCM key for stored DB passwords & remote URLs, plus HMAC-SHA256 session cookie secret. **Must not change across redeploys.** |
| `PANEL_ADMIN_PASSWORD_HASH_B64` | **Yes** *(in prod)* | — | Base64-encoded Argon2id hash of the Panel admin password. Preferred over raw `PANEL_ADMIN_PASSWORD_HASH` because `$` characters break `.env` variable expansion in Dokploy. |
| `PANEL_ADMIN_PASSWORD_HASH` | Alt | — | Raw Argon2id hash (only use when `$` escaping is handled properly). Checked before `PANEL_ADMIN_PASSWORD_HASH_B64`. |
| `BACKUP_ENCRYPTION_KEY` | Recommended | `""` | Passphrase used by OpenSSL `aes-256-cbc -pbkdf2` to encrypt backups. If blank, backups are stored unencrypted (`.dump`). **Save safely; required to decrypt `.dump.enc`.** |

### Network, Panel & Security Settings

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `PANEL_IMAGE` | `tusk-pg-panel:local` | Override with `ghcr.io/rasyiqism/tusk:latest` (or pinned tag e.g. `v2.2.0`) to skip local Docker builds. |
| `PANEL_BIND_IP` | `127.0.0.1` | Host IP binding for `pg-panel`. Keep `127.0.0.1` when behind Traefik/Caddy/Dokploy so HTTP isn't exposed directly. |
| `PANEL_PORT` | `4310` | Host port mapped to container port `3000`. Avoids Dokploy's own port `3000`. |
| `PGB_BIND_IP` | `0.0.0.0` | Host IP binding for PgBouncer (`0.0.0.0` for external clients, `127.0.0.1` for local-only/tunnel). |
| `PGB_PORT` | `6432` | External TCP port exposed for PostgreSQL client connections. |
| `PGB_TLS_MODE` | `allow` | `allow` accepts both plain Docker internal connections (`sslmode=disable`) and external TLS (`sslmode=require`). Set `require` to reject all non-TLS client connections. |
| `PUBLIC_DB_HOST` | `localhost` | Default hostname rendered in Panel connection strings (also configurable live in **Settings** UI). |
| `CORS_ORIGIN` | `""` | Comma-separated extra allowed origins for API & CSRF checks. Leave blank for strict same-origin. |
| `COOKIE_SECURE` | `""` | Set `"true"` to always mark session cookies `Secure` even if reverse proxy omits `X-Forwarded-Proto: https`. |
| `PANEL_TOTP_SECRET` | `""` | Optional Base32 TOTP secret to require a 6-digit authenticator code at login. |
| `ALLOW_INTERNAL_URLS` | `true` | Allows webhook alerts and scale-out migration targets on private/Docker IPs (`10.x`, `172.16.x`, `192.168.x`, service hostnames). Set `false` to block private IPs with strict SSRF protection. |
| `DATA_DIR` | `/app/data` | Path inside `pg-panel` holding `pg-panel.sqlite`, migration backups, and local `/backups`. |

### Backup Object Storage (Optional, Strongly Recommended)

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `S3_ENDPOINT` | `""` | S3-compatible URL (e.g. Cloudflare R2, MinIO, AWS S3, Garage). When all 4 S3 keys are set, local dump files are deleted right after upload to save VPS disk. |
| `S3_BUCKET` | `""` | Target bucket name. |
| `S3_REGION` | `us-east-1` | Region string (use `auto` or `us-east-1` for Cloudflare R2). |
| `S3_ACCESS_KEY_ID` | `""` | S3 Access Key ID. |
| `S3_SECRET_ACCESS_KEY` | `""` | S3 Secret Access Key. |

### Notifications / Alerts (Optional)

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `NTFY_URL` | `""` | Fallback `ntfy` topic URL (can be overridden in **Settings** UI). |
| `ALERT_WEBHOOK_URL` | `""` | Fallback JSON `POST` webhook URL (Discord/Slack/custom receiver). |
| `SMTP_HOST`, `SMTP_PORT` | `""`, `587` | SMTP server for email alerts (`465` = implicit TLS, `587` = `STARTTLS`). |
| `SMTP_USER`, `SMTP_PASS` | `""` | SMTP AUTH LOGIN credentials. |
| `SMTP_FROM`, `SMTP_TO` | `pg-panel@localhost`, `""` | Sender and recipient addresses (required together with `SMTP_HOST` to activate SMTP alerts). |

### Vertical Scale Tuning Variables

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `PG_MAX_CONNECTIONS` | `200` | PostgreSQL `max_connections`. |
| `PG_SHARED_BUFFERS` | `256MB` | PostgreSQL `shared_buffers` (~25% of RAM allocated to DB). |
| `PG_EFFECTIVE_CACHE_SIZE` | `768MB` | PostgreSQL planner cache hint (~50–75% of available RAM). |
| `PG_WORK_MEM` | `4MB` | Per-sort/hash operation memory (`max_connections * work_mem` should stay well below total RAM). |
| `PG_MAINTENANCE_WORK_MEM` | `64MB` | Memory for `VACUUM`, `CREATE INDEX`, and `pg_restore`. |
| `PGB_MAX_CLIENT_CONN` | `2000` | Maximum concurrent incoming client sockets accepted by PgBouncer. |
| `PGB_DEFAULT_POOL_SIZE` | `15` | Maximum backend connections opened per `(database, user)` pair in PgBouncer. |
| `PGB_RESERVE_POOL_SIZE` | `5` | Extra burst connections per pool used when client wait exceeds `reserve_pool_timeout`. |

---

## 3. Generating Production Secrets

Run this one-liner wherever `bun` is installed to print a complete, Dokploy-safe set of secrets:

```bash
bun -e '
const hash = await Bun.password.hash("CHANGE_YOUR_PANEL_PASSWORD", { algorithm: "argon2id" });
const rand = () => Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
console.log("PG_SUPERUSER_PASSWORD=" + rand());
console.log("PGBOUNCER_AUTH_PASSWORD=" + rand());
console.log("MASTER_KEY=" + rand());
console.log("BACKUP_ENCRYPTION_KEY=" + rand());
console.log("PANEL_ADMIN_PASSWORD_HASH_B64=" + Buffer.from(hash).toString("base64"));
'
```

Or on a standalone Linux server, run the interactive generator script:

```bash
chmod +x scripts/init-secrets.sh scripts/cold-dr.sh scripts/init-auth-query.sh
./scripts/init-secrets.sh
```

---

## 4. Dokploy vs Standalone Setup

### A. Dokploy Compose Service
1. Create a **Compose** resource in Dokploy linked to `https://github.com/rasyiqism/Tusk.git` (or your fork) and path `docker-compose.yml`.
2. Paste your secrets plus `PUBLIC_DB_HOST=db.yourdomain.com`, `PGB_BIND_IP=0.0.0.0`, `PGB_PORT=6432`, `PGB_TLS_MODE=allow` into the **Environment** tab.
3. Click **Deploy**. Verify all 3 services (`postgres`, `pgbouncer`, `pg-panel`) reach healthy/running status.
4. In **Domains**, add `tusk.yourdomain.com`:
   * **Service Name:** `pg-panel`
   * **Path:** `/`
   * **Container Port:** `3000`
   * **HTTPS:** `On` (Let's Encrypt)
5. **Firewall & DNS for PostgreSQL:**
   * Create DNS `A` record `db.yourdomain.com` $\rightarrow$ VPS IP (**DNS Only** / gray cloud in Cloudflare — HTTP proxies block raw Postgres TCP traffic).
   * Open TCP port `6432` on your VPS firewall (`ufw allow 6432/tcp` or restrict to app server IPs).
   * Do **not** add `db.yourdomain.com` in Dokploy's **Domains** tab (Traefik listens for HTTP/HTTPS, whereas PgBouncer already binds `0.0.0.0:6432` directly).

### B. Standalone VPS with Nginx / Caddy / Traefik
1. Run `./scripts/init-secrets.sh` and `docker compose up -d --build`.
2. Proxy HTTPS traffic from `https://tusk.yourdomain.com` to `http://127.0.0.1:4310` with standard `Host`, `X-Forwarded-Host`, and `X-Forwarded-Proto: https` headers (Tusk checks these headers for cookie `Secure` flags and same-origin CSRF checks).

---

## 5. Connecting Applications (Internal, External, ORMs)

`pgbouncer` starts in `transaction` pooling mode with `max_prepared_statements = 200` and auto-generates a 10-year self-signed TLS cert on `pgbouncer_tls` when `CLIENT_TLS_SSLMODE=allow`.

### A. Apps on the Same Docker / Dokploy Host (Internal)
1. Attach your application container/service to Tusk's bridge network (e.g. `<compose_project>_pg_internal`).
2. Use the **Internal (Docker)** string from the Panel:
   ```env
   DATABASE_URL="postgres://app_user:PASSWORD@pgbouncer:6432/app_db?sslmode=disable"
   ```

### B. External Apps (Vercel, Serverless, Remote VPS, Local CLI)
1. Open Tusk **Settings** UI, set **Host Publik DB** to `db.yourdomain.com` and **SSL Mode** to `require (TLS)`, then click **Save**.
2. Copy the **Transaction Pool (6432)** connection string from **Instances → Link**:
   ```env
   DATABASE_URL="postgres://app_user:PASSWORD@db.yourdomain.com:6432/app_db?sslmode=require"
   ```

### C. ORM & Client Notes (Drizzle, Prisma, node-postgres, postgres.js)
* **Prepared Statements:** `MAX_PREPARED_STATEMENTS=200` is enabled in PgBouncer `1.23.1`, so `postgres.js`, `pg`, Drizzle, and Prisma work smoothly through port `6432` without disabling prepared statements.
* **Self-Signed TLS Certificate:** PgBouncer generates a self-signed x509 cert (`CN=pgbouncer`). Standard `?sslmode=require` (encrypt traffic without public CA verification) works in Node/Bun/`psql`/Go/Python. **Do not** use `sslmode=verify-full` unless you mount a publicly trusted CA cert into `/etc/pgbouncer/tls/`.
* **Direct Schema Migrations (if needed):** Long-running advisory locks or `LISTEN/NOTIFY` require direct Postgres (`5432`) rather than `transaction` pooling. For security, port `5432` is intentionally not exposed publicly in `docker-compose.yml` — run `psql` internally or temporarily SSH-tunnel if needed.

---

## 6. Configuring S3 / Cloudflare R2 / MinIO Backups

In small VPS deployments (20–40 GB disks), storing daily backups locally on `panel_sqlite` can eventually exhaust disk space. Configure S3 object storage in `.env` / Dokploy Environment:

```env
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_BUCKET=tusk-pg-backups
S3_REGION=auto
S3_ACCESS_KEY_ID=your-r2-access-key
S3_SECRET_ACCESS_KEY=your-r2-secret-key
```

When configured:
1. Tusk streams `pg_dump` $\rightarrow$ OpenSSL AES-256-CBC to a temporary file, uploads it to S3 (`<instance_name>/<timestamp>_<type>.dump.enc`), and **immediately removes the local temp file**.
2. Retention cleanup (`0 4 * * *`) automatically deletes expired `scheduled` / `manual` objects older than `retention_days` (minimum 1 day; `pre_restore` and `pre_delete` safety snapshots are exempt from time-based expiry).

---

## 7. Configuring Alerts (ntfy, Webhook, SMTP)

* **ntfy / Webhook:** Configure directly in **Settings** UI (stored in SQLite) or via `NTFY_URL` / `ALERT_WEBHOOK_URL`. Webhook receives JSON `{ title, message, priority, timestamp }`.
* **SMTP Email Alerts:** Set `SMTP_HOST`, `SMTP_PORT` (`465` for SSL or `587` for STARTTLS), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, and `SMTP_TO` in environment variables.
* **Verify Delivery:** Click **Test Alert** in **Settings** (`POST /api/settings/test-alert`) to verify live delivery; failures surface exact error messages from the failing channel.

---

## 8. Enabling TOTP 2FA (Optional)

Generate a 160-bit Base32 secret and add `PANEL_TOTP_SECRET` to your environment:

```bash
TOTP_SECRET=$(bun -e 'const b=crypto.getRandomValues(new Uint8Array(20)); const a="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let o="",bits=0,v=0; for(const x of b){v=(v<<8)|x;bits+=8;while(bits>=5){o+=a[(v>>>(bits-5))&31];bits-=5}} console.log(o)')
echo "PANEL_TOTP_SECRET=$TOTP_SECRET"
echo "otpauth://totp/Tusk:admin?secret=$TOTP_SECRET&issuer=Tusk"
```

Add the `otpauth://` URL (or Base32 secret) to 1Password, Google Authenticator, or Bitwarden, then restart `pg-panel`.

---

## 9. Upgrading & Redeploying Safely (Zero Data Loss)

All persistent state lives on named Docker volumes declared in `docker-compose.yml`:
* `pg_shared_data` — PostgreSQL 17 cluster data directory (`/var/lib/postgresql/data`)
* `panel_sqlite` — Control panel SQLite database (`/app/data/pg-panel.sqlite`) + local `/app/data/backups`
* `pgbouncer_tls` — Persistent PgBouncer TLS server certificate & private key

When upgrading or clicking **Redeploy** in Dokploy (or running `docker compose up -d --build --remove-orphans`):
1. **Your databases, roles, SQLite metadata, and backups are preserved automatically.**
2. `postgres` (`stop_grace_period: 60s`), `pg-panel` (`30s`), and `pgbouncer` (`15s`) stop gracefully instead of hitting Docker's 10-second `SIGKILL`, letting Postgres flush checkpoints and `pg-panel` drain active jobs (`beginShutdownAndDrain`) + checkpoint SQLite WAL (`PRAGMA wal_checkpoint(TRUNCATE)`).
3. On startup, `pg-panel`:
   * Creates an automatic transactional backup (`<dbPath>.pre-v<N>.bak` via `VACUUM INTO`) before applying any new forward-only `schema_migrations`.
   * Reconciles interrupted state (`reconcileInterruptedJobsOnStartup`): marks crashed `'running'` backups as `'failed'`, removes orphan `*.tmp` temp files without touching completed `.dump`/`.dump.enc` archives, and automatically re-enables any `'active'` role left locked (`active_restore:*`) by a mid-restore kill.
4. **Never run `docker compose down -v`** or delete persistent volumes in Dokploy unless intentionally wiping all data.
5. **Never rotate `MASTER_KEY`, `BACKUP_ENCRYPTION_KEY`, or `PG_SUPERUSER_PASSWORD` blindly across redeploys:**
   * Note that Docker's `postgres` image ignores `POSTGRES_PASSWORD` once `pg_shared_data` is already initialized; changing `PG_SUPERUSER_PASSWORD` in `.env` without running `ALTER ROLE postgres WITH PASSWORD ...` inside SQL will lock `pg-panel` and `pgbouncer` out until matched!
   * If `MASTER_KEY` is ever lost or changed, PostgreSQL databases remain 100% intact; `pg-panel` flags affected connection strings as `<KEY_MISMATCH_RESET_REQUIRED>` and you can recover access with **Reset Password**.
   * Keep the PostgreSQL major version pinned (`postgres:17-alpine`); major version upgrades (`17 -> 18+`) require logical dump/restore (`pg_dump` / `cold-dr.sh`).

---

## 10. Scaling Up (Vertical) & Scaling Out (Remote Nodes)

### Vertical Scale-Up (Same VPS)
Tune PostgreSQL & PgBouncer cleanly via `.env` / Dokploy Environment and redeploy without touching data:

| VPS Tier | `PG_SHARED_BUFFERS` | `PG_EFFECTIVE_CACHE_SIZE` | `PG_WORK_MEM` | `PG_MAINTENANCE_WORK_MEM` | `PGB_DEFAULT_POOL_SIZE` | `PG_MAX_CONNECTIONS` |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **2 GB RAM** | `128MB` | `512MB` | `4MB` | `64MB` | `10` | `150` |
| **4 GB RAM (Default)** | `256MB` | `768MB` | `4MB` | `64MB` | `15` | `200` |
| **8 GB+ RAM** | `2GB` | `6GB` | `16MB` | `256MB` | `25` | `300` |

* **Per-Database Role Quotas:** In **Instances → Scale & Jadwal** (`sliders` icon), cap any single app's `CONNECTION LIMIT` (`1..500`) and `statement_timeout` (`1..3600s`) dynamically (`ALTER ROLE`), and adjust its individual `backup_cron` (e.g. `0 */6 * * *` for `prod`, `0 3 * * 0` for `dev`).
* **When to Scale:** Watch **Dashboard** 24h/7d sparklines and capacity advisories (cache hit `< 95%`, pool saturation `>= 75%` or client waits, disk `>= 75%`, RAM `>= 85%`).

### Horizontal Scale-Out & Bidirectional Layer 2 Standby
Tusk keeps **Tusk Local** as the Primary (`Layer 1`) database by default, while allowing an optional external PostgreSQL target (such as 1 legitimate Neon/Supabase Free project or a secondary VPS) to operate as **Layer 2 Warm Standby** (`Instances → Layer 2 & Failover` or **Add → Eksternal**):
1. **Default (`primary_tier = local`):** Apps connect to Tusk. Tusk mirrors snapshots `Local → External` manually or automatically after backups (`after_backup`) without synthetic keep-alive loops.
2. **Promote External → Primary (`Instances → Layer 2 & Failover → Jadikan Eksternal Primary`):** Streams a final cutover snapshot, pauses local writes, switches `primary_tier = external`, and retains the local Tusk DB as Layer 2 standby.
3. **Failback → Tusk Primary (`Kembalikan Tusk Primary`):** Reverse-streams the latest data `External → Local` (`--no-owner --role=<local_user>`), resumes local role logins, and switches `primary_tier = local`.
4. **One-Off Migration (`Instances → Scale-Out / Migrasi`):** Opens a streaming `pg_dump | pg_restore` wizard directly into a dedicated PostgreSQL server.

---

## 11. Disaster Recovery (Cold DR)

Download an encrypted `.dump.enc` archive from S3/R2 or copy it from `/app/data/backups`, then restore directly onto any PostgreSQL instance using [scripts/cold-dr.sh](https://github.com/rasyiqism/Tusk/blob/main/scripts/cold-dr.sh):

```bash
BACKUP_ENCRYPTION_KEY="your-backup-key" ./scripts/cold-dr.sh \
  ./path/to/backup_file.dump.enc \
  postgres://postgres:password@localhost:5432/target_db
```

---

## 12. Troubleshooting

| Symptom | Cause | Resolution |
| :--- | :--- | :--- |
| **`pg-panel` exits immediately (`FATAL: MASTER_KEY...`)** | `NODE_ENV=production` without a `>= 16`-char `MASTER_KEY`. | Set `MASTER_KEY` (24+ random bytes hex) in `.env` or Dokploy Environment and redeploy. |
| **Login returns `HTTP 503` ("HASH is not configured")** | Missing `PANEL_ADMIN_PASSWORD_HASH_B64` / `PANEL_ADMIN_PASSWORD_HASH`. | Generate Argon2id Base64 hash (`SECTION 3`), set `PANEL_ADMIN_PASSWORD_HASH_B64`, redeploy. |
| **Login returns `HTTP 401` with right password on Dokploy** | Used raw `PANEL_ADMIN_PASSWORD_HASH` and Docker `.env` stripped `$argon2id$...`. | Switch to `PANEL_ADMIN_PASSWORD_HASH_B64`. |
| **Login returns `HTTP 403 CSRF validation failed`** | Browser origin doesn't match `Host`/`X-Forwarded-Host` or custom proxy setup. | Ensure reverse proxy forwards `Host` & `X-Forwarded-Proto`, or set `CORS_ORIGIN=https://your-panel-domain`. |
| **Cannot connect to `db.domain.com:6432` externally** | Firewall blocking `6432/tcp`, Cloudflare orange-cloud proxy enabled, or `db.domain.com` registered as HTTP domain in Dokploy. | Keep Cloudflare **DNS Only**, open `6432/tcp`, verify `PGB_BIND_IP=0.0.0.0`, and remove `db.*` from Dokploy HTTP Domains. |
| **PgBouncer auth error after changing `PGBOUNCER_AUTH_PASSWORD`** | `init-auth-query.sh` only runs on empty `pg_shared_data`. Postgres still has old `pgbouncer_auth` password. | Update password inside Postgres: `docker compose exec postgres psql -U postgres -c "ALTER ROLE pgbouncer_auth WITH PASSWORD 'new_pass';"` |
| **Connection strings show `<KEY_MISMATCH_RESET_REQUIRED>`** | `MASTER_KEY` changed compared to when that DB was created. | Click **Reset Sandi** on that DB in **Instances** to generate & re-encrypt a new password. |
