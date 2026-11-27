# Panduan Deployment & Operasional Produksi (Tusk v2.2)

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

## 2. Skenario Koneksi Produksi

### A. Aplikasi di VPS Dokploy yang Sama (Internal Docker)
Tambahkan aplikasi Anda ke network `pg_internal` dan gunakan tab **Internal** dari panel:
```env
DATABASE_URL="postgres://app_user:PASSWORD@pgbouncer:6432/app_db?sslmode=disable"
```

### B. Akses Eksternal via TLS + IP Allowlist
1. Di `.env`, atur host publik dan mode TLS:
   ```env
   PUBLIC_DB_HOST=db.domainanda.com
   PGB_BIND_IP=0.0.0.0
   PGB_PORT=6432
   PGB_TLS_MODE=require
   ```
2. Kunci firewall VPS (UFW) agar port `6432` hanya menerima trafik dari IP server website Anda:
   ```bash
   sudo ufw allow from <IP_SERVER_APP> to any port 6432 proto tcp
   ```

### C. Migrasi Skema & DDL (Prisma / Drizzle)
Untuk operasi migrasi yang memerlukan direct session atau DDL locking, gunakan port direct `:5432`:
```env
DIRECT_URL="postgres://app_user:PASSWORD@db.domainanda.com:5432/app_db?sslmode=require"
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

## 4. Disaster Recovery (Cold DR)

Jika VPS utama mengalami kerusakan total, pulihkan database ke server baru dengan skrip Cold DR:
```bash
BACKUP_ENCRYPTION_KEY="kunci-enkripsi-anda" ./scripts/cold-dr.sh \
  ./path/ke/backup_file.dump.enc \
  postgres://postgres:password@localhost:5432/target_db
```
Skrip akan otomatis mendekripsi stream dengan OpenSSL AES-256-CBC dan me-restore seluruh data via `pg_restore`.
