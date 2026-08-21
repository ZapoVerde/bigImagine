/**
 * @file orchestrator/src/orchestrator/cleanupHeuristics.ts
 * @stamp 2026-08-11
 * @architectural-role Pure Function — the async cleanup subloop's decision engine (migration 0072)
 * @description
 * The monolithic cleanup LLM preset (docs/plans/vistalyze_integration/cleanup_prompt.md, migrations
 * 0057/0066/0070/0071) is retired (plan v2): cleanup now runs as a background subloop
 * (orchestrator/cleanupLoop.ts, Phase 3) that cleans a reply AFTER it lands. This module is the
 * subloop's pure core — regex triggers decide what needs doing, and the CleanupPlan it produces
 * drives the executor. No IO, no state: every export here is deterministic given its inputs, so
 * the whole engine is unit-testable by scripts/verify-cleanup-heuristics.mjs.
 *
 * TRG lineage (stacks/sillytavern/st-extensions/SillyTavern-Triggeryze): the trigger→action shape
 * is Triggeryze's ruleset model, and extractParagraph/collectUniqueParagraphs are direct ports of
 * actions/text.js — "replace paragraph" means replace every newline-bounded paragraph containing
 * a match, deduped by start offset, first-rule-wins on same-paragraph conflicts (user-guide.md's
 * documented behavior). The header/footer repair prompts are the user's "format expressed as a
 * prompt" (Cleanup page settings), with {{history, N}} and {{message}} resolved through the same
 * interpolateMacros hook the old runCleanupPass used for {{prev_turns, N}}.
 *
 * The three slop actions (cleanup_slop_rules.action, plan v2 §3):
 *   remove            — deterministic global delete of every regex match (optional static
 *                       replacement string, $1.. backreferences supported). Applied immediately;
 *                       later rules see the post-remove text, so coordinates stay stable.
 *   replace-paragraph — TRG-style: fire one LLM prompt per unique paragraph containing a match,
 *                       splice the outputs back at paragraph boundaries. The step's prompt is
 *                       fully resolved at plan time ({{keyword}}/{{paragraph}} substituted,
 *                       {{message}}/{{history, N}} macro-expanded) so the executor is dumb.
 *   llm               — escape hatch: fire one whole-message prompt. Its output REPLACES the
 *                       entire reply and is terminal (later steps are moot).
 *
 * Region inspection (header/footer) is regex-based and editable — the Cleanup page persists the
 * pattern/flags/prompt to orchestrator_settings (cleanup_header_regex, cleanup_header_prompt,
 * cleanup_footer_regex, cleanup_footer_prompt), and DEFAULT_CLEANUP_CONFIG below is the fallback
 * when a key is unset. The header's canonical shape is locationAndPresenceScraper.ts's
 * `[ TimeOfDay | 🗓️ DayOfWeek, Month DD, YYYY Era | 📍 Location - Specific Area ]` + `Present: …`
 * (two lines, nothing before them); the footer is the `<details>…</details>` inner-thoughts block
 * (character-visual-state-plan.md) — the `<summary>▸</summary>` header and the outfit slots are
 * optional, but the `Inner thoughts:`/`Expression:`/`Outfit:` field markers are mandatory. Footer
 * repair fires on any
 * non-'ok' status: 'malformed' (details-tag family present but not conforming) and 'suspected'
 * (whole-line italic narration) reformat what's already there; 'missing' (no inner-thought
 * evidence at all) builds a fresh footer from the reply's own content. This reverses 0066's
 * original "a turn with no inner thoughts must not gain one" rule at the user's request
 * (2026-08-11) — every eligible reply now gets a footer, not just the ones that already attempted
 * one.
 *
 * @api-declaration
 * extractParagraph(text, matchIndex)                 — { text, start, end } of the newline-bounded paragraph at matchIndex (TRG port)
 * collectUniqueParagraphs(text, re)                  — unique paragraphs (by start) containing a match, in document order (TRG port)
 * compileRulePattern(rule)                           — RegExp for a slop rule (always global), or null when the pattern/flags are invalid
 * evaluateSlopRules(text, rules)                     — applies all enabled 'remove' rules in order; collects replace-paragraph/llm steps + invalid-rule list
 * inspectHeader(text, cfg)                           — 'ok' | 'malformed' | 'missing' against the editable header regex
 * inspectFooter(text, cfg)                           — 'ok' | 'malformed' | 'suspected' | 'missing' against the editable footer regex
 * extractRegion(text, cfg)                           — the first regex match span ({ text, start, end }) of the editable footer regex, or null when the pattern is invalid or unmatched
 * formatHistoryPairs(history, pairs)                 — {{history, N}} expansion: last N turn pairs as labeled User:/Assistant: lines (mirrors the old formatPreviousTurns)
 * parseHistoryPairs(arg)                             — the N of {{history, N}}; 2 when missing/unparsable (cleanup_prompt.md §3.2's default)
 * interpolateSlopPrompt(template, vars)              — slop prompt resolution: {{keyword}}/{{paragraph}} literal pass + macro pass
 * buildRepairPrompt(template, vars)                  — repair prompt resolution: {{history, N}}/{{prev_turns, N}} via the resolveArg hook, {{message}} and {{user}} via snapshot
 * planCleanup(text, rules, header, footer, opts)     — the full decision: post-remove text + ordered RepairStep list + region statuses + invalid rules
 * applyRepairSteps(text, steps, outputs)             — pure executor: splices LLM outputs back (skip overlapping spans), header insert/replace, footer append/replace, llm-message terminal
 * normalizeDetailsWrapper(text)                      — strip all <Details> tags and re-wrap once (footer normalization)
 * DEFAULT_CLEANUP_CONFIG                             — fallback header/footer regex+flags+prompt when a settings key is unset
 *
 * @contract
 *   assertions:
 *     purity:          pure — no IO, no state, no clock (deterministic given inputs; bi_principles.md §8)
 *     state_ownership: []
 *     external_io:     []
 */

