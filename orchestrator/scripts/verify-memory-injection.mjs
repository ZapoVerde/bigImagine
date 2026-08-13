// Proves io/chatMemory/memoryInjection.ts in isolation — the pure template renderers for the RP
// memory component markers (bridge / plot_threads / auto_recall / recent_history) plus the
// deprecated fused memory_recall alias. The templates are CNZ-style {{var}}/{{#if}} interpolation;
// each renderer returns '' when its component has no content so an enabled slot with nothing to
// say emits nothing.
import {
  interpolateMemoryTemplate,
  renderBridge,
  renderPlotThreads,
  renderAutoRecall,
  renderFusedMemoryBlock,
  formatRecentHistoryTurns,
  renderRecentHistory,
  DEFAULT_INJECT_BRIDGE_PROMPT,
  DEFAULT_INJECT_PLOT_PROMPT,
  DEFAULT_INJECT_AUTO_RECALL_PROMPT,
  DEFAULT_AUTO_RECALL_CHUNK_PROMPT,
  DEFAULT_INJECT_RECENT_HISTORY_PROMPT,
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
    out.includes('The following are upcoming events and a summary of what has just occurred:\nDinner at 7.\n\nThe kitchen.'),
    'default bridge template renders the exact canonize summary header with events first, then scene (CNZ defaults.js:209-210)',
  );
}
{
  const out = renderBridge(undefined, undefined, DEFAULT_INJECT_BRIDGE_PROMPT);
  assert(out === '', 'empty bridge renders empty (slot emits nothing)');
}
{
  const out = renderBridge('The kitchen.', undefined, DEFAULT_INJECT_BRIDGE_PROMPT);
  assert(
    out.includes('The following are upcoming events and a summary of what has just occurred:') &&
      out.includes('The kitchen.') && !out.includes('Dinner'),
    'scene-only bridge keeps the canonize header (CNZ guards on {{summary}}, not the table alone)',
  );
}
{
  const custom = 'LOCATION: {{scene}}\nNEXT: {{events}}';
  const out = renderBridge('The kitchen.', 'Dinner.', custom);
  assert(out === 'LOCATION: The kitchen.\nNEXT: Dinner.', 'bespoke bridge template renders with {{scene}}/{{events}}');
}

// --- renderPlotThreads: per-arc <arc_tag> cards through the plot template ---
{
  const out = renderPlotThreads(
    [
      { arc_tag: 'a1', entries: [{ summary: 'Find the key', detail: 'the vault' }] },
      { arc_tag: 'a2', entries: [{ summary: 'Pay the debt', detail: '' }] },
    ],
    DEFAULT_INJECT_PLOT_PROMPT,
  );
  assert(
    out.includes('The following is a summary of the active plot threads:') &&
      out.includes('<a1>\nFind the key — the vault\n</a1>') &&
      out.includes('<a2>\nPay the debt\n</a2>'),
    'default plot template renders canonize-style <arc_tag> blocks (CNZ DEFAULT_CNZ_PLOT_CHUNK_TEMPLATE); a single-entry card is byte-identical to the pre-card shape',
  );
}
{
  // A multi-entry card renders all entries blank-line separated inside ONE <arc_tag> wrapper
  // (the first + last-three reduction was already applied by recallPlotLane).
  const out = renderPlotThreads(
    [{ arc_tag: 'a1', entries: [{ summary: 'The heist', detail: 'planned for Tuesday' }, { summary: 'The vault broke open', detail: '' }] }],
    DEFAULT_INJECT_PLOT_PROMPT,
  );
  assert(
    out.includes('<a1>\nThe heist — planned for Tuesday\n\nThe vault broke open\n</a1>'),
    'an arc with 2 entries renders both inside one <arc_tag> wrapper, blank-line separated',
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
      out.includes('<memory turns="7">\n[turns 6-8]\nUser: x\nAssistant: y\n</memory>') &&
      !out.includes('<!--'),
    'default auto-recall chunk template is CNZ verbatim (<memory turns>) with the summary prefixed as [header] inside the block (rag-fetch.js:202), no HTML comment',
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

// --- formatRecentHistoryTurns + renderRecentHistory: the active-context marker ---
{
  const turns = formatRecentHistoryTurns(
    [
      { role: 'user', content: 'What is the key?' },
      { role: 'assistant', content: 'Under the vault.' },
      { role: 'user', content: '' }, // empty content => bare speaker line, "send it as it is"
    ],
    'Ava',
    'Me',
  );
  assert(
    turns === 'Me: What is the key?\n\nAva: Under the vault.\n\nMe: ',
    'formatRecentHistoryTurns renders one "Name: content" line per message, joined by blank lines, as-is for empty content',
  );
}
{
  const turns = formatRecentHistoryTurns(
    [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'result' },
    ],
    'Ava',
    'Me',
  );
  assert(
    turns === 'Me: hi\n\ntool: result',
    'non-assistant/user roles render the role name verbatim as the speaker',
  );
}
{
  const out = renderRecentHistory('Me: hi\n\nAva: hi!', 'Ava', 'Me', DEFAULT_INJECT_RECENT_HISTORY_PROMPT);
  assert(out === 'Me: hi\n\nAva: hi!', 'default recent_history template renders the pre-rendered turns bare');
}
{
  const out = renderRecentHistory('Me: hi', 'Ava', 'Me', '<history>\n{{turns}}\n</history>');
  assert(
    out === '<history>\nMe: hi\n</history>',
    'bespoke template can wrap the turns in the preset author\'s own HTML tags',
  );
}
{
  const out = renderRecentHistory('Me: hi', 'Ava', 'Me', '{{char_name}} speaks to {{user_name}}: {{turns}}');
  assert(
    out === 'Ava speaks to Me: Me: hi',
    'bespoke template can use {{char_name}}/{{user_name}} alongside {{turns}}',
  );
}
{
  const out = renderRecentHistory('Me: hi', 'Ava', 'Me', '' || undefined);
  assert(out !== '', `empty override falls back to the built-in default ('' || undefined)`);
}

// --- renderFusedMemoryBlock: the deprecated memory_recall alias, legacy byte shape ---
{
  const out = renderFusedMemoryBlock(
    'The kitchen.',
    'Dinner at 7.',
    [{ arc_tag: 'a1', entries: [{ summary: 'Find the key', detail: 'the vault' }] }],
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
  // A multi-entry card lists its entries as separate bullets under the shared tag.
  const out = renderFusedMemoryBlock(
    undefined,
    undefined,
    [{ arc_tag: 'a1', entries: [{ summary: 'First', detail: '' }, { summary: 'Second', detail: 'more' }] }],
    '',
  );
  assert(
    out === 'Open plot threads:\n- #a1: First\n- #a1: Second — more',
    'fused alias renders each card entry as its own bullet under the arc tag',
  );
}
{
  const out = renderFusedMemoryBlock(undefined, undefined, [], '');
  assert(out === '', 'fully empty fused block renders empty');
}

console.log('\nAll memoryInjection checks passed.');
