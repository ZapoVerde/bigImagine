/**
 * @file orchestrator/src/io/chatMemory/memoryInjection.ts
 * @stamp 2026-08-10
 * @architectural-role Pure Functions — CNZ-style per-component memory injection templates
 * @description
 * The reader-side half of the RP memory split (the user's 2026-08-13 direction): instead of one
 * monolithic `memory_recall` blob (bridge scene+events + plot threads + auto-recall fused into a
 * single string by buildChatMemorySystemPrompt), each component is its own marker slot in the
 * prompt stack — `bridge`, `plot_threads`, `auto_recall` — and each is rendered from a
 * user-editable prompt template exactly the way SillyTavern-Canonize renders its own injections
 * (rag/inject.js + core/summary-prompt.js): a "default + bespoke" settings key (bi_principles
 * §17, empty = built-in default) with `{{variable}}` substitution, including CNZ's `{{#if key}}
 * ... {{/if}}` conditional blocks so a template can be written that reads naturally whether or
 * not a component has content.
 *
 * The template syntax is deliberately CNZ's own `interpolate()` (defaults.js:43-50), not
 * util/interpolateMacros.ts — that module is a closed Stage-1 macro registry ({{char}}, {{user}}
 * ...) with an explicit no-`{{if}}` policy and would silently pass unknown tokens through. These
 * memory templates are a separate, tiny, purpose-built vocabulary ({{scene}}, {{events}}, {{plot}},
 * {{text}}, {{turn_range}}, {{header}}, {{char_name}}); a real `{{char}}` typed into one still
 * resolves later via the narrator stack's own interpolateMacros pass (buildNarratorStackItems
 * runs Stage-1 over the rendered item), so both vocabularies compose without conflict.
 *
 * `memory_recall` remains as a deprecated fused alias: a preset that still has that slot gets the
 * exact legacy block (buildChatMemorySystemPrompt's old join) so the builtin "Standard" preset
 * and any user preset that hasn't been migrated keep working byte-identically. New presets use
 * the three component markers and can order them independently in the stack. Note: a preset
 * should use `memory_recall` XOR the three components — the fused alias already contains
 * scene/events/plot/auto-recall, so enabling both would double-inject.
 *
 * @api-declaration
 * interpolateMemoryTemplate(template, vars) -> string — CNZ's interpolate: {{#if key}}...{{/if}}
 *   blocks first, then {{var}} substitution (empty for unknown). Pure.
 * renderBridge(scene, events, template) -> string — {{scene}}/{{events}} via the bridge template.
 * renderPlotThreads(arcs, template) -> string — {{plot}} = canonize-style HTML blocks, one
 *   `<{{arc_tag}}>` card per selected arc (entries blank-line separated inside the wrapper, the
 *   first + last-three reduction recallPlotLane already applied), via the plot template.
 * renderAutoRecall(chunks, facts, template, chunkTemplate, charName) -> string — chunk blocks
 *   rendered through the chunk template ({{text}}, {{turn_range}}, {{header}}, {{char_name}}),
 *   fact bullets appended as {{facts}}; the injection template receives {{text}} = chunk blocks,
 *   {{facts}} = fact bullets. Empty component => '' (so an enabled slot with no content emits
 *   nothing, same non-empty filter as every other marker).
 * renderFusedMemoryBlock(scene, events, arcs, autoRecallBlock) -> string — the deprecated
 *   memory_recall alias: byte-identical to the legacy buildChatMemorySystemPrompt join.
 * formatRecentHistoryTurns(messages, charName, userName) -> string — the live-window turns
 *   rendered as one `Name: content` line per message (deterministic, no IO or randomness), the
 *   {{turns}} value the recent_history marker renders (2026-08-10 user direction: the active
 *   context, last sent turn + active turns, lives INSIDE the stack inside the preset's own HTML
 *   tags; nothing is appended as messages after it).
 * renderRecentHistory(turns, charName, userName, template) -> string — the recent_history marker
 *   template ({{turns}}, {{char_name}}, {{user_name}}); default = bare {{turns}}.
 *
 * @contract
 *   assertions:
 *     purity:          pure (no IO, no state — templates and content are inputs)
 *     state_ownership: []
 *     external_io:     []
 */

import type { LlmMessage } from '../llm/types.js';

/** CNZ's interpolate() (SillyTavern-Canonize defaults.js) — {{#if key}}...{{/if}} conditionals
 *  first, then plain {{var}} substitution for the known vocabulary. One deliberate divergence:
 *  unknown `{{tokens}}` pass through unchanged rather than being blanked, so a Stage-1 macro like
 *  {{char}}/{{user}} typed into a memory template survives to the narrator stack's own
 *  interpolateMacros pass (buildNarratorStackItems runs Stage-1 over the rendered item), and a
 *  typo stays visible instead of silently vanishing — the same diagnosable-never-deleted policy
 *  util/interpolateMacros.ts itself follows. */
