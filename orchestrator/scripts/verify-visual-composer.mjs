// Proves the pure portrait template composer (orchestrator/src/portraits/composer.ts, plan
// §Tests) — {{slot}} substitution, {{<layerId>_overflow}} buckets, unknown-token passthrough,
// and comma-run collapse — against layer lists of varying length (2, 4, 6 promptable layers),
// confirming no hardcoded assumption about which/how many layers exist. Pure function: no DB,
// no network — the same inputs the generation round feeds it (winner recomposition, candidate
// prompt recomputation).

import { compileTemplate } from '../dist/portraits/composer.js';
import { DEFAULT_LAYER_MANIFEST } from '../dist/portraits/layerStack.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const layers4 = DEFAULT_LAYER_MANIFEST.layers; // subject/outfit/style/expression/format, all promptable
const layers2 = layers4.slice(0, 2); // subject + outfit
const layers6 = [
  ...layers4,
  { id: 'hair', label: 'Hair', promptable: true, boundary: 'Hair shape and color.' },
  { id: 'eyes', label: 'Eyes', promptable: true, boundary: 'Eye color and gaze.' },
];

// --- default manifest: every slot folds into its layer's overflow bucket. ---
const slots4 = {
  subject: { subject_identity: 'Rin V2', age: '20' },
  outfit: { outfit_style: 'red coat', accessories: 'silver brooch' },
  style: { style_style: 'VLZ hybrid' },
  expression: { expression_emotion: 'calm confidence' },
};
const out4 = compileTemplate(DEFAULT_LAYER_MANIFEST.template, slots4, layers4);
assert(
  out4 ===
    'A portrait of subject_identity: Rin V2, age: 20, wearing outfit_style: red coat, accessories: silver brooch, rendered in style_style: VLZ hybrid, with expression_emotion: calm confidence. Format: .',
  `composer: default-manifest overflow folding -> "${out4}"`,
);
assert(!out4.includes('{{'), 'composer: 4-layer output leaves no unresolved tokens');

// --- Partial placement: an explicitly placed slot is not also folded into overflow. ---
const outPartial = compileTemplate(
  'A portrait of {{subject_identity}}, wearing {{outfit_overflow}}.',
  { subject: { subject_identity: 'Rin V2', age: '20' }, outfit: { outfit_style: 'red coat' } },
  layers4,
);
assert(
  outPartial === 'A portrait of Rin V2, wearing outfit_style: red coat.',
  `composer: placed slot substituted, unplaced slot folds -> "${outPartial}"`,
);

// --- Empty placed value: substitutes '', never lands in overflow; the left-behind comma
//     run collapses (leading comma trimmed). ---
const outEmptyPlaced = compileTemplate(
  '{{subject_identity}}, {{subject_overflow}}',
  { subject: { subject_identity: '', age: '20' } },
  layers4,
);
assert(outEmptyPlaced === 'age: 20', `composer: empty placed slot + overflow collapse -> "${outEmptyPlaced}"`);

// --- Unknown token / unknown-layer overflow: left verbatim, never dropped. ---
const outUnknown = compileTemplate('A {{mystery_token}} portrait', slots4, layers4);
assert(outUnknown === 'A {{mystery_token}} portrait', `composer: unknown slot token left verbatim -> "${outUnknown}"`);
const outUnknownOverflow = compileTemplate('{{nope_overflow}}', slots4, layers4);
assert(outUnknownOverflow === '{{nope_overflow}}', `composer: unknown-layer overflow token left verbatim -> "${outUnknownOverflow}"`);

// --- Non-promptable layer: its overflow token is not special. ---
const layersWithNonPromptable = [
  ...layers4,
  { id: 'body', label: 'Body', promptable: false, boundary: 'Serving-bowl anatomy; never rendered into the prompt.' },
];
const outNonPromptable = compileTemplate('{{body_overflow}}', { body: { pose: 'standing' } }, layersWithNonPromptable);
assert(outNonPromptable === '{{body_overflow}}', `composer: non-promptable layer overflow token left verbatim -> "${outNonPromptable}"`);

// --- 2-layer manifest: same code path, no minimum layer count assumed. ---
const out2 = compileTemplate(
  'A portrait of {{subject_overflow}}, wearing {{outfit_overflow}}.',
  { subject: { subject_identity: 'Rin V2', age: '20' }, outfit: { outfit_style: 'red coat' } },
  layers2,
);
assert(
  out2 === 'A portrait of subject_identity: Rin V2, age: 20, wearing outfit_style: red coat.',
  `composer: 2-layer manifest compiles -> "${out2}"`,
);

// --- 6-layer manifest: every promptable layer's bucket folds; count is not hardcoded. ---
const slots6 = {
  subject: { subject_identity: 'Rin V2' },
  outfit: { outfit_style: 'linen shirt' },
  style: { style_style: 'VLZ hybrid' },
  expression: { expression_emotion: 'serene' },
  hair: { hair_style: 'shoulder-length' },
  eyes: { eye_color: 'amber' },
};
const out6 = compileTemplate(
  '{{subject_overflow}} | {{outfit_overflow}} | {{style_overflow}} | {{expression_overflow}} | {{hair_overflow}} | {{eyes_overflow}}',
  slots6,
  layers6,
);
assert(
  out6 ===
    'subject_identity: Rin V2 | outfit_style: linen shirt | style_style: VLZ hybrid | expression_emotion: serene | hair_style: shoulder-length | eye_color: amber',
  `composer: 6-layer manifest compiles -> "${out6}"`,
);

// --- Empty slots map: every bucket vanishes; prose skeleton collapses but never throws. ---
const outEmpty = compileTemplate('A portrait of {{subject_overflow}}, wearing {{outfit_overflow}}.', {}, layers4);
assert(!outEmpty.includes('subject_identity') && !outEmpty.includes('Rin V2'), `composer: empty slots leave no values behind -> "${outEmpty}"`);

// --- Purity: identical inputs, identical outputs (the recomposition contract). ---
const again4 = compileTemplate(DEFAULT_LAYER_MANIFEST.template, slots4, layers4);
assert(again4 === out4, 'composer: pure — identical inputs produce identical output');

// --- Double comma run left by two empty buckets collapses to ''. ---
const outEmptyRun = compileTemplate('{{subject_identity}}, {{subject_overflow}}', { subject: { subject_identity: '', age: '' } }, layers4);
assert(outEmptyRun === '', `composer: double comma run collapses fully -> "${outEmptyRun}"`);
