/**
 * @file orchestrator/src/orchestrator/cleanupLoop.ts
 * @stamp 2026-08-07
 * @architectural-role Orchestrator — the async heuristic cleanup poll loop (migration 0072)
 * @description
 * The TRG-style async cleanup subloop that replaced the inline post-runTurn cleanup LLM preset
 * (docs/plans/vistalyze_integration/cleanup_prompt.md, migrations 0057/0066/0070/0071 — the inline
 * runCleanupPass call sites are gone). A reply now lands raw and instantly; this poll loop
 * rewrites it AFTER the fact, driven entirely by orchestrator/cleanupHeuristics.ts's pure engine:
 * regex triggers decide what needs doing, and only then a small user-defined repair prompt
 * (header/footer) or a deterministic text-op (antislop) runs. Zero LLM cost when there is nothing
 * to fix.
 *
 * Same roster-then-process shape as chatMemorySync.ts / agentRoutineDispatch.ts: withSystemScope
 * to list users (chat_sessions is RLS-forced, so there is no single-user context to scan across
 * all of them from), then per user withUserScope to find enabled chats — kind = 'rp' (RP-only by
 * design, plan v2 §1), cleanup_enabled_at not null (the per-chat opt-in switch), archived_at null
 * — then each chat's due assistant messages: role 'assistant', created AFTER the chat's
 * cleanup_enabled_at stamp (the retro-flood guard — enabling cleanup never re-processes old
 * history), with fewer than three cleanup_jobs rows for their active swipe (per-region dedup:
 * a message is due until its active swipe has one row for each of header/body/footer).
 *
 * Per due message the pipeline is:
 *   1. deps.chats.ensureActiveSwipe — a never-regenerated message has no swipe row yet, and the
 *      job ledger keys on (message_id, swipe_id), so materialize one before claiming.
 *   2. Read config live (no restart, bi_principles.md §13): the header/footer regex + repair
 *      prompts from orchestrator_settings (cleanup_header_regex/cleanup_header_prompt/
 *      cleanup_footer_regex/cleanup_footer_prompt, DEFAULT_CLEANUP_CONFIG fallback) and the slop
 *      rules from cleanup_slop_rules (RLS-exempt household config). Both are re-read every tick,
 *      exactly like chatMemorySync.ts's resolveSyncSettings.
 *   3. planCleanup(text, rules, header, footer, { history, userName }) — history is the tail of the
 *      chat's messages before this one (capped read; formatHistoryPairs slices to the prompt's own
 *      {{history, N}} anyway); userName is the household's persona_name for {{user}}.
 *   4. No steps → record job 'done', changed=false. Nothing to fix, no LLM call at all.
 *   5. Steps exist → dispatch each fully-resolved step prompt serially through deps.llm (TRG's
 *      runQueued shape), under runWithCallContext kind 'system' with taskId = chatId — metered but
 *      never capped by llmGate.ts (the user's "no cap" for cleanup; only agent_routine is capped).
 *      Fail-open per step: a throw or empty output yields null and that region is left as-is.
 *   6. applyRepairSteps → the cleaned text. If it differs → deps.chats.recordSwipe (original
 *      content stays as swipe #0, the TRG model). If steps existed but every output was empty/erred
 *      → nothing applied, job 'flagged' (the problem was left in place — the Cleanup page's
 *      flagged list). If outputs were non-empty but the text is byte-identical (LLM reproduced it)
 *      → 'done', changed=false.
 *   7. Record one cleanup_jobs row PER REGION against the message's CURRENT active swipe id
 *      (freshly read after any writeback) — so the next tick's dedup sees each region as covered,
 *      and cycling to an alternate swipe legitimately starts new jobs (migration 0072's own
 *      intent). Insert with ON CONFLICT (message_id, swipe_id, region) DO NOTHING: the unique
 *      index is the real concurrency guard against a run-now tick racing the poll tick.
 *
 * Every step is fail-open (cleanup_prompt.md §1's contract carried forward): a config/slop load
 * failure, a provider timeout, or a job-insert collision all log and leave the message as-is; the
 * loop never throws out of runCleanupTick. A chat's per-message failure is recorded as a
 * 'flagged'/'error' job where the ledger can surface it, never as a crash.
 *
 * The LLM used is deps.llm — the one gated provider shared since boot (index.ts). The old inline
 * pass ran the chat's own connection (turnLlm); the subloop deliberately keeps it simple: there is
 * no cleanup-specific connection setting in the plan, so the household's active connection is the
 * documented behavior, metered through the same gate as everything else.
 *
 * @api-declaration
 * startCleanupLoop(deps)                       — begins polling every POLL_INTERVAL_MS
 * runCleanupTick(deps)                         — one poll cycle, exported so verify scripts drive it
 * getCleanupStatus(db, userId, chatId)         — the pill/page read surface:
 *                                               { enabled, pending, latest: {messageId, regions} | null }
 * runCleanupNow(deps, userId, chatId)          — immediate pass over one chat (the page's run-now)
 * CleanupLoopDeps                              — { db, llm, settings, chats }
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO, LLM IO; owns the setInterval timer it starts)
 *     state_ownership: [the setInterval timer this starts; the in-flight (chat, message, swipe)
 *                       guard set that keeps overlapping ticks from re-planning a message whose
 *                       repair pass is still running (the live path holds a '*' wildcard swipe
 *                       key across the whole live span); finalizeCleanupResult, the shared
 *                       persistence handoff with the live path]
 *     external_io:     [Postgres, the LLM via the shared gated provider]
 */

