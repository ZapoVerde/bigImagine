/**
 * @file orchestrator/src/io/chatMemory/memoryInjection.ts
 * @stamp 2026-08-13
 * @architectural-role Pure Functions — CNZ-style per-component memory injection templates
 * @description
 * The reader-side half of the RP memory split (the user's 2026-08-13 direction): instead of one
 * monolithic `memory_recall` blob (bridge scene+events + plot threads + auto-recall fused into a
 * single string by buildChatMemorySystemPrompt), each component is its own marker slot in the
 * prompt stack — `bridge`, `plot_threads`, `auto_recall` — and each is rendered from a
 * user-editable prompt template exactly the way SillyTavern-Canonize renders its own injections
 * (rag/inject.js + core/summary-prompt.js): a "default + bespoke" settings key (bi_principles
 * §18, empty = built-in default) with `{{variable}}` substitution, including CNZ's `{{#if key}}
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
 *   `<{{arc_tag}}>\nsummary — detail\n</{{arc_tag}}>` per arc joined by blank lines, via the
 *   plot template.
 * renderAutoRecall(chunks, facts, template, chunkTemplate, charName) -> string — chunk blocks
 *   rendered through the chunk template ({{text}}, {{turn_range}}, {{header}}, {{char_name}}),
 *   fact bullets appended as {{facts}}; the injection template receives {{text}} = chunk blocks,
 *   {{facts}} = fact bullets. Empty component => '' (so an enabled slot with no content emits
 *   nothing, same non-empty filter as every other marker).
 * renderFusedMemoryBlock(scene, events, arcs, autoRecallBlock) -> string — the deprecated
 *   memory_recall alias: byte-identical to the legacy buildChatMemorySystemPrompt join.
 *
 * @contract
 *   assertions:
 *     purity:          pure (no IO, no state — templates and content are inputs)
 *     state_ownership: []
 *     external_io:     []
 */

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

/** The structured RP memory context — what buildChatMemorySystemPrompt's rp branch returns so the
 *  narrator stack can render each component marker from its own template (and the deprecated
 *  memory_recall alias from the pre-rendered fused block). */
export interface RpMemoryContext {
  scene?: string;
  events?: string;
  plotThreads: PlotArcRow[];
  chunks: ChunkRow[];
  facts: FactRow[];
  /** The legacy fused block (renderFusedMemoryBlock over the parts) — the deprecated
   *  memory_recall alias, and the no-preset fallback string. */
  fused: string;
}

export interface PlotArcRow {
  arc_tag: string;
  summary: string;
  detail?: string | null;
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

export function renderPlotThreads(arcs: PlotArcRow[], template = DEFAULT_INJECT_PLOT_PROMPT): string {
  const plot = arcs
    .map((a) => `<${a.arc_tag}>\n${a.summary}${a.detail ? ` — ${a.detail}` : ''}\n</${a.arc_tag}>`)
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

/** The deprecated `memory_recall` alias — byte-identical to buildChatMemorySystemPrompt's legacy
 *  rp join (scene header, events header, plot threads, then the auto-recall block), so presets
 *  that still carry a memory_recall slot behave exactly as before. */
export function renderFusedMemoryBlock(
  scene: string | undefined,
  events: string | undefined,
  arcs: PlotArcRow[],
  autoRecallBlock: string,
): string {
  const parts: string[] = [];
  if (scene) parts.push(`Scene so far (evolves each sync — call recall_chat_history for exact recent wording):\n${scene}`);
  if (events) parts.push(`Upcoming scheduled events:\n${events}`);
  if (arcs.length) {
    parts.push(
      `Open plot threads:\n${arcs.map((r) => `- #${r.arc_tag}: ${r.summary}${r.detail ? ` — ${r.detail}` : ''}`).join('\n')}`,
    );
  }
  if (autoRecallBlock) parts.push(autoRecallBlock);
  return parts.join('\n\n');
}
