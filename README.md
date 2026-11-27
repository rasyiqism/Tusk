# Tusk — Self-Hosted PostgreSQL Control Panel

[![CI](https://github.com/rasyiqism/Tusk/actions/workflows/ci.yml/badge.svg)](https://github.com/rasyiqism/Tusk/actions/workflows/ci.yml)
[![Release & Docker Build](https://github.com/rasyiqism/Tusk/actions/workflows/release-docker.yml/badge.svg)](https://github.com/rasyiqism/Tusk/actions/workflows/release-docker.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg)](LICENSE)

A lightweight, zero-bloat, single-operator PostgreSQL Control Panel (**Bun + ElysiaJS + Vue 3 SPA + SQLite + PgBouncer**) designed to manage multiple isolated project databases on a single VPS (Dokploy or standalone Docker Compose) with **no third-party SaaS lock-in**.

---

## Why Tusk?

Running a dozen BaaS containers (like Supabase) just to host stable PostgreSQL databases wastes gigabytes of RAM, while cheap shared DBaaS tiers suffer from `EMAXPOOLSREACHED` and cold-start `CONNECT_TIMEOUT` issues.

**Tusk** keeps your stack lean (**< 150 MB total overhead**):
* **1 × `postgres:17-alpine`** with strict per-database role isolation (`REVOKE ALL FROM PUBLIC`) and anti-hang guardrails (`statement_timeout = 30s`, `idle_in_transaction_session_timeout = 15s`, `temp_file_limit = 500MB`).
* **1 × `pgbouncer`** (`transaction` pooling with `max_prepared_statements = 200` and automatic `auth_query` lookup) supporting both internal Docker traffic (`sslmode=disable`) and external TLS traffic (`sslmode=require`) on port `6432`.
* **1 × `pg-panel`** unprivileged management container (**no `/var/run/docker.sock` mount**).

---

## Features

* **1-Click Isolated Databases:** Provision isolated databases & non-superuser roles with encrypted credential storage (`AES-256-GCM`), password reset, non-blocking streaming clone (`pg_dump | pg_restore`), pause/resume, and 14-day soft-delete trash with instant undelete or purge.
* **Dual Internal & External Access:** Automatic self-signed TLS certificate generation on `pgbouncer` (`CLIENT_TLS_SSLMODE=allow`), ready for both same-VPS Docker networks and external apps (Vercel, Next.js, Drizzle, Prisma).
* **Read-Only Table Inspector:** Browse tables (including `_prisma_migrations`, `__drizzle_migrations`, and CamelCase tables), inspect column schemas, and preview the first 25 rows directly from `/instances/:id/tables`.
* **Live Monitoring & Slow Queries:** Real-time VPS RAM/Disk/Load metrics, PgBouncer pool stats, active `pg_stat_activity` connections with safe PID termination, and `pg_stat_statements` top slow queries.
* **Streaming Encrypted Backups & DR:** Daily & manual streaming `pg_dump` encrypted with OpenSSL `aes-256-cbc` (`-pbkdf2`) to S3-compatible storage (R2, MinIO, Garage, AWS S3) or local volume, streaming decrypted `.dump` downloads, 1-click restore with pre-restore safety snapshot, weekly TOC integrity verification (`pg_restore --list`), and [scripts/cold-dr.sh](scripts/cold-dr.sh) for bare-metal recovery.
* **Hardened Security & Alerting:** Fail-closed Argon2id admin authentication (`PANEL_ADMIN_PASSWORD_HASH_B64`), optional RFC 6238 TOTP 2FA, login rate limiting, server-side logout revocation, CSRF `Origin` checks, audit log, and alerts via `ntfy`, Webhook, or SMTP.

---

## Quick Start (Docker Compose)

1. Clone the repository and generate secrets:
   ```bash
   git clone https://github.com/rasyiqism/Tusk.git
   cd Tusk
   chmod +x scripts/init-secrets.sh scripts/cold-dr.sh scripts/init-auth-query.sh
   ./scripts/init-secrets.sh
   ```
2. Start the stack:
   ```bash
   docker compose up -d --build
   ```
   *(Or pull the prebuilt GHCR image: `PANEL_IMAGE=ghcr.io/rasyiqism/tusk:latest docker compose up -d`)*
3. Open the panel at `http://127.0.0.1:4310` (bound safely to loopback by default; place behind HTTPS reverse proxy such as Traefik/Caddy/Dokploy for remote access).

---

## Deploying on Dokploy

1. Create a **Compose** service pointing to `https://github.com/rasyiqism/Tusk.git` (`docker-compose.yml`).
2. In the **Environment** tab, set the required variables (`PG_SUPERUSER_PASSWORD`, `PGBOUNCER_AUTH_PASSWORD`, `MASTER_KEY`, `BACKUP_ENCRYPTION_KEY`, `PANEL_ADMIN_PASSWORD_HASH_B64`, `PUBLIC_DB_HOST`). See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for a one-line generator.
3. In the **Domains** tab, bind your panel domain (e.g. `tusk.yourdomain.com`) to service **`pg-panel`**, Container Port **`3000`**, with **HTTPS On** (Let's Encrypt).
4. Point your database DNS `A` record (e.g. `db.yourdomain.com`, **DNS Only** if using Cloudflare) to your VPS IP and open port `6432/tcp` for external access.

---

## Documentation & Links

* Production & Dokploy Deployment Guide: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
* Security Architecture & Reporting: [SECURITY.md](SECURITY.md)
* Contributing & Local Dev: [CONTRIBUTING.md](CONTRIBUTING.md)
* Changelog: [CHANGELOG.md](CHANGELOG.md)
* License: [MIT](LICENSE)
