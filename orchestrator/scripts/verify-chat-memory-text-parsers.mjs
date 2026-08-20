// Proves the chat-memory text parsers in isolation — the first genuinely structured text formats of
// the chat-memory structured-output migration (docs/plans/chat-memory-structured-output-plan.md
// Chunk 2, docs/plans/chat-memory-world-curator-plan.md). The bridge's and the world curator's LLM
// calls are ordinary text completions whose raw output follows their own "OUTPUT FORMAT"
// conventions; these pure parsers turn that raw text back into the existing draft shapes.
// Later chunks (people/digest) can join this file rather than each getting their own verify script.

import { parseBridgeOutput } from '../dist/io/chatMemory/parseBridgeOutput.js';
import { parseWorldMemoryOutput } from '../dist/io/chatMemory/parseWorldMemoryOutput.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const EMPTY_EVENTS = ['| When | What | Who |', '|------|------|-----|'];

function bridgeOutput({ events = EMPTY_EVENTS, scene = 'The dusk settles over a quiet square.', plots = [] } = {}) {
  const lines = ['EVENTS:', ...events, '', 'SCENE:', scene];
  for (const p of plots) {
    lines.push('', `**NEW: ${p.name}**`, p.content, p.tag);
  }
  return lines.join('\n');
}

function parseOk(raw) {
  try {
    return parseBridgeOutput(raw);
  } catch (e) {
    throw new Error(`expected parseBridgeOutput to succeed but it threw: ${e.message}\n--- raw ---\n${raw}`);
  }
}

function parseFails(raw, label) {
  let threw = false;
  try {
    parseBridgeOutput(raw);
  } catch {
    threw = true;
  }
  assert(threw, label);
}

// --- 1. EVENTS + SCENE, no plots -> valid ------------------------------------

{
  const r = parseOk(bridgeOutput());
  assert(r.events === '| When | What | Who |\n|------|------|-----|', 'events is stored table-only (heading stripped)');
  assert(r.scene === 'The dusk settles over a quiet square.', 'scene is stored body-only (heading stripped)');
  assert(Array.isArray(r.plotEntries) && r.plotEntries.length === 0, 'no plot blocks -> plotEntries is []');
}

// --- 2. empty EVENTS table (header + separator, no rows) -> valid -------------

{
  const r = parseOk(bridgeOutput({ events: EMPTY_EVENTS }));
  assert(r.events === '| When | What | Who |\n|------|------|-----|', 'an events table with no data rows is valid');
}

// --- 3. one plot entry -> valid ----------------------------------------------

{
  const r = parseOk(
    bridgeOutput({
      plots: [{ name: 'The Ashford Siege Breaks Open', content: 'The siege wall breached.', tag: '#siege_break' }],
    }),
  );
  assert(r.plotEntries.length === 1, 'one plot block -> one entry');
  assert(r.plotEntries[0].name === 'The Ashford Siege Breaks Open', 'entry name is taken from the **NEW: header');
  assert(r.plotEntries[0].content === 'The siege wall breached.', 'entry content is the body minus the tag line');
  assert(r.plotEntries[0].arcTag === 'siege_break', "the arc tag is stored without its leading '#'");
}

// --- 4. multiple plot entries -> valid ---------------------------------------

{
  const r = parseOk(
    bridgeOutput({
      plots: [
        { name: 'The Ashford Siege Breaks Open', content: 'The siege wall breached.', tag: '#siege_break' },
        { name: "Elena's Allegiance Fractures", content: 'Elena turned against the council.', tag: '#elena_allegiance' },
      ],
    }),
  );
  assert(r.plotEntries.length === 2, 'two plot blocks -> two entries');
  assert(
    r.plotEntries[0].name === 'The Ashford Siege Breaks Open' && r.plotEntries[1].name === "Elena's Allegiance Fractures",
    'each block keeps its own name/content/tag, in order',
  );
}

// --- 5. CRLF -> valid ---------------------------------------------------------

