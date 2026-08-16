// Proves the pure chromosome reconciler (orchestrator/src/portraits/reconcile.ts, plan §Tests) —
// a hallucinated slot key is dropped, an omitted one is backfilled from the parent, per layer,
// across an arbitrary layer set; values pass through untouched; never throws (a degenerate
// child is backfilled wholesale). Pure function: no DB, no network.

import { enforceSlotKeys } from '../dist/portraits/reconcile.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// An arbitrary 3-layer set (not the fixed default four — §Tests: "across an arbitrary layer
// set").
const layers3 = [
  { id: 'subject', label: 'Subject', promptable: true, boundary: 'x' },
  { id: 'style', label: 'Style', promptable: true, boundary: 'x' },
  { id: 'hair', label: 'Hair', promptable: true, boundary: 'x' },
];

const parent = {
  slots: {
    subject: { subject_identity: 'Rin V2', age: '20' },
    style: { style_style: 'VLZ hybrid' },
    hair: { hair_style: 'shoulder-length', hair_color: 'black' },
  },
};

// --- Hallucinated key dropped; omitted key backfilled; child value kept verbatim. ---
const child1 = {
  slots: {
    subject: { subject_identity: 'Rin V3', hallucinated_key: 'not a real slot' }, // dropped: hallucinated; age omitted → backfilled
    style: { style_style: 'watercolor' },
    hair: { hair_style: 'bob', hair_color: 'silver' },
  },
};
const r1 = enforceSlotKeys(parent, child1, layers3);
assert(!('hallucinated_key' in r1.slots.subject), 'reconcile: hallucinated child slot key dropped');
assert(r1.slots.subject.age === '20', `reconcile: omitted parent key backfilled -> "${r1.slots.subject.age}"`);
assert(r1.slots.subject.subject_identity === 'Rin V3', 'reconcile: child value preserved verbatim');
assert(r1.slots.style.style_style === 'watercolor' && r1.slots.hair.hair_style === 'bob' && r1.slots.hair.hair_color === 'silver', 'reconcile: untouched layers pass through');

// --- Child with no slots object for one layer: that layer backfilled wholesale from parent. ---
const child2 = { slots: { subject: { subject_identity: 'Rin V3' }, style: { style_style: 'watercolor' } } }; // no hair entry at all
const r2 = enforceSlotKeys(parent, child2, layers3);
assert(
  r2.slots.hair.hair_style === 'shoulder-length' && r2.slots.hair.hair_color === 'black',
  'reconcile: layer missing entirely from child is backfilled wholesale',
);

// --- Child invents a whole layer: dropped (not in the manifest, not in the result). ---
const child3 = {
  slots: {
    subject: { subject_identity: 'Rin V3' },
    ghost: { ghost_slot: 'haunted' },
  },
};
const r3 = enforceSlotKeys(parent, child3, layers3);
assert(!('ghost' in r3.slots), 'reconcile: child-invented layer dropped entirely');
assert(r3.slots.style.style_style === 'VLZ hybrid', 'reconcile: layer with no child content backfilled');

// --- negative_prompt passes through; omitted when the child has none. ---
const child4 = { slots: { subject: { subject_identity: 'Rin V3' } }, negative_prompt: 'blurry' };
const r4 = enforceSlotKeys(parent, child4, layers3);
assert(r4.negative_prompt === 'blurry', 'reconcile: negative_prompt passes through');
const r4b = enforceSlotKeys(parent, { slots: { subject: { subject_identity: 'Rin V3' } } }, layers3);
assert(!('negative_prompt' in r4b), 'reconcile: negative_prompt omitted when the child had none');
const r4c = enforceSlotKeys(parent, { slots: { subject: { subject_identity: 'Rin V3' } }, negative_prompt: '' }, layers3);
assert(r4c.negative_prompt === '', 'reconcile: empty negative_prompt passes through as-is');

// --- Non-string child values coerced to string, never dropped. ---
const child5 = { slots: { subject: { subject_identity: 'Rin V3', age: 42 }, style: { style_style: { nested: true } } } };
const r5 = enforceSlotKeys(parent, child5, layers3);
assert(r5.slots.subject.age === '42', `reconcile: numeric slot value stringified -> "${r5.slots.subject.age}"`);
assert(r5.slots.style.style_style === '[object Object]', `reconcile: object slot value stringified -> "${r5.slots.style.style_style}"`);

// --- Degenerate child (null / missing slots object): wholesale backfill, never throws. ---
const r6 = enforceSlotKeys(parent, null, layers3);
assert(
  r6.slots.subject.subject_identity === 'Rin V2' && r6.slots.hair.hair_color === 'black',
  'reconcile: null child backfilled wholesale, no throw',
);
const r7 = enforceSlotKeys(parent, { slots: null }, layers3);
assert(r7.slots.subject.age === '20', 'reconcile: null child slots backfilled wholesale, no throw');

// --- Child layer entry that isn't an object: treated as no child content, backfilled. ---
const r8 = enforceSlotKeys(parent, { slots: { subject: { subject_identity: 'Rin V3' }, hair: 'not-an-object' } }, layers3);
assert(r8.slots.hair.hair_style === 'shoulder-length', 'reconcile: non-object child layer entry backfilled wholesale');

// --- Parent layer with no content: nothing enforced for it, layer absent from result. ---
const r9 = enforceSlotKeys(
  { slots: { subject: { subject_identity: 'Rin V2' }, style: { style_style: 'VLZ hybrid' } } },
  { slots: { style: { style_style: 'watercolor' } } },
  layers3,
);
assert(!('hair' in r9.slots), 'reconcile: layer with no parent content is skipped, not fabricated');

// --- Child-only layer not in the manifest is dropped even though it has content. ---
const r10 = enforceSlotKeys(parent, { slots: { subject: { subject_identity: 'Rin V3' }, ghost: { g: '1' } } }, layers3);
assert(!('ghost' in r10.slots), 'reconcile: child-only layer dropped despite having content');
