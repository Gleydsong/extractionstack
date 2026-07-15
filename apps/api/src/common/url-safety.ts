import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import * as ipaddr from 'ipaddr.js';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'instance-data.ec2.internal',
]);

export interface DnsAddress {
  address: string;
  family: number;
}

export type DnsResolver = (hostname: string) => Promise<DnsAddress[]>;

export interface UrlSafetyPolicy {
  maxUrlLength: number;
  allowedPorts: ReadonlySet<string>;
}

const DEFAULT_POLICY: UrlSafetyPolicy = {
  maxUrlLength: 2048,
  allowedPorts: new Set(['', '80', '443']),
};

const defaultResolver: DnsResolver = async (hostname) => lookup(hostname, { all: true });

export class UrlNotAllowedError extends Error {
  constructor(
    public readonly targetUrl: string,
    public readonly reason: string,
  ) {
    super(`target URL is not allowed: ${reason}`);
    this.name = 'UrlNotAllowedError';
  }
}

export function isPrivateIp(rawAddress: string): boolean {
  const address = stripIpv6Brackets(rawAddress);
  if (!ipaddr.isValid(address)) return true;

  const parsed = ipaddr.parse(address);
  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
    return parsed.toIPv4Address().range() !== 'unicast';
  }
  return parsed.range() !== 'unicast';
}

function stripIpv6Brackets(address: string): string {
  return address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = stripIpv6Brackets(hostname).toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(normalized)) return true;
  return (
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal')
  );
}

export async function assertSafeTargetUrl(
  rawUrl: string,
  resolver: DnsResolver = defaultResolver,
  policy: UrlSafetyPolicy = DEFAULT_POLICY,
): Promise<void> {
  if (rawUrl.length > policy.maxUrlLength) {
    throw new UrlNotAllowedError(rawUrl, 'URL exceeds maximum length');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UrlNotAllowedError(rawUrl, 'invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UrlNotAllowedError(rawUrl, 'only http(s) URLs are allowed');
  }
  if (parsed.username || parsed.password) {
    throw new UrlNotAllowedError(rawUrl, 'URL credentials are not allowed');
  }
  if (!policy.allowedPorts.has(parsed.port)) {
    throw new UrlNotAllowedError(rawUrl, 'target port is not allowed');
  }

  const hostname = parsed.hostname;
  if (!hostname) throw new UrlNotAllowedError(rawUrl, 'missing hostname');
  if (isBlockedHostname(hostname)) {
    throw new UrlNotAllowedError(rawUrl, 'blocked hostname');
  }

  const addressLiteral = stripIpv6Brackets(hostname);
  if (isIP(addressLiteral) !== 0) {
    if (isPrivateIp(addressLiteral)) {
      throw new UrlNotAllowedError(rawUrl, 'non-public IP address');
    }
    return;
  }

  let results: DnsAddress[];
  try {
    results = await resolver(hostname);
  } catch {
    throw new UrlNotAllowedError(rawUrl, 'hostname could not be resolved');
  }
  if (results.length === 0) {
    throw new UrlNotAllowedError(rawUrl, 'hostname could not be resolved');
  }
  for (const { address } of results) {
    if (isPrivateIp(address)) {
      throw new UrlNotAllowedError(rawUrl, `hostname resolves to non-public IP ${address}`);
    }
  }
}

export async function assertSafeRedirectChain(
  urls: readonly string[],
  resolver: DnsResolver = defaultResolver,
  policy: UrlSafetyPolicy = DEFAULT_POLICY,
): Promise<void> {
  for (const url of urls) await assertSafeTargetUrl(url, resolver, policy);
}