import type { LlmMessage } from '../io/llm/types.js';
import { interpolateMacros } from '../util/interpolateMacros.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SlopAction = 'remove' | 'replace-paragraph' | 'llm';

export interface SlopRule {
  ruleId: string;
  setName: string;
  position: number;
  /** Regex source, editable on the Cleanup page. */
  pattern: string;
  /** Regex flags, e.g. 'i'. 'g' is implied and always added. */
  flags: string;
  action: SlopAction;
  /** Static replacement for 'remove' (supports $1.. backreferences); null = delete the match. */
  replacement: string | null;
  /** Prompt for 'replace-paragraph' / 'llm'. Fallback prompts apply when null. */
  llmPrompt: string | null;
  enabled: boolean;
}

export type RegionStatus = 'ok' | 'missing' | 'malformed' | 'suspected';

export interface RegionConfig {
  /** Regex source for recognizing a conforming header/footer block. */
  regex: string;
  /** Regex flags ('g' is stripped — these are test()-ed, never exec()-looped). */
  flags: string;
  /** The repair prompt, in the user's own words — the "format expressed as a prompt". */
  prompt: string;
}

export interface Paragraph {
  text: string;
  start: number;
  end: number;
}

/** One thing the subloop must ask the LLM for, fully resolved at plan time. */
export type RepairStep =
  | { kind: 'replace-paragraph'; ruleId: string; setName: string; span: Paragraph; prompt: string }
  | { kind: 'llm-message'; ruleId: string; setName: string; matched: string; prompt: string }
  | { kind: 'repair-header'; span: { start: number; end: number }; prompt: string }
  | { kind: 'repair-footer'; span: { start: number; end: number }; prompt: string };

export interface InvalidRule {
  ruleId: string;
  setName: string;
  error: string;
}

/** The RepairStep variants that splice into the text at a span (everything except llm-message). */
type SpanStep = Extract<RepairStep, { kind: 'replace-paragraph' | 'repair-header' | 'repair-footer' }>;

export interface CleanupPlan {
  /** The post-'remove' deterministic text; every step's span/prompt is valid against this. */
  text: string;
  /** Ordered repair steps; the executor (applyRepairSteps) consumes them with one output each. */
  steps: RepairStep[];
  header: { status: RegionStatus };
  footer: { status: RegionStatus };
  invalidRules: InvalidRule[];
}

