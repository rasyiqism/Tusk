import { readFileSync } from "node:fs";
import { sqlite } from "../db/schema";
import { isSafeOutboundHost, safeOutboundFetch } from "../lib/safeOutboundUrl";

export interface PanelSettings {
  ntfy_url: string;
  alert_webhook_url: string;
  disk_alert_pct: number;
  ram_alert_pct: number;
  public_db_host: string;
  ssl_mode: "require" | "prefer" | "disable";
}

export function getPanelSettings(): PanelSettings {
  const rows = sqlite.prepare("SELECT key, value_json FROM settings").all() as Array<{
    key: string;
    value_json: string;
  }>;
  const map = new Map<string, unknown>();
  for (const r of rows) {
    try {
      map.set(r.key, JSON.parse(r.value_json));
    } catch {
      // ignore malformed
    }
  }

  const rawSsl = String(map.get("ssl_mode") ?? "require");
  const sslMode =
    rawSsl === "disable" || rawSsl === "prefer" || rawSsl === "require" ? rawSsl : "require";

  return {
    ntfy_url: String(map.get("ntfy_url") ?? process.env.NTFY_URL ?? ""),
    alert_webhook_url: String(
      map.get("alert_webhook_url") ?? process.env.ALERT_WEBHOOK_URL ?? ""
    ),
    disk_alert_pct: Number(map.get("disk_alert_pct") ?? 75),
    ram_alert_pct: Number(map.get("ram_alert_pct") ?? 90),
    public_db_host: String(map.get("public_db_host") ?? process.env.PUBLIC_DB_HOST ?? "localhost"),
    ssl_mode: sslMode,
  };
}

export interface AlertResult {
  sent: number;
  channels: string[];
  errors: string[];
}

export async function sendAlert(
  title: string,
  message: string,
  priority: "default" | "high" = "default"
): Promise<AlertResult> {
  const settings = getPanelSettings();
  const ntfyUrl = settings.ntfy_url;
  const webhookUrl = settings.alert_webhook_url;
  const channels: string[] = [];
  const errors: string[] = [];
  let sent = 0;

  const tasks: Promise<void>[] = [];
  const allowInternal =
    process.env.ALLOW_INTERNAL_URLS === "true" || process.env.ALLOW_INTERNAL_WEBHOOKS === "true";

  if (ntfyUrl) {
    const fetcher = allowInternal ? fetch : safeOutboundFetch;
    tasks.push(
      fetcher(ntfyUrl, {
        method: "POST",
        headers: {
          Title: title,
          Priority: priority,
        },
        body: message,
      })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          sent++;
          channels.push("ntfy");
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`ntfy: ${msg}`);
          console.error("ntfy alert error:", err);
        })
    );
  }

  if (webhookUrl) {
    const fetcher = allowInternal ? fetch : safeOutboundFetch;
    tasks.push(
      fetcher(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, message, priority, timestamp: new Date().toISOString() }),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          sent++;
          channels.push("webhook");
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`webhook: ${msg}`);
          console.error("webhook alert error:", err);
        })
    );
  }

  if (process.env.SMTP_HOST && process.env.SMTP_TO) {
    const hostOk = allowInternal || (await isSafeOutboundHost(process.env.SMTP_HOST));
    if (!hostOk) {
      errors.push("smtp: SMTP_HOST blocked by SSRF policy");
    } else {
      tasks.push(
        sendSmtpAlert(title, message)
          .then(() => {
            sent++;
            channels.push("smtp");
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`smtp: ${msg}`);
            console.error("smtp alert error:", err);
          })
      );
    }
  }

  await Promise.all(tasks);
  return { sent, channels, errors };
}

function sanitizeHeader(val: string): string {
  return val.replace(/[\r\n]+/g, " ").trim();
}

