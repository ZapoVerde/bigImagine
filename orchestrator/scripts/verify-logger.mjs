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

// Dedup: consecutive identical messages collapse into one line with a ×N suffix instead of
// repeating (still within MAX_LINES=5, so nothing here is evicted yet).
log.error('repeated message');
log.error('repeated message');
log.error('repeated message');
contents = readFileSync(logFile, 'utf8');
let lines = contents.trim().split('\n');
assert(
  lines.some((l) => l.includes('repeated message') && l.endsWith('×3')),
  'three consecutive identical messages collapse into one ×3 line',
);
assert(
  !lines.some((l) => l.includes('repeated message') && l.endsWith('×2')),
  'no intermediate ×2 line survives the final flush',
);

// Non-consecutive repeats (A, B, A) must NOT collapse — only genuinely consecutive duplicates do.
log.error('A');
log.error('B');
log.error('A');
contents = readFileSync(logFile, 'utf8');
lines = contents.trim().split('\n');
const aLines = lines.filter((l) => / \[ERROR\](?:\s\[[^\]]*\])? A$/.test(l));
assert(aLines.length === 2, `non-consecutive repeats are not collapsed (found ${aLines.length} distinct 'A' lines)`);

// Bounded buffer: push well past MAX_LINES, confirm the file never exceeds it and evicts oldest.
for (let i = 0; i < 20; i++) {
  log.error(`line-${i}`);
}
contents = readFileSync(logFile, 'utf8');
lines = contents.trim().split('\n');
assert(lines.length <= 5, `log file stays bounded at MAX_LINES (got ${lines.length} lines)`);
assert(contents.includes('line-19'), 'most recent line survives the cap');
assert(!lines.some((l) => l.endsWith(' line-0')), 'oldest lines are evicted once over the cap');

rmSync(dir, { recursive: true, force: true });

if (process.exitCode) {
  console.error('\nlogger verification FAILED');
  process.exit(1);
}
console.log('\nlogger verification passed');
