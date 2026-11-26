# PRD v2.1: Personal & Enterprise-Ready PostgreSQL Control Panel

> **Status:** Final v2.1 (Single-Operator & Self-Hosted Edition)
>
> **Tanggal:** 26 November 2026
>
> **Tujuan:** Membangun panel manajemen PostgreSQL mandiri (*self-hosted*, **single-operator**, **bebas ketergantungan pihak ketiga**) yang ringan dan bebas bloatware untuk mengelola banyak database proyek pada satu VPS Dokploy — menggabungkan efisiensi **Shared Cluster** untuk proyek harian dan isolasi **Dedicated Container + PITR** untuk proyek *enterprise*.

## 1. Latar Belakang & Prinsip Desain

Platform BaaS seperti Supabase membawa belasan container tambahan yang boros RAM dan tidak diperlukan ketika kebutuhan utamanya adalah **PostgreSQL terkelola yang stabil**. Di sisi lain, layanan DBaaS *shared* murah sering memunculkan masalah operasional seperti *pooler starvation* (`EMAXPOOLSREACHED`), `CONNECT_TIMEOUT` dari runtime serverless, dan minimnya kontrol backup.

Karena platform ini **khusus dipakai sendiri** (bukan SaaS DBaaS publik), seluruh kompleksitas multi-tenant komersial (registrasi pengguna, billing, hard-quota per tenant, distributed mTLS orchestrator, dan custom HTTP SQL proxy) **sengaja dibuang** agar sistem ramping, cepat selesai, dan mudah dirawat jangka panjang. Selain itu, sistem dirancang **tanpa ketergantungan wajib ke layanan SaaS pihak ketiga** (seperti Cloudflare Tunnel/Hyperdrive/Access atau cloud proprietary).

**Prinsip Utama:**

