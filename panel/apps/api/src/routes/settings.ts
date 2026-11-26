import { Elysia, t } from "elysia";
import { sqlite, type AuditEventRow, logAudit } from "../db/schema";
import { isSafeOutboundUrl } from "../lib/safeOutboundUrl";
import { getPanelSettings, sendAlert } from "../services/alert";
import { authPlugin } from "./auth";

export const settingsRoutes = new Elysia({ prefix: "/settings" })
  .use(authPlugin)
  .onBeforeHandle(({ isAuthenticated, set }) => {
    if (!isAuthenticated) {
      set.status = 401;
      return { error: "Unauthorized" };
    }
  })
  .get("/", () => {
    return { settings: getPanelSettings() };
  })
  .put(
    "/",
    async ({ body, set }) => {
      const allowInternal = process.env.ALLOW_INTERNAL_WEBHOOKS === "true";
      if (!allowInternal) {
        if (body.ntfy_url && !(await isSafeOutboundUrl(body.ntfy_url))) {
          set.status = 400;
          return { error: "ntfy_url blocked by SSRF policy" };
        }
        if (body.alert_webhook_url && !(await isSafeOutboundUrl(body.alert_webhook_url))) {
          set.status = 400;
          return { error: "alert_webhook_url blocked by SSRF policy" };
        }
      }

      const upsert = sqlite.prepare(`
        INSERT INTO settings (key, value_json, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = datetime('now')
      `);

      const entries: Array<[string, unknown]> = [
        ["ntfy_url", body.ntfy_url],
        ["alert_webhook_url", body.alert_webhook_url],
        ["disk_alert_pct", body.disk_alert_pct],
        ["ram_alert_pct", body.ram_alert_pct],
        ["public_db_host", body.public_db_host],
        ["ssl_mode", body.ssl_mode],
      ];

      for (const [k, v] of entries) {
        upsert.run(k, JSON.stringify(v));
      }

      logAudit("update_settings", { keys: entries.map(([k]) => k) });
      return { ok: true, settings: getPanelSettings() };
    },
    {
      body: t.Object({
        ntfy_url: t.String(),
        alert_webhook_url: t.String(),
        disk_alert_pct: t.Number({ minimum: 10, maximum: 99 }),
        ram_alert_pct: t.Number({ minimum: 10, maximum: 99 }),
        public_db_host: t.String(),
        ssl_mode: t.Union([t.Literal("require"), t.Literal("prefer"), t.Literal("disable")]),
      }),
    }
  )
  .post("/test-alert", async ({ set }) => {
    const result = await sendAlert(
      "PG Control Panel Test Alert",
      "Self-hosted alert channel is configured and working.",
      "default"
    );
    if (result.sent === 0 && result.errors.length === 0) {
      set.status = 400;
      return {
        ok: false,
        error: "Belum ada channel alert aktif (isi URL ntfy, Webhook, atau SMTP_HOST).",
      };
    }
    if (result.sent === 0 && result.errors.length > 0) {
      set.status = 400;
      return {
        ok: false,
        error: result.errors.join("; "),
      };
    }
    return { ok: true, channels: result.channels };
  })
  .get("/audit", () => {
    const events = sqlite
      .prepare(
        `SELECT a.*, i.name AS instance_name
         FROM audit_events a
         LEFT JOIN instances i ON i.id = a.instance_id
         ORDER BY a.id DESC
         LIMIT 100`
      )
      .all() as (AuditEventRow & { instance_name: string | null })[];
    return { events };
  });