export interface RepairVars {
  /** {{message}} — the text being cleaned (post-'remove'). */
  message: string;
  /** {{history, N}} / {{prev_turns, N}} — the turn-pair history the header repair may cite. */
  history?: LlmMessage[];
  historyPairs?: number;
  /** {{user}} — the household's persona_name setting, resolved the same way the rest of the
   *  app resolves {{user}} (interpolateMacros.ts's userName; empty when unset). */
  userName?: string;
  /** {{known_locations}} — the known-locations <locations> block (location.md §5.5), loaded by
   *  the async callers (cleanupLoop, ensureFirstTurnHeader) via loadLocationBlock and passed
   *  in here — buildRepairPrompt stays pure/sync (bi_principles.md §8). Empty when unset, so a
   *  template carrying the token still resolves (never leaks the literal token). */
  knownLocations?: string;
  /** {{roster}} — the comma-separated Present: roster (character-visual-state-plan.md), loaded
   *  by the async callers from the reply's parsed header and passed in here. '' when unset, so a
   *  template carrying the token still resolves — the footer repair then names no characters. */
  roster?: string;
}

// ---------------------------------------------------------------------------
// Paragraph utilities — direct ports of Triggeryze actions/text.js
// ---------------------------------------------------------------------------

/** Returns { text, start, end } of the newline-bounded paragraph at matchIndex. */
export function extractParagraph(text: string, matchIndex: number): Paragraph {
  const start = text.lastIndexOf('\n', matchIndex - 1) + 1;
  const nlEnd = text.indexOf('\n', matchIndex);
  const end = nlEnd === -1 ? text.length : nlEnd;
  return { text: text.slice(start, end), start, end };
}

/** Returns all unique paragraphs (by start index) that contain a regex match, in order. */
export function collectUniqueParagraphs(text: string, re: RegExp): Paragraph[] {
  const seen = new Map<number, Paragraph>();
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = extractParagraph(text, m.index);
    if (!seen.has(p.start)) seen.set(p.start, p);
  }
  return [...seen.values()].sort((a, b) => a.start - b.start);
}

/**
 * Returns the next newline-terminated paragraph at or after `fromOffset`, or null when the rest
 * of the buffer holds no completed paragraph. Paragraph semantics match extractParagraph: `end`
 * points at the closing newline and the returned text excludes it — a paragraph is "completed"
 * only once its trailing newline has arrived. The live cleanup engine (liveCleanup.ts) calls
 * this after every delta and advances its cursor to `end + 1`; the buffer's final, unterminated
 * paragraph is never returned here — finishStream's end-of-stream body pass is what judges it.
 */
export function nextCompletedParagraph(buffer: string, fromOffset: number): Paragraph | null {
  const nl = buffer.indexOf('\n', fromOffset);
  if (nl === -1) return null;
  const start = buffer.lastIndexOf('\n', fromOffset - 1) + 1;
  return { text: buffer.slice(start, nl), start, end: nl };
}

// ---------------------------------------------------------------------------
// Slop rule engine
// ---------------------------------------------------------------------------

/** Compiles a slop rule's pattern; always global (exec-looping needs /g). Returns null when the
 *  pattern or flags are invalid — the caller records an InvalidRule and skips it. */
export function compileRulePattern(rule: SlopRule): RegExp | null {
  try {
    const flags = rule.flags.includes('g') ? rule.flags : `${rule.flags}g`;
    return new RegExp(rule.pattern, flags);
  } catch {
    return null;
  }
}

/** Fallback prompts when a replace-paragraph / llm rule has no llm_prompt of its own. */
export const DEFAULT_SLOP_REWRITE_PROMPT =
  'The paragraph contains the prohibited phrase "{{keyword}}".\n\n' +
  'Rewrite this paragraph to remove the phrase entirely. Change the physical action or internal ' +
  'reaction — do not substitute a synonym or near-synonym. Maintain the current tone and pacing. ' +
  'Make a minimal structural change to the paragraph.\n\n' +
  'Output ONLY the rewritten paragraph text, nothing else.\n\n' +
  '{{paragraph}}';

