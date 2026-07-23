// Runtime proof for io/logger.ts, in the vamp-style "verify real behavior" tradition rather
// than a mocked unit test: writes to a real temp file and reads it back.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'bigbrain-log-check-'));
const logFile = join(dir, 'test.log');
process.env.BIGBRAIN_LOG_FILE = logFile;
process.env.BIGBRAIN_LOG_MAX_LINES = '5';

const { log, runWithRequestId } = await import('../dist/io/logger.js');

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// error() flushes immediately — no need to wait out the debounce window to observe it.
log.error('boom', new Error('synthetic failure'));
let contents = readFileSync(logFile, 'utf8');
assert(contents.includes('[ERROR]'), 'error level appears in the log file immediately');
assert(contents.includes('synthetic failure'), 'Error message/stack is captured');

runWithRequestId('req-42', () => {
  log.error('scoped message');
});
contents = readFileSync(logFile, 'utf8');
assert(contents.includes('[req-42]'), 'runWithRequestId tags the log line made inside it');

// Bounded buffer: push well past MAX_LINES, confirm the file never exceeds it and evicts oldest.
for (let i = 0; i < 20; i++) {
  log.error(`line-${i}`);
}
contents = readFileSync(logFile, 'utf8');
const lines = contents.trim().split('\n');
assert(lines.length <= 5, `log file stays bounded at MAX_LINES (got ${lines.length} lines)`);
assert(contents.includes('line-19'), 'most recent line survives the cap');
assert(!lines.some((l) => l.endsWith(' line-0')), 'oldest lines are evicted once over the cap');

rmSync(dir, { recursive: true, force: true });

if (process.exitCode) {
  console.error('\nlogger verification FAILED');
  process.exit(1);
}
console.log('\nlogger verification passed');
