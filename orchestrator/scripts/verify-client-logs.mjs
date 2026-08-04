// Integration test for POST /v1/client-logs: starts the real httpServer over a real socket (same
// pattern verify-server.mjs uses for its Part 3), with minimal fake deps — this route only
// touches deps.apiKeys/deps.accessIdentity (for best-effort attribution) and the io/clientLogSink
// module directly, so nothing else in HttpServerDeps needs a working fake.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'bigbrain-client-logs-'));
const logFile = join(dir, 'frontend.log');
process.env.BIGBRAIN_CLIENT_LOG_FILE = logFile;
process.env.BIGBRAIN_CLIENT_LOG_MAX_LINES = '50';

// Dynamic imports, after the env vars above are set — clientLogSink.js reads
// BIGBRAIN_CLIENT_LOG_FILE/MAX_LINES once at module load, so a static top-of-file import (hoisted
// before this script's own code runs) would lock onto the default ./logs/frontend.log instead of
// this test's tmp path. Same pattern verify-logger.mjs already uses for io/logger.js.
const { startHttpServer } = await import('../dist/server/httpServer.js');
const { createApiKeyStore } = await import('../dist/server/apiKeyStore.js');

const apiKeys = createApiKeyStore('good-key:11111111-1111-1111-1111-111111111111');
const accessIdentity = { async userIdForAccessJwt() { return undefined; } };

const server = startHttpServer({ apiKeys, accessIdentity, port: 0 });
await new Promise((resolve) => server.once('listening', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

// Unauthenticated POST — matches /healthz's posture, no Authorization header sent at all.
const okRes = await fetch(`${base}/v1/client-logs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    entries: [
      { level: 'ERROR', message: 'unauthenticated boom', session: 'abcd1234' },
      { level: 'LOG', message: 'unauthenticated log line', session: 'abcd1234' },
    ],
  }),
});
assert(okRes.status === 202, `unauthenticated POST is accepted (got ${okRes.status})`);
const okBody = await okRes.json();
assert(okBody.accepted === 2, `response reports the accepted count (got ${JSON.stringify(okBody)})`);

// error() entries flush immediately — no debounce wait needed to observe them.
let contents = readFileSync(logFile, 'utf8');
assert(contents.includes('unauthenticated boom'), 'ERROR entry lands in the file immediately');
assert(contents.includes('[sess:abcd1234]'), 'entry is tagged with its browser session id');

// Authenticated POST — userId should get attached to the tag for attribution.
const authedRes = await fetch(`${base}/v1/client-logs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer good-key' },
  body: JSON.stringify({ entries: [{ level: 'ERROR', message: 'authed boom', session: 'ffff0000' }] }),
});
assert(authedRes.status === 202, `authenticated POST is also accepted (got ${authedRes.status})`);
contents = readFileSync(logFile, 'utf8');
assert(
  contents.includes('[sess:ffff0000 user:11111111-1111-1111-1111-111111111111]'),
  'authenticated entry is tagged with both session and userId',
);

// Malformed body shapes.
const notArrayRes = await fetch(`${base}/v1/client-logs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ entries: 'not-an-array' }),
});
assert(notArrayRes.status === 400, `non-array entries is rejected (got ${notArrayRes.status})`);

const badJsonRes = await fetch(`${base}/v1/client-logs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{not json',
});
assert(badJsonRes.status === 400, `malformed JSON body is rejected (got ${badJsonRes.status})`);

// One malformed entry (no message) alongside good ones — the good ones must still land, the batch
// as a whole must not be dropped.
const mixedRes = await fetch(`${base}/v1/client-logs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    entries: [
      { level: 'ERROR', message: 'good entry survives', session: 'mixed001' },
      { level: 'ERROR', session: 'mixed001' }, // missing message — dropped in isolation
      {}, // missing everything — dropped in isolation
    ],
  }),
});
assert(mixedRes.status === 202, `mixed batch (some malformed entries) is still accepted (got ${mixedRes.status})`);
contents = readFileSync(logFile, 'utf8');
assert(contents.includes('good entry survives'), 'the valid entry in a mixed batch still lands in the file');

// An unrecognized level coerces to LOG rather than being dropped.
const badLevelRes = await fetch(`${base}/v1/client-logs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ entries: [{ level: 'TOTALLY_MADE_UP', message: 'weird level entry', session: 'lvl00001' }] }),
});
assert(badLevelRes.status === 202, `entry with an unrecognized level is still accepted (got ${badLevelRes.status})`);

server.close();
rmSync(dir, { recursive: true, force: true });

if (process.exitCode) {
  console.error('\nclient-logs verification FAILED');
  process.exit(1);
}
console.log('\nclient-logs verification passed');