import { log } from '../io/logger.js';
import { runWithCallContext } from '../io/llm/callContext.js';
import type { LlmMessage, LlmProvider } from '../io/llm/types.js';
import { recordPromptTrace, type PromptTraceEntry } from '../io/promptTrace.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import type { PostgresClient } from '../io/postgres.js';
import type { ChatSessionStore } from '../io/chatSessions.js';
import { registerTurnAbort, unregisterTurnAbort, isAbortError } from './turnAbort.js';
import {
  DEFAULT_CLEANUP_CONFIG,
  applyRepairSteps,
  inspectHeader,
  planCleanup,
  type CleanupPlan,
  type RegionConfig,
  type RepairStep,
  type SlopAction,
  type SlopRule,
} from './cleanupHeuristics.js';
import { loadLocationBlock, scrapeTurnPresence } from './locationAndPresenceScraper.js';
import { getCleanupLiveStatus } from './cleanupLiveStatus.js';

const POLL_INTERVAL_MS = 5_000; // the pill/user watches for the rewrite — snappy, unlike the 30s chat-memory digest
/** How much of the chat's history precedes one message for {{history, N}} resolution. formatHistoryPairs
 *  slices to the prompt's own pair count, so this cap only bounds the read, never the semantics. */
const HISTORY_READ_LIMIT = 40;

/** (chatId, messageId, swipeId) triples whose repair pipeline is currently running. The poll tick
 *  fires every POLL_INTERVAL_MS while a repair round-trip can take minutes, and a message stays
 *  'due' to every tick until its pass records a job — so without this guard each overlapping tick
 *  re-plans the same in-flight message and launches another LLM repair call for it. That runaway
 *  (tens of concurrent repairs per message, each holding an LLM lane slot for its whole duration)
 *  saturated the shared gate and starved interactive turns on 2026-08-08; this is the fix. One
 *  entry per (chat, message, swipe) triple: a user swipe mid-flight legitimately starts a new
 *  triple, and a finished pass records its job so findDueMessages skips it from then on anyway.
 *  Module-level in-memory only, same lifetime as the timer — a process bounce drops the set and
 *  the ledger re-plans, which is the restart tolerance the tick already has. */
const inFlightRepairs = new Set<string>();

/** Claim the in-flight guard for a (chat, message, swipe) triple, or the live path's wildcard
 *  (chatId, messageId, '*') — the live path claims the wildcard from stream start through
 *  finalizeCleanupResult (the assistant messageId is pre-generated before the turn begins; the
 *  swipeId isn't known until ensureActiveSwipe/recordSwipe runs), so the 5s tick can never launch
 *  a duplicate repair pass on a message the live path is still finishing (the plan's G2).
 *  Returns false (no-op) when the exact key was already held. */
export function claimCleanupInFlight(chatId: string, messageId: string, swipeId: string | '*'): boolean {
  const key = `${chatId}:${messageId}:${swipeId}`;
  if (inFlightRepairs.has(key)) return false;
  inFlightRepairs.add(key);
  return true;
}

/** Release a guard held by claimCleanupInFlight. */
export function releaseCleanupInFlight(chatId: string, messageId: string, swipeId: string | '*'): void {
  inFlightRepairs.delete(`${chatId}:${messageId}:${swipeId}`);
}

/** True when any repair pass is running for this (chat, message, swipe) — the exact triple or
 *  the live path's wildcard claim. */
function isCleanupInFlight(chatId: string, messageId: string, swipeId: string): boolean {
  return inFlightRepairs.has(`${chatId}:${messageId}:${swipeId}`) || inFlightRepairs.has(`${chatId}:${messageId}:*`);
}

export interface CleanupLoopDeps {
  db: PostgresClient;
  llm: LlmProvider;
  settings: OrchestratorSettingsStore;
  chats: ChatSessionStore;
  /** location.md §4.3 — fired when the deferred post-repair scrape resolves a location (the
   *  call-site scrape was skipped because the raw header was bad; the repaired text now has a
   *  header, so the standard describe→render chain runs for the newly-established location).
   *  Wired at the composition root (index.ts) to httpServer's fireLocationImageGeneration —
   *  kept out of this module's direct imports so cleanupLoop never depends on the HTTP layer.
   *  Fire-and-forget: the callback must never throw into the tick (fail-open, location.md §1.3). */
  onLocationScraped?: (userId: string, chatId: string, locationId: string) => void;
}

interface UserRow {
  user_id: string;
}

interface DueMessageRow {
  message_id: string;
  content: string;
  reasoning: string | null;
  created_at: string;
}

interface ChatRow {
  chat_id: string;
  cleanup_enabled_at: string;
}

interface SlopRuleRow {
  rule_id: string;
  set_name: string;
  position: number;
  pattern: string;
  flags: string;
  action: string;
  replacement: string | null;
  llm_prompt: string | null;
  enabled: boolean;
}

interface StatusChatRow {
  kind: string;
  cleanup_enabled_at: string | null;
  archived_at: string | null;
}

interface LatestMessageRow {
  message_id: string;
  created_at: string;
  active_swipe_id: string | null;
}

/** One region's pill state — the four-state vocabulary of the in-stream cleanup plan
 *  (docs/plans/completed/in-stream-cleanup-plan.md): grey until a repair was applied (not-called), red
 *  while a repair is in flight or the tick is mid-pass (in-flux), green once a repair actually
 *  changed the text (deployed), ⚠ when a repair was needed but produced nothing (flagged). */
export type CleanupRegionState = 'not-called' | 'in-flux' | 'deployed' | 'flagged';

/** One region's contribution to a finished cleanup pass — the ledger row shape (migration
 *  0090). finalizeCleanupResult writes one of these per region evaluated. */
export interface CleanupRegionOutcome {
  region: 'header' | 'body' | 'footer';
  status: 'done' | 'flagged' | 'error';
  changed: boolean;
  notes: string;
}

