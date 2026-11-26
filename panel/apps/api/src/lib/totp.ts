import { createHmac } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Computes a 6-digit RFC 6238 TOTP code for a given Base32 secret and Unix time.
 */
export function generateTotpCode(secret: string, timeMs = Date.now(), stepSec = 30): string {
  const key = base32Decode(secret);
  const counter = Math.floor(timeMs / 1000 / stepSec);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(code % 1_000_000).padStart(6, "0");
}

/**
 * Verifies a 6-digit TOTP code with +/- 1 time step window (30s skew tolerance).
 */
export function verifyTotpCode(secret: string, code: string, timeMs = Date.now()): boolean {
  const normalized = code.trim();
  if (!/^\d{6}$/.test(normalized)) return false;

  for (const offset of [-30_000, 0, 30_000]) {
    if (generateTotpCode(secret, timeMs + offset) === normalized) {
      return true;
    }
  }
  return false;
}