export const DEFAULT_SLOP_MESSAGE_PROMPT =
  'The reply contains the prohibited phrase "{{keyword}}".\n\n' +
  'Rewrite the reply to remove it entirely while keeping the story, the characters, their actions ' +
  'and the pacing unchanged. Do not substitute a synonym or near-synonym. Output ONLY the corrected ' +
  'reply, nothing else.\n\n' +
  '{{message}}';

function bySetPosition(a: SlopRule, b: SlopRule): number {
  return a.setName === b.setName ? a.position - b.position : a.setName.localeCompare(b.setName);
}

/** {{keyword}}/{{paragraph}} literal pass (slop prompts), then the macro pass for {{message}} etc. */
export function interpolateSlopPrompt(
  template: string,
  vars: RepairVars & { keyword?: string; paragraph?: string },
): string {
  const withLiterals = template
    .replace(/\{\{\s*keyword\s*\}\}/gi, vars.keyword ?? '')
    .replace(/\{\{\s*paragraph\s*\}\}/gi, vars.paragraph ?? '');
  return buildRepairPrompt(withLiterals, vars);
}

/** Applies every enabled 'remove' rule in order (set, position); collects LLM steps against the
 *  post-remove text so their spans are stable. Rules with an unparseable regex are skipped and
 *  reported — they never abort the pass. */
export function evaluateSlopRules(
  text: string,
  rules: SlopRule[],
): { text: string; steps: RepairStep[]; invalidRules: InvalidRule[] } {
  const steps: RepairStep[] = [];
  const invalidRules: InvalidRule[] = [];
  let current = text;

  for (const rule of [...rules].filter((r) => r.enabled).sort(bySetPosition)) {
    const re = compileRulePattern(rule);
    if (!re) {
      invalidRules.push({ ruleId: rule.ruleId, setName: rule.setName, error: `invalid regex pattern or flags: ${rule.pattern}` });
      continue;
    }

    if (rule.action === 'remove') {
      current = current.replace(re, rule.replacement ?? '');
      continue;
    }

    if (rule.action === 'replace-paragraph') {
      const paragraphs = collectUniqueParagraphs(current, re);
      for (const p of paragraphs) {
        re.lastIndex = 0;
        const first = re.exec(p.text);
        steps.push({
          kind: 'replace-paragraph',
          ruleId: rule.ruleId,
          setName: rule.setName,
          span: p,
          prompt: interpolateSlopPrompt(rule.llmPrompt ?? DEFAULT_SLOP_REWRITE_PROMPT, {
            keyword: first?.[0] ?? '',
            paragraph: p.text,
            message: current,
          }),
        });
      }
      continue;
    }

    // action === 'llm' — whole-message rewrite on first match; terminal at execution time.
    re.lastIndex = 0;
    const m = re.exec(current);
    if (m) {
      steps.push({
        kind: 'llm-message',
        ruleId: rule.ruleId,
        setName: rule.setName,
        matched: m[0],
        prompt: interpolateSlopPrompt(rule.llmPrompt ?? DEFAULT_SLOP_MESSAGE_PROMPT, {
          keyword: m[0],
          paragraph: '',
          message: current,
        }),
      });
    }
  }

  return { text: current, steps, invalidRules };
}

// ---------------------------------------------------------------------------
// Region inspection — editable regexes from the Cleanup page
// ---------------------------------------------------------------------------

/** test()-only compile: strips 'g' so a stateful lastIndex can never skew a second test(). */
function compileRegionRegex(cfg: RegionConfig): RegExp | null {
  const flags = cfg.flags.replace(/g/g, '');
  try {
    return new RegExp(cfg.regex, flags);
  } catch {
    return null;
  }
}

/** A header-ish attempt that the full regex failed to accept: a bracket-opened first line, a
 *  pipe-heavy first line, or a `Present:` line that isn't a conforming second line. */
