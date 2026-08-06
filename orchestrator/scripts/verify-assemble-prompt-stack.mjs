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

if (process.exitCode) {
  console.error('\nassemblePromptStack verification FAILED');
  process.exit(1);
}
console.log('\nassemblePromptStack verification passed');
