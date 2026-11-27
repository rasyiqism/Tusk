# Security Policy

## Architecture Security Guarantees

Tusk is engineered for self-hosted, single-operator PostgreSQL management with a minimal attack surface (detailed further in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)):

* **No Docker Socket Mount:** The `pg-panel` container runs unprivileged without `/var/run/docker.sock`. All database lifecycle and scale operations happen over standard PostgreSQL protocols (`postgres://`).
* **Fail-Closed Authentication:** In production (`NODE_ENV=production`) or with `REQUIRE_AUTH=true`, `MASTER_KEY` (minimum 16 characters) is strictly required at startup and `PANEL_ADMIN_PASSWORD_HASH` / `PANEL_ADMIN_PASSWORD_HASH_B64` is enforced across all protected routes.
* **Brute-Force & CSRF Protection:** Login attempts are rate-limited per verified socket/proxy IP (`429 Too Many Requests`), session cookies are `HttpOnly` + `HMAC-SHA256` signed with server-side revocation on logout (`revoked_tokens`), and mutating routes validate `Origin` and `Sec-Fetch-Site`.
* **Encrypted Secrets & Backups:** Role credentials (`encrypted_password`) and promoted remote Postgres admin URLs (`remote_admin_url_enc`) are encrypted using `AES-256-GCM`; backups are streamed through OpenSSL `aes-256-cbc` (`-pbkdf2`).
* **Anti-SSRF & Injection Guardrails:** Outbound URLs (webhooks, `ntfy`, SMTP hosts, scale-out migration targets) resolve DNS and block metadata/loopback/private IP ranges by default (`ALLOW_INTERNAL_URLS=false`). Database identifiers and table names are validated via `assertPgIdentifier` and `assertPgObjectName`.
* **PgBouncer TLS:** Client connections support TLS (`?sslmode=require`) externally while permitting plain local Docker network connections (`?sslmode=disable`).

## Reporting a Vulnerability

If you discover a security vulnerability, please **do not** open a public issue.

1. Use **GitHub Security Advisories** ("Report a vulnerability" under the Security tab of this repository), or contact the maintainer directly.
2. Include reproduction steps, affected files/versions, and potential impact.
3. We aim to acknowledge reports within 48 hours and publish a fix promptly.