{
  const r = parseOk(
    'EVENTS:\r\n| When | What | Who |\r\n|------|------|-----|\r\n\r\nSCENE:\r\nThe dusk settles.\r\n\r\n**NEW: Break**\r\nThe wall fell.\r\n#siege_break\r\n',
  );
  assert(r.scene === 'The dusk settles.', 'CRLF line endings parse the same as LF');
  assert(r.plotEntries[0].arcTag === 'siege_break', 'CRLF plot block parses with its tag intact');
}

// --- 6. enclosing markdown fence -> valid -------------------------------------

{
  const r = parseOk('```\n' + bridgeOutput() + '\n```');
  assert(r.events.startsWith('| When |'), 'one enclosing markdown fence is tolerated and stripped');
  assert(r.scene === 'The dusk settles over a quiet square.', 'fenced scene body is unchanged');
}

// --- 7. surrounding whitespace -> valid ---------------------------------------

{
  const r = parseOk('\n\n  ' + bridgeOutput() + '\n\t  ');
  assert(r.scene === 'The dusk settles over a quiet square.', 'leading/trailing whitespace is normalized away');
}

// --- 8. missing EVENTS -> fail ------------------------------------------------

parseFails('SCENE:\nThe dusk settles.', 'missing EVENTS section throws');

// --- 9. malformed EVENTS table -> fail ----------------------------------------

parseFails(
  'EVENTS:\n| When | What | Who |\n\nSCENE:\nThe dusk settles.',
  'an EVENTS table with no separator row throws',
);
parseFails(
  'EVENTS:\nWhen | What | Who\n|------|------|-----|\nSCENE:\nThe dusk settles.',
  'an EVENTS table whose header is not pipe-delimited throws',
);

// --- 10. missing SCENE -> fail ------------------------------------------------

parseFails('EVENTS:\n| When | What | Who |\n|------|------|-----|\n\nNo scene section here.', 'missing SCENE section throws');

// --- 11. empty SCENE -> fail --------------------------------------------------

parseFails('EVENTS:\n| When | What | Who |\n|------|------|-----|\n\nSCENE:\n', 'an empty SCENE body throws');
parseFails('EVENTS:\n| When | What | Who |\n|------|------|-----|\n\nSCENE:\n   \n', 'a whitespace-only SCENE body throws');

// --- 12. **NEW:** with empty name -> fail -------------------------------------

parseFails(
  'EVENTS:\n| When | What | Who |\n|------|------|-----|\n\nSCENE:\nThe dusk settles.\n\n**NEW:**\nThe wall fell.\n#siege_break',
  'a **NEW:** block with an empty name throws',
);

// --- 13. plot with empty content -> fail --------------------------------------

parseFails(
  'EVENTS:\n| When | What | Who |\n|------|------|-----|\n\nSCENE:\nThe dusk settles.\n\n**NEW: Break**\n#siege_break',
  'a plot block with no content body throws',
);

// --- 14. plot missing arc tag -> fail -----------------------------------------

parseFails(
  'EVENTS:\n| When | What | Who |\n|------|------|-----|\n\nSCENE:\nThe dusk settles.\n\n**NEW: Break**\nThe wall fell with no tag line.',
  'a plot block missing its final arc tag throws',
);

// --- 15. plot with two arc tags -> fail ---------------------------------------

parseFails(
  'EVENTS:\n| When | What | Who |\n|------|------|-----|\n\nSCENE:\nThe dusk settles.\n\n**NEW: Break**\nThe wall fell.\n#siege_break\n#wall_fall',
  'a plot block ending in two arc tags throws',
);

// --- 16. malformed arc tag (hyphenated, uppercase, no leading #) -> fail ------

