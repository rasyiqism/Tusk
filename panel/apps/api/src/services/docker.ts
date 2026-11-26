import { hostname } from "node:os";
import type { InstanceRow } from "../db/schema";
import { assertPgIdentifier } from "../lib/crypto";

const DOCKER_SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
const DEDICATED_IMAGE = process.env.DEDICATED_PG_IMAGE || "postgres:17-alpine";

let cachedDockerNetwork: string | null = process.env.DOCKER_NETWORK || null;

export async function resolveDockerNetwork(): Promise<string> {
  if (cachedDockerNetwork) return cachedDockerNetwork;
  try {
    const res = await dockerFetch(`/containers/${hostname()}/json`);
    if (res.ok) {
      const info = (await res.json()) as {
        NetworkSettings?: { Networks?: Record<string, unknown> };
      };
      const names = Object.keys(info.NetworkSettings?.Networks || {});
      if (names.length > 0) {
        cachedDockerNetwork = names[0];
        return cachedDockerNetwork;
      }
    }
  } catch {
    // fallback below
  }
  return "pg_internal";
}

export interface DedicatedContainerSpec {
  instanceId: string;
  name: string;
  dbName: string;
  dbUsername: string;
  password: string;
  pgVersion: "17" | "18";
  cpuLimit: number;
  ramLimitMb: number;
  hostPort: number;
  enableWalg?: boolean;
}

async function dockerFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://localhost${path}`, {
    ...init,
    unix: DOCKER_SOCKET,
  } as RequestInit);
}

export function buildDedicatedContainerPayload(
  spec: DedicatedContainerSpec,
  networkName = process.env.DOCKER_NETWORK || "pg_internal"
) {
  const safeName = assertPgIdentifier(spec.name, "name");
  const safeDb = assertPgIdentifier(spec.dbName, "db_name");
  const safeUser = assertPgIdentifier(spec.dbUsername, "db_username");

  if (spec.cpuLimit < 0.25 || spec.cpuLimit > 32) {
    throw new Error("cpu_limit must be between 0.25 and 32");
  }
  if (spec.ramLimitMb < 128 || spec.ramLimitMb > 131072) {
    throw new Error("ram_limit_mb must be between 128 and 131072");
  }
  if (spec.hostPort < 1024 || spec.hostPort > 65535) {
    throw new Error("direct_port must be between 1024 and 65535");
  }

  const sharedBuffersMb = Math.max(32, Math.floor(spec.ramLimitMb * 0.25));
  const workMemMb = Math.max(4, Math.floor(spec.ramLimitMb * 0.02));

  const cmd = [
    "postgres",
    "-c",
    "shared_preload_libraries=pg_stat_statements",
    "-c",
    "pg_stat_statements.track=all",
    "-c",
    "password_encryption=scram-sha-256",
    "-c",
    `shared_buffers=${sharedBuffersMb}MB`,
    "-c",
    `work_mem=${workMemMb}MB`,
    "-c",
    "log_statement=ddl",
    "-c",
    "log_connections=on",
    "-c",
    "log_disconnections=on",
    "-c",
    "log_min_duration_statement=500",
  ];

  if (spec.enableWalg) {
    if (!process.env.S3_BUCKET) {
      throw new Error(
        "WAL-G PITR requires S3_BUCKET, S3_ENDPOINT, and S3 credentials configured in .env"
      );
    }
    cmd.push(
      "-c",
      "wal_level=replica",
      "-c",
      "archive_mode=on",
      "-c",
      "archive_timeout=300",
      "-c",
      "archive_command=wal-g wal-push %p"
    );
  }

  const env = [
    `POSTGRES_USER=${safeUser}`,
    `POSTGRES_PASSWORD=${spec.password}`,
    `POSTGRES_DB=${safeDb}`,
  ];

  if (spec.enableWalg) {
    env.push(
      `WALG_S3_PREFIX=s3://${process.env.S3_BUCKET}/walg/${safeName}`,
      `AWS_ENDPOINT=${process.env.S3_ENDPOINT || ""}`,
      `AWS_ACCESS_KEY_ID=${process.env.S3_ACCESS_KEY_ID || ""}`,
      `AWS_SECRET_ACCESS_KEY=${process.env.S3_SECRET_ACCESS_KEY || ""}`,
      `AWS_REGION=${process.env.S3_REGION || "us-east-1"}`,
      `WALG_LIBSODIUM_KEY=${process.env.BACKUP_ENCRYPTION_KEY || ""}`
    );
  }

  const image = spec.enableWalg
    ? process.env.DEDICATED_WALG_IMAGE || "postgres:17-walg"
    : spec.pgVersion === "18"
      ? "postgres:18-alpine"
      : DEDICATED_IMAGE;

  return {
    Image: image,
    Cmd: cmd,
    Env: env,
    Labels: {
      "managed-by": "pg-panel",
      "instance-id": spec.instanceId,
      "instance-name": safeName,
    },
    ExposedPorts: { "5432/tcp": {} },
    HostConfig: {
      NanoCpus: Math.round(spec.cpuLimit * 1e9),
      Memory: spec.ramLimitMb * 1024 * 1024,
      RestartPolicy: { Name: "unless-stopped" },
      Binds: [`pg_ded_${safeName}:/var/lib/postgresql/data`],
      PortBindings: {
        "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: String(spec.hostPort) }],
      },
      NetworkMode: networkName,
    },
  };
}

