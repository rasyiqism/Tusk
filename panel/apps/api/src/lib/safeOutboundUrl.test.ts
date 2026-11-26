import { describe, expect, test } from "bun:test";
import { isSafeOutboundUrl, resolveClientIp, safeOutboundFetch } from "./safeOutboundUrl";

describe("anti-SSRF & proxy IP guardrails", () => {
  test("blocks private, loopback, and metadata URLs", async () => {
    expect(await isSafeOutboundUrl("http://127.0.0.1:8080/hook")).toBe(false);
    expect(await isSafeOutboundUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(await isSafeOutboundUrl("http://10.0.0.5/internal")).toBe(false);
    expect(await isSafeOutboundUrl("file:///etc/passwd")).toBe(false);
    await expect(safeOutboundFetch("http://127.0.0.1/admin")).rejects.toThrow();
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
  });
});
