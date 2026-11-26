# Panduan Deployment & Operasional Produksi

Panduan ini berisi konfigurasi siap pakai (*copy-pasteable*) untuk menjalankan **PG Control Panel** di VPS Dokploy maupun server mandiri tanpa ketergantungan SaaS pihak ketiga.

---

## 1. Setup Awal & Generasi Rahasia

```bash
chmod +x scripts/init-secrets.sh scripts/cold-dr.sh
./scripts/init-secrets.sh
```

Skrip ini otomatis membuat:
* `.env` berisi password acak Postgres & PgBouncer, hash Argon2id panel admin, `MASTER_KEY`, dan `BACKUP_ENCRYPTION_KEY`.
* `init-auth-query.sql` & `pgbouncer/userlist.txt` (`chmod 644`).
* Sertifikat TLS self-signed di `pgbouncer/tls/server.crt` & `server.key`.

---

## 2. Skenario Koneksi Produksi (Semua Aktif Bersamaan)

### A. Aplikasi di VPS Dokploy yang Sama (Internal Docker)
Tambahkan aplikasi Anda ke network `tusk_pg_internal` dan gunakan tab **Internal** dari panel:
```env
DATABASE_URL="postgres://app_user:PASSWORD@pgbouncer-tx:6432/app_db?sslmode=disable"
```

### B. Akses via WireGuard VPN
1. Jalankan container WireGuard opsional:
   ```bash
   docker compose --profile wireguard up -d
   ```
2. Di `.env`, ikat port PgBouncer ke IP interface WireGuard (atau `0.0.0.0` dengan firewall tertutup):
   ```env
   PUBLIC_DB_HOST=10.8.0.1
   PGB_BIND_IP=10.8.0.1
   ```
3. Di menu **Settings**, ubah **Host Publik DB** ke `10.8.0.1` dan **SSL Mode** ke `disable` (atau `require`).

### C. Akses Eksternal via TLS + IP Allowlist
1. Di `.env`, buka bind IP dengan mode TLS wajib:
   ```env
   PUBLIC_DB_HOST=db.domainanda.com
   PGB_BIND_IP=0.0.0.0
   PGB_TLS_MODE=require
   ```
2. Kunci firewall VPS agar port `6432` & `6433` hanya menerima IP server aplikasi Anda:
   ```bash
   sudo ufw allow from <IP_SERVER_APP> to any port 6432 proto tcp
   sudo ufw allow from <IP_SERVER_APP> to any port 6433 proto tcp
   ```

---

## 3. Mengaktifkan TOTP 2FA (Opsional)

Generate secret Base32 160-bit dan tambahkan ke `.env`:
```bash
TOTP_SECRET=$(bun -e 'const b=crypto.getRandomValues(new Uint8Array(20)); const a="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let o="",bits=0,v=0; for(const x of b){v=(v<<8)|x;bits+=8;while(bits>=5){o+=a[(v>>>(bits-5))&31];bits-=5}} console.log(o)')
echo "PANEL_TOTP_SECRET=$TOTP_SECRET" >> .env
echo "otpauth://totp/PGPanel:admin?secret=$TOTP_SECRET&issuer=PGPanel"
docker compose up -d pg-panel
```

---

## 4. Build Custom Image Dedicated WAL-G

Untuk mengaktifkan Continuous PITR pada container **Dedicated Enterprise**:
```bash
docker build -t postgres:17-walg ./docker/postgres-walg
```
Lalu set di `.env`:
```env
DEDICATED_WALG_IMAGE=postgres:17-walg
```

---

## 5. Cold Disaster Recovery (DR)

```bash
# 1. Restore database Shared dari file terenkripsi (.dump.enc)
BACKUP_ENCRYPTION_KEY="<key_dari_env>" ./scripts/cold-dr.sh shared backup.dump.enc "postgres://user:pass@host:5432/dbname"

# 2. Restore Dedicated Enterprise via WAL-G PITR ke timestamp tertentu
WALG_S3_PREFIX="s3://pg-backups/walg/erp_prod" ./scripts/cold-dr.sh dedicated /var/lib/postgresql/data "2026-11-26T15:00:00Z"
```