parseFails(
  'EVENTS:\n| When | What | Who |\n|------|------|-----|\n\nSCENE:\nThe dusk settles.\n\n**NEW: Break**\nThe wall fell.\n#siege-break',
  'a hyphenated arc tag throws',
);
parseFails(
  'EVENTS:\n| When | What | Who |\n|------|------|-----|\n\nSCENE:\nThe dusk settles.\n\n**NEW: Break**\nThe wall fell.\n#SiegeBreak',
  'an uppercase arc tag throws',
);
parseFails(
  'EVENTS:\n| When | What | Who |\n|------|------|-----|\n\nSCENE:\nThe dusk settles.\n\n**NEW: Break**\nThe wall fell.\nsiege_break',
  'an arc tag with no leading # throws',
);

// --- 17. stored scene never carries a SCENE: heading --------------------------
// Even when the raw output has the heading AND begins its body with a redundant `SCENE:` line
// (the doubled-heading shape the old forced-tool schema encouraged), the stored scene carries
// neither — matching Canonize's own /^SCENE:\s*/i strip.

{
  const raw = 'EVENTS:\n| When | What | Who |\n|------|------|-----|\n\nSCENE:\nSCENE: A quiet square at dusk.\nThe square is quiet.';
  const r = parseOk(raw);
  assert(!r.scene.includes('SCENE:'), 'stored scene never contains a SCENE: heading, even when the raw input doubled it');
  assert(
    r.scene === 'A quiet square at dusk.\nThe square is quiet.',
    'the doubled SCENE: prefix is stripped from the stored scene body',
  );
}

// --- 18. parser output matches the existing BridgeResult draft shape ----------
// plotEntries entries are exactly { name, content, arcTag } strings; events/scene are plain
// strings — the same keys chatMemorySync.ts's SQL writes consume today.

{
  const r = parseOk(
    bridgeOutput({
      events: ['| When | What | Who |', '|------|------|-----|', '| Dawn | The gate opens | The defenders |'],
      plots: [{ name: 'Break', content: 'The wall fell.', tag: '#siege_break' }],
    }),
  );
  assert(
    Object.keys(r).sort().join(',') === 'events,plotEntries,scene',
    "top-level keys are exactly { events, scene, plotEntries }",
  );
  assert(typeof r.events === 'string' && typeof r.scene === 'string', 'events and scene are plain strings');
  assert(
    r.plotEntries.every((e) => typeof e.name === 'string' && typeof e.content === 'string' && typeof e.arcTag === 'string') &&
      Object.keys(r.plotEntries[0]).sort().join(',') === 'arcTag,content,name',
    'each plot entry is exactly { name, content, arcTag } — the BridgePlotEntryDraft shape',
  );
  assert(r.events.includes('| Dawn | The gate opens | The defenders |'), 'a non-empty events table keeps its data rows');
}

// --- 19. heading with inline content on the same line -> valid ----------------
// The prompt asks for `SCENE:`/`EVENTS:` alone on their own line, but a model is free to put the
// section's content directly after the colon on that same line instead. The header regexes must
// only anchor on the heading token appearing at the start of a line, not on nothing else following
// it on that line — over-anchoring here would fail perfectly good output for a formatting quirk,
// exactly the kind of model-compliance fragility this migration exists to remove.

{
  const raw =
    'EVENTS:\n| When | What | Who |\n|------|------|-----|\n\n' +
    'SCENE: A quiet square at dusk. Elena watches the gate.\n\n' +
    '**NEW: Break**\nThe wall fell.\n#siege_break';
  const r = parseOk(raw);
  assert(r.scene === 'A quiet square at dusk. Elena watches the gate.', 'a SCENE heading followed by inline content parses, not just heading-then-newline');
  assert(r.plotEntries[0]?.arcTag === 'siege_break', 'the rest of the output still parses normally around the inline SCENE');
}

{
  const raw = 'EVENTS: | When | What | Who |\n|------|------|-----|\n\nSCENE:\nThe dusk settles.';
  const r = parseOk(raw);
  assert(r.events === '| When | What | Who |\n|------|------|-----|', 'an EVENTS heading whose table header starts on the same line still parses, not just heading-then-newline');
}