* **Zero-Bloat:** Seluruh overhead panel dan pooler berjalan di bawah **100 MB RAM** di luar engine PostgreSQL.
* **Boring & Battle-Tested:** Menggunakan PostgreSQL murni dan [PgBouncer](https://www.pgbouncer.org/features.html) yang teruji untuk kestabilan proyek *enterprise*.
* **Hybrid Isolation:** Proyek biasa hemat memori di *Shared Cluster*; proyek *enterprise* mendapat container, resource limit, dan PITR terpisah.
* **Zero Lock-In & Self-Hosted:** Koneksi memakai standar TCP/TLS + WireGuard, notifikasi via `ntfy`/Webhook, dan seluruh data/backup tersimpan dalam format standar PostgreSQL di storage pilihan sendiri (VPS SFTP/SSH, Self-Hosted S3 seperti Garage/MinIO, atau S3-compatible lainnya).

## 2. Mode Penyediaan Database (Hybrid)

| Mode | Target Penggunaan | Arsitektur | Backup & RPO |
| :--- | :--- | :--- | :--- |
| **Shared Cluster** | Proyek internal, UMKM, aplikasi harian (misal KBM Printing), dan environment *staging*. | 1 cluster PostgreSQL 17/18 + 2 instance PgBouncer (`tx` & `session`) dengan database & role terpisah per proyek. | `pg_dump --format=custom` terenkripsi harian ke S3-compatible / SFTP node terpisah (RPO 24 jam). |
| **Dedicated Enterprise** | Proyek *enterprise* dengan SLA ketat, trafik tinggi, atau kebutuhan isolasi/handover khusus. | 1 container PostgreSQL + 1 container PgBouncer eksklusif per proyek dengan batas `cpus`, `mem_limit`, dan volume disk terpisah via Docker Engine API. | Continuous WAL archiving + PITR terenkripsi ke S3-compatible / SSH via [WAL-G](https://github.com/wal-g/wal-g) (RPO ~1–5 menit). |

## 3. Arsitektur Sistem

Seluruh komponen berjalan dalam satu stack Docker di VPS Dokploy agar manajemen sederhana, tanpa memerlukan daemon *Node Agent* terpisah. Jika suatu saat perlu menambah VPS kedua (misal *Warm Standby* untuk proyek enterprise), panel cukup berkomunikasi via SSH/WireGuard.

```mermaid
flowchart TD
    Admin["Operator (Admin Tunggal)"] -->|"HTTPS (Traefik) + Built-in Auth / WireGuard"| Panel["PG Control Panel (Bun + ElysiaJS + Vue 3 SPA)"]
    Panel --> LocalDB[("SQLite Metadata & Job Logs")]

    subgraph VPS["Single-Node VPS (Dokploy / Docker Network)"]
        Panel -->|"SQL / Admin Console"| SharedPG[("Shared PostgreSQL 17/18")]
        Panel -->|"SHOW POOLS / STATS"| PGB_Tx["PgBouncer Tx (:6432)"]
        Panel -->|"SHOW POOLS / STATS"| PGB_Sess["PgBouncer Session (:6433)"]
        Panel -->|"Docker Unix Socket API"| DedPG[("Dedicated Enterprise PG + PgBouncer + WAL-G")]
        Panel -->|"Streaming pg_dump + age/AES"| BackupNode[("Self-Hosted S3 / SFTP Backup Node")]
        DedPG -->|"WAL-G (Continuous PITR)"| BackupNode
        Panel -->|"Alert Webhook"| Ntfy["Self-Hosted ntfy / SMTP"]
    end

    Apps["Backend / Serverless / Desktop Apps"] -->|"WireGuard VPN atau TLS + IP Allowlist"| PGB_Tx
    Apps -->|"Session / Migrasi"| PGB_Sess
    PGB_Tx --> SharedPG
    PGB_Sess --> SharedPG
```

### Mengapa Arsitektur Ini Dipilih

* **PgBouncer + `auth_query` (Bukan PgDog):** [PgBouncer](https://www.pgbouncer.org/faq.html) mendukung wildcard database (`*`) dan `auth_query` sehingga DB/role baru langsung bisa dipakai lewat pooler tanpa menulis ulang `userlist.txt`. Sejak versi 1.21+, PgBouncer juga mendukung protocol-level *prepared statements* di mode transaction melalui `max_prepared_statements`.
* **WireGuard + TLS IP Allowlist (Bukan Tunnel/Proxy SaaS):** Koneksi dari backend, desktop app, maupun runtime serverless langsung menuju PgBouncer melalui jaringan privat **WireGuard** (0 MB overhead di kernel Linux atau ~15 MB via `wg-easy`) atau melalui **TLS wajib (`sslmode=require`) + IP Allowlist firewall (`ufw`/`nftables`)**. Tidak ada ketergantungan kuota query maupun vendor pihak ketiga.
* **Bun + ElysiaJS + Vue 3 SPA (Single Container):** ElysiaJS dibangun khusus untuk Bun dengan **Eden Treaty** (*end-to-end type safety* langsung ke Vue 3), `@elysiajs/cron`, `@elysiajs/static`, `Bun.S3Client` (ringan tanpa AWS SDK berat), dan SSE/WebSocket bawaan untuk *live streaming* log backup/restore. Hasil build Vue 3 dilayani sebagai file statis dari container yang sama tanpa server SSR terpisah.

## 4. Fitur Inti

### 4.1 Manajemen Database & Container

* **Shared DB 1-Klik:** Membuat database dengan nama jelas (misal `kbm_printing_prod`), role khusus (`NOSUPERUSER NOCREATEDB NOCREATEROLE`), mencabut akses lintas DB (`REVOKE ALL ON DATABASE ... FROM PUBLIC`), dan langsung menampilkan 3 *connection string* siap salin (Transaction `:6432`, Session `:6433`, Direct `:5432`) dalam format `.env`.
* **Dedicated Enterprise Container 1-Klik:** Menjalankan container Postgres (`postgres:17-walg`) + PgBouncer terisolasi melalui Docker Engine Unix Socket API (`/var/run/docker.sock`, tanpa interpolasi shell) dengan validasi ketat batas CPU, RAM, versi Postgres, tuning dasar (`shared_buffers`, `work_mem`, `max_connections`), dan label Docker (`managed-by=pg-panel`, `instance-id=<id>`) untuk rekonsiliasi state.
* **Lifecycle & Cloning Aman:**
  * **Pause/Resume Shared DB:** Menjalankan `ALTER DATABASE ... WITH ALLOW_CONNECTIONS = false`, `ALTER ROLE ... NOLOGIN`, dan `pg_terminate_backend()` pada database target (bukan `PAUSE *` di PgBouncer agar database lain tidak terganggu).
  * **Clone DB (`prod` → `staging`):** Menggunakan streaming `pg_dump | pg_restore` alih-alih `CREATE DATABASE ... TEMPLATE` agar `prod` tetap online tanpa terblokir oleh koneksi aktif/idle di PgBouncer.
  * **Reset Password & Soft-Delete:** Reset password role dengan tampilan sekali lihat; delete aman menandai `status = 'deleted'`, memutus koneksi, membuat backup `pre_delete` otomatis ke storage, dan menahan penghapusan permanen selama masa tenggang (*grace period*).

### 4.2 Koneksi, Keamanan & Audit Standar Enterprise

* **Jaringan Tertutup:** Port database tidak dibuka bebas ke `0.0.0.0/0`. Akses eksternal hanya melalui **WireGuard VPN** atau **TLS wajib (`client_tls_sslmode=require`) + IP Allowlist** di level firewall VPS.
* **Proteksi Panel Mandiri:** Single Admin Login bawaan `pg-panel` menggunakan hash **Argon2id**, signed `HttpOnly` session cookie, rate limiting login, dan opsional **TOTP 2FA**, diletakkan di belakang Traefik HTTPS (Dokploy) dan/atau dibatasi hanya lewat IP WireGuard.
* **Password Hygiene:** Password role hanya ditampilkan penuh saat dibuat atau di-reset; jika fitur *reveal* diaktifkan, password dienkripsi menggunakan **AES-256-GCM** dengan `MASTER_KEY` terpisah di environment variable.
* **Jejak Audit Postgres (Enterprise):** Mengaktifkan `log_statement = 'ddl'`, `log_connections = on`, `log_disconnections = on`, dan `log_min_duration_statement = 500` untuk investigasi insiden.
* **Guardrail Anti-Hang:** Menyetel `statement_timeout = '30s'`, `idle_in_transaction_session_timeout = '15s'`, dan `temp_file_limit = '500MB'` secara default pada role aplikasi (dengan catatan penggunaan `SET statement_timeout = 0` pada skrip migrasi via pool `:6433` Session mode).

### 4.3 Observability Ringan (Tanpa Prometheus/Grafana)

Data diambil langsung secara *real-time* dari sistem internal PostgreSQL, sistem Linux (`/proc`), dan konsol admin PgBouncer:

* **Kesehatan VPS & DB:** Penggunaan CPU/RAM/Disk VPS, ukuran tiap database (`pg_database_size()`), dan `Cache Hit Ratio` (`pg_stat_database`).
* **Live Connections & Kill PID:** Daftar koneksi aktif dari `pg_stat_activity` + status antrean dari PgBouncer `SHOW POOLS`, lengkap dengan tombol **Terminate PID** (`pg_terminate_backend`) untuk memutus transaksi yang nyangkut langsung dari browser/HP.
* **Query Performance:** Top 10 *Slowest*, *Most Time*, dan *Most Called* queries dari ekstensi `pg_stat_statements` per database.
* **Alert Proaktif Mandiri:** Notifikasi otomatis ke **self-hosted `ntfy`**, **Generic Webhook**, atau **SMTP** jika disk VPS > 75%, RAM/swap kritis, koneksi aktif > 80% kapasitas, atau proses backup/WAL archiving gagal.

### 4.4 Backup, PITR & Disaster Recovery

* **Shared Cluster (Streaming & Terenkripsi):** Cron harian `pg_dump --format=custom --compress=6` menggunakan `postgresql17-client` (versi cocok dengan server) yang di-pipe langsung melalui enkripsi (`age` atau `openssl enc -aes-256-gcm`) dan di-stream via `Bun.S3Client` / SFTP ke storage node terpisah dengan retensi otomatis (misal 7/14/30 hari). Dilengkapi tombol **Backup Sekarang**, **Download `.dump`** (terdekripsi on-the-fly atau presigned URL), dan **1-Click Restore** (otomatis membuat snapshot `pre_restore` sebelum menimpa).
* **Dedicated Enterprise (PITR):** Continuous WAL archiving terenkripsi *client-side* (`WALG_LIBSODIUM_KEY`) ke S3-compatible / SSH node terpisah menggunakan **[WAL-G](https://github.com/wal-g/wal-g)**, memungkinkan pemulihan ke timestamp tertentu (*Point-in-Time Recovery*).
* **Automated Restore Test:** Tugas terjadwal mingguan yang mengambil backup terbaru, melakukan restore ke container Postgres sementara, memverifikasi jumlah tabel terbaca (`information_schema.tables`), lalu menghapus container uji tersebut dan mengirim laporan ke `ntfy`/Webhook/SMTP.
* **Mitigasi Single-Node VPS (DR):** Menyediakan skrip *Cold DR* teruji (`scripts/cold-dr.sh`) untuk memulihkan arsip WAL-G/`pg_dump` dari backup node ke VPS cadangan dalam < 15 menit, dengan opsi ekspansi *Warm Standby* (*streaming replication* via WireGuard) di VPS kedua untuk proyek enterprise yang menuntut SLA tinggi.

## 5. Model Data Panel (SQLite Lokal)

Metadata disimpan di satu file SQLite lokal milik `pg-panel` agar tidak bergantung pada cluster Postgres yang sedang dikelola.

```mermaid
erDiagram
    INSTANCES ||--o{ BACKUPS : has
    INSTANCES ||--o{ AUDIT_EVENTS : logs

    INSTANCES {
        string id PK
        string name
        string mode "shared | dedicated"
        string env "prod | staging | dev"
        string pg_version
        string db_name
        string db_username
        string encrypted_password "nullable AES-256-GCM"
        string container_id "nullable for shared"
        int direct_port
        int tx_pool_port
        int session_pool_port
        real cpu_limit "nullable for shared"
        int ram_limit_mb "nullable for shared"
        string backup_strategy "pg_dump | pitr_walg"
        string backup_cron "default 0 2 * * *"
        int retention_days "default 14"
        string status "active | paused | deleted"
        timestamp deleted_at "nullable"
        timestamp created_at
    }
    BACKUPS {
        string id PK
        string instance_id FK
        string type "scheduled | manual | pre_restore | pre_delete | wal_base"
        bigint size_bytes
        int duration_ms
        string storage_key
        string encryption_algo "age | aes-256-gcm"
        string status "running | success | failed"
        string error_message "nullable"
        boolean verified_restore
        timestamp created_at
    }
    AUDIT_EVENTS {
        integer id PK
        string instance_id FK
        string actor "admin"
        string ip_address
        string action "create | clone | pause | resume | kill_pid | restore | reset_pw | delete"
        string detail_json
        timestamp created_at
    }
    SETTINGS {
        string key PK
        string value_json
        timestamp updated_at
    }
```

## 6. Tech Stack

| Lapisan | Teknologi | Alasan |
| :--- | :--- | :--- |
| **Backend API & Orchestrator** | Bun + ElysiaJS (TypeScript) | Dibangun khusus untuk Bun, footprint RAM ~40–70 MB, dilengkapi `@elysiajs/cron`, `@elysiajs/static`, `Bun.S3Client`, dan SSE/WebSocket native. |
| **Frontend UI** | Vue 3 (Vite SPA) + Tailwind CSS + **Eden Treaty** | *End-to-end type safety* langsung dari Elysia ke Vue 3, dibundel sebagai file statis dalam 1 container yang sama. |
| **Metadata & Scheduler** | SQLite (`bun:sqlite`) + `@elysiajs/cron` | Nol ketergantungan eksternal; panel tetap bisa diakses meski Postgres sedang di-restart. |
| **Database Engine** | PostgreSQL 17 / 18 + `pg_stat_statements` | Standar industri, stabil, performa tinggi. |
| **Connection Pooler** | PgBouncer 1.23+ (`max_prepared_statements = 200`) | Ringan (~10–20 MB), mendukung wildcard `*`, `auth_query`, dan client TLS tanpa reload manual. |
| **Backup & PITR** | `pg_dump` + `age`/`openssl` (Shared) & **WAL-G** (Enterprise) | Ringan, single binary (WAL-G), enkripsi *client-side*, tanpa server backup terpisah. |
| **Backup Storage** | Self-Hosted S3 (**Garage** / **MinIO**) atau **SFTP/SSH** *(opsional R2/S3)* | Bebas vendor lock-in, cukup VPS storage murah atau NAS pribadi di lokasi terpisah. |
| **Jaringan & Alert** | **WireGuard** + TLS IP Allowlist + **Self-Hosted `ntfy`** / SMTP | 100% mandiri tanpa SaaS tunnel, proxy, atau API notifikasi pihak ketiga. |

## 7. Rencana Implementasi

### Tahap 1 — Core Stack & Shared Panel (Minggu 1)

* Deploy stack dasar di Dokploy (`postgres`, `pgbouncer-tx`, `pgbouncer-session`, `pg-panel`) dengan `userlist.txt` terotomasi dan pin versi image PgBouncer 1.23+.
* Konfigurasi `auth_query`, TLS client pada PgBouncer, WireGuard / IP Allowlist, dan Built-in Auth (`Argon2id` + cookie) pada `pg-panel`.
* Fitur Create/Reset/Pause/Resume/Clone (`pg_dump | pg_restore`)/Soft-Delete DB, 3 tab *Connection String*, Live Monitor (`Active Connections`, `Kill PID`, `DB Size`, `pg_stat_statements`).
* Cron `pg_dump` terenkripsi harian (streaming ke S3-compatible / SFTP) + SSE live log + tombol Backup/Download/1-Click Restore + alert ke `ntfy`/Webhook/SMTP.

### Tahap 2 — Enterprise Hardening (Minggu 2)

* Provisioning **Dedicated Enterprise Container** (`postgres:17-walg` + PgBouncer + resource limits) lewat Docker Engine Unix Socket API.
* Integrasi **WAL-G** untuk PITR terenkripsi pada container Dedicated + UI restore berbasis timestamp.
* Aktivasi audit logging (`log_statement = 'ddl'`, slow query log) dan **Automated Restore Test** mingguan.
* Uji coba skrip **Cold DR** (`scripts/cold-dr.sh`) ke VPS kedua untuk memvalidasi target pemulihan < 15 menit.

## 8. Lampiran Teknis: Blueprint Awal untuk Dokploy

### 8.1 Skrip Inisialisasi `auth_query` (`init-auth-query.sql`)

Dijalankan sekali pada cluster Shared Postgres agar PgBouncer dapat mengautentikasi user baru secara otomatis tanpa mengedit `userlist.txt`:

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Password disuntikkan saat init atau diubah sesuai env PGBOUNCER_AUTH_PASSWORD
CREATE ROLE pgbouncer_auth WITH LOGIN PASSWORD 'GANTI_PASSWORD_KUAT';

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
```

### 8.2 Kerangka `docker-compose.yml` (Stack Shared + Panel)

```yaml
services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${PG_SUPERUSER_PASSWORD}
    command:
      - "postgres"
      - "-c"
      - "shared_preload_libraries=pg_stat_statements"
      - "-c"
      - "pg_stat_statements.track=all"
      - "-c"
      - "password_encryption=scram-sha-256"
      - "-c"
      - "log_statement=ddl"
      - "-c"
      - "log_min_duration_statement=500"
      - "-c"
      - "max_connections=200"
    volumes:
      - pg_shared_data:/var/lib/postgresql/data
      - ./init-auth-query.sql:/docker-entrypoint-initdb.d/01-init.sql:ro
    networks:
      - pg_internal

  pgbouncer-tx:
    image: edoburu/pgbouncer:v1.23.1-p0
    restart: unless-stopped
    depends_on:
      - postgres
    environment:
      DB_HOST: postgres
      DB_PORT: 5432
      LISTEN_PORT: 6432
      POOL_MODE: transaction
      AUTH_TYPE: scram-sha-256
      AUTH_USER: pgbouncer_auth
      AUTH_QUERY: "SELECT usename, passwd FROM pgbouncer.user_lookup($1)"
      MAX_CLIENT_CONN: 2000
      DEFAULT_POOL_SIZE: 25
      MAX_PREPARED_STATEMENTS: 200
      ADMIN_USERS: postgres
      # Aktifkan jika diekspos via IP Allowlist tanpa WireGuard:
      # CLIENT_TLS_SSLMODE: require
    volumes:
      # Berisi tepat 2 akun: "pgbouncer_auth" dan "postgres" (di-generate oleh init/entrypoint)
      - ./pgbouncer/userlist.txt:/etc/pgbouncer/userlist.txt:ro
    networks:
      - pg_internal

  pgbouncer-session:
    image: edoburu/pgbouncer:v1.23.1-p0
    restart: unless-stopped
    depends_on:
      - postgres
    environment:
      DB_HOST: postgres
      DB_PORT: 5432
      LISTEN_PORT: 6433
      POOL_MODE: session
      AUTH_TYPE: scram-sha-256
      AUTH_USER: pgbouncer_auth
      AUTH_QUERY: "SELECT usename, passwd FROM pgbouncer.user_lookup($1)"
      MAX_CLIENT_CONN: 1000
      DEFAULT_POOL_SIZE: 25
      ADMIN_USERS: postgres
    volumes:
      - ./pgbouncer/userlist.txt:/etc/pgbouncer/userlist.txt:ro
    networks:
      - pg_internal

  pg-panel:
    build: ./panel
    restart: unless-stopped
    depends_on:
      - postgres
      - pgbouncer-tx
      - pgbouncer-session
    environment:
      PG_ADMIN_URL: postgres://postgres:${PG_SUPERUSER_PASSWORD}@postgres:5432/postgres
      PGB_TX_ADMIN_URL: postgres://postgres:${PG_SUPERUSER_PASSWORD}@pgbouncer-tx:6432/pgbouncer
      PGB_SESS_ADMIN_URL: postgres://postgres:${PG_SUPERUSER_PASSWORD}@pgbouncer-session:6433/pgbouncer
      PANEL_ADMIN_PASSWORD_HASH: ${PANEL_ADMIN_PASSWORD_HASH}
      MASTER_KEY: ${MASTER_KEY}
      BACKUP_ENCRYPTION_KEY: ${BACKUP_ENCRYPTION_KEY}
      S3_ENDPOINT: ${S3_ENDPOINT}
      S3_BUCKET: ${S3_BUCKET}
      S3_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID}
      S3_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY}
      NTFY_URL: ${NTFY_URL:-}
      ALERT_WEBHOOK_URL: ${ALERT_WEBHOOK_URL:-}
    volumes:
      - panel_sqlite:/app/data
      - /var/run/docker.sock:/var/run/docker.sock
    networks:
      - pg_internal

volumes:
  pg_shared_data:
  panel_sqlite:

networks:
  pg_internal:
    driver: bridge
```

> **Catatan Implementasi:** Pada `pgbouncer`, pastikan `userlist.txt` hanya berisi kredensial untuk `pgbouncer_auth` dan `postgres` (admin console), sedangkan seluruh user aplikasi baru akan otomatis diverifikasi melalui `AUTH_QUERY`. Untuk akses dari luar VPS, sambungkan `pgbouncer-tx:6432` melalui **WireGuard VPN** atau **TLS + IP Allowlist firewall** alih-alih mengekspos port secara terbuka ke `0.0.0.0/0`.

### 8.3 Struktur Direktori Monorepo (`panel/`)

```text
panel/
├── Dockerfile              # Multi-stage: build Vue 3 -> oven/bun:1-alpine + postgresql17-client + age
├── package.json            # Bun workspaces ("apps/api", "apps/web")
├── apps/
│   ├── api/                # Bun + ElysiaJS
│   │   └── src/
│   │       ├── index.ts    # Entrypoint Elysia, @elysiajs/static, @elysiajs/cron, export type App
│   │       ├── db/         # SQLite schema & queries (instances, backups, audit_events, settings)
│   │       ├── routes/     # auth.ts, instances.ts, monitor.ts, backups.ts
│   │       └── services/   # postgres.ts, pgbouncer.ts, docker.ts, backup.ts, alert.ts
│   └── web/                # Vue 3 + Vite + Tailwind CSS
│       └── src/
│           ├── lib/api.ts  # Eden Treaty client (import type { App } from "@panel/api")
│           ├── pages/      # Dashboard, Instances, Monitor, Backups
│           └── components/ # ConnectionTabs, KillPidTable, SlowQueryList, CreateDbModal
```