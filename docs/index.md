---
layout: home

hero:
  name: "Tusk"
  text: "Self-Hosted PostgreSQL Control Panel"
  tagline: "Run isolated Postgres databases cleanly on one small VPS with PgBouncer, encrypted backups, and Bidirectional Layer 2."
  image:
    src: /logo.svg
    alt: Tusk Logo
  actions:
    - theme: brand
      text: Deploy
      link: /DEPLOYMENT
    - theme: alt
      text: Architecture
      link: /ARCHITECTURE
    - theme: alt
      text: API
      link: /API

features:
  - title: Isolated Shared Cluster
    details: Dedicated non-superuser PostgreSQL 17 roles, per-role limits, statement timeouts, and REVOKE ALL FROM PUBLIC.
  - title: Built-In PgBouncer
    details: Transaction pooling for 2,000+ client connections with dynamic user_lookup auth and automatic TLS.
  - title: Zero-Data-Loss Redeploy
    details: Additive SQLite migrations with VACUUM INTO pre-migration snapshots, SIGTERM drain, and startup reconciliation.
  - title: Streaming AES-256 Backups
    details: Automated Zstd/custom pg_dump piped via OpenSSL directly to Cloudflare R2 / S3 with restore verification.
  - title: Scale-Up & Layer 2 Failover
    details: Env-based Postgres tuning, 24h/7d capacity advisories, and 1-click Promote/Failback to external nodes.
  - title: Unprivileged & Hardened
    details: Zero docker.sock mount, fail-closed Argon2id + TOTP 2FA, rate limits, CSRF guards, and anti-SSRF.
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
