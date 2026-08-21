/**
 * @file orchestrator/src/orchestrator/liveCleanup.ts
 * @stamp 2026-08-14
 * @architectural-role Orchestrator — the incremental in-stream cleanup engine
 * @description
 * The live half of docs/plans/completed/in-stream-cleanup-plan.md: the per-delta header/body checks that
 * run inside runStreamingRpTurn while a reply streams, plus finishStream's end-of-stream tail
 * body pass, footer inspection, and the deferred 'llm'-action slop pass. Pure decisions come
 * from cleanupHeuristics.ts (inspectHeader / inspectFooter / nextCompletedParagraph /
 * evaluateSlopRules); repairs dispatch through cleanupLoop.ts's exported dispatchStep — the
 * exact function the poll tick uses, so one repair mechanism with two trigger timings — and the
 * ambient pill state is written to cleanupLiveStatus.ts plus pushed to the client through the
 * caller-supplied onCleanupEvent callback (which the server handlers translate into
 * bigimagine_cleanup / bigimagine_patch SSE frames).
 *
 * Deliberately stateless as a module: everything the engine needs across calls lives in the
 * LiveCleanupContext object the streaming loop holds and passes back in (bi_principles.md §8's
 * Stateful-Owner split — this file is the Orchestrator, the context is the state,
 * cleanupLiveStatus.ts the leaf). The context is created once per turn (createLiveCleanupContext
 * resolves config/rules/history/knownLocations — the same live-reads cleanupLoop.ts makes every
 * tick), reset on every blank-reply retry (resetLiveCleanupContext, mirroring relayedText's
 * reset so patch offsets never diverge from what the client accumulated; a generation counter
 * makes late-resolving repairs from a discarded attempt no-ops), and returned from
 * runStreamingRpTurn so the caller can sequence finishStream itself (turn 1's
 * ensureFirstTurnHeader must run between the stream and finishStream — only the caller can do
 * that).
 *
 * The composed buffer (ctx.composed) is byte-identical to what the caller's onDelta
 * accumulation has produced so far — raw deltas plus every patch already emitted — so every
 * patch span emitted here is valid in the client's coordinate space too, and the client's
 * splice is the same span at the same moment, in the same order (the plan's "flash-then-patch,
 * never a delay": the raw stream is never withheld for any repair).
 *
 * @api-declaration
 * createLiveCleanupContext(deps, userId, chatId)         — resolve config/rules/history/knownLocations
 * resetLiveCleanupContext(ctx)                           — blank-reply retry: fresh buffer + region state
 * onLiveDelta(ctx, deps, userId, chatId, delta, signal, onCleanupEvent?) — per-delta driver:
 *   append to the buffer, run the once-per-turn early header check, scan newly-closed paragraphs
 * checkHeaderEarly(ctx, deps, userId, chatId, signal, onCleanupEvent?)  — the early header check
 *   (fires only when its threshold is met; internal verdict guard makes it once-per-turn)
 * checkBodyParagraph(ctx, deps, userId, chatId, p, signal, onCleanupEvent?) — one closed paragraph:
 *   deterministic 'remove' patches immediately, first-matching 'replace-paragraph' rule dispatches
 * finishStream(ctx, deps, baseText, opts)                — await in-flight live repairs, then the
 *   tail body pass + footer + deferred 'llm' pass; returns { composed, outcomes } ready for
 *   finalizeCleanupResult. Throws AbortError when the signal is aborted (caller then records
 *   nothing — the poll tick catches the message, same as the tick's own abort path).
 *
 * @contract
 *   assertions:
 *     purity:          impure (LLM IO through dispatchStep, config/history DB reads at creation)
 *     state_ownership: [the LiveCleanupContext the streaming loop holds; nothing module-level]
 *     external_io:     [the LLM via cleanupLoop's dispatchStep; the ambient cleanupLiveStatus map]
 */

import { log } from '../io/logger.js';
import type { LlmMessage } from '../io/llm/types.js';
import { isAbortError } from './turnAbort.js';
import {
  DEFAULT_SLOP_REWRITE_PROMPT,
  buildRepairPrompt,
  collectUniqueParagraphs,
  compileRulePattern,
  evaluateSlopRules,
  inspectFooter,
  inspectHeader,
  interpolateSlopPrompt,
  nextCompletedParagraph,
  normalizeDetailsWrapper,
  type Paragraph,
  type RegionConfig,
  type RepairStep,
  type SlopRule,
} from './cleanupHeuristics.js';
import {
  dispatchStep,
  loadRecentHistory,
  loadSlopRules,
  resolveCleanupConfig,
  type CleanupLoopDeps,
  type CleanupRegionOutcome,
  type CleanupRegionState,
} from './cleanupLoop.js';
import { updateCleanupLiveRegion } from './cleanupLiveStatus.js';
import { loadLocationBlock, parseStoryHeader } from './locationAndPresenceScraper.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CleanupRegion = 'header' | 'body' | 'footer';

