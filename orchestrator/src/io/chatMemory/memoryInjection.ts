/**
 * @file orchestrator/src/io/chatMemory/memoryInjection.ts
 * @stamp 2026-08-21
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
 * renderAutoRecall(chunks, facts, template, chunkTemplate, leadInTemplate, charName) -> string —
 *   chunk blocks rendered through the chunk template ({{text}}, {{turn_range}}, {{header}},
 *   {{char_name}}), lead-in entries through the lead-in template ({{text}} = summary alone),
 *   named fact records (renderFact) appended as {{facts}}; the injection template receives
 *   {{text}} = chunk blocks, {{facts}} = the fact records. Empty component => '' (so an enabled
 *   slot with no content emits nothing, same non-empty filter as every other marker).
 * renderFact(fact) -> string — a single canon_facts row as a named record: `<{{category}}
 *   name="{{detail}}">\n{{summary}}\n</{{category}}>` (the curator write path stores the entry's
 *   content in `summary` and its human-facing name in `detail` — chatMemorySync.ts's three
 *   canon_facts inserts all embed `${name}\n${content}` and write `summary = content,
 *   detail = name`, for every category including 'plot'). `detail` empty/absent => an unnamed
 *   `<{{category}}>` wrapper, never a dropped fact or an invented name. Shared by renderAutoRecall
 *   here and recallForPrompt.ts's formatAutoRecallBlock (the memory_recall preset's legacy fused
 *   renderer) so a canon fact reads the same named way regardless of which preset is active.
 * renderSyncSummaries(rows, template, entryTemplate, chunkTemplate, charName) -> string — the
 *   sync_summaries component (docs/plans/completed/sync-summaries-plan.md): a bare row renders through
 *   the lightweight entry template ({{text}} = its summary); an inflated row (content attached
 *   by recallForPrompt.ts's merge) renders through the SAME chunk template auto_recall uses,
 *   with the same [{{header}}]\n{{text}} composition — identical "what does a full recalled
 *   chunk look like" concept, no duplicated vocabulary (bi_principles.md §17).
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
import type { SyncSummaryRow } from './recallSyncSummaryLane.js';

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

/** DEFAULT_AUTO_RECALL_LEAD_IN_PROMPT — the per-entry template for a lead-in chunk
 *  (docs/plans/chunk-lead-in-context-plan.md §17: a real, user-overridable template, not a
 *  hardcoded string). A lead-in entry only ever carries a summary, so this is a lighter wrapper
 *  than the full chunk template — {{text}} is the summary itself. The live value is the
 *  chat_memory_auto_recall_lead_in_prompt setting (migration 0100), read by promptAssembly.ts. */
export const DEFAULT_AUTO_RECALL_LEAD_IN_PROMPT = `[Just before: {{text}}]`;

/** DEFAULT_INJECT_SYNC_SUMMARIES_PROMPT — the sync_summaries wrapper
 *  (docs/plans/completed/sync-summaries-plan.md Step 3): {{#if text}}...{{/if}}, the same
 *  empty-collapses-to-nothing shape as DEFAULT_INJECT_AUTO_RECALL_PROMPT — an enabled slot
 *  with nothing in the sync window emits nothing. {{text}} = the entry blocks (bare summaries
 *  or inflated full chunks), each already rendered through its per-entry template. The live
 *  value is the chat_memory_inject_sync_summaries_prompt setting (migration 0104), read by
 *  promptAssembly.ts. */
export const DEFAULT_INJECT_SYNC_SUMMARIES_PROMPT = `{{#if text}}[The following are recent turns not yet folded into the story summary:]
{{text}}{{/if}}`;

/** DEFAULT_SYNC_SUMMARY_ENTRY_PROMPT — the per-entry template for a BARE sync-summary row
 *  (a chunk waiting for the bridge tick that RAG did not also select): a lightweight wrapper,
 *  {{text}} = the chunk's summary. Its own setting (chat_memory_sync_summary_entry_prompt,
 *  migration 0104), NOT a reuse of chat_memory_auto_recall_lead_in_prompt — lead-ins are
 *  reserved for auto_recall's deep-archive picks only, and this entry's summary is the chunk's
 *  own header, not a "just before" predecessor. An inflated row (content attached by the
 *  recallForPrompt.ts merge) skips this template and renders through the auto-recall chunk
 *  template instead. */
