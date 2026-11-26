import { describe, expect, test } from "bun:test";
import { app } from "./index";

describe("PG Control Panel API integration", () => {
  test("GET /api/health returns ok", async () => {
    const res = await app.handle(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; time: string };
    expect(body.ok).toBe(true);
    expect(typeof body.time).toBe("string");
  });

  test("GET /api/auth/me reports auth state", async () => {
    const res = await app.handle(new Request("http://localhost/api/auth/me"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authenticated: boolean; authConfigured: boolean };
    expect(typeof body.authenticated).toBe("boolean");
    expect(typeof body.authConfigured).toBe("boolean");
  });

  test("GET /api/instances returns array", async () => {
    const res = await app.handle(new Request("http://localhost/api/instances"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test("GET /api/backups returns backups list", async () => {
    const res = await app.handle(new Request("http://localhost/api/backups"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { backups: unknown[] };
    expect(Array.isArray(body.backups)).toBe(true);
  });

  test("GET /api/settings and /api/settings/audit return valid payloads", async () => {
    const [sRes, aRes] = await Promise.all([
      app.handle(new Request("http://localhost/api/settings")),
      app.handle(new Request("http://localhost/api/settings/audit")),
    ]);
    expect(sRes.status).toBe(200);
    expect(aRes.status).toBe(200);
    const sBody = (await sRes.json()) as { settings: { disk_alert_pct: number } };
    const aBody = (await aRes.json()) as { events: unknown[] };
    expect(typeof sBody.settings.disk_alert_pct).toBe("number");
    expect(Array.isArray(aBody.events)).toBe(true);
  });

  test("POST /api/settings/test-alert fails honestly when no alert channel is configured", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/settings/test-alert", { method: "POST" })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error.length).toBeGreaterThan(0);
  });
});
