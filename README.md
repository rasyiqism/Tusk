# PG Control Panel (Tusk v2.2)

Self-hosted, single-operator PostgreSQL Control Panel (Bun + ElysiaJS + Vue 3 SPA + SQLite + PgBouncer) tanpa bloatware dan bebas ketergantungan SaaS pihak ketiga.

Dirancang khusus untuk mengelola puluhan database proyek dan website pada satu VPS Dokploy dengan konsumsi RAM di bawah 150 MB.

## Quick Start

1. Generate password, hash Argon2id, dan sertifikat TLS PgBouncer:
   ```bash
   chmod +x scripts/init-secrets.sh scripts/cold-dr.sh
   ./scripts/init-secrets.sh
   ```
2. Jalankan stack:
   ```bash
   docker compose up -d --build
   ```
3. Buka panel di `http://localhost:3000`.

## Fitur Utama

* **Zero-Bloat Multi-Database Isolation:** 1 PostgreSQL 17 cluster dengan isolasi native role dan database per website (`REVOKE ALL FROM PUBLIC`).
* **Anti-Hang Guardrails:** Tiap database otomatis dipasangi pembatas `statement_timeout = 30s`, `idle_in_transaction_session_timeout = 15s`, dan `temp_file_limit = 500MB`.
* **PgBouncer Terpadu (`:6432`):** Otomatis me-routing koneksi ribuan aplikasi via `auth_query` dengan dukungan *protocol-level prepared statements*.
* **Mode Koneksi Fleksibel:** `Transaction` (`:6432`) untuk aplikasi web, `Direct` (`:5432`) untuk migrasi skema/DDL (Drizzle/Prisma), dan `Internal` (`pgbouncer:6432`) untuk jaringan Docker VPS.
* **Table Inspector:** Halaman `/instances/:id/tables` untuk memeriksa skema tabel, kolom, tipe data, dan pratinjau 25 baris pertama (*read-only*).
* **Backup & DR Andal:** Streaming `pg_dump` terenkripsi (`aes-256-cbc`) ke S3-compatible / lokal, download `.dump` terdekripsi otomatis, 1-Click Restore, dan Uji Integritas Arsip berkala.
* **Keamanan & Alert:** Kontainer panel berjalan *unprivileged* (tanpa mount `docker.sock`), session auth Argon2id + HMAC, TOTP 2FA opsional, Audit Log, serta notifikasi via `ntfy`, Webhook, atau SMTP.

## Pengujian & Build Lokal

```bash
cd panel
bun install
bun run typecheck
bun run test
bun run build:web
```
