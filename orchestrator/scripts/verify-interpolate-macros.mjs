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
assert(interpolateMacros('{{reverse::abc}}', snapshot) === 'cba', 'reverse reverses its argument');
assert(interpolateMacros('{{reverse::}}', snapshot) === '', 'reverse of an empty argument is empty, not the literal token');

assert(interpolateMacros('a{{trim}}b', snapshot) === 'ab', 'trim with no surrounding whitespace just removes the token');
assert(interpolateMacros('a   {{trim}}   b', snapshot) === 'ab', 'trim collapses whitespace on both sides of the token');
assert(interpolateMacros('a\n\n{{trim}}\n\nb', snapshot) === 'ab', 'trim collapses surrounding newlines the same as spaces');

assert(interpolateMacros('{{getvar::x}}', snapshot) === '{{getvar::x}}', 'an unrecognized token (a not-yet-built macro) passes through unchanged, never deleted');
assert(interpolateMacros('literal {{ not a token', snapshot) === 'literal {{ not a token', 'unterminated/malformed {{ text is left alone, not partially consumed');

assert(
  interpolateMacros('{{char}} {{char}} {{char}}', snapshot) === 'Ava Ava Ava',
  'the same token resolves consistently every occurrence within one call — one snapshot, applied uniformly',
);

if (process.exitCode) {
  console.error('\ninterpolateMacros verification FAILED');
  process.exit(1);
}
console.log('\ninterpolateMacros verification passed');