export function buildDedicatedPgbouncerPayload(
  spec: DedicatedContainerSpec,
  pgContainerName: string,
  networkName = process.env.DOCKER_NETWORK || "pg_internal"
) {
  const safeName = assertPgIdentifier(spec.name, "name");
  const safeUser = assertPgIdentifier(spec.dbUsername, "db_username");
  const txPort = spec.hostPort + 1000;

  return {
    Image: "edoburu/pgbouncer:v1.23.1-p0",
    Env: [
      `DB_HOST=${pgContainerName}`,
      "DB_PORT=5432",
      "LISTEN_PORT=6432",
      "POOL_MODE=transaction",
      "AUTH_TYPE=scram-sha-256",
      `DB_USER=${safeUser}`,
      `DB_PASSWORD=${spec.password}`,
      "MAX_CLIENT_CONN=1000",
      "DEFAULT_POOL_SIZE=25",
      "MAX_PREPARED_STATEMENTS=200",
    ],
    Labels: {
      "managed-by": "pg-panel",
      "instance-id": spec.instanceId,
      "instance-name": safeName,
      role: "dedicated-pgbouncer",
    },
    ExposedPorts: { "6432/tcp": {} },
    HostConfig: {
      Memory: 64 * 1024 * 1024,
      RestartPolicy: { Name: "unless-stopped" },
      PortBindings: {
        "6432/tcp": [{ HostIp: "127.0.0.1", HostPort: String(txPort) }],
      },
      NetworkMode: networkName,
    },
  };
}

export async function spawnDedicatedContainer(spec: DedicatedContainerSpec): Promise<string> {
  const networkName = await resolveDockerNetwork();
  const payload = buildDedicatedContainerPayload(spec, networkName);
  const safeName = assertPgIdentifier(spec.name, "name");
  const containerName = `pg-ded-${safeName}`;

  const createRes = await dockerFetch(`/containers/create?name=${containerName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!createRes.ok) {
    throw new Error(`Docker create failed (${createRes.status}): ${await createRes.text()}`);
  }

  const { Id } = (await createRes.json()) as { Id: string };

  const startRes = await dockerFetch(`/containers/${Id}/start`, { method: "POST" });
  if (!startRes.ok) {
    throw new Error(`Docker start failed (${startRes.status}): ${await startRes.text()}`);
  }

  // Spawn dedicated PgBouncer sidecar
  const pgbPayload = buildDedicatedPgbouncerPayload(spec, containerName, networkName);
  const pgbCreate = await dockerFetch(`/containers/create?name=pgb-ded-${safeName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(pgbPayload),
  });
  if (pgbCreate.ok) {
    const { Id: pgbId } = (await pgbCreate.json()) as { Id: string };
    await dockerFetch(`/containers/${pgbId}/start`, { method: "POST" }).catch(() => {});
  }

  return Id;
}

