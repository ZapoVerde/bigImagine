// Proves parseBridgeOutput.ts in isolation — the first genuinely structured text format of the
// chat-memory structured-output migration (docs/plans/chat-memory-structured-output-plan.md Chunk
// 2). The bridge's LLM call is an ordinary text completion whose raw output follows Canonize's own
// "OUTPUT FORMAT" convention; this pure parser turns it back into the existing BridgeResult draft
// shape. Later chunks (world/people/digest) can join this file rather than each getting their own
// verify script.

import { parseBridgeOutput } from '../dist/io/chatMemory/parseBridgeOutput.js';

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

console.log(`\nverify-chat-memory-text-parsers: ${process.exitCode ? 'FAILED' : 'all assertions passed'}`);
process.exit(process.exitCode ?? 0);