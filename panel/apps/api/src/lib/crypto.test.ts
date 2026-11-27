import { describe, expect, test } from "bun:test";
import {
  assertPgIdentifier,
  assertPgObjectName,
  decryptSecret,
  encryptSecret,
  generateStrongPassword,
  signSessionToken,
  verifySessionToken,
} from "./crypto";

describe("crypto & identifier guards", () => {
  test("encryptSecret and decryptSecret roundtrip", () => {
    const secret = generateStrongPassword(16);
    const encrypted = encryptSecret(secret);
    expect(encrypted).not.toBe(secret);
    expect(decryptSecret(encrypted)).toBe(secret);
  });

  test("signSessionToken and verifySessionToken", () => {
    const token = signSessionToken(60);
    expect(verifySessionToken(token)).toBe(true);
    expect(verifySessionToken(token + "tamper")).toBe(false);
    expect(verifySessionToken(undefined)).toBe(false);
  });

  test("assertPgIdentifier accepts valid and rejects injection", () => {
    expect(assertPgIdentifier("kbm_printing_prod")).toBe("kbm_printing_prod");
    expect(() => assertPgIdentifier("bad; DROP TABLE users;--")).toThrow();
    expect(() => assertPgIdentifier("UppercaseName")).toThrow();
    expect(() => assertPgIdentifier("1starts_with_num")).toThrow();
  });

  test("assertPgObjectName allows Prisma/Drizzle/CamelCase tables while blocking SQL injection", () => {
    expect(assertPgObjectName("_prisma_migrations")).toBe("_prisma_migrations");
    expect(assertPgObjectName("__drizzle_migrations")).toBe("__drizzle_migrations");
    expect(assertPgObjectName("UserAccounts")).toBe("UserAccounts");
    expect(() => assertPgObjectName("users; DROP TABLE users;--")).toThrow();
    expect(() => assertPgObjectName('bad"quote')).toThrow();
    expect(() => assertPgObjectName("1bad")).toThrow();
  });
});
