// Proves util/promptTagTree.ts in isolation (a pure function, no IO) against the exact tag
// shapes the live `Comfy 2` preset produces (docs/prompt-inspector-tag-tree.md §2.6), plus the
// two global invariants the whole design rests on: losslessness (walking the tree in document
// order reproduces the input byte-for-byte) and determinism (same input ⇒ same tree).

import { parsePromptTagTree } from '../dist/util/promptTagTree.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// Recursively rebuild the source text from a section's own text plus its children — this is the
// losslessness invariant the panel's rendering relies on (no text is ever dropped or duplicated).
function reconstruct(section, text) {
  let out = '';
  let cursor = section.start;
  for (const child of section.children) {
    out += text.slice(cursor, child.start);
    out += reconstruct(child, text);
    cursor = child.end;
  }
  return out + text.slice(cursor, section.end);
}

// Compact tree shape for readable assertions, e.g. "root > inner thoughts > details > [summary, inner thoughts]".
function shape(section) {
  const children = section.children.map(shape);
  return `${section.name || 'root'}${children.length > 0 ? ` > [${children.join(' | ')}]` : ''}`;
}

function names(section) {
  return section.children.map((c) => c.name);
}

const ROOT_ONLY = new Set(['simple', 'preamble', 'siblings', 'nested-space-tag', 'inner-thoughts-double', 'cross-slot', 'crossed', 'missing-close', 'dangling-close', 'self-closing', 'attr-strip', 'recovery-order', 'eof-unclosed', 'group-wraps-single-tagged-child', 'empty-pair', 'comfy2-composite']);

// ownText mirrors PromptInspectorPanel.tsx's ownText(): a section's displayed "own text" is its
// [contentStart, contentEnd) span minus whatever its children occupy — the section's own tag
// bytes are never part of it. This is the function whose old behavior (slicing [start, end)
// instead) produced the reported bug.
function ownText(section, text) {
  let out = '';
  let cursor = section.contentStart;
  for (const child of section.children) {
    out += text.slice(cursor, child.start);
    cursor = child.end;
  }
  return out + text.slice(cursor, section.contentEnd);
}

// ---------------------------------------------------------------------------
// §2.6 fixtures — shapes mirror the live Comfy 2 preset content verbatim where noted.
// ---------------------------------------------------------------------------