export function interpolateMemoryTemplate(template: string, vars: Record<string, string>): string {
  let result = template.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, key: string, inner: string) => (vars[key] ? inner : ''),
  );
  result = result.replace(/\{\{(\w+)\}\}/g, (_, key: string) => (key in vars ? vars[key] : `{{${key}}}`));
  return result;
}

/** DEFAULT_INJECT_BRIDGE_PROMPT — the bridge component (scene + events combined), CNZ's
 *  DEFAULT_CNZ_SUMMARY_TEMPLATE summary half verbatim (defaults.js:209-210 — "The following are
 *  upcoming events and a summary of what has just occurred:\n{{summary}}"), split into the two
 *  source rows BI stores separately. Canonize's summary var contains the EVENTS table first, then
 *  the SCENE prose (hookseeker PART 1 before PART 2), so {{events}} renders before {{scene}}. */
export const DEFAULT_INJECT_BRIDGE_PROMPT = `{{#if scene}}The following are upcoming events and a summary of what has just occurred:
{{events}}

{{scene}}{{/if}}`;

/** DEFAULT_INJECT_PLOT_PROMPT — the plot-threads component, CNZ's DEFAULT_CNZ_SUMMARY_TEMPLATE
 *  plot half verbatim (defaults.js:206-207 — "The following is a summary of the active plot
 *  threads:\n{{plot}}"). {{plot}} is pre-formatted per canonize's _formatPlotArcs +
 *  DEFAULT_CNZ_PLOT_CHUNK_TEMPLATE (defaults-rag.js:183-186): one
 *  `<{{arc_tag}}>\n{{text}}\n</{{arc_tag}}>` block per arc, joined by blank lines. */
export const DEFAULT_INJECT_PLOT_PROMPT = `{{#if plot}}The following is a summary of the active plot threads:
{{plot}}{{/if}}`;

/** DEFAULT_INJECT_AUTO_RECALL_PROMPT — the auto-recall wrapper, CNZ's DEFAULT_RAG_INJECTION_
 *  TEMPLATE verbatim (defaults-rag.js:174-176: "[The following are archived narrative memories
 *  retrieved for the current context:]\n{{text}}"), with BI's fact bullets appended after the
 *  chunk blocks ({{text}} = the chunk blocks, each rendered through the chunk template). */
export const DEFAULT_INJECT_AUTO_RECALL_PROMPT = `[The following are archived narrative memories retrieved for the current context:]
{{text}}{{#if facts}}

{{facts}}{{/if}}`;

/** DEFAULT_AUTO_RECALL_CHUNK_PROMPT — per-chunk template, CNZ's DEFAULT_RAG_CHUNK_TEMPLATE
 *  verbatim (defaults-rag.js:178-181). Like canonize's rag-fetch.js:202, the chunk summary is
 *  prefixed into the text as "[{{header}}]" (not an HTML comment) — {{header}} remains available
 *  for bespoke templates that want it elsewhere. */
export const DEFAULT_AUTO_RECALL_CHUNK_PROMPT = `<memory turns="{{turn_range}}">
{{text}}
</memory>`;

/** DEFAULT_INJECT_RECENT_HISTORY_PROMPT — the recent_history marker's template: bare {{turns}}.
 *  The turns are already fully rendered (formatRecentHistoryTurns) as `Name: content` lines, so
 *  the default just places them; a bespoke override can add a header or wrap them (the template
 *  also receives {{char_name}}/{{user_name}} for exactly that). The {{#if turns}} guard keeps an
 *  empty window from leaking a bare header — the stack's non-empty filter would drop the slot
 *  anyway, this just makes the template itself read naturally. */
export const DEFAULT_INJECT_RECENT_HISTORY_PROMPT = `{{#if turns}}{{turns}}{{/if}}`;

/** The structured RP memory context — what buildChatMemorySystemPrompt's rp branch returns so the
 *  narrator stack can render each component marker from its own template (and the deprecated
 *  memory_recall alias from the pre-rendered fused block). */
export interface RpMemoryContext {
  scene?: string;
  events?: string;
  plotThreads: PlotArcCard[];
  chunks: ChunkRow[];
  facts: FactRow[];
  /** The legacy fused block (renderFusedMemoryBlock over the parts) — the deprecated
   *  memory_recall alias, and the no-preset fallback string. */
  fused: string;
}

/** One ranked plot-arc card (io/chatMemory/recallPlotLane.ts, docs/plans/plot-arc-recall-plan.md)
 *  — replaces the old single-row-per-arc PlotArcRow: each selected arc carries its full card
 *  history reduced to first entry + last three entries (recallPlotLane.reduceArcEntries), so the
 *  renderer shows a per-arc card, not one latest line. `detail` is non-optional-empty-string on
 *  each entry — matches the canon_facts.detail column's own `not null default ''` shape; no new
 *  optionality introduced. */
export interface PlotArcCard {
  arc_tag: string;
  entries: { summary: string; detail: string }[];
}

export interface ChunkRow {
  ordinal: number;
  summary: string;
  content: string;
}

export interface FactRow {
  category: string;
  summary: string;
  detail?: string | null;
}

