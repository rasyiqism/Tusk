# Security Policy

## Architecture Security Guarantees

Tusk is designed for self-hosted, single-operator PostgreSQL administration with minimal attack surface:

* **No Docker Socket Mount:** The `pg-panel` container runs unprivileged without `/var/run/docker.sock`. All database lifecycle operations happen strictly over the PostgreSQL protocol.
* **Fail-Closed Authentication:** In production (`NODE_ENV=production`), `MASTER_KEY` (minimum 16 characters) is strictly required at startup and `PANEL_ADMIN_PASSWORD_HASH` / `PANEL_ADMIN_PASSWORD_HASH_B64` is strictly enforced on all protected routes.
* **Brute-Force & CSRF Protection:** Login attempts are rate-limited per socket/proxy IP (`429 Too Many Requests`), session tokens are HMAC-SHA256 signed with server-side revocation on logout, and mutating requests enforce `Origin` / `Sec-Fetch-Site` checks.
* **Encrypted Secrets & Backups:** Role passwords are stored encrypted with AES-256-GCM; database backups are streamed through OpenSSL `aes-256-cbc` (`-pbkdf2`) encryption.
* **PgBouncer TLS:** Client connections to PgBouncer support TLS encryption (`?sslmode=require`) for external traffic while allowing plain internal Docker connections (`?sslmode=disable`).

## Reporting a Vulnerability

If you discover a security vulnerability, please **do not** open a public issue.

1. Use **GitHub Security Advisories** ("Report a vulnerability" under the Security tab of this repository), or contact the maintainer directly.
2. Include reproduction steps, affected files/versions, and potential impact.
3. We aim to acknowledge reports within 48 hours and publish a fix promptly.
