import postgres from "postgres";
import type { InstanceRow } from "../db/schema";
import { assertPgIdentifier, decryptSecret } from "../lib/crypto";
import { getPanelSettings } from "./alert";

export const PG_ADMIN_URL =
  process.env.PG_ADMIN_URL || "postgres://postgres:postgres@localhost:5432/postgres";

export const pgAdmin = postgres(PG_ADMIN_URL, {
  max: 5,
  idle_timeout: 20,
  connect_timeout: 5,
});

export interface ConnectionStrings {
  internal: string;
  transaction: string;
  session: string;
  direct: string;
}

export function buildConnectionStrings(
  dbName: string,
  username: string,
  password: string,
  txPort = 6432,
  sessPort = 5432,
  directPort = 5432,
  internalHost = "pgbouncer"
): ConnectionStrings {
  const settings = getPanelSettings();
  const host = settings.public_db_host || "localhost";
  const sslMode = settings.ssl_mode || "require";
  const encUser = encodeURIComponent(username);
  const encPass = encodeURIComponent(password);
  return {
    internal: `postgres://${encUser}:${encPass}@${internalHost}:6432/${dbName}?sslmode=disable`,
    transaction: `postgres://${encUser}:${encPass}@${host}:${txPort}/${dbName}?sslmode=${sslMode}`,
    session: `postgres://${encUser}:${encPass}@${host}:${sessPort}/${dbName}?sslmode=${sslMode}`,
    direct: `postgres://${encUser}:${encPass}@${host}:${directPort}/${dbName}?sslmode=${sslMode}`,
  };
}

export interface RoleLimits {
  connectionLimit?: number;
  statementTimeoutSec?: number;
}

function normalizeRoleLimits(limits?: RoleLimits) {
  const connectionLimit = Math.min(500, Math.max(1, Math.round(limits?.connectionLimit ?? 25)));
  const statementTimeoutSec = Math.min(3600, Math.max(1, Math.round(limits?.statementTimeoutSec ?? 30)));
  return { connectionLimit, statementTimeoutSec };
}

export async function createSharedDatabase(
  dbNameRaw: string,
  usernameRaw: string,
  password: string,
  limits?: RoleLimits
) {
  const dbName = assertPgIdentifier(dbNameRaw, "db_name");
  const username = assertPgIdentifier(usernameRaw, "db_username");
  const { connectionLimit, statementTimeoutSec } = normalizeRoleLimits(limits);

  // Create dedicated non-superuser role with anti-hang & noisy-neighbor guardrails
  await pgAdmin.unsafe(
    `CREATE ROLE "${username}" WITH LOGIN PASSWORD '${password.replace(/'/g, "''")}' CONNECTION LIMIT ${connectionLimit} NOSUPERUSER NOCREATEDB NOCREATEROLE`
  );

  try {
    await pgAdmin.unsafe(`ALTER ROLE "${username}" SET statement_timeout = '${statementTimeoutSec}s'`);
    await pgAdmin.unsafe(`ALTER ROLE "${username}" SET idle_in_transaction_session_timeout = '15s'`);
    await pgAdmin.unsafe(`ALTER ROLE "${username}" SET temp_file_limit = '500MB'`);

    // Create isolated database owned by the role and revoke public access
    await pgAdmin.unsafe(`CREATE DATABASE "${dbName}" OWNER "${username}"`);
    await pgAdmin.unsafe(`REVOKE ALL ON DATABASE "${dbName}" FROM PUBLIC`);
    await pgAdmin.unsafe(`GRANT ALL ON DATABASE "${dbName}" TO "${username}"`);
  } catch (err) {
    // Rollback orphaned role if database creation or grant failed
    await pgAdmin.unsafe(`DROP ROLE IF EXISTS "${username}"`).catch(() => {});
    throw err;
  }
}

export async function updateRoleLimits(usernameRaw: string, limits: RoleLimits) {
  const username = assertPgIdentifier(usernameRaw, "db_username");
  const { connectionLimit, statementTimeoutSec } = normalizeRoleLimits(limits);
  await pgAdmin.unsafe(`ALTER ROLE "${username}" CONNECTION LIMIT ${connectionLimit}`);
  await pgAdmin.unsafe(`ALTER ROLE "${username}" SET statement_timeout = '${statementTimeoutSec}s'`);
}

export async function dropSharedDatabaseAndRole(dbNameRaw: string, usernameRaw: string) {
  const dbName = assertPgIdentifier(dbNameRaw, "db_name");
  const username = assertPgIdentifier(usernameRaw, "db_username");

  await pgAdmin`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = ${dbName}
      AND pid <> pg_backend_pid()
  `;
  await pgAdmin.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
  await pgAdmin.unsafe(`DROP ROLE IF EXISTS "${username}"`);
}

export function getLocalAdminUrl(instance: InstanceRow): string {
  const dbName = assertPgIdentifier(instance.db_name, "db_name");
  const url = new URL(PG_ADMIN_URL);
  url.pathname = `/${dbName}`;
  return url.toString();
}

