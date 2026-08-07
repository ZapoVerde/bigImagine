// Proves interpolateMacros.ts as a pure function, in isolation — the RP-chat-turn wiring itself
// (which snapshot values get read from where) is verify-server.mjs's Part 5b job.

import { interpolateMacros } from '../dist/util/interpolateMacros.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const snapshot = {
  charName: 'Ava',
  userName: 'Jeremy',
  persona: 'Jeremy: A traveling merchant.',
  description: 'A grizzled tavern keeper.',
  scenario: 'A dusty roadside inn.',
};

assert(interpolateMacros('{{char}} meets {{user}}.', snapshot) === 'Ava meets Jeremy.', 'char/user resolve to the snapshot values');
assert(interpolateMacros('{{persona}}', snapshot) === 'Jeremy: A traveling merchant.', 'persona resolves to the composed household persona');
assert(interpolateMacros('{{description}} / {{scenario}}', snapshot) === 'A grizzled tavern keeper. / A dusty roadside inn.', 'description and scenario are independent fields, not aliases of each other');

assert(interpolateMacros('{{char}}', {}) === '', 'char resolves to empty string, not the literal token, when no character is linked');
assert(interpolateMacros('{{user}}', {}) === '', 'user resolves to empty string when no persona_name is set (no hardcoded "User" fallback)');

assert(interpolateMacros('a{{noop}}b', snapshot) === 'ab', 'noop contributes nothing');
assert(interpolateMacros('{{newline}}', snapshot) === '\n', 'newline (no arg) is a single \\n');
assert(interpolateMacros('{{newline::3}}', snapshot) === '\n\n\n', 'newline::N repeats N times');
assert(interpolateMacros('{{newline, 3}}', snapshot) === '\n\n\n', 'comma-form numeric argument {{newline, 3}} is equivalent to {{newline::3}}');
assert(interpolateMacros('{{newline,3}}', snapshot) === '\n\n\n', 'comma form tolerates a missing space after the comma');
assert(interpolateMacros('{{newline , 3}}', snapshot) === '\n\n\n', 'comma form tolerates a space before the comma too');
assert(interpolateMacros('{{reverse::abc}}', snapshot) === 'cba', 'reverse reverses its argument');
assert(interpolateMacros('{{reverse::}}', snapshot) === '', 'reverse of an empty argument is empty, not the literal token');
assert(interpolateMacros('{{newline, x}}', snapshot) === '{{newline, x}}', 'a non-numeric comma argument fails the pattern and passes through verbatim');

assert(interpolateMacros('a{{trim}}b', snapshot) === 'ab', 'trim with no surrounding whitespace just removes the token');
assert(interpolateMacros('a   {{trim}}   b', snapshot) === 'ab', 'trim collapses whitespace on both sides of the token');
assert(interpolateMacros('a\n\n{{trim}}\n\nb', snapshot) === 'ab', 'trim collapses surrounding newlines the same as spaces');

assert(interpolateMacros('{{getvar::x}}', snapshot) === '{{getvar::x}}', 'an unrecognized token (a not-yet-built macro) passes through unchanged, never deleted');
assert(interpolateMacros('literal {{ not a token', snapshot) === 'literal {{ not a token', 'unterminated/malformed {{ text is left alone, not partially consumed');

assert(
  interpolateMacros('{{char}} {{char}} {{char}}', snapshot) === 'Ava Ava Ava',
  'the same token resolves consistently every occurrence within one call — one snapshot, applied uniformly',
);

assert(
  interpolateMacros('TEXT TO FIX:\n{{message}}', { message: 'raw turn text' }) === 'TEXT TO FIX:\nraw turn text',
  'message resolves to the raw just-generated turn text, for cleanup preset resolution',
);
assert(interpolateMacros('{{message}}', {}) === '', 'message resolves to empty string, not the literal token, when unset (narrator/character resolution)');

// --- resolveArg hook (cleanup-pass-only macros like {{prev_turns, N}}) --------------------------
assert(
  interpolateMacros('{{prev_turns, 2}}', {}, (name, arg) => (name === 'prev_turns' ? `HISTORY(${arg})` : undefined)) === 'HISTORY(2)',
  'resolveArg supplies {{prev_turns, N}} with its numeric argument',
);
assert(
  interpolateMacros('{{prev_turns}}', {}, (name, arg) => (name === 'prev_turns' ? `HISTORY(${arg ?? 'none'})` : undefined)) === 'HISTORY(none)',
  'resolveArg sees an undefined argument when {{prev_turns}} has no count',
);
assert(
  interpolateMacros('{{prev_turns, 2}} {{char}}', { charName: 'Ava' }, (name, arg) => (name === 'prev_turns' ? 'HIST' : undefined)) === 'HIST Ava',
  'resolveArg only claims its own tokens; everything else falls through to the registry',
);
assert(
  interpolateMacros('{{prev_turns, 2}}', {}) === '{{prev_turns, 2}}',
  'without a resolver, {{prev_turns, N}} is unrecognized and passes through verbatim (narrator/character context)',
);

if (process.exitCode) {
  console.error('\ninterpolateMacros verification FAILED');
  process.exit(1);
}
console.log('\ninterpolateMacros verification passed');