export interface CleanupStatus {
  enabled: boolean;
  /** Assistant messages after the stamp whose active swipe lacks at least one region row. */
  pending: number;
  /** The newest assistant message after the stamp, with its three per-region pill states; null
   *  when there is none yet (pill shows nothing / 'off' rather than inventing a state for a
   *  pre-stamp message). */
  latest: {
    messageId: string;
    regions: {
      header: { state: CleanupRegionState };
      body: { state: CleanupRegionState };
      footer: { state: CleanupRegionState };
    };
  } | null;
}

/** The header/footer config + persona_name resolved live for one tick. */
interface ResolvedCleanupConfig {
  header: RegionConfig;
  footer: RegionConfig;
  /** persona_name for {{user}} in the repair prompts; '' when unset (matches interpolateMacros). */
  userName: string;
}

// ---------------------------------------------------------------------------
// Config loading — re-read every tick (bi_principles.md §13, chatMemorySync pattern)
// ---------------------------------------------------------------------------

export async function resolveCleanupConfig(settings: OrchestratorSettingsStore): Promise<ResolvedCleanupConfig> {
  const [headerRegex, headerPrompt, footerRegex, footerPrompt, userName] = await Promise.all([
    settings.get('cleanup_header_regex'),
    settings.get('cleanup_header_prompt'),
    settings.get('cleanup_footer_regex'),
    settings.get('cleanup_footer_prompt'),
    settings.get('persona_name'),
  ]);
  return {
    header: {
      regex: headerRegex ?? DEFAULT_CLEANUP_CONFIG.headerRegex,
      flags: DEFAULT_CLEANUP_CONFIG.headerFlags,
      prompt: headerPrompt ?? DEFAULT_CLEANUP_CONFIG.headerPrompt,
    },
    footer: {
      regex: footerRegex ?? DEFAULT_CLEANUP_CONFIG.footerRegex,
      flags: DEFAULT_CLEANUP_CONFIG.footerFlags,
      prompt: footerPrompt ?? DEFAULT_CLEANUP_CONFIG.footerPrompt,
    },
    userName: userName ?? '',
  };
}

/** cleanup_slop_rules is RLS-exempt household config (no user_id, migration 0072) — read it
 *  through withSystemScope, same as the other system-scoped tables. Exported for the Cleanup
 *  page's admin read (adminServer.ts's getCleanupSettings). */
export async function loadSlopRules(db: PostgresClient): Promise<SlopRule[]> {
  const rows = await db.withSystemScope((session) =>
    session.query<SlopRuleRow>('select * from cleanup_slop_rules order by set_name, position'),
  );
  return rows.map((r) => ({
    ruleId: r.rule_id,
    setName: r.set_name,
    position: r.position,
    pattern: r.pattern,
    flags: r.flags,
    action: (['remove', 'replace-paragraph', 'llm'].includes(r.action) ? r.action : 'remove') as SlopRule['action'],
    replacement: r.replacement,
    llmPrompt: r.llm_prompt,
    enabled: r.enabled,
  }));
}

// ---------------------------------------------------------------------------
// Per-message pipeline
// ---------------------------------------------------------------------------

/** The last HISTORY_READ_LIMIT messages before `messageId`, oldest first, for {{history, N}}. The
 *  "before" boundary is chronological (created_at, then message_id as tiebreak) — a UUID
 *  comparison alone would be lexicographic, not chronological. */
async function loadHistory(
  db: PostgresClient,
  userId: string,
  chatId: string,
  messageId: string,
  createdAt: string,
): Promise<LlmMessage[]> {
  return db.withUserScope(userId, async (session) => {
    const rows = await session.query<{ role: string; content: string }>(
      `select role, content from chat_messages
       where chat_id = $1
         and (created_at < $3 or (created_at = $3 and message_id < $2))
       order by created_at desc, message_id desc
       limit $4`,
      [chatId, messageId, createdAt, HISTORY_READ_LIMIT],
    );
    return rows
      .reverse()
      .map((m) => ({ role: (m.role === 'user' || m.role === 'assistant' ? m.role : 'user') as 'user' | 'assistant', content: m.content }));
  });
}

/** The last HISTORY_READ_LIMIT messages in a chat, oldest first, for {{history, N}} — the
 *  boundary-less sibling of loadHistory: the live cleanup path runs before the turn's assistant
 *  message exists, so there is no messageId/createdAt to bound against; it wants everything
 *  before the turn's own (already-persisted) user message. */
export async function loadRecentHistory(db: PostgresClient, userId: string, chatId: string): Promise<LlmMessage[]> {
  return db.withUserScope(userId, async (session) => {
    const rows = await session.query<{ role: string; content: string }>(
      `select role, content from chat_messages
       where chat_id = $1
       order by created_at desc, message_id desc
       limit $2`,
      [chatId, HISTORY_READ_LIMIT],
    );
    return rows
      .reverse()
      .map((m) => ({ role: (m.role === 'user' || m.role === 'assistant' ? m.role : 'user') as 'user' | 'assistant', content: m.content }));
  });
}

/** One repair step → one prompt trace entry + one LLM call. Fail-open: null on throw or empty
 *  output (applyRepairSteps then leaves that region untouched). The trace entry is recorded before
 *  the call (promptTrace.ts's contract — the prompt is sent either way) and then picks up the
 *  model's reply afterwards, so the inspector shows the full exchange: the repair prompt and
 *  exactly what the model replied with, which is otherwise unrecoverable (the cleaned text replaces
 *  it in the message). */