async function sendSmtpAlert(subject: string, body: string) {
  const host = process.env.SMTP_HOST!;
  const port = Number(process.env.SMTP_PORT || 587);
  const from = sanitizeHeader(process.env.SMTP_FROM || process.env.SMTP_USER || "pg-panel@localhost");
  const to = sanitizeHeader(process.env.SMTP_TO!);
  const user = process.env.SMTP_USER || "";
  const pass = process.env.SMTP_PASS || "";

  let recvBuffer = "";
  let pendingResolve: ((resp: string) => void) | null = null;
  let pendingReject: ((err: Error) => void) | null = null;

  const tryFlushSmtpResponse = () => {
    if (!pendingResolve) return;
    const lines = recvBuffer.split(/\r?\n/);
    // Keep trailing incomplete fragment
    const completeLines = lines.slice(0, -1);
    for (let i = 0; i < completeLines.length; i++) {
      const line = completeLines[i];
      // Final line of SMTP reply has space after 3-digit code (e.g. "250 OK"), not "-"
      if (/^\d{3}(?: |$)/.test(line)) {
        const consumed = completeLines.slice(0, i + 1).join("\n") + "\n";
        recvBuffer = recvBuffer.slice(consumed.length);
        const resolve = pendingResolve;
        pendingResolve = null;
        pendingReject = null;
        resolve(line);
        return;
      }
    }
  };

  const socketHandlers = {
    data(_sock: unknown, data: Buffer | Uint8Array) {
      recvBuffer += Buffer.from(data).toString("utf8");
      tryFlushSmtpResponse();
    },
    error(_sock: unknown, err: Error) {
      if (pendingReject) {
        const reject = pendingReject;
        pendingResolve = null;
        pendingReject = null;
        reject(err);
      }
    },
    close() {
      if (pendingReject) {
        const reject = pendingReject;
        pendingResolve = null;
        pendingReject = null;
        reject(new Error("SMTP socket closed unexpectedly"));
      }
    },
  };

  const waitForCode = (expectedPrefixes: string[]): Promise<string> => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingResolve = null;
        pendingReject = null;
        reject(new Error("SMTP server response timeout"));
      }, 10_000);

      pendingResolve = (line: string) => {
        clearTimeout(timer);
        if (!expectedPrefixes.some((p) => line.startsWith(p))) {
          reject(new Error(`Unexpected SMTP reply: ${line}`));
          return;
        }
        resolve(line);
      };
      pendingReject = (err: Error) => {
        clearTimeout(timer);
        reject(err);
      };
      tryFlushSmtpResponse();
    });
  };

  let activeSocket: any = await Bun.connect({
    hostname: host,
    port,
    tls: port === 465,
    socket: socketHandlers,
  });

  const sendCmd = async (cmd: string, expectedPrefixes: string[]) => {
    activeSocket.write(`${cmd}\r\n`);
    return waitForCode(expectedPrefixes);
  };

  try {
    await waitForCode(["220"]);
    await sendCmd("EHLO pg-panel.local", ["250"]);

    if (port === 587) {
      await sendCmd("STARTTLS", ["220"]);
      const [, upgraded] = activeSocket.upgradeTLS({
        socket: socketHandlers,
      });
      activeSocket = upgraded;
      recvBuffer = "";
      await sendCmd("EHLO pg-panel.local", ["250"]);
    }

    if (user && pass) {
      await sendCmd("AUTH LOGIN", ["334"]);
      await sendCmd(Buffer.from(user).toString("base64"), ["334"]);
      await sendCmd(Buffer.from(pass).toString("base64"), ["235"]);
    }

    await sendCmd(`MAIL FROM:<${from}>`, ["250"]);
    await sendCmd(`RCPT TO:<${to}>`, ["250", "251"]);
    await sendCmd("DATA", ["354"]);

    const safeBody = body.replace(/\r?\n\./g, "\r\n..");
    const payload = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: [PG Panel] ${sanitizeHeader(subject)}`,
      "",
      safeBody,
      ".",
    ].join("\r\n");

    await sendCmd(payload, ["250"]);
    await sendCmd("QUIT", ["221"]).catch(() => {});
  } finally {
    try {
      activeSocket.end();
    } catch {
      // ignore close errors
    }
  }
}

export interface VpsHealth {
  ramTotalMb: number;
  ramUsedMb: number;
  ramPct: number;
  diskTotalGb: number;
  diskUsedGb: number;
  diskPct: number;
  loadAvg1m: number;
}

export async function getVpsHealth(): Promise<VpsHealth> {
  let ramTotalMb = 0;
  let ramUsedMb = 0;
  let ramPct = 0;
  let loadAvg1m = 0;

  try {
    const meminfo = readFileSync("/proc/meminfo", "utf8");
    const totalMatch = meminfo.match(/MemTotal:\s+(\d+)\s+kB/);
    const availMatch = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
    if (totalMatch && availMatch) {
      const totalKb = Number(totalMatch[1]);
      const availKb = Number(availMatch[1]);
      ramTotalMb = Math.round(totalKb / 1024);
      ramUsedMb = Math.round((totalKb - availKb) / 1024);
      ramPct = Math.round(((totalKb - availKb) / totalKb) * 100);
    }

    const loadavg = readFileSync("/proc/loadavg", "utf8");
    loadAvg1m = Number(loadavg.split(" ")[0] ?? 0);
  } catch {
    // Non-Linux fallback
  }

  let diskTotalGb = 0;
  let diskUsedGb = 0;
  let diskPct = 0;
  try {
    const dfOut = await Bun.$`df -k /`.text();
    const lines = dfOut.trim().split("\n");
    const parts = lines[1]?.trim().split(/\s+/) ?? [];
    if (parts.length >= 5) {
      const totalKb = Number(parts[1]);
      const usedKb = Number(parts[2]);
      diskTotalGb = Number((totalKb / (1024 * 1024)).toFixed(1));
      diskUsedGb = Number((usedKb / (1024 * 1024)).toFixed(1));
      diskPct = Number(parts[4].replace("%", ""));
    }
  } catch {
    // Ignore
  }

  return { ramTotalMb, ramUsedMb, ramPct, diskTotalGb, diskUsedGb, diskPct, loadAvg1m };
}