const FIXTURES = {
  // 1. Simple match.
  simple: `<main_instructions>\nAll instructions here MUST be followed.\n</main_instructions>`,

  // 2. Untagged preamble — the preset's `---` block sits outside any tag and stays root text.
  preamble: `---\nAll instructions after this line MUST supersede the module context and any conflicting instructions.\n<main_instructions>\nhi\n</main_instructions>`,

  // 3. Two sibling blocks authored inside ONE prompt-stack slot.
  siblings: `<character_behavior_and_memory_protocol>\nAva stays wary of strangers.\n</character_behavior_and_memory_protocol>\n\n<character_autonomy_protocol>\nAva may leave the tavern at any time.\n</character_autonomy_protocol>`,

  // 4. Nested constraints with the space-named <No Deepity> tag.
  'nested-space-tag': `<constraints>\n<language>\nEnglish, lowercase.\n</language>\n<naming_constraints>\nNever call her "maiden".\n</naming_constraints>\n<No Deepity>\nNo purple prose.\n</No Deepity>\n</constraints>`,

  // 5. Duplicate <inner thoughts> — synthetic coverage (Comfy 2's live slot 6 had this shape
  //    until its OUTER tag was renamed to <internal thinking> to break the same-name nesting;
  //    kept here because nested same-name tags are legal and must stay distinct: the instruction
  //    section re-opens its own tag inside a <details><summary> example block, properly nested,
  //    and the nearest-close matcher nests B inside A.
  'inner-thoughts-double': `<inner thoughts>\n\nAfter every narrative response, append an internal thoughts block.\nUse this structure exactly:\n\n<details><summary>▸</summary>\n<inner thoughts>\n[Character]:\nWhat they feel beneath what they show.\n</inner thoughts>\n</details>\n\n</inner thoughts>`,

  // 6. Cross-slot pair: <narrative_execution> opens in slot 16, history sits between, close in slot 18.
  'cross-slot': `Ava: Welcome in.\n<narrative_execution>\nContinue the scene from the last event.\n</narrative_execution>`,

  // 7. Crossed pair degrades to the outer section only; the trailing </b> is dangling/inert.
  crossed: `<a><b>text</a>tail</b>`,

  // 8. Missing close → the open tag is inert; text rolls up to the root.
  'missing-close': `<x>text here`,

  // 9. Dangling close with no open → inert.
  'dangling-close': `hi</y>there`,

  // 10. Self-closing tags are inert.
  'self-closing': `<br/>one<br/>two`,

  // 11. Attribute-stripped names: template-emitted <memory turns="..."> matches </memory>;
  // <mira_seat> pairs match directly.
  'attr-strip': `<memory turns="1-3">\nchunk one\n</memory>\n<mira_seat>\nseat content\n</mira_seat>`,

  // 12. Recovery keeps completed children in DOCUMENT order even when two frames are
  // implicitly closed at once.
  'recovery-order': `<a><b1><c1></c1><b2><c2></c2></a>`,

  // 13. Unclosed open at EOF is not a section; its completed child survives under the root.
  'eof-unclosed': `<a>text<b>inner</b>more`,

  // 14. Migration-0086 group whose entire body is one nested tagEnabled child — the reported
  //     Prompt Inspector bug: "own text" must exclude the group's own delimiter bytes, or this
  //     renders as just the two <Time and Place> tag lines with nothing between them, making the
  //     real content (one level down, in header_instructions) look missing.
  'group-wraps-single-tagged-child': `<Time and Place>\n<header_instructions>\nSome real prose here.\n</header_instructions>\n</Time and Place>`,

  // 15. Empty tag pair — must yield NO own content, so the panel renders the dashed leaf row
  //     (nothing to expand) instead of a details block whose body is just its own tags.
  'empty-pair': `<a></a>`,

  // 16. Composite in the live Comfy 2 layout order: preamble → several root sections → nested
  // constraints → internal-thinking section (outer tag renamed from <inner thoughts> so the
  // example inside can keep its own <inner thoughts> name) → cross-slot narrative_execution.
  'comfy2-composite': `---\nAll instructions after this line MUST supersede the module context.\n<main_instructions>\nNarrate as Ava.\n</main_instructions>\n<earthy_physicality>\nTaste, smell, touch.\n</earthy_physicality>\n<point_of_view>\nAva's POV.\n</point_of_view>\n<character_behavior_and_memory_protocol>\nAva keeps her promises.\n</character_behavior_and_memory_protocol>\n<character_autonomy_protocol>\nAva may refuse.\n</character_autonomy_protocol>\n<constraints>\n<language>\nEnglish.\n</language>\n<naming_constraints>\nNever "maiden".\n</naming_constraints>\n<No Deepity>\nNo purple prose.\n</No Deepity>\n</constraints>\n<internal thinking>\nAppend thoughts blocks.\n\n<details><summary>▸</summary>\n<inner thoughts>\n[Character]:\nfeeling\n</inner thoughts>\n</details>\n</internal thinking>\n<narrative_execution>\nAva: Welcome in.\nAnd thus the scene continues.\n</narrative_execution>`,
};

// ---------------------------------------------------------------------------
// Structural assertions per fixture.
// ---------------------------------------------------------------------------

const simple = parsePromptTagTree(FIXTURES.simple);
assert(names(simple).join() === 'main_instructions', 'simple: exactly one root child named main_instructions');
assert(simple.children[0].start === 0 && simple.children[0].end === FIXTURES.simple.length, 'simple: section spans the whole text (tags included)');

const preamble = parsePromptTagTree(FIXTURES.preamble);
assert(names(preamble).join() === 'main_instructions', 'preamble: the untagged --- block adds no section');
assert(FIXTURES.preamble.slice(0, preamble.children[0].start).includes('---'), 'preamble: untagged text stays as root own-text before the section');

const siblings = parsePromptTagTree(FIXTURES.siblings);
assert(names(siblings).join() === 'character_behavior_and_memory_protocol,character_autonomy_protocol', 'siblings: two sibling sections in one slot, in document order');

const nested = parsePromptTagTree(FIXTURES['nested-space-tag']);
assert(shape(nested) === 'root > [constraints > [language | naming_constraints | No Deepity]]', 'nested-space-tag: constraints nests language, naming_constraints and the space-named No Deepity');

const double = parsePromptTagTree(FIXTURES['inner-thoughts-double']);
assert(shape(double) === 'root > [inner thoughts > [details > [summary | inner thoughts]]]', 'inner-thoughts-double: the example block nests as its own sections via nearest-close matching');

const crossSlot = parsePromptTagTree(FIXTURES['cross-slot']);
assert(shape(crossSlot) === 'root > [narrative_execution]', 'cross-slot: a pair spanning slots (history text between) forms one section');
assert(crossSlot.children[0].start > FIXTURES['cross-slot'].indexOf('Ava:'), 'cross-slot: history text before the open stays root own-text');

const crossed = parsePromptTagTree(FIXTURES.crossed);
assert(shape(crossed) === 'root > [a]', 'crossed: <a><b></a></b> degrades to the outer section only');
assert(crossed.children[0].end === FIXTURES.crossed.indexOf('tail'), 'crossed: the outer section ends at its close; the dangling </b> stays root text');

const missingClose = parsePromptTagTree(FIXTURES['missing-close']);
assert(missingClose.children.length === 0, 'missing-close: an unclosed open creates no section — text rolls up to the root');

