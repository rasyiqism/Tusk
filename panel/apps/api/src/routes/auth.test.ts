import { afterEach, describe, expect, test } from "bun:test";
import { app } from "../index";
import { resetLoginRateLimiter } from "./auth";

describe("Authentication, Rate Limit & CSRF Hardening", () => {
  const origHash = process.env.PANEL_ADMIN_PASSWORD_HASH;
  const origReqAuth = process.env.REQUIRE_AUTH;

  afterEach(() => {
    resetLoginRateLimiter();
    if (origHash !== undefined) process.env.PANEL_ADMIN_PASSWORD_HASH = origHash;
    else delete process.env.PANEL_ADMIN_PASSWORD_HASH;

    if (origReqAuth !== undefined) process.env.REQUIRE_AUTH = origReqAuth;
    else delete process.env.REQUIRE_AUTH;
  });

  test("fails closed when REQUIRE_AUTH=true and password hash is unset", async () => {
    delete process.env.PANEL_ADMIN_PASSWORD_HASH;
    process.env.REQUIRE_AUTH = "true";

    const instRes = await app.handle(new Request("http://localhost/api/instances"));
    expect(instRes.status).toBe(401);

    const loginRes = await app.handle(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "any" }),
      })
    );
    expect(loginRes.status).toBe(503);
  });

  test("enforces 401 without cookie, allows valid login, and rate-limits brute force", async () => {
    const hash = await Bun.password.hash("super-secret-admin-pass", { algorithm: "argon2id" });
    process.env.PANEL_ADMIN_PASSWORD_HASH = hash;
    process.env.REQUIRE_AUTH = "true";

    const unauthRes = await app.handle(new Request("http://localhost/api/instances"));
    expect(unauthRes.status).toBe(401);

    // 5 failed attempts from same IP should trigger 429 on 6th
    for (let i = 0; i < 5; i++) {
      const badLogin = await app.handle(
        new Request("http://localhost/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.77" },
          body: JSON.stringify({ password: "wrong-password" }),
        })
      );
      expect(badLogin.status).toBe(401);
    }

    const blocked = await app.handle(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.77" },
        body: JSON.stringify({ password: "super-secret-admin-pass" }),
      })
    );
    expect(blocked.status).toBe(429);

    // Valid login from another IP succeeds and sets session cookie
    const goodLogin = await app.handle(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.88" },
        body: JSON.stringify({ password: "super-secret-admin-pass" }),
      })
    );
    expect(goodLogin.status).toBe(200);
    const setCookie = goodLogin.headers.get("set-cookie") || "";
    expect(setCookie).toContain("pg_panel_session=");

    const cookiePair = setCookie.split(";")[0];
    const authRes = await app.handle(
      new Request("http://localhost/api/instances", {
        headers: { Cookie: cookiePair },
      })
    );
    expect(authRes.status).toBe(200);

    // Logout revokes the token server-side so reusing the old cookie is rejected
    const logoutRes = await app.handle(
      new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { Cookie: cookiePair },
      })
    );
    expect(logoutRes.status).toBe(200);

    const postLogoutRes = await app.handle(
      new Request("http://localhost/api/instances", {
        headers: { Cookie: cookiePair },
      })
    );
    expect(postLogoutRes.status).toBe(401);
  });

  test("rejects cross-site mutating requests via Origin / Sec-Fetch-Site CSRF check", async () => {
    const res1 = await app.handle(
      new Request("http://localhost:3000/api/auth/logout", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          Origin: "https://evil.attacker.example",
        },
      })
    );
    expect(res1.status).toBe(403);

    const res2 = await app.handle(
      new Request("http://localhost:3000/api/auth/logout", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          "Sec-Fetch-Site": "cross-site",
        },
      })
    );
    expect(res2.status).toBe(403);
  });
});