export const DEFAULT_SYNC_SUMMARY_ENTRY_PROMPT = `[{{text}}]`;

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
  /** The open-sync-point rows (docs/plans/completed/sync-summaries-plan.md) — every chunk archived
   *  since the chat's last bridge update, as bare summaries; a row RAG also selected carries
   *  its full content (inflated by recallForPrompt.ts's merge) and is absent from `chunks`. */
  syncSummaries: SyncSummaryRow[];
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
  /** True only for lead-in entries produced by the recallForPrompt.ts merge
   *  (docs/plans/chunk-lead-in-context-plan.md) — rendered from summary alone under the lighter
   *  lead-in template, never from content (which is empty for such an entry). Falsy/absent for
   *  every lane-fetched chunk, so existing call sites and templates are unaffected. */
  isLeadIn?: boolean;
}

export interface FactRow {
  category: string;
  summary: string;
  detail?: string | null;
}

function escapeFactName(name: string): string {
  return name.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A single canon fact as a named record — the entry's `detail` (its human-facing name, per the
 *  curator write path — see this file's @api-declaration) becomes the wrapper's `name` attribute,
 *  its `summary` (the entry's actual content) becomes the body, and its `category` becomes the
 *  tag itself ('person' | 'place' | 'thing' | 'concept' | 'plot' — every value canon_facts.category
 *  allows renders the same way, no special-casing). A missing/empty `detail` renders an unnamed
 *  wrapper rather than dropping the fact or inventing a name — old rows predating this convention
 *  stay readable. */
export function renderFact(f: FactRow): string {
  const tag = f.category;
  const nameAttr = f.detail ? ` name="${escapeFactName(f.detail)}"` : '';
  return `<${tag}${nameAttr}>\n${f.summary}\n</${tag}>`;
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
  leadInTemplate = DEFAULT_AUTO_RECALL_LEAD_IN_PROMPT,
  charName = '',
): string {
  // Nothing to inject — return '' so an enabled slot emits nothing (the non-empty filter every
  // marker shares). The template's static prefix would otherwise leak a bare header.
  if (chunks.length === 0 && facts.length === 0) return '';
  const text = chunks
    .map((c) => {
      // A lead-in entry (recallForPrompt.ts merge, docs/plans/chunk-lead-in-context-plan.md)
      // carries no content — {{text}} renders as the summary alone under the lead-in template.
      if (c.isLeadIn) {
        return interpolateMemoryTemplate(leadInTemplate, {
          text: c.summary,
          turn_range: String(c.ordinal),
          header: c.summary,
          char_name: charName,
        });
      }
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
  const factBlock = facts.map((f) => renderFact(f)).join('\n\n');
  return interpolateMemoryTemplate(template, { text, facts: factBlock });
}

/** Render the sync_summaries component (docs/plans/completed/sync-summaries-plan.md) — every chunk under
 *  the chat's open sync point (archived since the last bridge tick). A BARE row (RAG did not
 *  also select it) renders through the lightweight entry template with {{text}} = its summary.
 *  An INFLATED row (content attached by the recallForPrompt.ts merge) renders through the SAME
 *  chunkTemplate auto_recall uses, with the same `[{{header}}]\n{{text}}` composition
 *  renderAutoRecall applies to a normal full chunk — identical "what does a full recalled chunk
 *  look like" concept, so reuse avoids a redundant setting (bi_principles.md §17's
 *  "default + bespoke" pattern, not duplicated vocabulary). Empty rows => '' (an enabled slot
 *  with nothing in the sync window emits nothing). */
export function renderSyncSummaries(
  rows: SyncSummaryRow[],
  template = DEFAULT_INJECT_SYNC_SUMMARIES_PROMPT,
  entryTemplate = DEFAULT_SYNC_SUMMARY_ENTRY_PROMPT,
  chunkTemplate = DEFAULT_AUTO_RECALL_CHUNK_PROMPT,
  charName = '',
): string {
  if (rows.length === 0) return '';
  const text = rows
    .map((r) => {
      // Inflated row — the merge attached full content; compose the same way renderAutoRecall
      // does for a full chunk (summary prefixed as [header], CNZ rag-fetch.js:202 shape).
      if (r.content) {
        const content = r.summary ? `[${r.summary}]\n${r.content}` : r.content;
        return interpolateMemoryTemplate(chunkTemplate, {
          text: content,
          turn_range: String(r.ordinal),
          header: r.summary,
          char_name: charName,
        });
      }
      // Bare row — summary alone under the lightweight entry template.
      return interpolateMemoryTemplate(entryTemplate, {
        text: r.summary,
        turn_range: String(r.ordinal),
        header: r.summary,
        char_name: charName,
      });
    })
    .join('\n\n');
  return interpolateMemoryTemplate(template, { text });
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