export function getExternalAdminUrl(instance: InstanceRow): string | null {
  const enc = instance.external_url_enc || instance.remote_admin_url_enc;
  if (!enc) return null;
  const raw = decryptSecret(enc);
  const url = new URL(raw);
  if (!url.pathname || url.pathname === "/") {
    const dbName = assertPgIdentifier(instance.db_name, "db_name");
    url.pathname = `/${dbName}`;
  }
  return url.toString();
}

export function isExternalPrimary(instance: InstanceRow): boolean {
  return (
    instance.primary_tier === "external" ||
    Boolean(instance.remote_admin_url_enc && instance.primary_tier !== "local")
  );
}

export function getInstanceAdminUrl(instance: InstanceRow): string {
  if (isExternalPrimary(instance)) {
    const ext = getExternalAdminUrl(instance);
    if (ext) return ext;
  }
  return getLocalAdminUrl(instance);
}

export function getMaskedExternalTarget(instance: InstanceRow): string | null {
  try {
    const ext = getExternalAdminUrl(instance);
    if (!ext) return null;
    const url = new URL(ext);
    return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
  } catch {
    return null;
  }
}

export function buildInstanceConnectionStrings(
  instance: InstanceRow,
  password: string
): ConnectionStrings {
  if (isExternalPrimary(instance)) {
    const ext = getExternalAdminUrl(instance);
    if (ext) {
      const remoteUrl = new URL(ext);
      const sslMode = remoteUrl.searchParams.get("sslmode") || "require";
      remoteUrl.searchParams.set("sslmode", sslMode);
      const direct = remoteUrl.toString();
      return {
        internal: direct,
        transaction: direct,
        session: direct,
        direct,
      };
    }
  }
  return buildConnectionStrings(instance.db_name, instance.db_username, password);
}

export async function resetRolePassword(usernameRaw: string, newPassword: string) {
  const username = assertPgIdentifier(usernameRaw, "db_username");
  await pgAdmin.unsafe(
    `ALTER ROLE "${username}" WITH PASSWORD '${newPassword.replace(/'/g, "''")}'`
  );
}

export async function pauseSharedDatabase(dbNameRaw: string, usernameRaw: string) {
  const dbName = assertPgIdentifier(dbNameRaw, "db_name");
  const username = assertPgIdentifier(usernameRaw, "db_username");

  // Disable role login & public connect without setting ALLOW_CONNECTIONS = false,
  // keeping superuser access open for pg_dump, pg_restore, and table inspection.
  await pgAdmin.unsafe(`REVOKE CONNECT ON DATABASE "${dbName}" FROM PUBLIC`);
  await pgAdmin.unsafe(`ALTER ROLE "${username}" NOLOGIN`);
  await pgAdmin`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = ${dbName}
      AND pid <> pg_backend_pid()
      AND usename <> current_user
  `;
}

export async function resumeSharedDatabase(dbNameRaw: string, usernameRaw: string) {
  const dbName = assertPgIdentifier(dbNameRaw, "db_name");
  const username = assertPgIdentifier(usernameRaw, "db_username");

  await pgAdmin.unsafe(`GRANT CONNECT ON DATABASE "${dbName}" TO "${username}"`);
  await pgAdmin.unsafe(`ALTER ROLE "${username}" LOGIN`);
}

/**
 * Clones a shared database without blocking active connections on the source DB
 * by streaming pg_dump into pg_restore.
 */
export async function cloneSharedDatabase(
  sourceDbRaw: string,
  targetDbRaw: string,
  targetUserRaw: string,
  targetPassword: string
) {
  const sourceDb = assertPgIdentifier(sourceDbRaw, "source_db");
  const targetDb = assertPgIdentifier(targetDbRaw, "target_db");
  const targetUser = assertPgIdentifier(targetUserRaw, "target_user");

  await createSharedDatabase(targetDb, targetUser, targetPassword);

  const srcUrl = new URL(PG_ADMIN_URL);
  srcUrl.pathname = `/${sourceDb}`;

  const dstUrl = new URL(PG_ADMIN_URL);
  dstUrl.pathname = `/${targetDb}`;

  try {
    const dumpProc = Bun.spawn(
      ["pg_dump", "--format=custom", "--no-owner", "--no-acl", srcUrl.toString()],
      { stdout: "pipe", stderr: "pipe" }
    );

    const restoreProc = Bun.spawn(
      ["pg_restore", "--no-owner", "--no-acl", `--role=${targetUser}`, "-d", dstUrl.toString()],
      { stdin: dumpProc.stdout, stdout: "pipe", stderr: "pipe" }
    );

    const [dumpExit, restoreExit] = await Promise.all([dumpProc.exited, restoreProc.exited]);
    if (dumpExit !== 0) {
      const err = await new Response(dumpProc.stderr).text();
      throw new Error(`pg_dump failed during clone: ${err}`);
    }
    if (restoreExit !== 0) {
      const err = await new Response(restoreProc.stderr).text();
      throw new Error(`pg_restore failed during clone: ${err}`);
    }
  } catch (err) {
    // Cleanup target DB and role if clone failed mid-stream
    await dropSharedDatabaseAndRole(targetDb, targetUser).catch(() => {});
    throw err;
  }
}