export async function execInContainer(containerId: string, cmd: string[]): Promise<string> {
  const createRes = await dockerFetch(`/containers/${containerId}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      AttachStdout: true,
      AttachStderr: true,
      Cmd: cmd,
    }),
  });
  if (!createRes.ok) {
    throw new Error(`Docker exec create failed (${createRes.status}): ${await createRes.text()}`);
  }
  const { Id } = (await createRes.json()) as { Id: string };
  const startRes = await dockerFetch(`/exec/${Id}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Detach: false, Tty: false }),
  });
  if (!startRes.ok) {
    throw new Error(`Docker exec start failed (${startRes.status}): ${await startRes.text()}`);
  }
  return startRes.text();
}

export async function controlDedicatedContainer(
  containerId: string,
  action: "pause" | "unpause" | "stop" | "start" | "remove",
  instanceName?: string
) {
  const sidecarName = instanceName ? `pgb-ded-${assertPgIdentifier(instanceName, "name")}` : null;

  if (action === "remove") {
    await dockerFetch(`/containers/${containerId}?force=true&v=true`, { method: "DELETE" });
    if (sidecarName) {
      await dockerFetch(`/containers/${sidecarName}?force=true&v=true`, { method: "DELETE" }).catch(
        () => {}
      );
    }
    return;
  }
  const res = await dockerFetch(`/containers/${containerId}/${action}`, { method: "POST" });
  if (!res.ok && res.status !== 304) {
    throw new Error(`Docker ${action} failed (${res.status}): ${await res.text()}`);
  }
  if (sidecarName) {
    await dockerFetch(`/containers/${sidecarName}/${action}`, { method: "POST" }).catch(() => {});
  }
}

export async function spawnEphemeralRestoreContainer(name: string, password: string): Promise<string> {
  const networkName = await resolveDockerNetwork();
  const createRes = await dockerFetch(`/containers/create?name=${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      Image: DEDICATED_IMAGE,
      Env: [`POSTGRES_USER=postgres`, `POSTGRES_PASSWORD=${password}`, `POSTGRES_DB=verify_db`],
      Labels: { "managed-by": "pg-panel", role: "restore-test" },
      HostConfig: {
        Memory: 256 * 1024 * 1024,
        NetworkMode: networkName,
      },
    }),
  });

  if (!createRes.ok) {
    throw new Error(`Failed to create restore-test container: ${await createRes.text()}`);
  }
  const { Id } = (await createRes.json()) as { Id: string };
  const startRes = await dockerFetch(`/containers/${Id}/start`, { method: "POST" });
  if (!startRes.ok) {
    await controlDedicatedContainer(Id, "remove");
    throw new Error(`Failed to start restore-test container: ${await startRes.text()}`);
  }
  return Id;
}

/**
 * Recreates the Dedicated PgBouncer sidecar so password resets take effect immediately.
 */
export async function recreateDedicatedPgbouncer(spec: DedicatedContainerSpec): Promise<void> {
  const networkName = await resolveDockerNetwork();
  const safeName = assertPgIdentifier(spec.name, "name");
  const sidecarName = `pgb-ded-${safeName}`;
  const pgContainerName = `pg-ded-${safeName}`;

  await dockerFetch(`/containers/${sidecarName}?force=true`, { method: "DELETE" }).catch(() => {});
  const pgbPayload = buildDedicatedPgbouncerPayload(spec, pgContainerName, networkName);
  const pgbCreate = await dockerFetch(`/containers/create?name=${sidecarName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(pgbPayload),
  });
  if (!pgbCreate.ok) {
    throw new Error(`Failed to recreate sidecar: ${await pgbCreate.text()}`);
  }
  const { Id } = (await pgbCreate.json()) as { Id: string };
  const startRes = await dockerFetch(`/containers/${Id}/start`, { method: "POST" });
  if (!startRes.ok) {
    throw new Error(`Failed to start sidecar: ${await startRes.text()}`);
  }
}