function malformedHeaderEvidence(text: string): boolean {
  const lines = text.split('\n');
  const first = lines[0] ?? '';
  if (/^\s*\[/.test(first)) return true;
  if (/^\s*[^|\n]*\|[^|\n]*\|/.test(first)) return true;
  if (/Present\s*:/i.test(lines.slice(0, 4).join('\n'))) return true;
  return false;
}

/** Header status against the editable regex. A non-matching regex config (unparseable pattern)
 *  yields 'missing' — the repair prompt is never fired on config error, only flagged. */
export function inspectHeader(text: string, cfg: RegionConfig): { status: RegionStatus } {
  const re = compileRegionRegex(cfg);
  if (!re) return { status: 'missing' };
  if (re.test(text)) return { status: 'ok' };
  return { status: malformedHeaderEvidence(text) ? 'malformed' : 'missing' };
}

/** Footer status against the editable regex: 'ok' when a conforming block is present, 'malformed'/
 *  'suspected' when there's evidence of an attempt that didn't land right, 'missing' when the reply
 *  has no inner-thoughts evidence at all. A non-matching regex config degrades to 'missing' like the
 *  header. All three non-'ok' statuses now drive a footer repair (planCleanup) — 'missing' builds a
 *  fresh footer rather than being left untouched. */
export function inspectFooter(text: string, cfg: RegionConfig): { status: RegionStatus } {
  const re = compileRegionRegex(cfg);
  if (!re) return { status: 'missing' };
  if (re.test(text)) return { status: 'ok' };
  if (/<details|<summary|▸|<inner\b|<\/inner\b/i.test(text)) return { status: 'malformed' };
  if (/^\s*\*[^*\n]+\*\s*$/m.test(text)) return { status: 'suspected' };
  return { status: 'missing' };
}

/** The first span the editable region regex matches — the region boundary for consumers that need
 *  the matched text itself, not just a status. Pure: uses the same compileRegionRegex as
 *  inspectFooter so the two can never disagree over config semantics. Returns null when the pattern
 *  is unparseable or nothing matches, so callers fail open exactly like inspectFooter's 'missing'. */
export function extractRegion(text: string, cfg: RegionConfig): { text: string; start: number; end: number } | null {
  const re = compileRegionRegex(cfg);
  if (!re) return null;
  const m = re.exec(text);
  if (!m) return null;
  return { text: m[0], start: m.index, end: m.index + m[0].length };
}

// ---------------------------------------------------------------------------
// Repair prompt resolution — {{history, N}} / {{prev_turns, N}} / {{message}}
// ---------------------------------------------------------------------------

/** The {{history, N}} expansion — the last N turn pairs of the active history, rendered as
 *  labeled User:/Assistant: lines, oldest first (byte-identical to the old runCleanupPass's
 *  formatPreviousTurns so a prompt sees the same history either way). */
export function formatHistoryPairs(history: LlmMessage[], pairs: number): string {
  const kept = pairs > 0 ? history.slice(-pairs * 2) : [];
  return kept
    .map((m) => `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role}: ${m.content}`)
    .join('\n');
}

/** The N of {{history, N}}: a non-negative integer pair count, 2 when missing or unparsable. */
export function parseHistoryPairs(arg: string | undefined): number {
  if (arg === undefined) return 2;
  const n = Number(arg);
  return Number.isInteger(n) && n >= 0 ? n : 2;
}

/** Resolves a repair (or slop) prompt template: {{history, N}}/{{prev_turns, N}} and
 *  {{known_locations}} (location.md §5.5) through the interpolateMacros resolveArg hook,
 *  {{message}} and {{user}} (the household's persona_name) through the registry. Deterministic
 *  given the same vars (bi_principles.md §8). */
export function buildRepairPrompt(template: string, vars: RepairVars): string {
  return interpolateMacros(template, { message: vars.message, userName: vars.userName }, (name, arg) => {
    if (name === 'history' || name === 'prev_turns') {
      return formatHistoryPairs(vars.history ?? [], parseHistoryPairs(arg));
    }
    if (name === 'known_locations') {
      // The block is loaded by the async caller (loadLocationBlock); '' here keeps the token
      // from leaking verbatim into the prompt when the caller has none (turn 1, disabled).
      return vars.knownLocations ?? '';
    }
    if (name === 'roster') {
      // Loaded by the async caller from the reply's parsed header (parseStoryHeader().present);
      // '' here keeps the token from leaking verbatim when the caller has no parsed header.
      return vars.roster ?? '';
    }
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// Footer Details wrapper normalization — tolerant of LLM per-character wrapping
// ---------------------------------------------------------------------------

/**
 * Normalize repeated `<Details>` wrappers into exactly one pair.
 *
 * The LLM sometimes wraps each footer character block in its own
 * `<Details>...</Details>` pair. The intended final shape is always
 * exactly one opening `<Details>` at the start and one `</Details>` at
 * the end with no intermediate tags. This helper:
 *  1. Removes all existing opening and closing Details tags (case-insensitive,
 *     tolerating ordinary whitespace/attributes inside the tag).
 *  2. Preserves the content and ordering between those tags.
 *  3. Trims only leading/trailing whitespace introduced by removal.
 *  4. Wraps the result once with `<Details>` … `</Details>`.
 *
 * `<Details>` is only used for this footer feature, so no contextual
 * protection is needed.
 */
export function normalizeDetailsWrapper(text: string): string {
  const withoutTags = text.replace(/<\/?\s*details\b[^>]*>/gi, '');
  const inner = withoutTags.trim();
  if (inner === '') return '<Details>\n</Details>';
  return `<Details>\n${inner}\n</Details>`;
}

// ---------------------------------------------------------------------------
// Plan assembly + pure executor
// ---------------------------------------------------------------------------

/** The replacement span when a malformed header must be swapped out: the first line plus the
 *  `Present:` line when one follows. For 'missing' the span is empty — the repair inserts at 0. */
function headerRepairSpan(text: string, status: RegionStatus): { start: number; end: number } {
  if (status !== 'malformed') return { start: 0, end: 0 };
  const nl = text.indexOf('\n');
  const line1End = nl === -1 ? text.length : nl + 1;
  const rest = text.slice(line1End);
  const m = /^\s*Present\s*:[^\n]*/.exec(rest);
  return { start: 0, end: m ? line1End + m[0].length : line1End };
}

/** The replacement span for a malformed footer: an unclosed `<details` block is swallowed to end
 *  of text (everything after it is presumed part of the broken block); a stray summary/▸/inner tag
 *  without `<details` is replaced through the end of its line. 'suspected' appends at the end. */
function footerRepairSpan(text: string, status: RegionStatus): { start: number; end: number } {
  if (status !== 'malformed') return { start: text.length, end: text.length };
  const open = text.indexOf('<details');
  if (open !== -1) {
    const close = text.indexOf('</details>', open);
    return { start: open, end: close === -1 ? text.length : close + '</details>'.length };
  }
  const from = text.search(/<summary|▸|<inner\b|<\/inner\b/i);
  if (from === -1) return { start: text.length, end: text.length };
  const lineEnd = text.indexOf('\n', from);
  return { start: from, end: lineEnd === -1 ? text.length : lineEnd + 1 };
}

/** The full decision for one reply: deterministic 'remove' ops applied, every LLM repair
 *  captured as a fully-resolved step, region statuses recorded. Purely derived — the executor
 *  (cleanupLoop.ts) just dispatches step prompts through the LLM gate and splices the outputs. */
export function planCleanup(
  text: string,
  rules: SlopRule[],
  header: RegionConfig,
  footer: RegionConfig,
  opts: { history?: LlmMessage[]; historyPairs?: number; userName?: string; knownLocations?: string; roster?: string } = {},
): CleanupPlan {
  const slop = evaluateSlopRules(text, rules);
  const vars: RepairVars = { message: slop.text, history: opts.history, historyPairs: opts.historyPairs, userName: opts.userName, knownLocations: opts.knownLocations, roster: opts.roster };
  const h = inspectHeader(slop.text, header);
  const f = inspectFooter(slop.text, footer);

  const steps: RepairStep[] = [...slop.steps];
  if (h.status !== 'ok') {
    steps.push({ kind: 'repair-header', span: headerRepairSpan(slop.text, h.status), prompt: buildRepairPrompt(header.prompt, vars) });
  }
  // Footer repair fires on any non-'ok' status: 'malformed'/'suspected' reformat an existing
  // attempt, 'missing' builds a fresh footer from the reply itself (footerRepairSpan appends at
  // the end for 'missing' the same as it does for 'suspected').
  if (f.status !== 'ok') {
    steps.push({ kind: 'repair-footer', span: footerRepairSpan(slop.text, f.status), prompt: buildRepairPrompt(footer.prompt, vars) });
  }

  return { text: slop.text, steps, header: h, footer: f, invalidRules: slop.invalidRules };
}

/** Pure executor: applies one LLM output per step against the plan's text. Empty/absent output
 *  leaves that region untouched (fail-open). replace-paragraph skips a span already replaced
 *  (TRG first-rule-wins on same-paragraph conflicts); llm-message output is terminal — it
 *  replaces the whole reply and later steps are moot. All spans are valid against the original
 *  `text` (the plan's post-remove text), so accepted replacements are spliced in descending
 *  span.start order — insertion order alone isn't enough, since planCleanup always appends the
 *  header step (span near 0) before the footer step (span near the end) regardless of where any
 *  paragraph steps fall in between; splicing by insertion order would apply the header's edit
 *  while a not-yet-processed paragraph span was still expressed in now-stale original-text
 *  coordinates. Sorting by start descending keeps every not-yet-processed span's coordinates
 *  valid, the same invariant Triggeryze's applyReplaceParagraph relies on. */
export function applyRepairSteps(text: string, steps: RepairStep[], outputs: Array<string | null | undefined>): string {
  const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;
  const accepted: Array<{ step: SpanStep; output: string }> = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const o = outputs[i];
    if (!o) continue; // null/''/whitespace output = keep as-is (fail-open)

    if (step.kind === 'llm-message') return o.trim(); // terminal: the rule rewrote the whole reply
    if (accepted.some((a) => overlaps(a.step.span, step.span))) continue; // first rule wins
    accepted.push({ step, output: o });
  }
  accepted.sort((a, b) => a.step.span.start - b.step.span.start);

  let out = text;
  for (let k = accepted.length - 1; k >= 0; k--) {
    const { step, output } = accepted[k];
    const { start, end } = step.span;
    let insert: string;
    switch (step.kind) {
      case 'replace-paragraph':
        insert = output.trim();
        break;
      case 'repair-header':
        insert = output.trimEnd() + '\n';
        break;
      case 'repair-footer': {
        const appending = start === end;
        const sep = appending && text.length > 0 && !text.endsWith('\n') ? '\n\n' : '';
        insert = (appending ? sep : '') + normalizeDetailsWrapper(output);
        break;
      }
      default:
        continue;
    }
    out = out.slice(0, start) + insert + out.slice(end);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Defaults — fallback when a cleanup settings key is unset (Cleanup page persists overrides)
// ---------------------------------------------------------------------------

export const DEFAULT_CLEANUP_CONFIG = {
  /** Canonical header shape (locationAndPresenceScraper.ts): bracketed line + Present: line, at
   *  the very top of the reply ('^' anchors position 0 because the flags are deliberately empty). */
  headerRegex:
    '^\\[\\s*[^|]+?\\s*\\|\\s*(?:🗓️\\s*)?[^|]+?\\s*\\|\\s*(?:📍\\s*)?[^\\]]+?\\s*\\]\\s*\\n\\s*Present:[^\\n]*',
  headerFlags: '',
  headerPrompt:
    'The character\'s reply below is missing its required two-line scene header, or the header is ' +
    'malformed. Rebuild both lines from the recent conversation history and the reply itself — never ' +
    'invent a location, date, time or character that the history does not support.\n\n' +
    'Required format, exactly two lines, nothing before them:\n' +
    '[ TimeOfDay | 🗓️ DayOfWeek, Month DD, YYYY Era | 📍 Location - Specific Area ]\n' +
    'Present: Character A, Character B\n\n' +
    '- TimeOfDay: a plain phrase (e.g. "Early Morning", "Late Evening"), not a clock time.\n' +
    '- Era: AD/BC by default, or the story\'s own established calendar era (e.g. "41st Millennium", "3 ABY").\n' +
    '- Location: "General Area - Specific Room" when a specific spot is known, otherwise just the general area.\n' +
    '- Present: the comma-separated roster of every character physically in the room at the end of ' +
    'this turn, from the history — never invented, never guessed from off-screen mentions. ' +
    'List whoever is currently most narratively active or central to the turn first (the ' +
    'character speaking, acting, or otherwise the scene\'s focus), with the rest following in ' +
    'no required order — this ordering is preserved and displayed, so first place matters.\n' +
    '{{known_locations}}\n' +
    '\n' +
    'Recent conversation:\n' +
    '{{history, 2}}\n\n' +
    'Reply to fix:\n' +
    '{{message}}\n\n' +
    'Output ONLY the two header lines, nothing else.',
  /** Canonical footer shape (character-visual-state-plan.md): the hidden inner-thoughts details
   *  block, structure-aware — a <details> wrapper that may carry a <summary>▸</summary> header,
   *  plus one or more <Name>…</Name> blocks each carrying Inner thoughts:/Expression:/Outfit: in
   *  order. Outfit slots are optional — zero or more `- Slot: value` lines in any known-slot
   *  presence — so a partial outfit is valid and the absent slots carry no information. The
   *  legacy generic <inner thoughts> block (0066's shape) FAILS this pattern — it lacks the field
   *  markers — so it lands as 'malformed' and gets repaired into the canonical shape. */
  footerRegex:
    '<details\\s*[^>]*>\\s*' +
    '(?:<summary\\s*[^>]*>[^<]*</summary>\\s*)?' +
    '(?:<[A-Za-z][A-Za-z0-9 _-]*>\\s*' +
    'Inner\\s*thoughts:[^\\n]*' +
    '(?:\\n(?!\\s*(?:Expression|Outfit):)[^\\n]*)*' +
    '\\n?\\s*Expression:[^\\n]*' +
    '\\n?\\s*Outfit:[^\\n]*' +
    '(?:\\s*\\n?\\s*-\\s*[A-Za-z][A-Za-z0-9 _-]*:[^\\n]*)*' +
    '\\s*</[A-Za-z][A-Za-z0-9 _-]*>\\s*' +
    ')+' +
    '</details>',
  footerFlags: 'i',
  footerPrompt:
    'The character\'s reply below is missing its hidden inner-thoughts footer, or the footer is ' +
    'malformed. Produce the standard hidden footer block, exactly this shape, appended after the ' +
    'reply with nothing before or after it:\n\n' +
    '<details>\n' +
    '<Ava>\n' +
    'Inner thoughts: What Ava is feeling beneath what she is showing. What Ava wants from {{user}} right now.\n' +
    'Expression: pleased\n' +
    'Outfit:\n' +
    '- Top: white blouse\n' +
    '- Accessory: silver pendant\n' +
    '</Ava>\n' +
    '</details>\n\n' +
    '- One block per character in the roster, in roster order: {{roster}}\n' +
    '- Inner thoughts: keep the reply\'s existing inner thoughts if any; otherwise infer them from ' +
    'the reply\'s tone, actions, and subtext. Two parts: what the character is feeling beneath what ' +
    'they are showing, and what they want from {{user}} right now. Free-form, a few sentences at most.\n' +
    '- Expression: exactly ONE word (e.g. pleased, calm, angry) — never a phrase.\n' +
    '- Outfit: the currently worn item per known slot as `- Slot: item` lines, in this fixed order — ' +
    'Outerwear, Top, Bottom, Underwear top, Underwear bottom, Accessory — omitting any slot that is ' +
    'not meaningfully worn or that the reply gives no evidence for (skipping a slot does not break ' +
    'the order of the ones you do include) — never fill a slot with \'none\' for the sake of ' +
    'completeness.\n' +
    '- Never invent characters — only the roster\'s characters, never characters absent from the ' +
    'reply.\n' +
    '- Output ONLY the footer block, nothing else — never repeat the reply text.\n\n' +
    'Recent conversation:\n' +
    '{{history, 1}}\n\n' +
    'Reply:\n' +
    '{{message}}',
} as const;
