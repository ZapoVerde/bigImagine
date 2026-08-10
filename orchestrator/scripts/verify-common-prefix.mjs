// Proves util/commonPrefix.ts in isolation (a pure function, no IO) plus the cache-coverage rule
// it feeds (docs/prompt-inspector-tag-tree.md §3.2, revised design): the Prompt Inspector's cache
// badges diff the last fired main prompt against the one before it — both recorded bytes, so the
// badge is deterministic. stablePrefixChars = longest common prefix of the two joined texts; a
// tag-tree section is cache-covered iff section.end <= stablePrefixChars (anything upstream moved
// means the provider's prefix cache can't replay past that point).

import { longestCommonPrefixLength } from '../dist/util/commonPrefix.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// --- longestCommonPrefixLength: core cases -----------------------------------

assert(longestCommonPrefixLength('', '') === 0, 'lcp: two empty strings is 0');
assert(longestCommonPrefixLength('', 'abc') === 0, 'lcp: empty first string is 0');
assert(longestCommonPrefixLength('abc', '') === 0, 'lcp: empty second string is 0');
assert(longestCommonPrefixLength('abc', 'xyz') === 0, 'lcp: no shared prefix is 0');
assert(longestCommonPrefixLength('abc', 'abc') === 3, 'lcp: identical strings is the full length');
assert(longestCommonPrefixLength('abc', 'abcde') === 3, 'lcp: one string a prefix of the other stops at its end');
assert(longestCommonPrefixLength('abcde', 'abc') === 3, 'lcp: same, reversed argument order');
assert(longestCommonPrefixLength('aXc', 'aYc') === 1, 'lcp: divergence mid-string stops at the first difference');
assert(longestCommonPrefixLength('abcd', 'abXX') === 2, 'lcp: shared prefix before divergence');
assert(
  longestCommonPrefixLength('prefix and more', 'prefix and other') === 'prefix and '.length,
  'lcp: sentence-length shared prefix',
);

// --- longestCommonPrefixLength: code-unit semantics --------------------------
// The result composes directly with promptTagTree.ts section offsets and the frontend's
// slice(), both of which are UTF-16 code units — so LCP must count code units too, not
// code points. 😀 (U+1F600) is a surrogate pair = 2 code units.

const smile = '\u{1F600}';
assert(longestCommonPrefixLength(`${smile}ab`, `${smile}cd`) === 2, 'lcp: shared emoji prefix counts 2 code units (surrogate pair)');
assert(longestCommonPrefixLength(`${smile}`, `${smile}x`) === 2, 'lcp: identical emoji is 2 units, then divergence');
assert(longestCommonPrefixLength('a😀b', 'a😀c') === 3, 'lcp: emoji mid-string; b/c diverge after 2-unit emoji');
assert(longestCommonPrefixLength('😀x', '😀') === 2, 'lcp: one string ends inside the other after a surrogate pair');

// --- determinism -------------------------------------------------------------
// Same inputs, same answer — the property that makes the badge "completely deterministic".

assert(
  longestCommonPrefixLength('turn text', 'turn text') === longestCommonPrefixLength('turn text', 'turn text'),
  'determinism: identical inputs give identical output',
);
const a = 'alpha beta gamma';
const b = 'alpha beta delta';
assert(longestCommonPrefixLength(a, b) === longestCommonPrefixLength(a, b), 'determinism: divergent inputs are stable');

// --- cache-coverage rule (§3.2) ----------------------------------------------
// Section coverage is exactly "section.end <= stablePrefixChars": the section and everything
// upstream of it is byte-identical to the previous call. Simulated with a tiny tree of sections
// over a source text and an LCP length computed by the util itself.

const prev = '<a>first</a>\n<b>second</b>\n<c>third</c>';
const now = '<a>first</a>\n<b>second</b>\n<c>THIRD</c>';
const prefixLen = longestCommonPrefixLength(prev, now);

// Sections are (name, end-offset) pairs into `now`, from the tag tree the frontend would build:
// <a> spans [0,15), <b> spans [15,30), <c> spans [30,46) (approx — computed as char offsets into
// the string below rather than hand-rolled, so the assertion tests the RULE, not my arithmetic).
const endA = now.indexOf('</a>') + '</a>'.length;
const endB = now.indexOf('</b>') + '</b>'.length;
const endC = now.indexOf('</c>') + '</c>'.length;

assert(endA <= prefixLen, `coverage: section A (ends ${endA}) is at/before the stable prefix (${prefixLen}) => cached`);
assert(endB <= prefixLen, `coverage: section B (ends ${endB}) is at/before the stable prefix => cached`);
assert(endC > prefixLen, `coverage: section C (ends ${endC}) is past the stable prefix => changed`);
assert(
  now.slice(0, prefixLen) === prev.slice(0, prefixLen) && now.slice(prefixLen) !== prev.slice(prefixLen),
  'coverage: the stable prefix is exactly the maximal identical leading run',
);

// Changed word upstream invalidates everything downstream — an edit at the very first byte
// collapses the stable prefix to 0, so every section is changed.
const now2 = 'X<a>FIRST</a>\n<b>second</b>\n<c>third</c>';
const prefixLen2 = longestCommonPrefixLength(prev, now2);
assert(prefixLen2 === 0, 'coverage: an edit at the very first byte gives a 0-length stable prefix');
assert(
  endA > prefixLen2 && endB > prefixLen2 && endC > prefixLen2,
  'coverage: everything downstream of the edit is changed too (prefix cache cannot replay past it)',
);

// Identical turns → the whole prompt is covered (the provider would replay it all).
const prefixLen3 = longestCommonPrefixLength(now, now);
assert(prefixLen3 === now.length && endC <= prefixLen3, 'coverage: two identical turns cover every section');

console.log(`\nverify-common-prefix: ${process.exitCode ? 'FAILED' : 'all assertions passed'}`);
process.exit(process.exitCode ?? 0);