async function dispatchStep(
  deps: CleanupLoopDeps,
  userId: string,
  chatId: string,
  step: RepairStep,
  signal: AbortSignal,
): Promise<string | null> {
  const stepKind = step.kind === 'repair-header' ? 'header' : step.kind === 'repair-footer' ? 'footer' : step.setName;
  try {
    // A Stop (orchestrator/turnAbort.ts, fired by POST /v1/chat/abort) landed while this chat's
    // repair pass was between steps: skip without firing another billed call — the caller's loop
    // sees the aborted signal too and records nothing, so the next tick re-plans the message.
    if (signal.aborted) return null;
    // The entry object stays live in the trace after recordPromptTrace pushes it — attaching the
    // reply to it post-call is what makes the inspector able to show the reply at all.
    const entry: PromptTraceEntry = {
      kind: 'cleanup',
      title: `Cleanup Repair — ${stepKind}`,
      items: [{ role: 'user', content: step.prompt, chars: step.prompt.length, estimatedTokens: Math.ceil(step.prompt.length / 4) }],
      capturedAt: Date.now(),
    };
    recordPromptTrace(chatId, entry);
    // The seam the log used to be silent on: an LLM repair prompt going out. Logged with its
    // size, not its content (the full text lives in the prompt trace / inspector) — the reply
    // below is the part that's otherwise unrecoverable.
    log.info('cleanup loop: repair prompt fired', { chat: chatId, kind: stepKind, promptChars: step.prompt.length });
    const turn = await runWithCallContext({ taskId: chatId, kind: 'system', userId }, () =>
      deps.llm.complete([{ role: 'user', content: step.prompt }], [], { signal }),
    );
    const out = turn.message.content;
    if (out && out.trim()) {
      const trimmed = out.trim();
      entry.reply = trimmed; // exactly the text applyRepairSteps will consume — same trim
      log.info('cleanup loop: repair reply', { chat: chatId, kind: stepKind, reply: trimmed });
      return trimmed;
    }
    log.warn('cleanup loop: repair replied empty', { chat: chatId, kind: stepKind });
    return null;
  } catch (err) {
    // Stopped by the user (the same abort signal above) is not a repair failure — leave the
    // region as-is and let the caller's abort handling decide what gets recorded.
    if (isAbortError(err)) return null;
    log.error(`cleanup loop: repair step failed for chat ${chatId}, leaving the region as-is`, err);
    return null;
  }
}

/** One repair step → one prompt trace entry + one LLM call. Fail-open: null on throw or empty
 *  output (applyRepairSteps then leaves that region untouched). Exported so the live path
 *  (liveCleanup.ts) dispatches repairs with the exact same function the poll tick uses. */
export { dispatchStep };


function describePlan(plan: CleanupPlan): string {
  const parts: string[] = [];
  if (plan.header.status !== 'ok') parts.push(`header:${plan.header.status}`);
  if (plan.footer.status !== 'ok') parts.push(`footer:${plan.footer.status}`);
  if (plan.invalidRules.length > 0) parts.push(`invalid-rules:${plan.invalidRules.map((r) => r.ruleId).join(',')}`);
  return parts.join(' ') || 'ok';
}

/** Process one due message end to end. Never throws — every failure path lands in the job ledger
 *  ('flagged' when a repair was needed but produced nothing, 'error' for unexpected failures). */
