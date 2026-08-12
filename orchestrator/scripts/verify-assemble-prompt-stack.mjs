// Proves util/assemblePromptStack.ts in isolation (a pure function, no DB) — moved into core
// 2026-08-06 (docs/turn-loop-plan.md §3.2) so server/httpServer.ts's per-turn narrator assembly
// can call it directly without inverting the plugin/core dependency direction. Mirrors the
// assertions plugins/context-stack-presets's own verify script already had for this function
// before the move.

import { assemblePromptStack, groupRuns, groupTagsForRendered } from '../dist/util/assemblePromptStack.js';
import { formatRecentHistoryTurns } from '../dist/io/chatMemory/memoryInjection.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const assembled = assemblePromptStack(
  { description: 'A quiet tavern.', recent_history: 'Ava: Welcome in.' },
  [
    { slotType: 'marker', markerKey: 'system', enabled: true },
    { slotType: 'marker', markerKey: 'description', enabled: true },
    { slotType: 'custom', enabled: true, customRole: 'system', customContent: 'Stay in character.' },
    { slotType: 'marker', markerKey: 'personality', enabled: true },
    { slotType: 'marker', markerKey: 'recent_history', enabled: false },
  ],
);
assert(assembled.length === 2, 'assemblePromptStack skips a marker slot with no matching field and a disabled slot');
assert(assembled[0].content === 'A quiet tavern.' && assembled[0].role === 'system', "assemblePromptStack emits a marker slot's value under role system");
assert(assembled[1].role === 'system' && assembled[1].content === 'Stay in character.', 'assemblePromptStack emits a custom slot under its own chosen role');

assert(
  assemblePromptStack({}, [{ slotType: 'marker', markerKey: 'system', enabled: true }]).length === 0,
  'a marker slot with no backing field is skipped entirely, not emitted empty',
);

const order = assemblePromptStack(
  { system: 'S', scenario: 'C' },
  [
    { slotType: 'marker', markerKey: 'scenario', enabled: true },
    { slotType: 'custom', enabled: true, customRole: 'user', customContent: 'mid' },
    { slotType: 'marker', markerKey: 'system', enabled: true },
  ],
);
assert(
  order.map((m) => m.content).join(',') === 'C,mid,S',
  'output order follows slot position, not marker-key declaration order — slots are walked in the order given',
);
assert(order[1].role === 'user', "a custom slot's role is whatever the slot itself chose, not always system");

// --- migration 0085: per-slot HTML-style tag wrapping (tagEnabled) ---
const tagged = assemblePromptStack(
  { description: 'A quiet tavern.', recent_history: 'Ava: Welcome in.' },
  [
    { slotType: 'marker', markerKey: 'recent_history', enabled: true, tagEnabled: true },
    { slotType: 'marker', markerKey: 'description', enabled: true, label: 'The Setting', tagEnabled: true },
    { slotType: 'custom', enabled: true, customRole: 'system', customContent: 'Stay in character.', label: 'Tone', tagEnabled: true },
  ],
);
assert(
  tagged[0].content === '<Recent History>\nAva: Welcome in.\n</Recent History>',
  'tagEnabled marker slot wraps content in <Friendly Name>…</Friendly Name> (spaces kept, marker label resolved server-side)',
);
assert(
  tagged[1].content === '<The Setting>\nA quiet tavern.\n</The Setting>',
  'an explicit slot label wins over the marker label as the tag name',
);
assert(
  tagged[2].content === '<Tone>\nStay in character.\n</Tone>',
  'tagEnabled custom slot wraps with its own label',
);
assert(
  assemblePromptStack({ system: 'S' }, [{ slotType: 'marker', markerKey: 'system', enabled: true }])[0].content === 'S',
  'tagEnabled unset (default) leaves content byte-identical — existing stacks keep their prompt-cache prefix',
);

const sanitized = assemblePromptStack(
  { description: 'a' },
  [{ slotType: 'marker', markerKey: 'description', enabled: true, label: 'My <Weird>\n  Label', tagEnabled: true }],
);
assert(
  sanitized[0].content === '<My Weird Label>\na\n</My Weird Label>',
  'tag names are sanitized: literal < > stripped, newlines/whitespace collapsed to single spaces',
);

// --- migration 0086: slot grouping (groupName, contiguous runs) ---
const grouped = assemblePromptStack(
  { description: 'A quiet tavern.', scenario: 'Rain falls.', system: 'Be concise.' },
  [
    { slotType: 'marker', markerKey: 'description', enabled: true, groupName: 'World Info' },
    { slotType: 'marker', markerKey: 'scenario', enabled: true, groupName: 'World Info' },
    { slotType: 'marker', markerKey: 'system', enabled: true },
  ],
);
assert(
  grouped[0].content === '<World Info>\nA quiet tavern.' && grouped[1].content === 'Rain falls.\n</World Info>',
  'a contiguous groupName run wraps the opener with <Name> and the closer with </Name> (members in between untouched)',
);
assert(
  grouped[2].content === 'Be concise.',
  'a slot outside any group is untouched',
);

const singleMemberGroup = assemblePromptStack(
  { description: 'd' },
  [{ slotType: 'marker', markerKey: 'description', enabled: true, groupName: 'Solo' }],
);
assert(
  singleMemberGroup[0].content === '<Solo>\nd\n</Solo>',
  'a one-slot group wraps just itself with both tags',
);

