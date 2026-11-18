import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { ArcError } from '../errors.js';

/** Address ranges a customer-supplied URL must never reach (SSRF protection). */
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
] as const)
  blocked.addSubnet(net, prefix, 'ipv6');

// IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:XXXX:XXXX) is checked as the embedded IPv4.
// (BlockList treats ::ffff:0:0/96 as covering every IPv4 address, so it cannot be listed.)
function embeddedIpv4(address: string): string | null {
  const m = /^::ffff:(?:0:)?(.+)$/i.exec(address);
  if (!m) return null;
  const rest = m[1]!;
  if (isIP(rest) === 4) return rest;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
  if (!hex) return null;
  const hi = parseInt(hex[1]!, 16);
  const lo = parseInt(hex[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 6) {
    const v4 = embeddedIpv4(address);
    if (v4) return blocked.check(v4, 'ipv4');
  }
  return blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export type Resolver = (host: string) => Promise<string[]>;
const defaultResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Reject URLs that are not HTTPS or resolve to private, loopback, link-local or other
 * non-public addresses. Used for customer (BYOK) keys; the platform owner may use local hosts.
 * Note: checked at save and before each probe; DNS rebinding between the check and the
 * request remains a residual risk until egress is pinned (tracked in the threat model).
 */
export async function assertPublicHttpsUrl(
  raw: string,
  resolve: Resolver = defaultResolver,
): Promise<void> {
  const url = new URL(raw);
  if (url.protocol !== 'https:') {
    throw new ArcError(400, 'base_url_not_allowed', 'Base URL must use https');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolve(host);
  } catch {
    throw new ArcError(400, 'base_url_unresolvable', 'Base URL host could not be resolved');
  }
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    throw new ArcError(
      400,
      'base_url_not_allowed',
      'Base URL must point to a public internet address',
    );
  }
}
