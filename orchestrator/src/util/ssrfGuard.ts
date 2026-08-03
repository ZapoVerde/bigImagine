/**
 * @file orchestrator/src/util/ssrfGuard.ts
 * @stamp 2026-07-25
 * @architectural-role Pure Function — private/reserved network address classification
 * @description
 * ingest_url (plugins/documents/src/ingestUrlTool.ts) fetches a URL the LLM or a chat message
 * supplied — the one outbound HTTP destination in the platform that isn't admin-configured
 * (contrast the LLM provider base URL, set from the Settings tab by the person running the
 * deployment). io/fetchUntrusted.ts is the IO Wrapper that resolves the
 * target hostname and calls this to decide whether a resolved address is safe to fetch at all.
 *
 * Hand-rolled rather than a dependency: the ranges that matter here (loopback, RFC1918 private
 * space, link-local — which is also where cloud metadata endpoints like 169.254.169.254 live,
 * carrier-grade NAT, multicast/reserved) are a small, stable set that a library adds a dependency
 * without adding real coverage for.
 *
 * @api-declaration
 * isBlockedAddress(address: string) — true if `address` (a literal IPv4 or IPv6 address, as
 *   returned by DNS resolution) is loopback, private, link-local, or otherwise not a legitimate
 *   public fetch target; true for anything that isn't even a well-formed IP literal.
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

import { isIPv4, isIPv6 } from 'node:net';

function isBlockedIpv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local — includes the 169.254.169.254 cloud metadata endpoint
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT (RFC 6598)
  if (a === 0) return true; // "this network"
  if (a >= 224) return true; // multicast (224-239) and reserved (240-255)
  return false;
}

function isBlockedIpv6(rawAddress: string): boolean {
  const address = rawAddress.toLowerCase();
  if (address === '::1' || address === '::') return true; // loopback / unspecified

  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);

  const firstHextet = address.split(':')[0];
  if (/^fe[89ab][0-9a-f]$/.test(firstHextet)) return true; // link-local, fe80::/10
  if (/^f[cd][0-9a-f]{2}$/.test(firstHextet)) return true; // unique local, fc00::/7
  if (firstHextet.startsWith('ff')) return true; // multicast, ff00::/8

  return false;
}

export function isBlockedAddress(address: string): boolean {
  if (isIPv4(address)) return isBlockedIpv4(address);
  if (isIPv6(address)) return isBlockedIpv6(address);
  return true; // not a well-formed IP literal — refuse rather than guess
}
