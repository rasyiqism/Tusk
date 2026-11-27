import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

function isPrivateIpv4(addr: string): boolean {
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

function isPrivateIpv6(addr: string): boolean {
  const low = addr.toLowerCase().replace(/^\[|\]$/g, '');
  if (low === '::1' || low === '::') return true;
  if (low.startsWith('fc') || low.startsWith('fd')) return true; // fc00::/7 unique-local
  if (low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb')) return true; // fe80::/10 link-local
  if (low.startsWith('::ffff:')) {
    const mapped = low.slice(7);
    if (isIP(mapped) === 4) return isPrivateIpv4(mapped);
  }
  if (low.startsWith('2002:') || low.startsWith('64:ff9b:')) return true; // 6to4 & NAT64 transition ranges
  return false;
}

function isReservedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === 'localhost.localdomain' || h === '0.0.0.0') return true;
  return h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal');
}

function isSafeIpAddress(addr: string, version: number): boolean {
  if (version === 4) return !isPrivateIpv4(addr) && addr !== '0.0.0.0';
  if (version === 6) return !isPrivateIpv6(addr);
  return false;
}

/**
 * Prevent SSRF: only allow http/https URL toward public internet hosts,
 * unless ALLOW_INTERNAL_URLS=true is enabled for self-hosted container environments.
 */
export async function isSafeOutboundUrl(urlString: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const allowInternal = process.env.ALLOW_INTERNAL_URLS === 'true' || process.env.ALLOW_INTERNAL_WEBHOOKS === 'true';
  if (allowInternal) {
    return true;
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const ipVersion = isIP(hostname);
  if (ipVersion !== 0) return isSafeIpAddress(hostname, ipVersion);

  if (isReservedHostname(hostname)) return false;

  try {
    const raw: any = await lookup(hostname, { family: 0, all: true, verbatim: true });
    const records = Array.isArray(raw) ? raw : raw?.address ? [raw] : [];
    if (records.length === 0) return false;
    return records.every((rec) => isSafeIpAddress(rec.address, isIP(rec.address)));
  } catch {
    // Fail closed when DNS resolution fails
    return false;
  }
}

/**
 * Safe outbound fetch wrapper preventing HTTP redirect SSRF bypasses.
 */
export async function safeOutboundFetch(
  urlString: string,
  init: RequestInit & { maxRedirects?: number } = {}
): Promise<Response> {
  const { maxRedirects = 0, ...fetchInit } = init;
  let currentUrl = urlString;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!(await isSafeOutboundUrl(currentUrl))) {
      throw new Error('Outbound URL blocked for security reasons (SSRF protection)');
    }

    const response = await fetch(currentUrl, {
      ...fetchInit,
      redirect: 'manual'
    });

    const isRedirect = response.status >= 300 && response.status < 400;
    if (!isRedirect) {
      return response;
    }

    const location = response.headers.get('location');
    if (!location || hop >= maxRedirects) {
      throw new Error(`Outbound HTTP redirect blocked (${response.status})`);
    }

    currentUrl = new URL(location, currentUrl).toString();
  }

  throw new Error('Too many outbound redirects');
}

/**
 * Resolve real client IP behind reverse proxies without allowing direct-client header spoofing.
 */
export function resolveClientIp(ctx: {
  server?: any;
  request?: any;
  headers?: Record<string, string | undefined>;
} = {}): string {
  const getHeader = (name: string): string => {
    const lower = name.toLowerCase();
    return String(
      ctx.headers?.[lower] ??
      ctx.headers?.[name] ??
      ctx.request?.headers?.get?.(lower) ??
      ''
    ).trim();
  };

  const hasSocketIntrospection = typeof ctx.server?.requestIP === "function";
  const rawSocketIp = String(ctx.server?.requestIP?.(ctx.request)?.address || '').trim();
  const cleanSocketIp = rawSocketIp.replace(/^\[|\]$/g, '');
  const socketVersion = cleanSocketIp ? isIP(cleanSocketIp) : 0;

  if (hasSocketIntrospection && !cleanSocketIp) {
    return 'unknown';
  }

  const socketIsProxy =
    !cleanSocketIp ||
    (socketVersion === 4 && isPrivateIpv4(cleanSocketIp)) ||
    (socketVersion === 6 && isPrivateIpv6(cleanSocketIp));

  if (!socketIsProxy) {
    return cleanSocketIp;
  }

  const cfIp = getHeader('cf-connecting-ip');
  if (cfIp) return cfIp.split(',')[0].trim();

  const realIp = getHeader('x-real-ip');
  if (realIp) return realIp.split(',')[0].trim();

  const fwd = getHeader('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0].trim();
    if (first) return first;
  }

  return cleanSocketIp || 'unknown';
}

/**
 * Prevent SSRF against non-HTTP network hosts (e.g. SMTP, IMAP, Redis).
 */
export async function isSafeOutboundHost(hostname: string): Promise<boolean> {
  const cleanHost = (hostname || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!cleanHost) return false;

  const allowInternal = process.env.ALLOW_INTERNAL_URLS === 'true' || process.env.ALLOW_INTERNAL_WEBHOOKS === 'true';
  if (allowInternal) {
    return true;
  }

  const ipVersion = isIP(cleanHost);
  if (ipVersion !== 0) return isSafeIpAddress(cleanHost, ipVersion);

  if (isReservedHostname(cleanHost)) return false;

  try {
    const raw: any = await lookup(cleanHost, { family: 0, all: true, verbatim: true });
    const records = Array.isArray(raw) ? raw : raw?.address ? [raw] : [];
    if (records.length === 0) return false;
    return records.every((rec) => isSafeIpAddress(rec.address, isIP(rec.address)));
  } catch {
    return false;
  }
}
