// Runtime proof that io/logger.ts's session/restart tracking survives across process restarts —
// inherently a "new process" concern (module-load-time state), so this spawns two separate real
// `node` processes in sequence against the same log directory, rather than re-importing within
// one process (module caching would make a second in-process import a no-op).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'bigbrain-log-session-'));
const logFile = join(dir, 'test.log');

const bootScript = `
  process.env.BIGBRAIN_LOG_FILE = ${JSON.stringify(logFile)};
  process.env.BIGBRAIN_LOG_MAX_LINES = '50';
  await import(${JSON.stringify(new URL('../dist/io/logger.js', import.meta.url).href)});
`;

function boot() {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', bootScript], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`child process exited ${result.status}\nstderr: ${result.stderr}`);
  }
}

boot();
const firstContents = readFileSync(logFile, 'utf8');
const firstMatch = firstContents.match(/session #(\d+) \| ([^|]+) \| session: ([0-9a-f]+)/);
assert(Boolean(firstMatch), 'first boot writes a banner line with session/restart info');

boot();
const secondContents = readFileSync(logFile, 'utf8');
const secondMatch = secondContents.match(/session #(\d+) \| ([^|]+) \| session: ([0-9a-f]+)/);
assert(Boolean(secondMatch), 'second boot writes a banner line with session/restart info');

if (firstMatch && secondMatch) {
  assert(
    Number(secondMatch[1]) === Number(firstMatch[1]) + 1,
    `restart counter increments across boots (${firstMatch[1]} -> ${secondMatch[1]})`,
  );
  assert(secondMatch[3] !== firstMatch[3], 'session id differs across boots');
}

rmSync(dir, { recursive: true, force: true });

if (process.exitCode) {
  console.error('\nlogger-session verification FAILED');
  process.exit(1);
}
console.log('\nlogger-session verification passed');
