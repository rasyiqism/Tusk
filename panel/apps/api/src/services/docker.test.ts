import { describe, expect, test } from "bun:test";
import {
  buildDedicatedContainerPayload,
  buildDedicatedPgbouncerPayload,
  buildPitrHelperPayload,
} from "./docker";

describe("docker dedicated container payload", () => {
  test("builds valid payload with resource limits and audit logging", () => {
    const payload = buildDedicatedContainerPayload({
      instanceId: "inst-123",
      name: "enterprise_erp",
      dbName: "enterprise_erp",
      dbUsername: "erp_admin",
      password: "secret",
      pgVersion: "17",
      cpuLimit: 2,
      ramLimitMb: 1024,
      hostPort: 5445,
      enableWalg: false,
    });

    expect(payload.HostConfig.NanoCpus).toBe(2_000_000_000);
    expect(payload.HostConfig.Memory).toBe(1024 * 1024 * 1024);
    expect(payload.Labels["managed-by"]).toBe("pg-panel");
    expect(payload.Cmd).toContain("log_statement=ddl");
    expect(payload.Cmd).toContain("shared_buffers=256MB");
  });

  test("rejects out-of-bounds CPU or RAM limits", () => {
    expect(() =>
      buildDedicatedContainerPayload({
        instanceId: "inst-123",
        name: "bad_erp",
        dbName: "bad_erp",
        dbUsername: "erp_admin",
        password: "secret",
        pgVersion: "17",
        cpuLimit: 0.1,
        ramLimitMb: 1024,
        hostPort: 5445,
      })
    ).toThrow();
  });

  test("builds dedicated pgbouncer sidecar payload", () => {
    const pgb = buildDedicatedPgbouncerPayload(
      {
        instanceId: "inst-123",
        name: "enterprise_erp",
        dbName: "enterprise_erp",
        dbUsername: "erp_admin",
        password: "secret",
        pgVersion: "17",
        cpuLimit: 2,
        ramLimitMb: 1024,
        hostPort: 5445,
      },
      "pg-ded-enterprise_erp"
    );
    expect(pgb.Labels.role).toBe("dedicated-pgbouncer");
    expect(pgb.Env).toContain("DB_HOST=pg-ded-enterprise_erp");
    expect(pgb.HostConfig.PortBindings["6432/tcp"][0].HostPort).toBe("6445");
  });

  test("fails fast when enableWalg is true without S3_BUCKET and builds valid PITR helper payload", () => {
    const prevBucket = process.env.S3_BUCKET;
    try {
      delete process.env.S3_BUCKET;
      expect(() =>
        buildDedicatedContainerPayload({
          instanceId: "inst-123",
          name: "walg_erp",
          dbName: "walg_erp",
          dbUsername: "erp_admin",
          password: "secret",
          pgVersion: "17",
          cpuLimit: 1,
          ramLimitMb: 512,
          hostPort: 5446,
          enableWalg: true,
        })
      ).toThrow();

      process.env.S3_BUCKET = "my-bucket";
      const pitr = buildPitrHelperPayload("walg_erp", "2026-11-26T15:00:00Z");
      expect(pitr.Image).toBe("postgres:17-walg");
      expect(pitr.Cmd[0]).toContain("recovery_target_time = '2026-11-26T15:00:00.000Z'");
    } finally {
      if (prevBucket !== undefined) process.env.S3_BUCKET = prevBucket;
      else delete process.env.S3_BUCKET;
    }
  });
});