/** One event the live engine reports to the caller (translated into an SSE frame by the server
 *  handlers): a region's pill state transition, or a content patch expressed in the composed
 *  buffer's coordinate space (== the client's accumulated text). */
export type CleanupLiveEvent =
  | { kind: 'status'; region: CleanupRegion; state: CleanupRegionState }
  | { kind: 'patch'; region: CleanupRegion; start: number; end: number; replacement: string };

export type CleanupLiveEventSink = (event: CleanupLiveEvent) => void;

/** One region's live state as of stream end / finishStream — the shape runStreamingRpTurn's
 *  cleanup result carries (the caller maps it into finalizeCleanupResult outcomes). */
export interface LiveRegionOutcome {
  region: CleanupRegion;
  state: CleanupRegionState;
}

/** The engine's mutable state for one live span — created per turn, held by the streaming loop,
 *  reset on blank-reply retry, returned to the caller for finishStream. */
export interface LiveCleanupContext {
  /** Byte-identical to what the caller's onDelta accumulation has produced so far. */
  composed: string;
  /** Offset of the first not-yet-body-checked character — one past the last live-closed
   *  paragraph's newline, cursor-corrected by every patch (applyPatch) so it never drifts. */
  bodyCursor: number;
  /** 'pending' until the early header check fires (once per turn), then 'settled'. */
  headerVerdict: 'pending' | 'settled';
  headerState: CleanupRegionState;
  bodyState: CleanupRegionState;
  footerState: CleanupRegionState;
  /** Replace-paragraph repairs currently dispatched (in-flight LLM calls), for the body pill's
   *  in-flux union rule. */
  pendingBodyRepairs: number;
  /** True once any body patch landed this turn (live remove/replace, the tail pass, or the
   *  deferred 'llm' rewrite). */
  bodyPatched: boolean;
  /** Dispatch-time paragraph starts whose repair failed (empty/error output); a span is cleared
   *  when a later patch covers it ("flagged if any paragraph repair failed and nothing later
   *  fixed the same span"). */
  flaggedBodySpans: Set<number>;
  /** In-flight repair resolutions (header + paragraph), so finishStream can await them before
   *  building outcomes — a repair that outlives the stream must still land in the composed text
   *  and the ledger. */
  pending: Set<Promise<void>>;
  /** Incremented by resetLiveCleanupContext; resolutions capture the generation at dispatch and
   *  are no-ops when it changed (a discarded blank attempt's late repair must not patch the
   *  retry's buffer). */
  generation: number;
  rules: SlopRule[];
  headerCfg: RegionConfig;
  footerCfg: RegionConfig;
  userName: string;
  knownLocations: string;
  history: LlmMessage[];
}

export interface FinishStreamOptions {
  userId: string;
  chatId: string;
  /** The turn's abort signal — a Stop during finishStream's repairs throws AbortError to the
   *  caller, which then records nothing (the message stays due for the poll tick). */
  signal: AbortSignal;
  onCleanupEvent?: CleanupLiveEventSink;
  /** Turn 1: the early header and live-body triggers never ran; the tail pass covers the whole
   *  body, and the header region is attributed from ensureFirstTurnHeader's own result. */
  skipLiveTriggers?: boolean;
  /** Turn 1: ensureFirstTurnHeader actually repaired the header (deployed) vs left it as-is
   *  (not-called) — the plan's attribution rule for the header region on turn 1. */
  headerDeployed?: boolean;
}

// ---------------------------------------------------------------------------
// Span helpers — the repair replacement spans, replicated from cleanupHeuristics.ts
// (they are module-private there by the plan's file-scope: only nextCompletedParagraph was
// added to that file; the live engine needs the same spans, so they live here with the source
// of truth named — if the heuristics' versions change, these must change with them).
// ---------------------------------------------------------------------------

/** The replacement span when a malformed header must be swapped out: the first line plus the
 *  `Present:` line when one follows. For 'missing' the span is empty — the repair inserts at 0. */
function headerRepairSpan(text: string, status: 'ok' | 'missing' | 'malformed' | 'suspected'): { start: number; end: number } {
  if (status !== 'malformed') return { start: 0, end: 0 };
  const nl = text.indexOf('\n');
  const line1End = nl === -1 ? text.length : nl + 1;
  const rest = text.slice(line1End);
  const m = /^\s*Present\s*:[^\n]*/.exec(rest);
  return { start: 0, end: m ? line1End + m[0].length : line1End };
}

