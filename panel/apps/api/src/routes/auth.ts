import { createHash } from "node:crypto";
import { Elysia, t } from "elysia";
import { signSessionToken, verifySessionToken } from "../lib/crypto";
import { resolveClientIp } from "../lib/safeOutboundUrl";
import { verifyTotpCode } from "../lib/totp";
import { logAudit, sqlite } from "../db/schema";

const SESSION_COOKIE = "pg_panel_session";
const MAX_LOGIN_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const loginAttempts = new Map<string, { failures: number; resetAt: number }>();

function getAdminHash(): string {
  return process.env.PANEL_ADMIN_PASSWORD_HASH || "";
}

function getTotpSecret(): string {
  return process.env.PANEL_TOTP_SECRET || "";
}

function isAuthFailClosed(): boolean {
  return process.env.NODE_ENV === "production" || process.env.REQUIRE_AUTH === "true";
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isTokenRevoked(token: string): boolean {
  const row = sqlite
    .prepare("SELECT token_hash FROM revoked_tokens WHERE token_hash = ?")
    .get(hashToken(token)) as { token_hash: string } | undefined;
  return Boolean(row);
}

function revokeToken(token: string | undefined) {
  if (!token) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const expPart = Number(token.split(".")[0]);
  const expiresAt = Number.isFinite(expPart) ? expPart : nowSec + 86400 * 7;

  sqlite.prepare("DELETE FROM revoked_tokens WHERE expires_at < ?").run(nowSec);
  sqlite
    .prepare("INSERT OR REPLACE INTO revoked_tokens (token_hash, expires_at) VALUES (?, ?)")
    .run(hashToken(token), expiresAt);
}

function checkAuthenticated(token: string | undefined): boolean {
  const adminHash = getAdminHash();
  if (!adminHash) {
    // Fail-closed in production; non-production only allows open access if REQUIRE_AUTH is not forced
    return !isAuthFailClosed();
  }
  if (!verifySessionToken(token)) return false;
  return !isTokenRevoked(token!);
}

export function resetLoginRateLimiter() {
  loginAttempts.clear();
}

export const authPlugin = new Elysia({ name: "auth-guard" }).derive(
  { as: "global" },
  ({ cookie }) => {
    const token = cookie[SESSION_COOKIE]?.value as string | undefined;
    return { isAuthenticated: checkAuthenticated(token) };
  }
);

export const authRoutes = new Elysia({ prefix: "/auth" })
  .get("/me", ({ cookie }) => {
    const token = cookie[SESSION_COOKIE]?.value as string | undefined;
    const adminHash = getAdminHash();
    return {
      authenticated: checkAuthenticated(token),
      authConfigured: Boolean(adminHash),
      totpRequired: Boolean(getTotpSecret()),
    };
  })
  .post(
    "/login",
    async ({ body, cookie, set, request, server }) => {
      const adminHash = getAdminHash();
      const totpSecret = getTotpSecret();
      const ip = resolveClientIp({ server, request });
      const now = Date.now();

      if (!adminHash && isAuthFailClosed()) {
        set.status = 503;
        return {
          ok: false,
          error: "PANEL_ADMIN_PASSWORD_HASH is not configured on the server",
        };
      }

      const record = loginAttempts.get(ip);
      if (record) {
        if (now > record.resetAt) {
          loginAttempts.delete(ip);
        } else if (record.failures >= MAX_LOGIN_FAILURES) {
          set.status = 429;
          return {
            ok: false,
            error: "Terlalu banyak percobaan login gagal. Coba lagi dalam 15 menit.",
          };
        }
      }

      const registerFailure = () => {
        const cur = loginAttempts.get(ip);
        if (!cur || now > cur.resetAt) {
          loginAttempts.set(ip, { failures: 1, resetAt: now + LOGIN_WINDOW_MS });
        } else {
          cur.failures += 1;
        }
      };

      if (adminHash) {
        let valid = false;
        try {
          valid = await Bun.password.verify(body.password, adminHash);
        } catch {
          valid = false;
        }
        if (!valid) {
          registerFailure();
          logAudit("login_failed", { reason: "invalid_password" }, null, ip);
          set.status = 401;
          return { ok: false, error: "Invalid password" };
        }
      }

      if (totpSecret) {
        if (!body.totpCode || !verifyTotpCode(totpSecret, body.totpCode)) {
          registerFailure();
          logAudit("login_failed", { reason: "invalid_totp" }, null, ip);
          set.status = 401;
          return { ok: false, error: "Invalid or missing TOTP 2FA code" };
        }
      }

      loginAttempts.delete(ip);

      const isHttps =
        process.env.COOKIE_SECURE === "true" ||
        request.headers.get("x-forwarded-proto") === "https";

      const token = signSessionToken();
      cookie[SESSION_COOKIE].set({
        value: token,
        httpOnly: true,
        sameSite: "lax",
        secure: isHttps,
        path: "/",
        maxAge: 86400 * 7,
      });

      logAudit("login", { success: true, totp: Boolean(totpSecret) }, null, ip);
      return { ok: true };
    },
    {
      body: t.Object({
        password: t.String(),
        totpCode: t.Optional(t.String()),
      }),
    }
  )
  .post("/logout", ({ cookie }) => {
    const token = cookie[SESSION_COOKIE]?.value as string | undefined;
    revokeToken(token);
    cookie[SESSION_COOKIE].remove();
    return { ok: true };
  });
