# PG Control Panel

Self-hosted, single-operator PostgreSQL Control Panel (Bun + ElysiaJS + Vue 3 SPA + SQLite + PgBouncer + WAL-G) tanpa ketergantungan SaaS pihak ketiga.

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

* **Hybrid Isolation:** Shared Cluster (`postgres:17-alpine` + PgBouncer `auth_query`) dan Dedicated Enterprise Container (CPU/RAM limit + PgBouncer sidecar + WAL-G PITR).
* **4 Mode Koneksi:** `Internal` (`pgbouncer-tx:6432`), `Transaction` (`:6432`), `Session` (`:6433`), dan `Direct` (`:5432`) dengan TLS otomatis.
* **Table Inspector:** Halaman khusus `/instances/:id/tables` untuk memeriksa daftar tabel, kolom, tipe data, dan pratinjau 25 baris pertama (*read-only*).
* **Backup & DR:** Streaming `pg_dump` terenkripsi (`aes-256-cbc`) ke S3-compatible / lokal, download `.dump` terdekripsi otomatis, 1-Click Restore, Automated Restore Test mingguan, retensi otomatis, dan purge soft-delete 14 hari.
* **Keamanan & Alert:** Argon2id + HMAC session cookie, TOTP 2FA opsional, Anti-SSRF outbound fetcher (`safeOutboundFetch`), Audit Log, serta notifikasi via `ntfy`, Webhook, atau SMTP.

## Dokumentasi Lengkap & Pengujian

* Panduan produksi (WireGuard, TLS Allowlist, WAL-G, TOTP, Cold DR): [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
* Pengujian & build lokal:
  ```bash
  cd panel
  bun install
  bun run typecheck
  bun run test
  bun run build:web
  ```
