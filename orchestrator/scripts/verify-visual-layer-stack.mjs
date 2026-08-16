// Proves studio-character-bridge-plan.md Part D's layer-stack additions against the pure
// layerStack.ts / composer.ts modules — no pool, no server, no LLM (the plan's "pure manifest
// checks" carve-out):
//   - DEFAULT_LAYER_MANIFEST carries the fifth `format` layer (id 'format', label 'Format',
//     promptable), added by Part D so composition/shot-type/transparency intent has a home
//     outside the style layer, with a boundary naming what belongs there and what doesn't;
//   - the default template references the `{{format_overflow}}` token, so a format layer's
//     unplaced slots fold into the compiled prompt;
//   - parseLayerManifest round-trips a manifest that includes `format`, and unset/corrupt/
//     subject-less values still fall back to the built-in default (which includes it);
//   - getPromptableLayers includes format — it reaches candidate chromosomes;
//   - compileTemplate actually resolves a format slot through the overflow token, and an empty
//     format bucket vanishes the token (no dangling "Format:").

import { compileTemplate } from '../dist/portraits/composer.js';
import { DEFAULT_LAYER_MANIFEST, getPromptableLayers, parseLayerManifest } from '../dist/portraits/layerStack.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const format = DEFAULT_LAYER_MANIFEST.layers.find((l) => l.id === 'format');
assert(format !== undefined, 'DEFAULT_LAYER_MANIFEST includes a `format` layer (Part D)');
assert(format.label === 'Format' && format.promptable === true, "the format layer is labeled 'Format' and is promptable");
assert(format.boundary.length > 0, 'the format layer has boundary prose (composition/shot-type; not appearance, not outfit, not style)');

assert(DEFAULT_LAYER_MANIFEST.template.includes('{{format_overflow}}'), 'the default template references the {{format_overflow}} token');

assert(parseLayerManifest('') === DEFAULT_LAYER_MANIFEST, 'an unset/empty stored manifest falls back to the default — which includes format');
assert(parseLayerManifest('{not json') === DEFAULT_LAYER_MANIFEST, 'corrupt JSON falls back to the default manifest');
assert(
  parseLayerManifest(JSON.stringify({ layers: [{ id: 'format', label: 'Format', promptable: true, boundary: 'b' }], template: '{{format_overflow}}' })) === DEFAULT_LAYER_MANIFEST,
  'a manifest without a subject layer is treated as corrupt → default (the subject anchor rule)',
);

const custom = {
  layers: [
    ...DEFAULT_LAYER_MANIFEST.layers,
    { id: 'bg', label: 'Background', promptable: true, boundary: 'The backdrop behind the subject.' },
  ],
  template: '{{subject_overflow}} / {{format_overflow}}',
};
const parsed = parseLayerManifest(JSON.stringify(custom));
assert(parsed !== DEFAULT_LAYER_MANIFEST, 'a custom manifest round-trips as itself, not the default');
assert(parsed.layers.some((l) => l.id === 'format') && parsed.layers.some((l) => l.id === 'bg'), 'a round-tripped manifest keeps the format layer (and any added layer) intact');
assert(parsed.template.includes('{{format_overflow}}'), 'the round-tripped template keeps the {{format_overflow}} token');

assert(getPromptableLayers(DEFAULT_LAYER_MANIFEST).some((l) => l.id === 'format'), 'format is promptable → it reaches candidate chromosomes');

const compiled = compileTemplate(
  'A portrait of {{subject_overflow}}, wearing {{outfit_overflow}}, rendered in {{style_overflow}}, with {{expression_overflow}}. Format: {{format_overflow}}.',
  {
    subject: { subject_identity: 'Rin' },
    outfit: { outfit_style: 'red coat' },
    style: { style_style: 'VLZ hybrid' },
    expression: { expression_emotion: 'calm' },
    format: { format_framing: 'bust shot, transparent background' },
  },
  DEFAULT_LAYER_MANIFEST.layers,
);
assert(compiled.includes('Format: format_framing: bust shot, transparent background'), 'compileTemplate folds a format layer\'s slot into the {{format_overflow}} bucket (name: value)');

const noFormat = compileTemplate(
  'A portrait of {{subject_overflow}}. Format: {{format_overflow}}.',
  { subject: { subject_identity: 'Rin' } },
  DEFAULT_LAYER_MANIFEST.layers,
);
assert(!noFormat.includes('format_overflow'), 'an empty format bucket resolves the token away — nothing leaks into the prompt');

if (process.exitCode) {
  console.error('\nlayer stack verification FAILED');
  process.exit(1);
}
console.log('\nlayer stack verification passed');