export function buildPitrHelperPayload(instanceName: string, targetTimeIso: string) {
  const safeName = assertPgIdentifier(instanceName, "name");
  if (!process.env.S3_BUCKET) {
    throw new Error("WAL-G PITR requires S3_BUCKET configured in .env");
  }
  const parsedMs = Date.parse(targetTimeIso);
  if (Number.isNaN(parsedMs)) {
    throw new Error("Invalid targetTime ISO timestamp");
  }
  const normalizedIso = new Date(parsedMs).toISOString();
  const walgImage = process.env.DEDICATED_WALG_IMAGE || "postgres:17-walg";

  const script = [
    "rm -rf /var/lib/postgresql/data/*",
    "wal-g backup-fetch /var/lib/postgresql/data LATEST",
    "touch /var/lib/postgresql/data/recovery.signal",
    "echo \"restore_command = 'wal-g wal-fetch %f %p'\" >> /var/lib/postgresql/data/postgresql.auto.conf",
    `echo "recovery_target_time = '${normalizedIso}'" >> /var/lib/postgresql/data/postgresql.auto.conf`,
    "echo \"recovery_target_action = 'promote'\" >> /var/lib/postgresql/data/postgresql.auto.conf",
  ].join(" && ");

  return {
    Image: walgImage,
    Entrypoint: ["/bin/sh", "-c"],
    Cmd: [script],
    Env: [
      `WALG_S3_PREFIX=s3://${process.env.S3_BUCKET}/walg/${safeName}`,
      `AWS_ENDPOINT=${process.env.S3_ENDPOINT || ""}`,
      `AWS_ACCESS_KEY_ID=${process.env.S3_ACCESS_KEY_ID || ""}`,
      `AWS_SECRET_ACCESS_KEY=${process.env.S3_SECRET_ACCESS_KEY || ""}`,
      `AWS_REGION=${process.env.S3_REGION || "us-east-1"}`,
      `WALG_LIBSODIUM_KEY=${process.env.BACKUP_ENCRYPTION_KEY || ""}`,
    ],
    Labels: { "managed-by": "pg-panel", role: "pitr-helper" },
    HostConfig: {
      Binds: [`pg_ded_${safeName}:/var/lib/postgresql/data`],
    },
  };
}

/**
 * Automated WAL-G PITR recovery for Dedicated Enterprise instances.
 */
export async function runDedicatedPitrRecovery(
  instance: InstanceRow,
  targetTimeIso: string
): Promise<void> {
  if (!instance.container_id) {
    throw new Error("Dedicated container ID missing");
  }
  const helperPayload = buildPitrHelperPayload(instance.name, targetTimeIso);
  const helperName = `pg-pitr-${assertPgIdentifier(instance.name, "name")}-${Date.now()}`;

  await controlDedicatedContainer(instance.container_id, "stop", instance.name);

  let helperId: string | null = null;
  try {
    const createRes = await dockerFetch(`/containers/create?name=${helperName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(helperPayload),
    });
    if (!createRes.ok) {
      throw new Error(`PITR helper create failed: ${await createRes.text()}`);
    }
    const { Id } = (await createRes.json()) as { Id: string };
    helperId = Id;

    const startRes = await dockerFetch(`/containers/${helperId}/start`, { method: "POST" });
    if (!startRes.ok) {
      throw new Error(`PITR helper start failed: ${await startRes.text()}`);
    }

    const waitRes = await dockerFetch(`/containers/${helperId}/wait`, { method: "POST" });
    const waitJson = (await waitRes.json()) as { StatusCode?: number };
    if (waitJson.StatusCode !== 0) {
      const logs = await dockerFetch(`/containers/${helperId}/logs?stdout=1&stderr=1`).then((r) =>
        r.text()
      );
      throw new Error(`WAL-G PITR fetch failed (exit ${waitJson.StatusCode}): ${logs}`);
    }
  } finally {
    if (helperId) {
      await dockerFetch(`/containers/${helperId}?force=true`, { method: "DELETE" }).catch(() => {});
    }
    await controlDedicatedContainer(instance.container_id, "start", instance.name).catch(() => {});
  }
}