/** The replacement span for a malformed footer: an unclosed `<details` block is swallowed to end
 *  of text; a stray summary/▸/inner tag without `<details` is replaced through the end of its
 *  line. Any other non-'ok' status appends at the end. */
function footerRepairSpan(text: string, status: 'ok' | 'missing' | 'malformed' | 'suspected'): { start: number; end: number } {
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

// ---------------------------------------------------------------------------
// Context lifecycle
// ---------------------------------------------------------------------------

/** Create the context for one turn. Resolves the same live-read config the poll tick reads
 *  every tick (bi_principles.md §13): header/footer regex + prompts from orchestrator_settings,
 *  slop rules from cleanup_slop_rules, the chat's recent history for {{history, N}}, and the
 *  known-locations block. Fail-open: a load failure logs and returns undefined — the turn
 *  streams normally with no live cleanup and the poll tick catches the message afterwards. */
export async function createLiveCleanupContext(
  deps: CleanupLoopDeps,
  userId: string,
  chatId: string,
): Promise<LiveCleanupContext | undefined> {
  try {
    const [config, rules, history, locationBlock] = await Promise.all([
      resolveCleanupConfig(deps.settings),
      loadSlopRules(deps.db),
      loadRecentHistory(deps.db, userId, chatId),
      loadLocationBlock({ db: deps.db, settings: deps.settings }, userId, chatId),
    ]);
    return {
      composed: '',
      bodyCursor: 0,
      headerVerdict: 'pending',
      headerState: 'not-called',
      bodyState: 'not-called',
      footerState: 'not-called',
      pendingBodyRepairs: 0,
      bodyPatched: false,
      flaggedBodySpans: new Set(),
      pending: new Set(),
      generation: 0,
      rules,
      headerCfg: config.header,
      footerCfg: config.footer,
      userName: config.userName,
      knownLocations: locationBlock.block,
      history,
    };
  } catch (err) {
    log.error(`live cleanup: config load failed for chat ${chatId}, live cleanup disabled for this turn (poll tick catches it)`, err);
    return undefined;
  }
}

/** Blank-reply retry: fresh buffer + region state, mirroring relayedText's reset so patch
 *  offsets never diverge from what the client accumulated. The generation bump makes any repair
 *  still in flight from the discarded attempt a no-op when it resolves (its spans were computed
 *  against the old buffer). */
export function resetLiveCleanupContext(ctx: LiveCleanupContext): void {
  ctx.composed = '';
  ctx.bodyCursor = 0;
  ctx.headerVerdict = 'pending';
  ctx.headerState = 'not-called';
  ctx.bodyState = 'not-called';
  ctx.footerState = 'not-called';
  ctx.pendingBodyRepairs = 0;
  ctx.bodyPatched = false;
  ctx.flaggedBodySpans.clear();
  ctx.pending.clear();
  ctx.generation += 1;
}

/** The three regions' states — what runStreamingRpTurn returns alongside the composed buffer. */
export function collectLiveOutcomes(ctx: LiveCleanupContext): LiveRegionOutcome[] {
  return [
    { region: 'header', state: ctx.headerState },
    { region: 'body', state: ctx.bodyState },
    { region: 'footer', state: ctx.footerState },
  ];
}

// ---------------------------------------------------------------------------
// Emission + cursor helpers
// ---------------------------------------------------------------------------

function emitStatus(chatId: string, region: CleanupRegion, state: CleanupRegionState, onCleanupEvent?: CleanupLiveEventSink): void {
  updateCleanupLiveRegion(chatId, region, state);
  if (onCleanupEvent) onCleanupEvent({ kind: 'status', region, state });
}

function emitPatch(onCleanupEvent: CleanupLiveEventSink | undefined, region: CleanupRegion, start: number, end: number, replacement: string): void {
  if (onCleanupEvent) onCleanupEvent({ kind: 'patch', region, start, end, replacement });
}

/** Splice a patch into the composed buffer and keep the body cursor valid. The invariant every
 *  caller relies on: patches emitted here have end <= bodyCursor at emission time (the header
 *  sits at position 0, remove/replace patches are within already-closed paragraphs), so the
 *  cursor shifts by exactly the length delta. A straddling patch (shouldn't happen — the guard
 *  is a fail-open backstop) backs the cursor up to the patch start, re-processing that span. */
function applyPatch(ctx: LiveCleanupContext, start: number, end: number, replacement: string): void {
  const delta = replacement.length - (end - start);
  ctx.composed = ctx.composed.slice(0, start) + replacement + ctx.composed.slice(end);
  if (ctx.bodyCursor >= end) {
    ctx.bodyCursor += delta;
  } else if (ctx.bodyCursor > start) {
    ctx.bodyCursor = start;
  }
}

/** The enabled slop rules in the tick's evaluation order (set, then position). */
function orderedRules(ctx: LiveCleanupContext, action: SlopRule['action']): SlopRule[] {
  return ctx.rules
    .filter((r) => r.enabled && r.action === action)
    .sort((a, b) => a.setName.localeCompare(b.setName) || a.position - b.position);
}

/** Re-locate a dispatched paragraph in the current composed buffer when its LLM call resolves —
 *  earlier remove/header patches may have shifted offsets since dispatch, so the patch span is
 *  computed at emission time, never captured at dispatch time (the plan's coordinate invariant).
 *  Match by text first (the paragraph may have moved), nearest start as the tiebreak/fallback;
 *  null means it can't be found — fail-open, the raw text stays. */
function relocateParagraph(ctx: LiveCleanupContext, rule: SlopRule, stored: Paragraph): Paragraph | null {
  const re = compileRulePattern(rule);
  if (!re) return null;
  const paragraphs = collectUniqueParagraphs(ctx.composed, re);
  const byText = paragraphs.filter((p) => p.text === stored.text);
  if (byText.length > 0) {
    return byText.reduce((best, p) => (Math.abs(p.start - stored.start) < Math.abs(best.start - stored.start) ? p : best));
  }
  if (paragraphs.length === 0) return null;
  return paragraphs.reduce((best, p) => (Math.abs(p.start - stored.start) < Math.abs(best.start - stored.start) ? p : best));
}

/** The body pill's union rule (plan Logic): in-flux while any paragraph repair is out, deployed
 *  once any patch landed (and nothing is out), flagged when a repair failed and nothing later
 *  fixed the same span, not-called when the whole reply produced no matches at all. */
function refreshBodyState(ctx: LiveCleanupContext, chatId: string, onCleanupEvent?: CleanupLiveEventSink): void {
  let next: CleanupRegionState;
  if (ctx.pendingBodyRepairs > 0) next = 'in-flux';
  else if (ctx.bodyPatched) next = 'deployed';
  else if (ctx.flaggedBodySpans.size > 0) next = 'flagged';
  else next = 'not-called';
  if (next !== ctx.bodyState) emitStatus(chatId, 'body', next, onCleanupEvent);
  ctx.bodyState = next;
}

// ---------------------------------------------------------------------------
// Live hooks (per delta, per closed paragraph)
// ---------------------------------------------------------------------------

/** After every delta while no header verdict has been reached: fire once the buffer contains two
 *  newline characters (both candidate header lines are fully formed), or 400 characters have
 *  arrived with zero newlines, or 400 characters with exactly one newline when inspectHeader
 *  reports 'missing' (a 'malformed' single-newline prefix may be a still-streaming genuine
 *  header — wait for the second newline or finishStream's end-of-stream judgment). A
 *  whitespace-only buffer never fires (a blank first attempt can't dispatch a spurious repair).
 *  'ok' → the region is done for the turn; otherwise a repair-header step dispatches
 *  immediately, concurrently with the main stream (dispatchStep under the same turn signal). */
export function checkHeaderEarly(
  ctx: LiveCleanupContext,
  deps: CleanupLoopDeps,
  userId: string,
  chatId: string,
  signal: AbortSignal,
  onCleanupEvent?: CleanupLiveEventSink,
): void {
  if (ctx.headerVerdict !== 'pending') return;
  const buffer = ctx.composed;
  if (buffer.trim() === '') return; // blank attempt — never dispatch on whitespace
  const newlines = (buffer.match(/\n/g) ?? []).length;
  let fire = false;
  if (newlines >= 2) fire = true;
  else if (buffer.length >= 400 && newlines === 0) fire = true;
  else if (buffer.length >= 400 && newlines === 1 && inspectHeader(buffer, ctx.headerCfg).status === 'missing') fire = true;
  if (!fire) return;

  ctx.headerVerdict = 'settled';
  const verdict = inspectHeader(buffer, ctx.headerCfg).status;
  if (verdict === 'ok') {
    emitStatus(chatId, 'header', 'not-called', onCleanupEvent);
    ctx.headerState = 'not-called';
    return;
  }

  emitStatus(chatId, 'header', 'in-flux', onCleanupEvent);
  ctx.headerState = 'in-flux';
  const step: RepairStep = {
    kind: 'repair-header',
    span: headerRepairSpan(buffer, verdict),
    prompt: buildRepairPrompt(ctx.headerCfg.prompt, {
      message: buffer, // whatever prefix triggered the check — typically just the malformed attempt
      history: ctx.history,
      userName: ctx.userName,
      knownLocations: ctx.knownLocations,
    }),
  };
  const generation = ctx.generation;
  const resolution = (async () => {
    const output = await dispatchStep(deps, userId, chatId, step, signal);
    if (ctx.generation !== generation || signal.aborted) return; // discarded attempt / stopped — no state transition
    if (output && output.trim()) {
      // The header sits at position 0 and only text AFTER it has streamed since dispatch, so the
      // check-time span [0, end] is still valid in the composed buffer — apply + report the patch.
      const replacement = output.trimEnd() + '\n';
      applyPatch(ctx, step.span.start, step.span.end, replacement);
      ctx.headerState = 'deployed';
      emitStatus(chatId, 'header', 'deployed', onCleanupEvent);
      emitPatch(onCleanupEvent, 'header', step.span.start, step.span.end, replacement);
    } else {
      // Fail-open: the raw header stays displayed as-is, exactly like the poll tick's flagging.
      ctx.headerState = 'flagged';
      emitStatus(chatId, 'header', 'flagged', onCleanupEvent);
    }
  })();
  ctx.pending.add(resolution);
  void resolution.finally(() => ctx.pending.delete(resolution));
}

/** One newly-closed paragraph: deterministic 'remove' rules patch immediately (no LLM round
 *  trip), then the first matching 'replace-paragraph' rule dispatches one repair scoped to just
 *  this paragraph (TRG's first-rule-wins per paragraph, mirroring applyRepairSteps' overlap
 *  skip). The dispatch is concurrent with the main stream; its patch span is re-located in the
 *  composed buffer when it resolves. */
export function checkBodyParagraph(
  ctx: LiveCleanupContext,
  deps: CleanupLoopDeps,
  userId: string,
  chatId: string,
  paragraph: Paragraph,
  signal: AbortSignal,
  onCleanupEvent?: CleanupLiveEventSink,
): void {
  let p = { ...paragraph };
  // 1. Deterministic 'remove' rules, in set/position order, against exactly this paragraph.
  for (const rule of orderedRules(ctx, 'remove')) {
    const re = compileRulePattern(rule);
    if (!re) continue;
    const replaced = p.text.replace(re, rule.replacement ?? '');
    if (replaced === p.text) continue;
    applyPatch(ctx, p.start, p.end, replaced);
    ctx.bodyPatched = true;
    refreshBodyState(ctx, chatId, onCleanupEvent);
    emitPatch(onCleanupEvent, 'body', p.start, p.end, replaced);
    p = { text: replaced, start: p.start, end: p.end }; // subsequent rules judge the patched paragraph
  }
  // 2. First matching 'replace-paragraph' rule dispatches (in-flux while out).
  for (const rule of orderedRules(ctx, 'replace-paragraph')) {
    const re = compileRulePattern(rule);
    if (!re) continue;
    re.lastIndex = 0;
    if (!re.test(p.text)) continue;
    re.lastIndex = 0;
    const first = re.exec(p.text);
    const step: RepairStep = {
      kind: 'replace-paragraph',
      ruleId: rule.ruleId,
      setName: rule.setName,
      span: { ...p },
      prompt: interpolateSlopPrompt(rule.llmPrompt ?? DEFAULT_SLOP_REWRITE_PROMPT, {
        keyword: first?.[0] ?? '',
        paragraph: p.text,
        message: ctx.composed,
      }),
    };
    ctx.pendingBodyRepairs += 1;
    refreshBodyState(ctx, chatId, onCleanupEvent);
    const generation = ctx.generation;
    const resolution = (async () => {
      const output = await dispatchStep(deps, userId, chatId, step, signal);
      // Decrement only for a live resolution: a discarded attempt (blank-reply retry bumped the
      // generation, resetLiveCleanupContext zeroed the counter) or a stopped turn must not drive
      // the count negative — refreshBodyState would then under-report in-flight repairs.
      if (ctx.generation !== generation || signal.aborted) return;
      ctx.pendingBodyRepairs -= 1;
      if (output && output.trim()) {
        const loc = relocateParagraph(ctx, rule, p);
        if (loc) {
          const replacement = output.trim();
          applyPatch(ctx, loc.start, loc.end, replacement);
          ctx.bodyPatched = true;
          for (const k of [...ctx.flaggedBodySpans]) {
            if (k >= loc.start && k < loc.end) ctx.flaggedBodySpans.delete(k);
          }
          emitPatch(onCleanupEvent, 'body', loc.start, loc.end, replacement);
        }
      } else {
        ctx.flaggedBodySpans.add(p.start);
        log.warn(`live cleanup: body paragraph repair for chat ${chatId} produced no output, flagged`, { ruleId: rule.ruleId });
      }
      refreshBodyState(ctx, chatId, onCleanupEvent);
    })();
    ctx.pending.add(resolution);
    void resolution.finally(() => ctx.pending.delete(resolution));
    break; // first rule wins per paragraph
  }
}

/** The per-delta driver runStreamingRpTurn calls: append the delta to the composed buffer, run
 *  the once-per-turn early header check, then scan for every newly-closed paragraph and run its
 *  body check. All synchronous up to dispatch — the raw stream is never delayed for any repair
 *  (the LLM calls run concurrently under the same turn signal). */
export function onLiveDelta(
  ctx: LiveCleanupContext,
  deps: CleanupLoopDeps,
  userId: string,
  chatId: string,
  delta: string,
  signal: AbortSignal,
  onCleanupEvent?: CleanupLiveEventSink,
): void {
  ctx.composed += delta;
  checkHeaderEarly(ctx, deps, userId, chatId, signal, onCleanupEvent);
  let p: Paragraph | null;
  while ((p = nextCompletedParagraph(ctx.composed, ctx.bodyCursor)) !== null) {
    // Advance before the (possibly patching) check so applyPatch's cursor correction applies to
    // the already-advanced position.
    ctx.bodyCursor = p.end + 1;
    checkBodyParagraph(ctx, deps, userId, chatId, p, signal, onCleanupEvent);
  }
}

// ---------------------------------------------------------------------------
// finishStream — the end-of-stream pass (caller-driven, after the stream resolves)
// ---------------------------------------------------------------------------

/** The end-of-stream pass, run by the caller after the stream resolves (and, for turn 1, after
 *  ensureFirstTurnHeader — its output is baseText). Awaits any live repairs still in flight so
 *  their patches land in the composed text and ledger, then runs: the tail body pass (the final
 *  unterminated paragraph never closed live; for turn 1 with skipLiveTriggers, the whole body),
 *  the footer inspection, and the deferred 'llm'-action slop pass (both need the complete text).
 *  Emits patch frames for anything that changes text the client already received as raw deltas,
 *  sent just before the turn's normal stop chunk. Returns the final composed text + one outcome
 *  per region, ready for finalizeCleanupResult. Throws AbortError when the signal is aborted —
 *  the caller then records nothing and the poll tick catches the message. */
export async function finishStream(
  ctx: LiveCleanupContext,
  deps: CleanupLoopDeps,
  baseText: string,
  opts: FinishStreamOptions,
): Promise<{ composed: string; outcomes: CleanupRegionOutcome[] }> {
  const { userId, chatId, signal, onCleanupEvent, skipLiveTriggers = false, headerDeployed = false } = opts;
  // The composed buffer is authoritative, NOT baseText — for a live turn the buffer already
  // carries every delta plus every live repair patch, in the same coordinates the client
  // accumulated (each patch was relayed via a bigimagine_patch frame), so rebasing here would
  // silently discard the live header/body repairs from the durable text. Only turn 1
  // (skipLiveTriggers) needs the rebase: its buffer holds the raw stream, while baseText is
  // ensureFirstTurnHeader's already-repaired reply — the text that was persisted and sent.
  if (skipLiveTriggers) ctx.composed = baseText;
  try {
    // Any repair still in flight when the stream ended must resolve before outcomes are built —
    // otherwise its patch would land after the ledger row mislabels the region (in-flux → done).
    await Promise.allSettled([...ctx.pending]);
    if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');

    if (skipLiveTriggers) {
      // Turn 1: the header was already judged by ensureFirstTurnHeader — attribute its result
      // (deployed if it repaired, not-called otherwise); the tail pass covers the whole body.
      ctx.headerVerdict = 'settled';
      ctx.headerState = headerDeployed ? 'deployed' : 'not-called';
      emitStatus(chatId, 'header', ctx.headerState, onCleanupEvent);
      ctx.bodyCursor = 0;
    } else if (ctx.headerVerdict === 'pending') {
      // The stream ended before the early check fired (a short reply): judge the header now.
      const verdict = inspectHeader(ctx.composed, ctx.headerCfg).status;
      if (verdict !== 'ok') {
        ctx.headerVerdict = 'settled';
        emitStatus(chatId, 'header', 'in-flux', onCleanupEvent);
        ctx.headerState = 'in-flux';
        const step: RepairStep = {
          kind: 'repair-header',
          span: headerRepairSpan(ctx.composed, verdict),
          prompt: buildRepairPrompt(ctx.headerCfg.prompt, {
            message: ctx.composed,
            history: ctx.history,
            userName: ctx.userName,
            knownLocations: ctx.knownLocations,
          }),
        };
        const output = await dispatchStep(deps, userId, chatId, step, signal);
        if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
        if (output && output.trim()) {
          const replacement = output.trimEnd() + '\n';
          applyPatch(ctx, step.span.start, step.span.end, replacement);
          ctx.headerState = 'deployed';
          emitStatus(chatId, 'header', 'deployed', onCleanupEvent);
          emitPatch(onCleanupEvent, 'header', step.span.start, step.span.end, replacement);
        } else {
          ctx.headerState = 'flagged';
          emitStatus(chatId, 'header', 'flagged', onCleanupEvent);
        }
      } else {
        ctx.headerVerdict = 'settled';
        ctx.headerState = 'not-called';
        emitStatus(chatId, 'header', 'not-called', onCleanupEvent);
      }
    }

    await runTailBodyPass(ctx, deps, userId, chatId, signal, onCleanupEvent);
    await runFooterCheck(ctx, deps, userId, chatId, signal, onCleanupEvent);
    await runLlmPass(ctx, deps, userId, chatId, signal, onCleanupEvent);
  } catch (err) {
    if (isAbortError(err)) throw err;
    // Fail-open per phase: log and continue with what was applied — the caller persists the
    // composed text as-is (the client has already seen every patch emitted), and the regions
    // that never settled are recorded 'error' below.
    log.error(`live cleanup: finishStream failed for chat ${chatId} (regions left as-is)`, err);
  }
  return { composed: ctx.composed, outcomes: buildOutcomes(ctx) };
}

/** The tail body pass: the reply's final paragraph has no trailing newline, so no live trigger
 *  ever saw it close — evaluate the unprocessed tail (from the body cursor to the end; the whole
 *  body for turn 1) with the tick's own evaluateSlopRules: deterministic 'remove' changes splice
 *  immediately, 'replace-paragraph' steps dispatch serially with emission-time re-location. */
async function runTailBodyPass(
  ctx: LiveCleanupContext,
  deps: CleanupLoopDeps,
  userId: string,
  chatId: string,
  signal: AbortSignal,
  onCleanupEvent?: CleanupLiveEventSink,
): Promise<void> {
  const tailStart = Math.min(ctx.bodyCursor, ctx.composed.length);
  if (tailStart >= ctx.composed.length) return;
  const tailText = ctx.composed.slice(tailStart);
  const slop = evaluateSlopRules(tailText, ctx.rules);
  if (slop.text !== tailText) {
    // Deterministic remove rules changed the tail — patch the whole tail span in place.
    applyPatch(ctx, tailStart, ctx.composed.length, slop.text);
    ctx.bodyPatched = true;
    refreshBodyState(ctx, chatId, onCleanupEvent);
    emitPatch(onCleanupEvent, 'body', tailStart, tailStart + tailText.length, slop.text);
  }
  for (const step of slop.steps) {
    if (step.kind !== 'replace-paragraph') continue; // 'llm' handled by runLlmPass
    const offsetStep = {
      ...step,
      span: { ...step.span, start: step.span.start + tailStart, end: step.span.end + tailStart },
    };
    ctx.pendingBodyRepairs += 1;
    refreshBodyState(ctx, chatId, onCleanupEvent);
    const rule = ctx.rules.find((r) => r.ruleId === step.ruleId);
    const output = await dispatchStep(deps, userId, chatId, offsetStep, signal);
    ctx.pendingBodyRepairs -= 1;
    if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    if (output && output.trim()) {
      const loc = rule ? relocateParagraph(ctx, rule, offsetStep.span) : offsetStep.span;
      const span = loc ?? offsetStep.span;
      const replacement = output.trim();
      applyPatch(ctx, span.start, span.end, replacement);
      ctx.bodyPatched = true;
      for (const k of [...ctx.flaggedBodySpans]) {
        if (k >= span.start && k < span.end) ctx.flaggedBodySpans.delete(k);
      }
      emitPatch(onCleanupEvent, 'body', span.start, span.end, replacement);
    } else {
      ctx.flaggedBodySpans.add(offsetStep.span.start);
      log.warn(`live cleanup: tail paragraph repair for chat ${chatId} produced no output, flagged`, { ruleId: step.ruleId });
    }
    refreshBodyState(ctx, chatId, onCleanupEvent);
  }
}

/** Footer inspection + repair, once the complete text exists (a footer repair splices into the
 *  final text server-side; the client still needs a patch frame for trailing-text changes it
 *  already received, sent just before the stop chunk). */
async function runFooterCheck(
  ctx: LiveCleanupContext,
  deps: CleanupLoopDeps,
  userId: string,
  chatId: string,
  signal: AbortSignal,
  onCleanupEvent?: CleanupLiveEventSink,
): Promise<void> {
  const verdict = inspectFooter(ctx.composed, ctx.footerCfg).status;
  if (verdict === 'ok') return;
  emitStatus(chatId, 'footer', 'in-flux', onCleanupEvent);
  ctx.footerState = 'in-flux';
  const span = footerRepairSpan(ctx.composed, verdict);
  const step: RepairStep = {
    kind: 'repair-footer',
    span,
    prompt: buildRepairPrompt(ctx.footerCfg.prompt, {
      message: ctx.composed,
      history: ctx.history,
      userName: ctx.userName,
      knownLocations: ctx.knownLocations,
      // character-visual-state-plan.md — the {{roster}} footer-repair token from the composed
      // text's own parsed header ('' when the header is missing or unparsable — the footer repair
      // then names no characters rather than leaking the token).
      roster: parseStoryHeader(ctx.composed)?.present.join(', ') ?? '',
    }),
  };
  const output = await dispatchStep(deps, userId, chatId, step, signal);
  if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  if (output && output.trim()) {
    // The same splice applyRepairSteps performs for repair-footer: 'missing'/'suspected' append
    // at the end with a blank-line separator; 'malformed' replaces the broken block in place.
    // Normalize repeated <Details> wrappers (the LLM sometimes wraps each character block separately).
    const appending = span.start === span.end;
    const sep = appending && ctx.composed.length > 0 && !ctx.composed.endsWith('\n') ? '\n\n' : '';
    const replacement = (appending ? sep : '') + normalizeDetailsWrapper(output);
    applyPatch(ctx, span.start, span.end, replacement);
    ctx.footerState = 'deployed';
    emitStatus(chatId, 'footer', 'deployed', onCleanupEvent);
    emitPatch(onCleanupEvent, 'footer', span.start, span.end, replacement);
  } else {
    ctx.footerState = 'flagged';
    emitStatus(chatId, 'footer', 'flagged', onCleanupEvent);
    log.warn(`live cleanup: footer repair for chat ${chatId} produced no output, flagged`);
  }
}

/** The one slop-action kind the live path can't run — 'llm' rewrites the whole message and is
 *  terminal — deferred to finishStream, exactly as the plan requires (a naive live-only design
 *  would miss it entirely). A non-empty output replaces the whole composed text (patch frame
 *  included, so the client's accumulated text catches up); empty/errored output flags the body
 *  region. */
async function runLlmPass(
  ctx: LiveCleanupContext,
  deps: CleanupLoopDeps,
  userId: string,
  chatId: string,
  signal: AbortSignal,
  onCleanupEvent?: CleanupLiveEventSink,
): Promise<void> {
  const llmRules = ctx.rules.filter((r) => r.enabled && r.action === 'llm');
  if (llmRules.length === 0) return;
  const slop = evaluateSlopRules(ctx.composed, llmRules);
  const step = slop.steps.find((s) => s.kind === 'llm-message');
  if (!step) return;
  ctx.bodyState = 'in-flux';
  emitStatus(chatId, 'body', 'in-flux', onCleanupEvent);
  const output = await dispatchStep(deps, userId, chatId, step, signal);
  if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  if (output && output.trim()) {
    const replacement = output.trim();
    const oldLength = ctx.composed.length;
    applyPatch(ctx, 0, oldLength, replacement);
    ctx.bodyPatched = true;
    ctx.flaggedBodySpans.clear(); // the whole message was rewritten — every failed span is covered
    ctx.bodyState = 'deployed';
    emitStatus(chatId, 'body', 'deployed', onCleanupEvent);
    emitPatch(onCleanupEvent, 'body', 0, oldLength, replacement);
  } else {
    ctx.flaggedBodySpans.add(-1); // a whole-message rewrite failed and nothing later fixed it
    refreshBodyState(ctx, chatId, onCleanupEvent);
    log.warn(`live cleanup: 'llm' slop rewrite for chat ${chatId} produced no output, flagged`);
  }
}

/** One CleanupRegionOutcome per region for finalizeCleanupResult: 'flagged' for a region whose
 *  repair was needed but produced nothing, 'done' otherwise; changed only when a patch actually
 *  landed (deployed). 'error' when an unexpected failure left a region still 'in-flux' — that
 *  state is never a valid terminal outcome, so it must not be reported as settled 'done' work
 *  (finishStream's catch swallows a non-abort failure and returns here with whatever regions
 *  never reached a terminal state — see finishStream above). */
function buildOutcomes(ctx: LiveCleanupContext): CleanupRegionOutcome[] {
  const regionOutcome = (region: CleanupRegion, state: CleanupRegionState, fallbackNotes: string): CleanupRegionOutcome => ({
    region,
    status: state === 'in-flux' ? 'error' : state === 'flagged' ? 'flagged' : 'done',
    changed: state === 'deployed',
    notes:
      state === 'not-called' ? `no ${region} steps needed` : state === 'in-flux' ? `${region} left unsettled by an unexpected finishStream failure` : fallbackNotes,
  });
  return [
    regionOutcome('header', ctx.headerState, `header:${ctx.headerState}`),
    regionOutcome('body', ctx.bodyState, `body:${ctx.bodyState}`),
    regionOutcome('footer', ctx.footerState, `footer:${ctx.footerState}`),
  ];
}
