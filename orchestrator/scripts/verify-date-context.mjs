// Proves formatCurrentDateContext.ts is actually timezone-sensitive (not silently using the
// server's own local time or always UTC) and produces the shape handleChatCompletions relies on.

import { formatCurrentDateContext } from '../dist/util/dateContext.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const instant = new Date('2026-01-01T23:30:00Z');

const utc = formatCurrentDateContext('UTC', instant);
assert(
  /^Today is \w+, \d{4}-\d{2}-\d{2} \(current local time \d{2}:\d{2}, .+\)\.$/.test(utc),
  'the output matches the expected "Today is <weekday>, <date> (current local time <time>, <zone>)." shape',
);
assert(utc.includes('2026-01-01') && utc.includes('23:30') && utc.includes('UTC'), 'UTC renders the instant\'s own calendar date and time verbatim');

// Pacific/Kiritimati is UTC+14 — 23:30 UTC on Jan 1 has already rolled into Jan 2 there. A real,
// well-known always-ahead-of-UTC zone, good for proving the date itself shifts across a boundary.
const aheadOfUtc = formatCurrentDateContext('Pacific/Kiritimati', instant);
assert(aheadOfUtc.includes('2026-01-02'), 'a zone 14 hours ahead of UTC has already crossed into the next calendar day for the same instant');

// Etc/GMT+12 is UTC-12 (Etc/GMT sign convention is inverted from common usage) — still Jan 1,
// but earlier in the day than UTC.
const behindUtc = formatCurrentDateContext('Etc/GMT+12', instant);
assert(behindUtc.includes('2026-01-01') && behindUtc.includes('11:30'), 'a zone 12 hours behind UTC keeps the same calendar date but a different local time');

// Weekday cross-checked against the same Intl mechanism directly, not a hardcoded calendar fact —
// this only proves formatCurrentDateContext didn't typo/hardcode a weekday, not that the
// underlying calendar math is correct (that's V8/ICU's job, not ours to re-verify).
const independentWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(instant);
assert(utc.includes(`Today is ${independentWeekday},`), 'the weekday matches the same Intl-derived value for the same zone/instant');

// An invalid IANA name is Intl's problem to reject, not this module's to catch — the caller
// (adminServer.ts's parseSetTimezoneBody) validates before anything is ever stored, so this
// should never receive a bad name in practice; confirming it still throws rather than silently
// producing a nonsense string is the useful guarantee here.
let threw = false;
try {
  formatCurrentDateContext('Not/A_Real_Zone', instant);
} catch {
  threw = true;
}
assert(threw, 'an invalid IANA zone name throws rather than silently formatting garbage');

if (process.exitCode) {
  console.error('\ndate context verification FAILED');
  process.exit(1);
}
console.log('\ndate context verification passed');
