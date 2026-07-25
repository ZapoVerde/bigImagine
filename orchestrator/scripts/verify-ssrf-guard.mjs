// Proves util/ssrfGuard.ts's isBlockedAddress correctly separates legitimate public fetch
// targets from loopback/private/link-local/reserved addresses — including the 169.254.169.254
// cloud metadata endpoint, the specific case import_recipe's SSRF guard exists to stop.

import { isBlockedAddress } from '../dist/util/ssrfGuard.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// --- Blocked: loopback ---
assert(isBlockedAddress('127.0.0.1'), '127.0.0.1 (IPv4 loopback) is blocked');
assert(isBlockedAddress('127.53.0.1'), 'any 127.0.0.0/8 address is blocked, not just 127.0.0.1');
assert(isBlockedAddress('::1'), '::1 (IPv6 loopback) is blocked');

// --- Blocked: RFC1918 private space ---
assert(isBlockedAddress('10.0.0.5'), '10.0.0.0/8 is blocked');
assert(isBlockedAddress('172.16.0.1'), '172.16.0.0/12 lower bound is blocked');
assert(isBlockedAddress('172.31.255.255'), '172.16.0.0/12 upper bound is blocked');
assert(!isBlockedAddress('172.32.0.1'), '172.32.0.0 is just outside 172.16.0.0/12 and is not blocked');
assert(isBlockedAddress('192.168.1.1'), '192.168.0.0/16 is blocked');

// --- Blocked: link-local, including the cloud metadata endpoint ---
assert(isBlockedAddress('169.254.169.254'), 'the cloud metadata endpoint (169.254.169.254) is blocked');
assert(isBlockedAddress('169.254.0.1'), '169.254.0.0/16 is blocked generally');
assert(isBlockedAddress('fe80::1'), 'fe80::/10 (IPv6 link-local) is blocked');

// --- Blocked: carrier-grade NAT, "this network", multicast/reserved ---
assert(isBlockedAddress('100.64.0.1'), '100.64.0.0/10 (carrier-grade NAT) is blocked');
assert(isBlockedAddress('0.0.0.1'), '0.0.0.0/8 is blocked');
assert(isBlockedAddress('224.0.0.1'), 'multicast (224.0.0.0/4) is blocked');
assert(isBlockedAddress('fd00::1'), 'fc00::/7 (IPv6 unique local) is blocked');
assert(isBlockedAddress('ff02::1'), 'ff00::/8 (IPv6 multicast) is blocked');

// --- Blocked: IPv4-mapped IPv6 wrapping a private address ---
assert(isBlockedAddress('::ffff:127.0.0.1'), '::ffff:127.0.0.1 unwraps to loopback and is blocked');
assert(isBlockedAddress('::ffff:169.254.169.254'), '::ffff:169.254.169.254 unwraps to the metadata endpoint and is blocked');

// --- Blocked: not a well-formed IP literal at all ---
assert(isBlockedAddress('not-an-ip'), 'a non-IP string is blocked (fail closed)');

// --- Not blocked: ordinary public addresses ---
assert(!isBlockedAddress('93.184.216.34'), 'an ordinary public IPv4 address is not blocked');
assert(!isBlockedAddress('2606:4700:4700::1111'), 'an ordinary public IPv6 address is not blocked');

if (process.exitCode) {
  console.error('\nssrf guard verification FAILED');
  process.exit(1);
}
console.log('\nssrf guard verification passed');
