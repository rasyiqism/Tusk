---
layout: home

hero:
  name: "Tusk"
  text: "Self-Hosted PostgreSQL Control Panel"
  tagline: "Run multiple isolated databases cleanly on one small VPS with Bun, SQLite WAL, and PgBouncer — scale vertically via env presets or fail over outward with Bidirectional Layer 2."
  actions:
    - theme: brand
      text: Deploy & Scale Guide
      link: /DEPLOYMENT
    - theme: alt
      text: System Architecture
      link: /ARCHITECTURE
    - theme: alt
      text: API Reference
      link: /API

features:
  - title: Isolated Shared Cluster
    details: Dedicated non-superuser PostgreSQL 17 roles, per-role CONNECTION LIMIT, statement_timeout, idle-in-tx cutoffs, and REVOKE ALL FROM PUBLIC.
  - title: Built-In PgBouncer Pooling
    details: Transaction pooling with up to 2,000 concurrent client connections, max_prepared_statements=200, dynamic user_lookup auth, and auto-TLS.
  - title: Redeploy Zero-Data-Loss
    details: Forward-only SQLite migrations with automatic VACUUM INTO pre-migration snapshots, SIGTERM active job draining, and crash reconciliation.
  - title: Streaming Encrypted Backups
    details: Automated Zstd/custom pg_dump piped through OpenSSL AES-256-CBC directly to Cloudflare R2 / S3, plus pre-restore safety snapshots and TOC verification.
  - title: Scale-Up & Bidirectional Layer 2
    details: Env-driven vertical Postgres tuning, 24h/7d SQLite sparkline advisories, and 1-click Promote/Failback between Tusk Local and external Postgres nodes.
  - title: Unprivileged & Hardened
    details: Zero /var/run/docker.sock mount, fail-closed Argon2id auth + TOTP 2FA, login rate limiting, logout revocation, CSRF Origin guards, and anti-SSRF.
---

## Architecture Overview

```mermaid
flowchart LR
  Apps["Client Apps\n(Docker / Vercel / Workers)"] -->|"Port 6432\nTLS allow / require"| PGB["PgBouncer\n(Transaction Pool + auth_query)"]
  PGB -->|"Pooled Backend"| PG["PostgreSQL 17 Alpine\n(Multi-DB + Role Limits)"]
  Admin["Operator Browser"] -->|"HTTPS (Traefik / Dokploy)"| Panel["Tusk Control Panel\n(Bun + Elysia + Vue 3)"]
  Panel -->|"Direct Admin SQL + pg_dump"| PG
  Panel -->|"Metadata + 5m Metrics"| SQLite[("SQLite WAL\n/app/data")]
  Panel -->|"AES-256-CBC Backups"| S3["S3 / Cloudflare R2 / MinIO"]
  Panel -.->|"Bidirectional Layer 2\nPromote / Failback"| RemotePG["External Postgres\n(Neon / Supabase / VPS 2)"]
```

## Quick Start

```bash
git clone https://github.com/rasyiqism/Tusk.git
cd Tusk
chmod +x scripts/init-secrets.sh scripts/cold-dr.sh scripts/init-auth-query.sh
./scripts/init-secrets.sh
docker compose up -d --build
```

Open **`http://127.0.0.1:4310`** on the host or follow [Production Deployment & Scaling](/DEPLOYMENT) for **Dokploy**, **Cloudflare R2**, **Vertical Tuning**, and **Layer 2 Failover**.
