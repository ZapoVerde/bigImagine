// Proves util/synthesizeImagePrompt.ts (endpoint.md §4): the Master Image Prompt Template expands
// deterministically against a location's visual description + environment, missing macros become
// empty strings, unknown macros stay verbatim, the default template is used when no override is
// set, and the negative prompt passes straight through.

import { synthesizeImagePrompt, DEFAULT_IMAGE_PROMPT_TEMPLATE } from '../dist/util/synthesizeImagePrompt.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// Full expansion of every macro.
{
  const { positive, negative } = synthesizeImagePrompt({
    template: '{{style_prefix}} {{visual_description}} at {{time_of_day}}, {{weather}}, {{mood}}, {{lighting}}',
    visualDescription: 'a mossy forest clearing',
    environment: { time_of_day: 'dusk', weather: 'light rain', mood: 'eerie', lighting: 'dim' },
    stylePrefix: 'Cinematic, 8k',
    negativePrompt: 'blurry, low quality',
  });
  assert(
    positive === 'Cinematic, 8k a mossy forest clearing at dusk, light rain, eerie, dim',
    'every known macro expands in place',
  );
  assert(negative === 'blurry, low quality', 'the master negative prompt passes through untouched');
}

// Missing environment fields become empty strings, not "undefined" — the template still reads
// cleanly when a location has no weather/mood/lighting recorded.
{
  const { positive } = synthesizeImagePrompt({
    template: '{{visual_description}} | {{weather}} | {{mood}} | {{lighting}}',
    visualDescription: 'a stone tavern',
    environment: { time_of_day: 'noon' },
    stylePrefix: '',
    negativePrompt: '',
  });
  assert(positive === 'a stone tavern |  |  | ', 'missing environment fields expand to empty strings');
}

// Unknown macros stay verbatim — a typo is visible in the output, not silently dropped.
{
  const { positive } = synthesizeImagePrompt({
    template: '{{visual_description}} {{typo_macro}}',
    visualDescription: 'x',
    environment: {},
    stylePrefix: '',
    negativePrompt: '',
  });
  assert(positive === 'x {{typo_macro}}', 'unknown macros are left untouched so a typo is diagnosable');
}

// An empty override falls back to the built-in default (bi_principles.md §18).
{
  const { positive } = synthesizeImagePrompt({
    template: '',
    visualDescription: 'the harbor at night',
    environment: { time_of_day: 'night' },
    stylePrefix: 'Watercolor',
    negativePrompt: '',
  });
  assert(
    positive === DEFAULT_IMAGE_PROMPT_TEMPLATE
      .replace('{{style_prefix}}', 'Watercolor')
      .replace('{{visual_description}}', 'the harbor at night')
      .replace('{{time_of_day}}', 'night')
      .replace('{{weather}}', '')
      .replace('{{mood}}', ''),
    'an empty template falls back to DEFAULT_IMAGE_PROMPT_TEMPLATE and expands against it',
  );
}

// Determinism — the same inputs always produce the same output (the pure-function contract that
// makes cache-first rendering safe, endpoint.md §4 / bi_principles.md §17).
{
  const input = {
    template: '{{style_prefix}} {{visual_description}} {{time_of_day}}',
    visualDescription: 'the library',
    environment: { time_of_day: 'morning' },
    stylePrefix: 'Studio',
    negativePrompt: 'n1',
  };
  const a = synthesizeImagePrompt(input);
  const b = synthesizeImagePrompt(input);
  assert(a.positive === b.positive && a.negative === b.negative, 'synthesizeImagePrompt is deterministic for identical inputs');
}

if (process.exitCode) {
  console.error('\nsynthesize image prompt verification FAILED');
  process.exit(1);
}
console.log('\nsynthesize image prompt verification passed');