async function processDueMessage(
  deps: CleanupLoopDeps,
  userId: string,
  chatId: string,
  message: DueMessageRow,
  config: ResolvedCleanupConfig,
  rules: SlopRule[],
): Promise<void> {
  // Declared outside the try so the finally can always drop the guard entry — the key is only
  // assigned after ensureActiveSwipe succeeds, so an early return before that leaves it undefined
  // and the finally's delete is a harmless no-op.
  let inFlightKey: string | undefined;
  // Registered for the whole pass so POST /v1/chat/abort can stop the repair LLM call mid-flight
  // (orchestrator/turnAbort.ts) — keyed by chatId like the interactive turn's own registration,
  // so one Stop kills the chat's whole active LLM spend at once. Unregistered in the finally.
  const abortController = registerTurnAbort(chatId);
  try {
    const swipeId = await deps.chats.ensureActiveSwipe(userId, chatId, message.message_id);
    if (!swipeId) {
      log.warn(`cleanup loop: message ${message.message_id} vanished before processing, skipping`);
      return;
    }

    // In-flight guard: at most one repair pass per (chat, message, swipe) at a time. Without it,
    // every overlapping tick (POLL_INTERVAL_MS while a pass takes minutes) sees the message as
    // still 'due' — no job is recorded until the pass finishes — and launches another LLM repair
    // call for the same content, the runaway that saturated the LLM lane and starved interactive
    // turns on 2026-08-08. Skip, don't queue: the next tick re-reads the ledger and only picks
    // the message up again if this pass left it uncovered (e.g. the user swiped mid-flight). The
    // live path's wildcard claim (chatId, messageId, '*') is honored here too — a turn whose live
    // cleanup span hasn't finished yet must not be double-processed by this tick.
    inFlightKey = `${chatId}:${message.message_id}:${swipeId}`;
    if (isCleanupInFlight(chatId, message.message_id, swipeId)) {
      log.debug(`cleanup loop: message ${message.message_id} in chat ${chatId} already being repaired, skipping this tick`, {
        swipe: swipeId,
      });
      return;
    }
    inFlightRepairs.add(inFlightKey);

    const [history, locationBlock] = await Promise.all([
      loadHistory(deps.db, userId, chatId, message.message_id, message.created_at),
      // location.md §5.5 — the known-locations block for the {{known_locations}} header-repair
      // token. Fail-open: '' when disabled or empty, so a template carrying the token still
      // resolves (never leaks the literal token into the repair prompt).
      loadLocationBlock({ db: deps.db, settings: deps.settings }, userId, chatId),
    ]);
    const plan = planCleanup(message.content, rules, config.header, config.footer, {
      history,
      userName: config.userName,
      knownLocations: locationBlock.block,
    });
    const steps = plan.steps;

    // applyRepairSteps always runs against plan.text (the post-'remove' text) — so even with zero
    // steps, a deterministic 'remove' rule's output is what gets compared and written back.
    const outputs: Array<string | null> = [];
    for (const step of steps) {
      // Serialized, TRG runQueued style — per-step fail-open inside dispatchStep. A Stop that
      // landed between steps breaks out here without firing another billed call.
      if (abortController.signal.aborted) break;
      outputs.push(await dispatchStep(deps, userId, chatId, step, abortController.signal));
    }
    if (abortController.signal.aborted) {
      // The user hit Stop: nothing gets recorded (no job, no writeback), so the message stays
      // due and the next tick re-plans it from scratch — a stopped pass must not mark the
      // problem 'flagged', since it was never attempted to completion.
      log.info(`cleanup loop: repair pass for message ${message.message_id} in chat ${chatId} aborted, nothing recorded`);
      return;
    }
    const cleaned = applyRepairSteps(plan.text, steps, outputs);

    // Per-region attribution (migration 0090): every region evaluated in this pass gets its own
    // ledger row, so the poll tick and the live path share one persistence shape (the plan's
    // one-implementation rule). A region is 'flagged' when it needed steps but none produced
    // output; 'done'+changed is decided by applying that region's own steps to plan.text and
    // comparing (plus, for the body, whether the deterministic 'remove' rules changed the text at
    // all — plan.text is the post-'remove' text) — so a repair that reproduced the text
    // byte-identical still records changed=false, exactly the old pill's 'unchanged' meaning.
    const regionOf = (s: RepairStep): 'header' | 'body' | 'footer' =>
      s.kind === 'repair-header' ? 'header' : s.kind === 'repair-footer' ? 'footer' : 'body';
    const outcomes: CleanupRegionOutcome[] = (['header', 'body', 'footer'] as const).map((region) => {
      const own = steps.map((s, i) => ({ s, output: outputs[i] })).filter(({ s }) => regionOf(s) === region);
      if (own.length === 0) {
        return { region, status: 'done', changed: region === 'body' && plan.text !== message.content, notes: `no ${region} steps needed` };
      }
      const regionText = applyRepairSteps(plan.text, own.map(({ s }) => s), own.map(({ output }) => output));
      const changed = regionText !== plan.text || (region === 'body' && plan.text !== message.content);
      const applied = own.some(({ output }) => output !== null);
      if (!applied) {
        log.warn(`cleanup loop: message ${message.message_id} in chat ${chatId} ${region} flagged — repair needed but produced no output`, {
          notes: describePlan(plan),
        });
      }
      return { region, status: applied ? 'done' : 'flagged', changed, notes: describePlan(plan) };
    });
    if (outcomes.some((o) => o.changed)) {
      log.info(`cleanup loop: rewrote message ${message.message_id} in chat ${chatId}`, { notes: describePlan(plan) });
    } else if (steps.length > 0) {
      log.info(`cleanup loop: repairs reproduced the text byte-identical for message ${message.message_id} in chat ${chatId}`, {
        notes: describePlan(plan),
      });
    } else {
      log.debug(`cleanup loop: nothing to fix for message ${message.message_id} in chat ${chatId}`);
    }
    // One persistence handoff shared with the live path: writeback (if the text changed) +
    // per-region jobs + the deferred location scrape when a header repair landed.
    await finalizeCleanupResult(deps, userId, chatId, message.message_id, message.content, cleaned, outcomes, message.reasoning ?? undefined);
  } catch (err) {
    log.error(`cleanup loop: unexpected failure processing message ${message.message_id} in chat ${chatId}`, err);
    const errorOutcomes: CleanupRegionOutcome[] = (['header', 'body', 'footer'] as const).map((region) => ({
      region,
      status: 'error',
      changed: false,
      notes: 'unexpected failure',
    }));
    await recordJobsForActiveSwipe(deps, userId, chatId, message.message_id, message.content, errorOutcomes).catch((e) =>
      log.error(`cleanup loop: failed to record error job for ${message.message_id}`, e),
    );
  } finally {
    // The guard is per (chat, message, swipe): drop it once this pass is done, whatever happened
    // (job recorded, flagged, or the user changed the content mid-flight). If the pass left the
    // message uncovered, the next tick legitimately picks it up again — but as a new pass, not
    // as a parallel twin of this one.
    if (inFlightKey) inFlightRepairs.delete(inFlightKey);
    unregisterTurnAbort(chatId, abortController);
  }
}

/** Record one job row per evaluated region against a specific swipe id. ON CONFLICT DO NOTHING —
 *  the unique (message_id, swipe_id, region) index is the concurrency guard; a concurrent run-now
 *  tick or poll tick that already covered this region is a no-op, not an error. Fail-open: a
 *  job-insert failure here only loses the ledger row, never the message (the next tick's dedup
 *  sees the region uncovered and simply re-plans it, which converges once the text is clean) — so
 *  it must never throw into finalizeCleanupResult, which would mislabel an already-successful
 *  rewrite as 'error'. */
async function recordJobs(
  db: PostgresClient,
  userId: string,
  chatId: string,
  messageId: string,
  swipeId: string,
  regionOutcomes: CleanupRegionOutcome[],
): Promise<void> {
  try {
    await db.withUserScope(userId, async (session) => {
      for (const o of regionOutcomes) {
        await session.query(
          `insert into cleanup_jobs (chat_id, message_id, swipe_id, region, status, changed, notes, finished_at)
           values ($1, $2, $3, $4, $5, $6, $7, now())
           on conflict (message_id, swipe_id, region) do nothing`,
          [chatId, messageId, swipeId, o.region, o.status, o.changed, o.notes],
        );
      }
    });
  } catch (err) {
    log.error(`cleanup loop: failed to record jobs for message ${messageId}, will re-plan next tick`, err);
  }
}

