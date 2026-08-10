// Proves util/assemblePromptStack.ts in isolation (a pure function, no DB) — moved into core
// 2026-08-06 (docs/turn-loop-plan.md §3.2) so server/httpServer.ts's per-turn narrator assembly
// can call it directly without inverting the plugin/core dependency direction. Mirrors the
// assertions plugins/context-stack-presets's own verify script already had for this function
// before the move.

import { assemblePromptStack } from '../dist/util/assemblePromptStack.js';

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

if (process.exitCode) {
  console.error('\nassemblePromptStack verification FAILED');
  process.exit(1);
}
console.log('\nassemblePromptStack verification passed');
