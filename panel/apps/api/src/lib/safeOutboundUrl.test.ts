import { afterEach, describe, expect, test } from "bun:test";
import { isSafeOutboundUrl, resolveClientIp, safeOutboundFetch } from "./safeOutboundUrl";

describe("anti-SSRF & proxy IP guardrails", () => {
  const origAllowInternal = process.env.ALLOW_INTERNAL_URLS;

  afterEach(() => {
    if (origAllowInternal !== undefined) process.env.ALLOW_INTERNAL_URLS = origAllowInternal;
    else delete process.env.ALLOW_INTERNAL_URLS;
  });

  test("blocks private, loopback, and metadata URLs by default", async () => {
    delete process.env.ALLOW_INTERNAL_URLS;
    expect(await isSafeOutboundUrl("http://127.0.0.1:8080/hook")).toBe(false);
    expect(await isSafeOutboundUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(await isSafeOutboundUrl("http://10.0.0.5/internal")).toBe(false);
    expect(await isSafeOutboundUrl("file:///etc/passwd")).toBe(false);
    await expect(safeOutboundFetch("http://127.0.0.1/admin")).rejects.toThrow();
  });

  test("allows internal docker/self-hosted URLs when ALLOW_INTERNAL_URLS=true while still blocking non-HTTP schemes", async () => {
    process.env.ALLOW_INTERNAL_URLS = "true";
    expect(await isSafeOutboundUrl("http://ntfy:80/pg-alerts")).toBe(true);
    expect(await isSafeOutboundUrl("http://127.0.0.1:8080/hook")).toBe(true);
    expect(await isSafeOutboundUrl("file:///etc/passwd")).toBe(false);
  });

  test("ignores spoofed forwarding headers from public socket IPs", () => {
    const publicIp = resolveClientIp({
      server: { requestIP: () => ({ address: "203.0.113.45" }) },
      request: new Request("http://localhost", {
        headers: { "x-forwarded-for": "127.0.0.1", "cf-connecting-ip": "10.0.0.1" },
      }),
    });
    expect(publicIp).toBe("203.0.113.45");

    const proxiedIp = resolveClientIp({
      server: { requestIP: () => ({ address: "127.0.0.1" }) },
      request: new Request("http://localhost", {
        headers: { "x-forwarded-for": "198.51.100.22" },
      }),
    });
    expect(proxiedIp).toBe("198.51.100.22");

    const missingSocketIp = resolveClientIp({
      server: { requestIP: () => null },
      request: new Request("http://localhost", {
        headers: { "x-forwarded-for": "198.51.100.99" },
      }),
    });
    expect(missingSocketIp).toBe("unknown");
  });
});
