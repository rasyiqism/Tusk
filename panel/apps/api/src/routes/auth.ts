import { Elysia, t } from "elysia";
import { signSessionToken, verifySessionToken } from "../lib/crypto";
import { resolveClientIp } from "../lib/safeOutboundUrl";
import { verifyTotpCode } from "../lib/totp";
import { logAudit } from "../db/schema";

const SESSION_COOKIE = "pg_panel_session";
const ADMIN_HASH = process.env.PANEL_ADMIN_PASSWORD_HASH || "";
const TOTP_SECRET = process.env.PANEL_TOTP_SECRET || "";

export const authPlugin = new Elysia({ name: "auth-guard" }).derive(
  { as: "global" },
  ({ cookie }) => {
    const token = cookie[SESSION_COOKIE]?.value as string | undefined;
    const isAuthenticated = !ADMIN_HASH || verifySessionToken(token);
    return { isAuthenticated };
  }
);

export const authRoutes = new Elysia({ prefix: "/auth" })
  .get("/me", ({ cookie }) => {
    const token = cookie[SESSION_COOKIE]?.value as string | undefined;
    return {
      authenticated: !ADMIN_HASH || verifySessionToken(token),
      authConfigured: Boolean(ADMIN_HASH),
      totpRequired: Boolean(TOTP_SECRET),
    };
  })
  .post(
    "/login",
    async ({ body, cookie, set, request }) => {
      if (ADMIN_HASH) {
        const valid = await Bun.password.verify(body.password, ADMIN_HASH);
        if (!valid) {
          set.status = 401;
          return { ok: false, error: "Invalid password" };
        }
      }

      if (TOTP_SECRET) {
        if (!body.totpCode || !verifyTotpCode(TOTP_SECRET, body.totpCode)) {
          set.status = 401;
          return { ok: false, error: "Invalid or missing TOTP 2FA code" };
        }
      }

      const token = signSessionToken();
      cookie[SESSION_COOKIE].set({
        value: token,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 86400 * 7,
      });

      const ip = resolveClientIp({ request });
      logAudit("login", { success: true, totp: Boolean(TOTP_SECRET) }, null, ip);
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
    cookie[SESSION_COOKIE].remove();
    return { ok: true };
  });