export function renderBridge(scene: string | undefined, events: string | undefined, template = DEFAULT_INJECT_BRIDGE_PROMPT): string {
  return interpolateMemoryTemplate(template, { scene: scene ?? '', events: events ?? '' });
}

/** Render the plot-threads component — {{plot}} = one `<{{arc_tag}}>` card per selected arc,
 *  each card's entries blank-line separated inside the wrapper (first entry + last three, already
 *  reduced by recallPlotLane.reduceArcEntries). Single-entry arcs render byte-identically to the
 *  pre-card shape (`<arc_tag>\nsummary — detail\n</arc_tag>`). */
export function renderPlotThreads(arcs: PlotArcCard[], template = DEFAULT_INJECT_PLOT_PROMPT): string {
  const plot = arcs
    .map((a) => `<${a.arc_tag}>\n${a.entries.map((e) => `${e.summary}${e.detail ? ` — ${e.detail}` : ''}`).join('\n\n')}\n</${a.arc_tag}>`)
    .join('\n\n');
  return interpolateMemoryTemplate(template, { plot });
}

export function renderAutoRecall(
  chunks: ChunkRow[],
  facts: FactRow[],
  template = DEFAULT_INJECT_AUTO_RECALL_PROMPT,
  chunkTemplate = DEFAULT_AUTO_RECALL_CHUNK_PROMPT,
  charName = '',
): string {
  // Nothing to inject — return '' so an enabled slot emits nothing (the non-empty filter every
  // marker shares). The template's static prefix would otherwise leak a bare header.
  if (chunks.length === 0 && facts.length === 0) return '';
  const text = chunks
    .map((c) => {
      // Canonize rag-fetch.js:202 prefixes the chunk summary into the text as "[header]\n"
      // (its chunk template has no header slot of its own) — {{header}} still substitutes
      // for bespoke templates that place it elsewhere.
      const content = c.summary ? `[${c.summary}]\n${c.content}` : c.content;
      return interpolateMemoryTemplate(chunkTemplate, {
        text: content,
        turn_range: String(c.ordinal),
        header: c.summary ?? '',
        char_name: charName,
      });
    })
    .join('\n\n');
  const factBlock = facts.map((f) => `- [${f.category}] ${f.summary}${f.detail ? ` — ${f.detail}` : ''}`).join('\n');
  return interpolateMemoryTemplate(template, { text, facts: factBlock });
}

/** The recent_history marker's {{turns}} value — the live-window messages rendered as one
 *  `Name: content` line per message, in order, joined by blank lines. Deterministic (identical
 *  window => identical bytes => the stack's stable prefix survives) and as-is (an
 *  empty-content turn renders as just the speaker line — the 2026-08-10 user direction: "send it
 *  as it is"; the stack is robust enough to provoke a good response). assistant -> charName,
 *  user -> userName, any other role (system/tool) -> the role name verbatim. */
export function formatRecentHistoryTurns(messages: LlmMessage[], charName: string, userName: string): string {
  return messages
    .map((m) => {
      const speaker = m.role === 'assistant' ? charName : m.role === 'user' ? userName : m.role;
      return `${speaker || m.role}: ${m.content}`;
    })
    .join('\n\n');
}

/** The recent_history marker — {{turns}} (the pre-rendered turn lines), {{char_name}}/{{user_name}}
 *  for bespoke templates. Empty-string override = built-in default (the platform's §17 contract,
 *  same `|| undefined` as the bridge/plot/auto-recall templates). */
export function renderRecentHistory(
  turns: string,
  charName: string,
  userName: string,
  template = DEFAULT_INJECT_RECENT_HISTORY_PROMPT,
): string {
  return interpolateMemoryTemplate(template, { turns, char_name: charName, user_name: userName });
}

/** The deprecated `memory_recall` alias — byte-identical to buildChatMemorySystemPrompt's legacy
 *  rp join (scene header, events header, plot threads, then the auto-recall block), so presets
 *  that still carry a memory_recall slot behave exactly as before. Plot arcs render as one bullet
 *  per entry (`- #arc: summary — detail`) — a single-entry arc is byte-identical to the pre-card
 *  shape; a multi-entry arc lists its card's entries as separate bullets under the shared tag. */
export function renderFusedMemoryBlock(
  scene: string | undefined,
  events: string | undefined,
  arcs: PlotArcCard[],
  autoRecallBlock: string,
): string {
  const parts: string[] = [];
  if (scene) parts.push(`Scene so far (evolves each sync — call recall_chat_history for exact recent wording):\n${scene}`);
  if (events) parts.push(`Upcoming scheduled events:\n${events}`);
  if (arcs.length) {
    parts.push(
      `Open plot threads:\n${arcs
        .flatMap((a) => a.entries.map((e) => `- #${a.arc_tag}: ${e.summary}${e.detail ? ` — ${e.detail}` : ''}`))
        .join('\n')}`,
    );
  }
  if (autoRecallBlock) parts.push(autoRecallBlock);
  return parts.join('\n\n');
}