const danglingClose = parsePromptTagTree(FIXTURES['dangling-close']);
assert(danglingClose.children.length === 0, 'dangling-close: a close with no open is inert');

const selfClosing = parsePromptTagTree(FIXTURES['self-closing']);
assert(selfClosing.children.length === 0, 'self-closing: <br/> creates no section');

const attrStrip = parsePromptTagTree(FIXTURES['attr-strip']);
assert(shape(attrStrip) === 'root > [memory | mira_seat]', 'attr-strip: <memory turns="1-3"> matches </memory>; <mira_seat> matches directly');

const recoveryOrder = parsePromptTagTree(FIXTURES['recovery-order']);
assert(shape(recoveryOrder) === 'root > [a > [c1 | c2]]', 'recovery-order: implicitly closed frames vanish but their children survive in document order');

const eofUnclosed = parsePromptTagTree(FIXTURES['eof-unclosed']);
assert(shape(eofUnclosed) === 'root > [b]', 'eof-unclosed: the completed <b> child survives under the root when its enclosing open is unclosed');

const groupWrapsChild = parsePromptTagTree(FIXTURES['group-wraps-single-tagged-child']);
assert(shape(groupWrapsChild) === 'root > [Time and Place > [header_instructions]]', 'group-wraps-single-tagged-child: the group nests its tagEnabled member as a child');
{
  const group = groupWrapsChild.children[0];
  assert(ownText(group, FIXTURES['group-wraps-single-tagged-child']).trim() === '', "group-wraps-single-tagged-child: the group's own text (tags excluded) is empty — its whole body is the nested child, not indistinguishable-from-empty tag lines");
}

const emptyPair = parsePromptTagTree(FIXTURES['empty-pair']);
assert(shape(emptyPair) === 'root > [a]', 'empty-pair: <a></a> still forms a section');
assert(ownText(emptyPair.children[0], FIXTURES['empty-pair']) === '', 'empty-pair: own text (tags excluded) is exactly empty — the panel renders this as the dashed "nothing to expand" leaf row, not a details block containing only its own tags');

const composite = parsePromptTagTree(FIXTURES['comfy2-composite']);
assert(
  shape(composite) === 'root > [main_instructions | earthy_physicality | point_of_view | character_behavior_and_memory_protocol | character_autonomy_protocol | constraints > [language | naming_constraints | No Deepity] | internal thinking > [details > [summary | inner thoughts]] | narrative_execution]',
  'comfy2-composite: the full live layout order parses into the expected nested tree',
);

// ---------------------------------------------------------------------------
// Global invariants: losslessness + determinism + root span, over EVERY fixture.
// ---------------------------------------------------------------------------

// contentStart/contentEnd invariant: every non-root section's own-content window sits strictly
// inside its tag-included span (start <= contentStart <= contentEnd <= end), and reproducing the
// text from ownText() + children (i.e. the panel's actual render) still loses nothing once each
// section's own tag bytes are added back in.
function reconstructViaContent(section, text) {
  let out = text.slice(section.start, section.contentStart); // this section's own open tag
  let cursor = section.contentStart;
  for (const child of section.children) {
    out += text.slice(cursor, child.start);
    out += reconstructViaContent(child, text);
    cursor = child.end;
  }
  out += text.slice(cursor, section.contentEnd);
  out += text.slice(section.contentEnd, section.end); // this section's own close tag
  return out;
}

function assertContentBounds(section) {
  assert(
    section.start <= section.contentStart && section.contentStart <= section.contentEnd && section.contentEnd <= section.end,
    `contentStart/contentEnd of "${section.name || 'root'}" stay within [start, end]`,
  );
  section.children.forEach(assertContentBounds);
}

for (const [name, text] of Object.entries(FIXTURES)) {
  const tree = parsePromptTagTree(text);
  assert(reconstruct(tree, text) === text, `${name}: lossless — walking the tree reproduces the input byte-for-byte`);
  assert(reconstructViaContent(tree, text) === text, `${name}: lossless via contentStart/contentEnd — the panel's actual own-text+tags render reproduces the input byte-for-byte`);
  assert(tree.start === 0 && tree.end === text.length, `${name}: root always spans the whole text`);
  assertContentBounds(tree);
  assert(JSON.stringify(parsePromptTagTree(text)) === JSON.stringify(tree), `${name}: deterministic — same input yields the same tree`);
}

// Empty and tag-free text degrade to a root-only tree (today's single-block rendering).
const empty = parsePromptTagTree('');
assert(empty.children.length === 0 && empty.end === 0, 'empty text: root-only tree');
const tagless = parsePromptTagTree('Just prose, no tags at all.');
assert(tagless.children.length === 0, 'tag-free prose: root-only tree');
assert(ROOT_ONLY.size > 0, 'fixture registry sanity');
