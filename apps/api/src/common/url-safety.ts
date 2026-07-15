import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
]);

export class UrlNotAllowedError extends Error {
  constructor(
    public readonly targetUrl: string,
    public readonly reason: string,
  ) {
    super(`target URL is not allowed: ${reason}`);
    this.name = 'UrlNotAllowedError';
  }
}

export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIpv4(ip);
  if (kind === 6) return isPrivateIpv6(ip);
  return true;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const a = parts[0] ?? -1;
  const b = parts[1] ?? -1;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('fe80:')) return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h.endsWith('.localhost')) return true;
  if (h.endsWith('.local')) return true;
  if (h.endsWith('.internal')) return true;
  return false;
}

export async function assertSafeTargetUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UrlNotAllowedError(rawUrl, 'invalid URL');
  }

  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new UrlNotAllowedError(rawUrl, 'only http(s) URLs are allowed');
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    throw new UrlNotAllowedError(rawUrl, 'missing hostname');
  }

  if (isBlockedHostname(hostname)) {
    throw new UrlNotAllowedError(rawUrl, 'blocked hostname');
  }

  const ipKind = isIP(hostname);
  if (ipKind !== 0) {
    if (isPrivateIp(hostname)) {
      throw new UrlNotAllowedError(rawUrl, 'private or reserved IP');
    }
    return;
  }

  try {
    const results = await lookup(hostname, { all: true });
    if (results.length === 0) {
      throw new UrlNotAllowedError(rawUrl, 'hostname could not be resolved');
    }
    for (const { address } of results) {
      if (isPrivateIp(address)) {
        throw new UrlNotAllowedError(rawUrl, `hostname resolves to private IP ${address}`);
      }
    }
  } catch (err) {
    if (err instanceof UrlNotAllowedError) throw err;
    throw new UrlNotAllowedError(rawUrl, 'hostname could not be resolved');
  }
}