// =============================================================================
// World-curator parser (chat-memory-world-curator-plan.md): parseWorldMemoryOutput
// turns the curator's plain-text OUTPUT FORMAT back into the WorldMemoryCuratorEntryDraft
// shape the old forced curate_lorebook tool call produced.
// =============================================================================

function worldOutput({ updates = [], news = [], duplicates = [] } = {}) {
  const lines = [];
  for (const u of updates) lines.push(`**UPDATE: ${u.name}**`, `Category: ${u.category}`, u.content, '');
  for (const n of news) lines.push(`**NEW: ${n.name}**`, `Category: ${n.category}`, n.content, '');
  for (const d of duplicates) lines.push(`**DUPLICATE: ${d.name}**`, `Duplicate of: ${d.duplicateOf}`, '');
  return lines.join('\n').trim();
}

function worldParseOk(raw) {
  try {
    return parseWorldMemoryOutput(raw);
  } catch (e) {
    throw new Error(`expected parseWorldMemoryOutput to succeed but it threw: ${e.message}\n--- raw ---\n${raw}`);
  }
}

function worldParseFails(raw, label) {
  let threw = false;
  try {
    parseWorldMemoryOutput(raw);
  } catch {
    threw = true;
  }
  assert(threw, label);
}

// --- 20. exact NO CHANGES NEEDED -> [] ---------------------------------------

{
  const r = worldParseOk('NO CHANGES NEEDED');
  assert(Array.isArray(r) && r.length === 0, 'the exact NO CHANGES NEEDED sentinel parses to an empty array');
  assert(worldParseOk('no changes needed').length === 0, 'the sentinel is case-insensitive-tolerant (but still the exact sentinel, not prose)');
}

// --- 21. one UPDATE -> valid --------------------------------------------------

{
  const r = worldParseOk(
    worldOutput({
      updates: [{ name: 'The Wandering Pavilion', category: 'place', content: 'The pavilion sits at the crossroads.\nIt has weathered three wars.' }],
    }),
  );
  assert(r.length === 1 && r[0].action === 'update' && r[0].name === 'The Wandering Pavilion' && r[0].category === 'place', 'one UPDATE block -> one update entry with name/category');
  assert(r[0].content.includes('weathered three wars'), 'the body after the Category line becomes the entry content');
}

// --- 22. one NEW -> valid -----------------------------------------------------

{
  const r = worldParseOk(
    worldOutput({ news: [{ name: 'Ash Covenant', category: 'concept', content: 'A secretive order of archivists.' }] }),
  );
  assert(r.length === 1 && r[0].action === 'new' && r[0].name === 'Ash Covenant' && r[0].category === 'concept', 'one NEW block -> one new entry');
}

// --- 23. one DUPLICATE -> valid ----------------------------------------------

{
  const r = worldParseOk(worldOutput({ duplicates: [{ name: 'The Pavilion', duplicateOf: 'The Wandering Pavilion' }] }));
  assert(
    r.length === 1 && r[0].action === 'duplicate' && r[0].name === 'The Pavilion' && r[0].duplicateOf === 'The Wandering Pavilion' && r[0].category === undefined && r[0].content === undefined,
    'one DUPLICATE block -> one duplicate entry carrying no category or content',
  );
}

// --- 24. mixed UPDATE + NEW + DUPLICATE -> valid ------------------------------

{
  const r = worldParseOk(
    worldOutput({
      updates: [{ name: 'The Wandering Pavilion', category: 'place', content: 'It now flies a black banner.' }],
      news: [{ name: 'Ash Covenant', category: 'concept', content: 'A secretive order of archivists.' }],
      duplicates: [{ name: 'The Pavilion', duplicateOf: 'The Wandering Pavilion' }],
    }),
  );
  assert(r.length === 3, 'a mixed response yields exactly three entries');
  assert(r.map((e) => e.action).join(',') === 'update,new,duplicate', 'mixed blocks keep their action order');
}

