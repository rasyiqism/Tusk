# Contributing to Tusk

Thank you for contributing to **Tusk**! We keep the codebase lean, zero-bloat, crash-safe, and easy to operate on both single small VPS hosts and dedicated scaled-out PostgreSQL nodes.

## Prerequisites

* [Bun](https://bun.sh/) `>= 1.2`
* [Docker](https://docs.docker.com/get-docker/) & Docker Compose v2 (for container & integration verification)

## Documentation Map

Before modifying core subsystems, review:
* [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — SQL isolation, SQLite migration & crash recovery, crypto, and streaming job internals
* [docs/API.md](docs/API.md) — HTTP + SSE endpoint contracts
* [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Production environment, Dokploy, and scaling configuration

## Local Development

```bash
cd panel
bun install

# Terminal 1: API server (watch mode)
bun run dev:api

# Terminal 2: Vue 3 + Vite dev server
bun run dev:web
```

*(Note: Setting `NODE_ENV=development` and omitting `PANEL_ADMIN_PASSWORD_HASH` allows local dev iteration without login unless `REQUIRE_AUTH=true` is set.)*

## Quality Gates & Git Hooks

Tusk installs **Husky** git hooks automatically via `bun install`:

* **`pre-commit`:** Runs `bash -n` on shell scripts in `scripts/` and `bun run typecheck` (`tsc --noEmit` + `vue-tsc --noEmit`).
* **`pre-push`:** Runs `bun run test` and `bun run build:web`.

Before opening a pull request, verify all checks locally:

```bash
docker compose --env-file .env.example config -q
cd panel
bun run typecheck
bun run test
bun run build:web
```

## Guidelines

* Preserve the **Zero-Bloat** principle: avoid heavy sidecar daemons (Prometheus, Redis, queues) when SQLite WAL or PostgreSQL primitives solve the problem cleanly.
* Any new SQLite column or table **must** be added as a forward-only additive migration inside `MIGRATIONS` in `panel/apps/api/src/db/schema.ts` using `addColumnIfMissing` — never modify existing migration versions destructively.
* Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, `docs:`, `ci:`).
* Include targeted Bun tests in `panel/apps/api/src/` for any new API, migration, backup, or security behavior.
