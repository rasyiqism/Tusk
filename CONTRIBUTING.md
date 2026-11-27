# Contributing to Tusk

Thank you for your interest in contributing to **Tusk**! We keep the codebase lean, zero-bloat, and strictly focused on single-node self-hosted PostgreSQL management.

## Prerequisites

* [Bun](https://bun.sh/) `>= 1.2`
* [Docker](https://docs.docker.com/get-docker/) & Docker Compose v2 (for integration/container testing)

## Local Development

```bash
cd panel
bun install

# Terminal 1: API server (watch mode)
bun run dev:api

# Terminal 2: Vue 3 + Vite dev server
bun run dev:web
```

## Quality Gates & Git Hooks

Tusk uses **Husky** git hooks installed automatically via `bun install`:

* **`pre-commit`:** Runs `bash -n` on shell scripts and `bun run typecheck` (`tsc` + `vue-tsc`).
* **`pre-push`:** Runs `bun run test` and `bun run build:web`.

Before opening a pull request, ensure all checks pass locally:

```bash
cd panel
bun run typecheck
bun run test
bun run build:web
```

## Guidelines

* Preserve the **Zero-Bloat** principle: avoid adding heavy background daemons, speculative enterprise abstractions, or external SaaS dependencies.
* Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, `docs:`, `ci:`).
* Include unit or integration tests in `panel/apps/api/src/` for any new API or security behavior.
