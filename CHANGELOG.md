# Changelog

All notable changes to **Tusk** are documented in this file.

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
