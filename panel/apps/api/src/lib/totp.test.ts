import { describe, expect, test } from "bun:test";
import { generateTotpCode, verifyTotpCode } from "./totp";

describe("RFC 6238 TOTP", () => {
  test("verifies valid 6-digit code and rejects invalid code", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const now = 1_700_000_000_000;
    const code = generateTotpCode(secret, now);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotpCode(secret, code, now)).toBe(true);
    expect(verifyTotpCode(secret, "000000", now)).toBe(false);
    expect(verifyTotpCode(secret, "bad", now)).toBe(false);
  });
});