/** One persistence handoff for a finished cleanup pass — the poll tick and the live path both
 *  call this, so there is exactly one implementation of "write the cleaned text + record the
 *  per-region ledger" (the plan's one-implementation rule). Writes the composed final text as a
 *  new swipe when it differs (original stays swipe #0, exactly recordSwipeIfContent's existing
 *  contract), then records one cleanup_jobs row per evaluated region. Also runs the deferred
 *  post-repair location scrape (location.md §4.3) when a header repair landed — the raw reply's
 *  bad header made the call-site scrape skip it, and the repaired text now passes inspection.
 *  The message's reasoning (reasoning-blocks-plan.md) is carried forward into the composed swipe
 *  via `reasoning`: the repair only rewrites the reply text, so the thought that produced it
 *  belongs to the composed variant too — passing undefined (never called with it by the poll
 *  tick's stale legacy rows) writes NULL, which is why every caller with real reasoning passes
 *  it (without this, recordSwipeIfContent's NULL default would wipe the reasoning the turn
 *  path just persisted). Fail-open throughout: never throws to its caller. */
export async function finalizeCleanupResult(
  deps: CleanupLoopDeps,
  userId: string,
  chatId: string,
  messageId: string,
  originalContent: string,
  composedContent: string,
  regionOutcomes: CleanupRegionOutcome[],
  reasoning?: string,
): Promise<void> {
  if (composedContent === originalContent) {
    // Nothing to write back — record the per-region rows against the active swipe, but only when
    // that swipe still holds the content we processed (see recordJobsForActiveSwipe).
    await recordJobsForActiveSwipe(deps, userId, chatId, messageId, originalContent, regionOutcomes);
    return;
  }
  // Atomic writeback + mid-flight guard in one transaction (recordSwipeIfContent): if the user
  // regenerated or swiped while the repair LLM ran, the content no longer matches what we planned
  // against and nothing is written — the new content carries no job, so the next tick picks it up.
  const result = await deps.chats.recordSwipeIfContent(userId, chatId, messageId, originalContent, composedContent, reasoning);
  if (!result) {
    log.warn(`cleanup: message ${messageId} in chat ${chatId} changed mid-flight, skipping writeback`);
    return;
  }
  await recordJobs(deps.db, userId, chatId, messageId, result.newSwipeId, regionOutcomes);
  log.info(`cleanup: rewrote message ${messageId} in chat ${chatId}`, {
    notes: regionOutcomes.map((o) => `${o.region}:${o.status}`).join(','),
  });

  // location.md §4.3 — the deferred post-cleanup scrape. Fire-and-forget, fail-open.
  if (regionOutcomes.some((o) => o.region === 'header' && o.changed)) {
    const config = await resolveCleanupConfig(deps.settings);
    if (inspectHeader(composedContent, config.header).status === 'ok') {
      // Mode from the cleaned swipe's ordinal (location.md §4.3.2): the cleanup writeback always
      // adds exactly one swipe, so index 1 = the message was never regenerated ('extend' — a
      // location change advances previous_scene_id, the 0076 revert target); index ≥ 2 = the
      // active content was itself a regeneration ('replace' — never advances it).
      const mode = (result.message.swipes?.index ?? 0) > 1 ? 'replace' : 'extend';
      void (async () => {
        try {
          const locationId = await scrapeTurnPresence(
            { db: deps.db, settings: deps.settings, ensureActiveSwipe: (u, c, m) => deps.chats.ensureActiveSwipe(u, c, m) },
            userId,
            chatId,
            messageId,
            composedContent,
            mode,
          );
          if (locationId) deps.onLocationScraped?.(userId, chatId, locationId);
        } catch (err) {
          log.warn(`cleanup: deferred scrape failed for message ${messageId} (fail-open)`, { chatId, err });
        }
      })();
    }
  }
}

/** Record one job row per evaluated region against the message's active swipe, but only when
 *  that swipe still holds the content we processed (expectedContent) — the no-change path, where
 *  no writeback happened, so the job key must be verified: if the user regenerated or swiped
 *  mid-flight, the current active swipe is NOT what we processed, and keying a job to it would
 *  wrongly mark that content covered (the next tick then skips it forever). Refuse instead — the
 *  new content has no job, so the next tick picks it up. Read + verify + insert in one
 *  transaction; a message deleted mid-cleanup records nothing rather than a dangling job.
 *  Fail-open like recordJobs — a ledger write must never cascade into finalizeCleanupResult's
 *  callers. */
async function recordJobsForActiveSwipe(
  deps: CleanupLoopDeps,
  userId: string,
  chatId: string,
  messageId: string,
  expectedContent: string,
  regionOutcomes: CleanupRegionOutcome[],
): Promise<void> {
  try {
    await deps.db.withUserScope(userId, (session) =>
      session
        .query<{ content: string; active_swipe_id: string }>(
          // FOR UPDATE, symmetric with recordSwipeIfContent's guard: without the row lock a user
          // regen between this SELECT and the INSERT below would key the job to a now-inactive
          // swipe. Benign either way (every status/pending query filters on the live
          // active_swipe_id, so the orphan row is inert and the new content is picked up next
          // tick), but the lock makes the two paths behave identically.
          `select content, active_swipe_id from chat_messages where message_id = $1 and chat_id = $2 for update`,
          [messageId, chatId],
        )
        .then(async (rows) => {
          const current = rows[0];
          if (!current || !current.active_swipe_id) return; // message gone — nothing to record against
          if (current.content !== expectedContent) return; // user changed it mid-flight — next tick picks it up
          for (const o of regionOutcomes) {
            await session.query(
              `insert into cleanup_jobs (chat_id, message_id, swipe_id, region, status, changed, notes, finished_at)
               values ($1, $2, $3, $4, $5, $6, $7, now())
               on conflict (message_id, swipe_id, region) do nothing`,
              [chatId, messageId, current.active_swipe_id, o.region, o.status, o.changed, o.notes],
            );
          }
        }),
    );
  } catch (err) {
    log.error(`cleanup loop: failed to record jobs for message ${messageId}, will re-plan next tick`, err);
  }
}

