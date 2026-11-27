# Production Deployment & Operations Guide (Tusk v2.2)

This guide covers deploying **Tusk** cleanly on **Dokploy** or a standalone Linux VPS with Docker Compose.

---

## 1. Generating Required Secrets

Run the helper script locally (or via `bun`) to generate strong keys and an Argon2id admin password hash:

```bash
bun -e '
const hash = await Bun.password.hash("CHANGE_YOUR_PANEL_PASSWORD", { algorithm: "argon2id" });
const rand = () => Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
console.log("PG_SUPERUSER_PASSWORD=" + rand());
console.log("PGBOUNCER_AUTH_PASSWORD=" + rand());
console.log("MASTER_KEY=" + rand());
console.log("BACKUP_ENCRYPTION_KEY=" + rand());
console.log("PANEL_ADMIN_PASSWORD_HASH_B64=" + Buffer.from(hash).toString("base64"));
'
```

> **Tip for Dokploy:** Always use `PANEL_ADMIN_PASSWORD_HASH_B64` instead of raw `PANEL_ADMIN_PASSWORD_HASH` in Dokploy's Environment UI so `$` characters in Argon2id hashes are never stripped by `.env` variable interpolation.

For standalone VPS setup, you can run:
```bash
chmod +x scripts/init-secrets.sh scripts/cold-dr.sh scripts/init-auth-query.sh
./scripts/init-secrets.sh
docker compose up -d --build
```

---

## 2. Connecting Applications (Internal & External)

`pgbouncer` automatically initializes `/etc/pgbouncer/userlist.txt` and generates a persistent self-signed TLS certificate on the `pgbouncer_tls` volume with `CLIENT_TLS_SSLMODE=allow`:

### A. Same-VPS Docker Apps (Internal Network)
Attach your app container to the Tusk Docker network (e.g. `<compose_project>_pg_internal`) and use the **Internal (Docker)** connection string from the panel:
```env
DATABASE_URL="postgres://app_user:PASSWORD@pgbouncer:6432/app_db?sslmode=disable"
```

### B. External Apps (Vercel, Workers, Remote VPS, Local Tools)
1. Create a DNS `A` record (e.g. `db.yourdomain.com`) pointing to your VPS IP (**DNS Only** if using Cloudflare).
2. Ensure `PGB_BIND_IP=0.0.0.0`, `PGB_PORT=6432`, `PGB_TLS_MODE=allow`, and `PUBLIC_DB_HOST=db.yourdomain.com` are set in your environment.
3. Open port `6432/tcp` in your VPS firewall (restrict to known server IPs when possible).
4. In the panel **Settings** page, set **Host Publik DB** to `db.yourdomain.com` and **SSL Mode** to `require (TLS)`:
   ```env
   DATABASE_URL="postgres://app_user:PASSWORD@db.yourdomain.com:6432/app_db?sslmode=require"
   ```

---

## 3. Routing the Panel Web UI (Traefik / Dokploy)

* `pg-panel` binds safely to `127.0.0.1:4310` on the host (`PANEL_BIND_IP=127.0.0.1`, `PANEL_PORT=4310`) so it never collides with Dokploy's port `3000` or exposes plain HTTP on `0.0.0.0`.
* In Dokploy **Domains**, add your panel domain (e.g. `tusk.yourdomain.com`) targeting service **`pg-panel`**, Container Port **`3000`**, with **HTTPS On** (Let's Encrypt).
* Do **not** register `db.yourdomain.com` in Dokploy Domains — PostgreSQL traffic goes directly to port `6432` over TCP, not HTTP/HTTPS Traefik.

---

## 4. Enabling TOTP 2FA (Optional)

Generate a 160-bit Base32 secret and set `PANEL_TOTP_SECRET` in `.env` / Dokploy Environment:
```bash
TOTP_SECRET=$(bun -e 'const b=crypto.getRandomValues(new Uint8Array(20)); const a="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let o="",bits=0,v=0; for(const x of b){v=(v<<8)|x;bits+=8;while(bits>=5){o+=a[(v>>>(bits-5))&31];bits-=5}} console.log(o)')
echo "PANEL_TOTP_SECRET=$TOTP_SECRET"
echo "otpauth://totp/Tusk:admin?secret=$TOTP_SECRET&issuer=Tusk"
```

---

## 5. Disaster Recovery (Cold DR)

To restore an encrypted `.dump.enc` archive onto a fresh PostgreSQL instance:
```bash
BACKUP_ENCRYPTION_KEY="your-backup-key" ./scripts/cold-dr.sh \
  ./path/to/backup_file.dump.enc \
  postgres://postgres:password@localhost:5432/target_db
```