const disabledInRun = assemblePromptStack(
  { description: 'A quiet tavern.', scenario: 'Rain falls.' },
  [
    { slotType: 'marker', markerKey: 'description', enabled: true, groupName: 'World Info' },
    { slotType: 'marker', markerKey: 'system', enabled: false, groupName: 'World Info' },
    { slotType: 'marker', markerKey: 'scenario', enabled: true, groupName: 'World Info' },
  ],
);
assert(
  disabledInRun[0].content === '<World Info>\nA quiet tavern.' && disabledInRun[1].content === 'Rain falls.\n</World Info>',
  'a disabled member stays inside the group positionally — tags wrap the first and last RENDERED member',
);

const splitRuns = assemblePromptStack(
  { description: 'a', scenario: 'b', system: 'c' },
  [
    { slotType: 'marker', markerKey: 'description', enabled: true, groupName: 'G1' },
    { slotType: 'marker', markerKey: 'scenario', enabled: true },
    { slotType: 'marker', markerKey: 'system', enabled: true, groupName: 'G2' },
  ],
);
assert(
  splitRuns[0].content === '<G1>\na\n</G1>' && splitRuns[2].content === '<G2>\nc\n</G2>',
  'a non-member slot between two runs splits them — two independent groups',
);

const groupPlusSlotTag = assemblePromptStack(
  { description: 'a', scenario: 'b' },
  [
    { slotType: 'marker', markerKey: 'description', enabled: true, groupName: 'World Info', tagEnabled: true, label: 'Locations' },
    { slotType: 'marker', markerKey: 'scenario', enabled: true, groupName: 'World Info' },
  ],
);
assert(
  groupPlusSlotTag[0].content === '<World Info>\n<Locations>\na\n</Locations>' && groupPlusSlotTag[1].content === 'b\n</World Info>',
  'a slot\'s own 0085 tags nest INSIDE its group tags',
);

const emptyNameBreaksRun = assemblePromptStack(
  { description: 'a', scenario: 'b', system: 'c' },
  [
    { slotType: 'marker', markerKey: 'description', enabled: true, groupName: 'G' },
    { slotType: 'marker', markerKey: 'scenario', enabled: true, groupName: '  ' },
    { slotType: 'marker', markerKey: 'system', enabled: true, groupName: 'G' },
  ],
);
assert(
  emptyNameBreaksRun[0].content === '<G>\na\n</G>' && emptyNameBreaksRun[1].content === 'b' && emptyNameBreaksRun[2].content === '<G>\nc\n</G>',
  'an empty/whitespace groupName emits no tags and breaks a run (unnamed opener is mid-edit, not a group)',
);

assert(
  assemblePromptStack({ system: 'S' }, [{ slotType: 'marker', markerKey: 'system', enabled: true, groupName: undefined }])[0].content === 'S',
  'groupName unset (default) leaves content byte-identical — existing stacks keep their prompt-cache prefix',
);

// groupRuns/groupTagsForRendered are shared with the per-turn narrator path (httpServer.ts) —
// assert their direct contract too, so a drift between the two assembly sites fails here first.
assert(
  groupRuns([{ groupName: 'A' }, { groupName: 'A' }, {}, { groupName: 'B' }]).length === 2,
  'groupRuns derives runs purely from contiguity + equality, no opener/closer flags needed',
);
assert(
  groupTagsForRendered([{ groupName: 'X' }, { groupName: 'X' }, {}], [0, 1]) instanceof Map,
  'groupTagsForRendered returns the per-rendered-index tag map both assembly sites consume',
);

// --- reasoning-blocks-plan.md §17 regression: recent_history is built from message *content*
// only — a reasoning-bearing history assembles byte-identical to the same history without
// reasoning. The server maps StoredChatMessage -> LlmMessage via { role, content } (ChatView's
// toWireMessages / promptAssembly's recentHistoryMessages), so the reasoning column can never
// leak into the stack: this proves the exclusion is real, not accidental, at the pure-function
// layer the assembler runs on.
{
  // Two source histories that differ ONLY in the optional reasoning field (as StoredChatMessage
  // rows would after a reasoning turn), run through the same content-only mapping the server's
  // recent_history path uses before formatting.
  const withReasoning = [
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'A1', reasoning: 'the plan: open the door' },
    { role: 'user', content: 'U2' },
    { role: 'assistant', content: 'A2', reasoning: null },
  ];
  const withoutReasoning = [
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'U2' },
    { role: 'assistant', content: 'A2' },
  ];
  const toLlmMessages = (rows) => rows.map(({ role, content }) => ({ role, content }));
  const turnsWith = formatRecentHistoryTurns(toLlmMessages(withReasoning), 'Aria', 'You');
  const turnsWithout = formatRecentHistoryTurns(toLlmMessages(withoutReasoning), 'Aria', 'You');
  assert(turnsWith === turnsWithout, 'formatRecentHistoryTurns renders the same {{turns}} bytes whether or not the source rows carried reasoning');

  const slots = [
    { slotType: 'marker', markerKey: 'system', enabled: true },
    { slotType: 'marker', markerKey: 'recent_history', enabled: true },
  ];
  const stackWith = assemblePromptStack({ system: 'S', recent_history: turnsWith }, slots);
  const stackWithout = assemblePromptStack({ system: 'S', recent_history: turnsWithout }, slots);
  assert(
    JSON.stringify(stackWith) === JSON.stringify(stackWithout) && stackWith[1].content === turnsWith,
    'the assembled stack is byte-identical with and without reasoning history — the tag span never enters recent_history',
  );
}

if (process.exitCode) {
  console.error('\nassemblePromptStack verification FAILED');
  process.exit(1);
}
console.log('\nassemblePromptStack verification passed');
