// Proves io/chatMemory/memoryInjection.ts in isolation — the pure template renderers for the three
// RP memory component markers (bridge / plot_threads / auto_recall) plus the deprecated fused
// memory_recall alias. The templates are CNZ-style {{var}}/{{#if}} interpolation; each renderer
// returns '' when its component has no content so an enabled slot with nothing to say emits nothing.
import {
  interpolateMemoryTemplate,
  renderBridge,
  renderPlotThreads,
  renderAutoRecall,
  renderFusedMemoryBlock,
  DEFAULT_INJECT_BRIDGE_PROMPT,
  DEFAULT_INJECT_PLOT_PROMPT,
  DEFAULT_INJECT_AUTO_RECALL_PROMPT,
  DEFAULT_AUTO_RECALL_CHUNK_PROMPT,
} from '../dist/io/chatMemory/memoryInjection.js';

function assert(cond, message) {
  if (!cond) throw new Error(`FAIL: ${message}`);
  console.log(`ok: ${message}`);
}

// --- interpolateMemoryTemplate: {{var}} + {{#if}} ---
{
  const out = interpolateMemoryTemplate('A {{scene}} B', { scene: 'x' });
  assert(out === 'A x B', '{{var}} substitutes; unknown vars become empty');
}
{
  const out = interpolateMemoryTemplate('{{#if events}}E: {{events}}{{/if}}', { events: '' });
  assert(out === '', '{{#if}} with empty var renders nothing');
}
{
  const out = interpolateMemoryTemplate('{{#if events}}E: {{events}}{{/if}}', { events: 'soon' });
  assert(out === 'E: soon', '{{#if}} with non-empty var renders its inner block');
}
{
  const out = interpolateMemoryTemplate('{{unknown}}', {});
  assert(out === '{{unknown}}', 'unknown plain var passes through unchanged (so {{char}}/{{user}} survive to Stage-1)');
}
{
  const out = interpolateMemoryTemplate('Hi {{char}}! {{scene}}', { scene: 'kitchen' });
  assert(out === 'Hi {{char}}! kitchen', 'known vars substitute, unknown Stage-1 macros pass through');
}

// --- renderBridge: scene + events via the bridge template ---
{
  const out = renderBridge('The kitchen.', 'Dinner at 7.', DEFAULT_INJECT_BRIDGE_PROMPT);
  assert(
    out.includes('The following is a summary of what has just occurred:\nThe kitchen.') &&
      out.includes('The following are upcoming events:\nDinner at 7.'),
    'default bridge template renders scene and events sections',
  );
}
{
  const out = renderBridge(undefined, undefined, DEFAULT_INJECT_BRIDGE_PROMPT);
  assert(out === '', 'empty bridge renders empty (slot emits nothing)');
}
{
  const out = renderBridge('The kitchen.', undefined, DEFAULT_INJECT_BRIDGE_PROMPT);
  assert(!out.includes('upcoming events') && out.includes('The kitchen.'), '{{#if events}} drops the events section when absent');
}
{
  const custom = 'LOCATION: {{scene}}\nNEXT: {{events}}';
  const out = renderBridge('The kitchen.', 'Dinner.', custom);
  assert(out === 'LOCATION: The kitchen.\nNEXT: Dinner.', 'bespoke bridge template renders with {{scene}}/{{events}}');
}

// --- renderPlotThreads: per-arc lines through the plot template ---
{
  const out = renderPlotThreads(
    [
      { arc_tag: 'a1', summary: 'Find the key', detail: 'the vault' },
      { arc_tag: 'a2', summary: 'Pay the debt' },
    ],
    DEFAULT_INJECT_PLOT_PROMPT,
  );
  assert(
    out.includes('The following is a summary of the active plot threads:') &&
      out.includes('- #a1: Find the key — the vault') &&
      out.includes('- #a2: Pay the debt'),
    'default plot template renders one "- #arc: summary — detail" line per arc',
  );
}
{
  const out = renderPlotThreads([], DEFAULT_INJECT_PLOT_PROMPT);
  assert(out === '', 'empty plot renders empty');
}

// --- renderAutoRecall: chunk blocks + facts through injection + chunk templates ---
{
  const out = renderAutoRecall(
    [{ ordinal: 7, summary: 'turns 6-8', content: 'User: x\nAssistant: y' }],
    [{ category: 'plot', summary: 'The key is in the vault' }],
    DEFAULT_INJECT_AUTO_RECALL_PROMPT,
    DEFAULT_AUTO_RECALL_CHUNK_PROMPT,
    'Bostaff',
  );
  assert(
    out.startsWith('[The following are archived narrative memories retrieved for the current context:]') &&
      out.includes('<memory turns="7">\nUser: x\nAssistant: y\n</memory>'),
    'default auto-recall template wraps chunk blocks in <memory turns>',
  );
  assert(out.includes('- [plot] The key is in the vault'), 'facts render as bullet lines in the injection template');
}
{
  const out = renderAutoRecall([], [], DEFAULT_INJECT_AUTO_RECALL_PROMPT, DEFAULT_AUTO_RECALL_CHUNK_PROMPT, '');
  assert(out === '', 'empty auto-recall renders empty');
}
{
  const out = renderAutoRecall(
    [{ ordinal: 3, summary: '', content: 'Body' }],
    [],
    '[Chunks]\n{{text}}',
    'T{{turn_range}} C{{char_name}} H{{header}}: {{text}}',
    'Runny',
  );
  assert(
    out === '[Chunks]\nT3 CRunny H: Body',
    'bespoke chunk template gets {{turn_range}}, {{char_name}}, {{header}}, {{text}}',
  );
}

// --- Empty-string template = built-in default (the platform's "default + bespoke" contract, the
// same `'' || DEFAULT` shape the digest prompts use — an empty override must NOT render empty). ---
{
  const empty = '';
  assert(
    renderBridge('The kitchen.', undefined, empty || undefined) ===
      renderBridge('The kitchen.', undefined, undefined),
    "empty bridge override falls back to the built-in default ('' || undefined)",
  );
  assert(
    renderAutoRecall([{ ordinal: 1, summary: '', content: 'x' }], [], '' || undefined, '' || undefined, '') !== '',
    "empty auto-recall/chunk overrides fall back to the built-in defaults and still render",
  );
}

// --- renderFusedMemoryBlock: the deprecated memory_recall alias, legacy byte shape ---
{
  const out = renderFusedMemoryBlock(
    'The kitchen.',
    'Dinner at 7.',
    [{ arc_tag: 'a1', summary: 'Find the key', detail: 'the vault' }],
    'Recalled from earlier in this conversation (archived):\n<memory turns="7">\nx\n</memory>',
  );
  assert(
    out.startsWith('Scene so far (evolves each sync — call recall_chat_history for exact recent wording):\nThe kitchen.') &&
      out.includes('Upcoming scheduled events:\nDinner at 7.') &&
      out.includes('Open plot threads:\n- #a1: Find the key — the vault') &&
      out.includes('Recalled from earlier in this conversation (archived):'),
    'fused alias joins scene/events/plot/auto-recall with the legacy headers',
  );
}
{
  const out = renderFusedMemoryBlock(undefined, undefined, [], '');
  assert(out === '', 'fully empty fused block renders empty');
}

console.log('\nAll memoryInjection checks passed.');
