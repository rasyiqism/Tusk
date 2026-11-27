# Changelog

All notable changes to **Tusk** are documented in this file.

## [Unreleased]

### Added
* **Vertical Scale-Up Presets & Per-Role Guardrails:** Parameterized `PG_MAX_CONNECTIONS`, `PG_SHARED_BUFFERS`, `PG_EFFECTIVE_CACHE_SIZE`, `PG_WORK_MEM`, `PG_MAINTENANCE_WORK_MEM`, `PGB_MAX_CLIENT_CONN`, `PGB_DEFAULT_POOL_SIZE` (default `15`), and `PGB_RESERVE_POOL_SIZE` in `docker-compose.yml` & `.env.example`. Added per-instance `connection_limit` (`CONNECTION LIMIT`) and `statement_timeout_sec` enforcement (`PATCH /api/instances/:id/limits`).
* **Lightweight Time-Series Metrics & Capacity Advisories:** Added SQLite migration `v2` (`scale_up_v2_3`) with `metrics_samples` sampled every 5 minutes (14-day retention), `GET /api/monitor/history`, inline SVG sparklines (`24h`/`7d`) on Dashboard, and automatic pool/cache/disk/RAM saturation advisories on `/api/monitor/overview`.
* **Scale-Out Migration Wizard & Remote Management:** Added `POST /api/instances/:id/migrate/preflight`, streaming `pg_dump | pg_restore` migration (`POST /api/instances/:id/migrate` over SSE `jobStream.ts`), and **Promote to Remote** (`remote_admin_url_enc`) so Tusk can keep managing migrated external PostgreSQL nodes.
* **Per-Instance `backup_cron` & Auto Zstd Compression:** Replaced hardcoded `0 2 * * *` backup dispatch with per-instance 5-field cron evaluation (`PATCH /api/instances/:id/schedule`), and automatic `pg_dump --compress=zstd:3` capability detection (fallback `--compress=6`).
* **Bidirectional Primary & Layer 2 Standby:** Added SQLite migration `v3` (`bidirectional_layer2_v2_4`), `layer2.ts` service, `POST /api/instances/external` (companion local standby pre-provisioning), `PUT`/`DELETE /api/instances/:id/layer2`, `after_backup` automatic mirroring, and 1-click bidirectional `POST /api/instances/:id/layer2/switch` (Promote External ↔ Failback Tusk Local).
* **Comprehensive Documentation:** Added [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/API.md](docs/API.md), and expanded [README.md](README.md) & [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

### Reliability & Redeploy Safety
* **Graceful Shutdown & Container Stop Buffers:** Added `stop_grace_period` (`60s` postgres, `30s` pg-panel, `15s` pgbouncer), `pg-panel` Docker healthcheck, `SIGTERM`/`SIGINT` active-job draining (`beginShutdownAndDrain`), and clean SQLite WAL checkpoint/close (`checkpointAndCloseSqlite`).
* **Zero-Data-Loss SQLite Migrations & Startup Reconciliation:** Added `schema_migrations`, `PRAGMA synchronous = FULL`, automatic transactional `VACUUM INTO *.pre-vN.bak` snapshots prior to schema migrations, and `reconcileInterruptedJobsOnStartup()` (marks interrupted `'running'` backups failed, prunes `*.tmp`, preserves valid backups, and unlocks `active_restore:*` locks left by mid-restore crashes).
* **Key Mismatch & Retention Guards:** Enforced minimum `retention_days` (`MAX(1, retention_days)` and route validation `1..3650`) and graceful handling of `MASTER_KEY` decryption mismatches in `/api/instances/:id/connections`.

---

## [v2.2.0] - 2026-11-27

### Added
* **Dokploy & Zero-Config Container Initialization:** Dynamic `scripts/init-auth-query.sh` entrypoint script and automatic PgBouncer `userlist.txt` + self-signed TLS certificate generation on `pgbouncer_tls` volume.
* **Base64 Admin Hash Support:** Added `PANEL_ADMIN_PASSWORD_HASH_B64` to prevent `$` variable interpolation issues in Docker Compose / Dokploy UIs.
* **Trash Undelete & Immediate Purge:** Added `POST /api/instances/:id/undelete`, `DELETE /api/instances/:id?purge=1`, and a **Sampah (Trash)** tab in the Databases UI.
* **CI/CD & Open Source Release Pipeline:** Added Husky (`pre-commit`, `pre-push`) hooks, GitHub Actions CI, multi-arch (`linux/amd64`, `linux/arm64`) GHCR Docker builds, and automated GitHub Releases.

### Security & Reliability
* **Removed `/var/run/docker.sock` Mount:** Panel now runs completely unprivileged using native PostgreSQL SQL isolation.
* **Fail-Closed Auth & Master Key:** Enforced strict `MASTER_KEY` and `PANEL_ADMIN_PASSWORD_HASH` validation in production, added login rate limiting (`429`), server-side session revocation on logout (`revoked_tokens`), and `Origin`/`Sec-Fetch-Site` CSRF validation.
* **Streaming Backup & Download Anti-OOM:** Streamed `pg_dump`, S3 transfers, and OpenSSL decryption directly without buffering entire archives in RAM; fixed SSE `ReadableStream` cleanup (`cancel()`).
* **Safe Database Pause & Restore:** Preserved superuser access during pause/restore (`REVOKE CONNECT` + `NOLOGIN` instead of `ALLOW_CONNECTIONS = false`) and added `--role` ownership preservation during `pg_restore`.
* **Table Inspector Compatibility:** Added `assertPgObjectName` to inspect `_prisma_migrations`, `__drizzle_migrations`, and CamelCase tables safely.

### Removed
* Pruned premature enterprise/bloat components: `docker/postgres-walg`, dedicated container Docker orchestration, speculative PostgreSQL 18 option, duplicate `pgbouncer-session` daemon, and in-stack WireGuard container.
