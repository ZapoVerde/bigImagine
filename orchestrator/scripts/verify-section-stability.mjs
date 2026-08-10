// Proves util/sectionStability.ts in isolation (pure, no IO) — the Prompt Inspector's per-subsection
// "identical to the previous call" percentage (docs/prompt-inspector-tag-tree.md §3.3). The window
// is the last x calls on record in io/promptTrace.ts (≤ 12): each consecutive pair contributes one
// observation per section (seen++), and identical++ when the section's full span is byte-identical
// to the previous call's same section. Sections keyed by canonical tag name + per-call occurrence
// index (preorder, a section before its children), so repeated names are tracked separately and the
// frontend matches rendered rows with the same key rule.

import { flattenSections, computeSectionStability } from '../dist/util/sectionStability.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// --- flattenSections: ordering, keys, spans ---------------------------------

{
  const flat = flattenSections('<a>x</a>');
  assert(flat.length === 1, 'flatten: one matched section');
  assert(flat[0].key === 'a' && flat[0].name === 'a', 'flatten: single occurrence keys by bare name');
  assert(flat[0].text === '<a>x</a>', 'flatten: text is the full span, tags included');
}

{
  const flat = flattenSections('pre <a>x</a> mid <b>y</b> post');
  assert(flat.length === 2, 'flatten: sections only, untagged text ignored');
  assert(flat[0].key === 'a' && flat[1].key === 'b', 'flatten: document order preserved');
}

{
  const flat = flattenSections('<m>x</m><m>y</m>');
  assert(flat.length === 2, 'flatten: repeated names both captured');
  assert(flat[0].key === 'm' && flat[1].key === 'm#1', 'flatten: second occurrence keys with #1');
  assert(flat[0].text === '<m>x</m>' && flat[1].text === '<m>y</m>', 'flatten: per-occurrence spans kept apart');
}

{
  const flat = flattenSections('<a><b>inner</b>own</a>');
  assert(flat.length === 2 && flat[0].key === 'a' && flat[1].key === 'b', 'flatten: preorder — parent before child');
  assert(flat[0].text === '<a><b>inner</b>own</a>', 'flatten: parent span includes the child');
}

{
  const flat = flattenSections('no tags here');
  assert(flat.length === 0, 'flatten: no matched tags → empty (root-only tree)');
}

{
  const flat = flattenSections('<memory turns="1">x</memory><inner thoughts>y</inner thoughts>');
  assert(flat[0].key === 'memory' && flat[1].key === 'inner thoughts', 'flatten: attribute-stripped + spaced names used as keys');
}

{
  // Broken tags are inert text — never sections.
  const flat = flattenSections('<a>x');
  assert(flat.length === 0, 'flatten: unclosed open tag is not a section');
}

// --- computeSectionStability: the window replay ------------------------------

{
  const r = computeSectionStability([]);
  assert(r.comparisons === 0 && r.sections.length === 0, 'stability: empty window → no stats');
  const r1 = computeSectionStability(['<a>x</a>']);
  assert(r1.comparisons === 0 && r1.sections.length === 0, 'stability: single call → no comparisons');
}

{
  // Two calls, section unchanged → 1 comparison, 100%.
  const r = computeSectionStability(['<a>x</a>', '<a>x</a>']);
  assert(r.comparisons === 1 && r.sections.length === 1, 'stability: two calls → one comparison');
  assert(r.sections[0].seen === 1 && r.sections[0].identical === 1, 'stability: identical text → seen 1 / identical 1');
}

{
  // Section text changed between the two calls.
  const r = computeSectionStability(['<a>x</a>', '<a>y</a>']);
  assert(r.sections[0].seen === 1 && r.sections[0].identical === 0, 'stability: changed text → seen 1 / identical 0');
}

{
  // Three calls, change on the last one → 2 comparisons, 50%.
  const r = computeSectionStability(['<a>x</a>', '<a>x</a>', '<a>z</a>']);
  assert(r.comparisons === 2, 'stability: three calls → two comparisons');
  assert(r.sections[0].seen === 2 && r.sections[0].identical === 1, 'stability: 2 seen / 1 identical over three calls');
}

{
  // A section new in the later call counts as seen-but-not-identical (nothing to be identical to).
  const r = computeSectionStability(['<a>x</a>', '<a>x</a><b>new</b>']);
  const a = r.sections.find((s) => s.key === 'a');
  const b = r.sections.find((s) => s.key === 'b');
  assert(a.seen === 1 && a.identical === 1, 'stability: pre-existing section unaffected by a sibling appearing');
  assert(b.seen === 1 && b.identical === 0, 'stability: new section → seen 1 / identical 0');
}

{
  // A section disappearing from the later call contributes nothing that call.
  const r = computeSectionStability(['<a>x</a><b>y</b>', '<a>x</a>']);
  const a = r.sections.find((s) => s.key === 'a');
  assert(a.seen === 1 && a.identical === 1, 'stability: surviving section still 100%');
  assert(r.sections.every((s) => s.key !== 'b'), 'stability: vanished section leaves no stat');
}

{
  // Repeated names tracked separately by occurrence key.
  const r = computeSectionStability(['<m>x</m><m>y</m>', '<m>x</m><m>y</m>', '<m>x</m><m>z</m>']);
  const first = r.sections.find((s) => s.key === 'm');
  const second = r.sections.find((s) => s.key === 'm#1');
  assert(first.seen === 2 && first.identical === 2, 'stability: occurrence 0 stable across all three calls');
  assert(second.seen === 2 && second.identical === 1, 'stability: occurrence #1 changed on the last call → 1/2');
}

{
  // Nested sections: a child change flips the parent's span too (parent includes the child).
  const r = computeSectionStability(['<a><b>x</b></a>', '<a><b>x</b></a>', '<a><b>y</b></a>']);
  const a = r.sections.find((s) => s.key === 'a');
  const b = r.sections.find((s) => s.key === 'b');
  assert(a.seen === 2 && a.identical === 1, 'stability: parent span flips when the child changes');
  assert(b.seen === 2 && b.identical === 1, 'stability: child itself 1/2');
}

{
  // Determinism: same inputs → identical outputs.
  const inputs = ['<a>x</a><b>y</b>', '<a>x</a><b>z</b>', '<a>w</a><b>z</b>'];
  const r1 = computeSectionStability(inputs);
  const r2 = computeSectionStability(inputs);
  assert(
    JSON.stringify(r1) === JSON.stringify(r2),
    'stability: deterministic — same window yields identical stats',
  );
}

{
  // Window is purely the last x calls passed in — the caller (buildPromptPreview) feeds exactly
  // the mains the trace holds, oldest first; a 12-call window yields 11 comparisons.
  const calls = Array.from({ length: 12 }, () => '<a>same</a>');
  const r = computeSectionStability(calls);
  assert(r.comparisons === 11, 'stability: 12 calls → 11 comparisons (trace cap)');
  assert(r.sections[0].seen === 11 && r.sections[0].identical === 11, 'stability: 11/11 identical across the full window');
}