// ---------------------------------------------------------------------------
// Roster + tick
// ---------------------------------------------------------------------------

async function findEnabledChats(db: PostgresClient, userId: string): Promise<ChatRow[]> {
  return db.withUserScope(userId, (session) =>
    session.query<ChatRow>(
      `select chat_id, cleanup_enabled_at from chat_sessions
       where kind = 'rp' and cleanup_enabled_at is not null and archived_at is null
       order by updated_at desc`,
    ),
  );
}

async function findDueMessages(db: PostgresClient, userId: string, chatId: string, enabledAt: string): Promise<DueMessageRow[]> {
  return db.withUserScope(userId, (session) =>
    session.query<DueMessageRow>(
      `select m.message_id, m.content, m.reasoning, m.created_at
       from chat_messages m
       join chat_sessions s on s.chat_id = m.chat_id
       where m.chat_id = $1
         and m.role = 'assistant'
         and m.created_at > $2
         and (
           select count(distinct j2.region) from cleanup_jobs j2
           where j2.message_id = m.message_id and j2.swipe_id = m.active_swipe_id
         ) < 3
       order by m.created_at, m.message_id`,
      [chatId, enabledAt],
    ),
  );
}

/** One poll cycle: roster enabled chats, process every due message. Exported so verify scripts
 *  drive it directly and POST /v1/cleanup/run can trigger it on demand. Never throws. */
export async function runCleanupTick(deps: CleanupLoopDeps): Promise<void> {
  try {
    const config = await resolveCleanupConfig(deps.settings);
    const rules = await loadSlopRules(deps.db);
    const users = await deps.db.withSystemScope((session) => session.query<UserRow>('select user_id from users'));
    for (const { user_id: userId } of users) {
      const chats = await findEnabledChats(deps.db, userId);
      for (const chat of chats) {
        const due = await findDueMessages(deps.db, userId, chat.chat_id, chat.cleanup_enabled_at);
        for (const message of due) {
          await processDueMessage(deps, userId, chat.chat_id, message, config, rules);
        }
      }
    }
  } catch (err) {
    // Config load, roster, or per-chat read failure — log and move on; the next tick retries.
    log.error('cleanup loop tick failed', err);
  }
}

export function startCleanupLoop(deps: CleanupLoopDeps): void {
  const tick = () => {
    runCleanupTick(deps).catch((err) => log.error('cleanup loop tick failed', err));
  };
  tick();
  setInterval(tick, POLL_INTERVAL_MS).unref();
}

// ---------------------------------------------------------------------------
// Status + run-now (server/httpServer.ts routes)
// ---------------------------------------------------------------------------

/** The pill/page read surface: whether the chat is opted in, how many messages are still pending,
 *  and the newest eligible message's per-region pill states. Mirrors the loop's roster predicates
 *  exactly (kind = 'rp', archived_at null) — a chat that the loop would never process reports
 *  enabled:false rather than a never-draining pending count. Undefined only when the chat doesn't
 *  exist. While a turn streams, the live path's ambient map (cleanupLiveStatus.ts) is overlaid on
 *  top of the settled rows, so a polling read never shows stale 'not-called' for a region a repair
 *  is actually working on. */
export async function getCleanupStatus(db: PostgresClient, userId: string, chatId: string): Promise<CleanupStatus | undefined> {
  return db.withUserScope(userId, async (session) => {
    const [chat] = await session.query<StatusChatRow>(
      'select kind, cleanup_enabled_at, archived_at from chat_sessions where chat_id = $1',
      [chatId],
    );
    if (!chat) return undefined;

    // The loop's findEnabledChats requires kind = 'rp' and archived_at null — status must agree,
    // or a 'chat'-kind/archived chat with a stray stamp would read enabled with a pending count
    // that can never drain (the loop never touches it).
    const enabledAt = chat.kind === 'rp' && !chat.archived_at ? chat.cleanup_enabled_at : null;
    if (!enabledAt) return { enabled: false, pending: 0, latest: null };

    const [pendingRow] = await session.query<{ count: string }>(
      `select count(*) from chat_messages m
       join chat_sessions s on s.chat_id = m.chat_id
       where m.chat_id = $1
         and m.role = 'assistant'
         and m.created_at > s.cleanup_enabled_at
         and (
           select count(distinct j2.region) from cleanup_jobs j2
           where j2.message_id = m.message_id and j2.swipe_id = m.active_swipe_id
         ) < 3`,
      [chatId],
    );

    const [latest] = await session.query<LatestMessageRow>(
      `select m.message_id, m.created_at, m.active_swipe_id from chat_messages m
       join chat_sessions s on s.chat_id = m.chat_id
       where m.chat_id = $1 and m.role = 'assistant' and m.created_at > s.cleanup_enabled_at
       order by m.created_at desc, m.message_id desc
       limit 1`,
      [chatId],
    );
    if (!latest) return { enabled: true, pending: Number(pendingRow?.count ?? 0), latest: null };

    const jobRows = await session.query<{ region: string; status: string; changed: boolean }>(
      `select j.region, j.status, j.changed from cleanup_jobs j
       join chat_messages m on m.message_id = j.message_id
       where j.message_id = $1 and j.swipe_id = m.active_swipe_id
       order by j.finished_at desc nulls last`,
      [latest.message_id],
    );

    // Per-region state (the settled mapping, plan Contracts): the newest job row wins — done+
    // changed → deployed, done+!changed → not-called, flagged/error → flagged. No row: in-flux
    // while the live path's ambient map or the in-flight guard covers the message, else
    // not-called.
    const live = getCleanupLiveStatus(chatId);
    const inFlight =
      (latest.active_swipe_id && isCleanupInFlight(chatId, latest.message_id, latest.active_swipe_id)) ||
      isCleanupInFlight(chatId, latest.message_id, '*');
    const regionState = (region: 'header' | 'body' | 'footer'): { state: CleanupRegionState } => {
      const row = jobRows.find((r) => r.region === region);
      if (row) {
        const state: CleanupRegionState =
          row.status === 'flagged' || row.status === 'error' ? 'flagged' : row.changed ? 'deployed' : 'not-called';
        return { state };
      }
      if (live && live[region]) return live[region]!;
      return { state: inFlight ? 'in-flux' : 'not-called' };
    };

    return {
      enabled: true,
      pending: Number(pendingRow?.count ?? 0),
      latest: {
        messageId: latest.message_id,
        regions: { header: regionState('header'), body: regionState('body'), footer: regionState('footer') },
      },
    };
  });
}

