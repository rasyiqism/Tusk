import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const RAW_MASTER_KEY = process.env.MASTER_KEY || "dev-only-insecure-master-key-change-me";

function deriveKey(salt: string): Buffer {
  return scryptSync(RAW_MASTER_KEY, salt, 32);
}

const AES_KEY = deriveKey("pg-panel-aes-v1");
const SESSION_SECRET = deriveKey("pg-panel-session-v1");

/**
 * Encrypts sensitive strings (e.g. DB role passwords) using AES-256-GCM.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", AES_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}.${tag.toString("hex")}.${encrypted.toString("hex")}`;
}

/**
 * Decrypts an AES-256-GCM payload produced by encryptSecret.
 */
export function decryptSecret(payload: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(".");
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error("Invalid encrypted payload format");
  }
  const decipher = createDecipheriv("aes-256-gcm", AES_KEY, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/**
 * Generates a URL-safe random password for PostgreSQL roles.
 */
export function generateStrongPassword(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Signs a session token with HMAC-SHA256.
 */
export function signSessionToken(ttlSeconds = 86400 * 7): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const nonce = randomBytes(16).toString("hex");
  const payload = `${exp}.${nonce}`;
  const sig = createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

/**
 * Verifies an HMAC-SHA256 session token and checks expiration.
 */
export function verifySessionToken(token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [expStr, nonce, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;

  const expectedSig = createHmac("sha256", SESSION_SECRET)
    .update(`${expStr}.${nonce}`)
    .digest("hex");

  if (sig.length !== expectedSig.length || !/^[0-9a-f]+$/i.test(sig)) return false;

  const sigBuf = Buffer.from(sig, "hex");
  const expectedBuf = Buffer.from(expectedSig, "hex");
  if (sigBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(sigBuf, expectedBuf);
}

const PG_IDENTIFIER_RE = /^[a-z][a-z0-9_]{1,62}$/;

/**
 * Strictly validates PostgreSQL database/role identifiers to prevent SQL injection.
 */
export function assertPgIdentifier(value: string, label = "identifier"): string {
  if (!PG_IDENTIFIER_RE.test(value)) {
    throw new Error(
      `Invalid ${label}: must start with lowercase letter and contain only a-z, 0-9, _ (2-63 chars)`
    );
  }
  return value;
}