// --- 25. multiple entries of the same action -> valid -------------------------

{
  const r = worldParseOk(
    worldOutput({
      news: [
        { name: 'Ash Covenant', category: 'concept', content: 'First.' },
        { name: 'The Iron Road', category: 'thing', content: 'Second.' },
        { name: 'The Hollow Vale', category: 'place', content: 'Third.' },
      ],
    }),
  );
  assert(r.length === 3 && r.every((e) => e.action === 'new'), 'multiple NEW blocks all parse, in order');
  assert(r[2].name === 'The Hollow Vale', 'the third NEW block keeps its own name');
}

// --- 26. CRLF -> valid --------------------------------------------------------

{
  const r = worldParseOk(
    '**UPDATE: The Wandering Pavilion**\r\nCategory: place\r\nIt now flies a black banner.\r\n\r\n**NEW: Ash Covenant**\r\nCategory: concept\r\nA secretive order.\r\n',
  );
  assert(r.length === 2 && r[0].content === 'It now flies a black banner.', 'CRLF line endings parse the same as LF');
}

// --- 27. enclosing markdown fence -> valid ------------------------------------

{
  const r = worldParseOk('```\n' + worldOutput({ news: [{ name: 'Ash Covenant', category: 'concept', content: 'A secretive order.' }] }) + '\n```');
  assert(r.length === 1 && r[0].name === 'Ash Covenant', 'one enclosing markdown fence is tolerated and stripped');
}

// --- 28. surrounding whitespace -> valid --------------------------------------

{
  const r = worldParseOk('\n\n  ' + worldOutput({ news: [{ name: 'Ash Covenant', category: 'concept', content: 'A secretive order.' }] }) + '\n\t  ');
  assert(r.length === 1 && r[0].content === 'A secretive order.', 'leading/trailing whitespace is normalized away');
}

// --- 29. place / thing / concept each accepted --------------------------------

{
  for (const category of ['place', 'thing', 'concept']) {
    const r = worldParseOk(worldOutput({ updates: [{ name: `X ${category}`, category, content: 'Body.' }] }));
    assert(r[0].category === category, `the ${category} category is accepted`);
  }
}

// --- 30. missing name -> fail -------------------------------------------------

worldParseFails('**UPDATE:**\nCategory: place\nSome content.', 'an UPDATE block with an empty name throws');
worldParseFails('**NEW:**\nCategory: concept\nSome content.', 'a NEW block with an empty name throws');

// --- 31. missing Category -> fail ---------------------------------------------

worldParseFails('**UPDATE: The Wandering Pavilion**\nNo category line here.\nSome content.', 'an UPDATE block with no Category line throws');

// --- 32. Category: person -> fail ---------------------------------------------

worldParseFails('**NEW: Some Person**\nCategory: person\nSome content.', 'a Category of person throws');

// --- 33. unknown category -> fail ---------------------------------------------

worldParseFails('**NEW: Somewhere**\nCategory: location\nSome content.', 'a Category of location throws');

// --- 34. empty content -> fail ------------------------------------------------

worldParseFails('**UPDATE: The Wandering Pavilion**\nCategory: place\n', 'an UPDATE block with empty content throws');
worldParseFails('**NEW: Ash Covenant**\nCategory: concept\n   \n', 'a NEW block with whitespace-only content throws');

// --- 35. DUPLICATE missing / empty target -> fail -----------------------------

worldParseFails('**DUPLICATE: The Pavilion**', 'a DUPLICATE block with no Duplicate-of line throws');
worldParseFails('**DUPLICATE: The Pavilion**\nDuplicate of: ', 'a DUPLICATE block with an empty Duplicate-of target throws');

// --- 36. unknown action such as DELETE -> fail --------------------------------

worldParseFails('**DELETE: Some Entry**\nSome content.', 'an unrecognized **DELETE:** block throws');