/** The Cleanup page's run-now: one immediate pass over one chat (the poll tick keeps the rest).
 *  Same per-message pipeline as the tick — fail-open throughout, so it never rejects. */
export async function runCleanupNow(deps: CleanupLoopDeps, userId: string, chatId: string): Promise<void> {
  try {
    const config = await resolveCleanupConfig(deps.settings);
    const rules = await loadSlopRules(deps.db);
    const [chat] = await deps.db.withUserScope(userId, (session) =>
      session.query<ChatRow>(
        `select chat_id, cleanup_enabled_at from chat_sessions
         where chat_id = $1 and kind = 'rp' and cleanup_enabled_at is not null and archived_at is null`,
        [chatId],
      ),
    );
    if (!chat) {
      log.warn(`cleanup run-now: chat ${chatId} is not an enabled RP chat, nothing to do`);
      return;
    }
    const due = await findDueMessages(deps.db, userId, chatId, chat.cleanup_enabled_at);
    for (const message of due) {
      await processDueMessage(deps, userId, chatId, message, config, rules);
    }
  } catch (err) {
    log.error(`cleanup run-now failed for chat ${chatId}`, err);
  }
}

// ---------------------------------------------------------------------------
// Admin surface (Cleanup page setup): slop-rule full-set replace + settings trio
// ---------------------------------------------------------------------------

/** The page's save shape for one slop rule (no rule_id — a full-set replace regenerates them;
 *  nothing references cleanup_slop_rules.rule_id, so replacing the whole set is safe). */
export interface SlopRuleInput {
  setName: string;
  position: number;
  pattern: string;
  flags: string;
  action: SlopAction;
  replacement: string | null;
  llmPrompt: string | null;
  enabled: boolean;
}

/** Full-set replace of cleanup_slop_rules — the Cleanup page's save. The whole table is
 *  household config (RLS-exempt, migration 0072) and small, so a delete-all + insert-each in one
 *  system-scoped transaction is the simplest consistent write; per-rule CRUD would need a second
 *  index surface for ordering (position within a set) for no benefit. */
export async function replaceSlopRules(db: PostgresClient, rules: SlopRuleInput[]): Promise<void> {
  await db.withSystemScope(async (session) => {
    await session.query('delete from cleanup_slop_rules');
    for (const rule of rules) {
      await session.query(
        `insert into cleanup_slop_rules (set_name, position, pattern, flags, action, replacement, llm_prompt, enabled)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [rule.setName, rule.position, rule.pattern, rule.flags, rule.action, rule.replacement, rule.llmPrompt, rule.enabled],
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Jobs history (Cleanup page activity): user-scoped recent cleanup_jobs rows
// ---------------------------------------------------------------------------

/** The page's per-chat "recently cleaned / flagged" list. User-scoped like every other
 *  cleanup_jobs read (RLS via chat_messages.user_id) — a user only ever sees their own chats'
 *  jobs. */
export interface CleanupJobInfo {
  jobId: string;
  messageId: string;
  status: 'done' | 'flagged' | 'error';
  changed: boolean;
  notes: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** First ~120 chars of the message content, so the list can show what was cleaned/flagged. */
  preview: string;
}

export async function getCleanupJobs(db: PostgresClient, userId: string, chatId: string, limit: number): Promise<CleanupJobInfo[]> {
  return db.withUserScope(userId, async (session) => {
    const rows = await session.query<{
      job_id: string;
      message_id: string;
      status: string;
      changed: boolean;
      notes: string | null;
      created_at: string;
      finished_at: string | null;
      preview: string;
    }>(
      `select j.job_id, j.message_id, j.status, j.changed, j.notes, j.created_at, j.finished_at,
              left(m.content, 120) as preview
       from cleanup_jobs j
       join chat_messages m on m.message_id = j.message_id
       where j.chat_id = $1
       order by j.created_at desc
       limit $2`,
      [chatId, limit],
    );
    return rows.map((r) => ({
      jobId: r.job_id,
      messageId: r.message_id,
      status: (r.status === 'done' || r.status === 'flagged' || r.status === 'error' ? r.status : 'error') as CleanupJobInfo['status'],
      changed: r.changed,
      notes: r.notes,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
      preview: r.preview ?? '',
    }));
  });
}