// --- 37. one malformed block fails the whole response -------------------------

worldParseFails(
  worldOutput({
    news: [{ name: 'Ash Covenant', category: 'concept', content: 'Good content.' }],
    updates: [{ name: 'Broken', category: 'location', content: 'Bad category.' }],
    duplicates: [{ name: 'The Pavilion', duplicateOf: 'The Wandering Pavilion' }],
  }),
  'a single malformed block among otherwise valid blocks fails the entire response (whole-response failure)',
);

// --- 38. arbitrary prose outside any block -> fail ----------------------------

worldParseFails(
  'Here are the changes I recommend:\n\n' + worldOutput({ news: [{ name: 'Ash Covenant', category: 'concept', content: 'A secretive order.' }] }),
  'prose before the first block throws — the format is exact, no preamble allowed',
);

// --- 39. parsed object matches the existing WorldMemoryCuratorEntryDraft shape ---
// update/new entries are exactly { action, name, category, content }; duplicates are exactly
// { action, name, duplicateOf } — the same key sets chatMemorySync.ts's upsert_world_memory
// consumes today.

{
  const r = worldParseOk(
    worldOutput({
      updates: [{ name: 'The Wandering Pavilion', category: 'place', content: 'It now flies a black banner.' }],
      news: [{ name: 'Ash Covenant', category: 'concept', content: 'A secretive order.' }],
      duplicates: [{ name: 'The Pavilion', duplicateOf: 'The Wandering Pavilion' }],
    }),
  );
  const update = r.find((e) => e.action === 'update');
  const news = r.find((e) => e.action === 'new');
  const duplicate = r.find((e) => e.action === 'duplicate');
  assert(
    Object.keys(update).sort().join(',') === 'action,category,content,name',
    'an update entry is exactly { action, name, category, content }',
  );
  assert(
    Object.keys(news).sort().join(',') === 'action,category,content,name',
    'a new entry is exactly { action, name, category, content }',
  );
  assert(
    Object.keys(duplicate).sort().join(',') === 'action,duplicateOf,name',
    'a duplicate entry is exactly { action, name, duplicateOf } — no category, no content',
  );
  assert(
    typeof update.category === 'string' && typeof update.content === 'string' && typeof duplicate.duplicateOf === 'string',
    'entry fields are plain strings',
  );
}

// --- 40. stray text between two otherwise-valid blocks -> fail ---------------
// The OUTPUT FORMAT puts a blank line only between blocks, never inside one. A model that tacks on
// conversational filler after a block's content (before the next block header, or trailing after
// the last block) must not have that filler silently merged into the preceding entry's content —
// this is exactly the "arbitrary text between structured blocks" case plan §8 requires to fail the
// whole response, not just the one block.

worldParseFails(
  '**NEW: Ash Covenant**\nCategory: concept\nA secretive order.\n\nLet me know if you need anything else!\n\n**DUPLICATE: The Pavilion**\nDuplicate of: The Wandering Pavilion',
  'stray prose between two valid blocks throws — it must not silently merge into the previous entry\'s content',
);
worldParseFails(
  '**NEW: Ash Covenant**\nCategory: concept\nA secretive order.\n\nHope that helps!',
  'stray prose trailing after the last block throws — same rule applies at the end of the response',
);

// --- 41. legitimate single-paragraph multi-line content still parses ---------
// The stray-text rule above must not reject ordinary multi-line content (several sentences on
// separate lines with no blank line between them) — only a *second paragraph* is stray.

{
  const r = worldParseOk('**UPDATE: The Wandering Pavilion**\nCategory: place\nLine one.\nLine two.');
  assert(r[0].content === 'Line one.\nLine two.', 'multi-line content with no internal blank line is not mistaken for stray trailing text');
}

console.log(`\nverify-chat-memory-text-parsers: ${process.exitCode ? 'FAILED' : 'all assertions passed'}`);
process.exit(process.exitCode ?? 0);