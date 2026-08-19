/**
 * @file orchestrator/src/orchestrator/chatMemorySync.ts
 * @stamp 2026-08-17
 * @architectural-role Orchestrator — the rolling chat-summarization/RAG sync poll loop
 * @description
 * docs/chat-memory.md's sync pipeline. Lives in core, not plugins/chat-memory (which contributes
 * only the LLM-facing recall/household-memory tools) — same reason
 * orchestrator/src/orchestrator/agentRoutineDispatch.ts does: it needs io/llm/callContext.ts's
 * runWithCallContext to satisfy bb_principles.md §14's gate before ever calling llm.complete(),
 * and that module (like runTurn/ToolRegistry) is deliberately not in the plugin-facing exports map
 * (orchestrator/package.json) — a plugin may depend on @bigbrain/orchestrator, never reach behind
 * its public seam.
 *
 * Same per-user roster-then-process shape as agentRoutineDispatch.ts's dispatch tick
 * (withSystemScope to list users, since chat_sessions is RLS-forced and there is no single-user
 * context to scan across all of them from), but "due" here means "this chat has more unsynced
 * messages, past its live window, than chat_memory_sync_every_pairs allows" rather than a
 * next_run_at timestamp.
 *
 * One sync pass, per chat, does everything in a single withUserScope transaction: promote that
 * chat's 'proposed' canon_facts to 'approved' (the settling-window auto-approve — see
 * plugins/canonize/src/proposeCanonFactTool.ts), settle the transient locations/characters the
 * post-cleanup scraper anchored to the archived messages (docs/plans/vistalyze_integration/segway.md
 * §2.5: active-swipe rows promote to 'permanent', alternate-swipe rows demote to 'inactive'),
 * chunk the newly-archived messages
 * (chunkChatTranscript.ts), summarize+embed each chunk (classifyChatChunk.ts + the embeddings
 * provider) — always, for both chat kinds, since chat_chunks/recall_chat_history is the one lane
 * that's already correctly RAG-only and needs no divergence — then branch on chat_sessions.kind:
 * a 'chat' (household) chat distills its "key ideas" digest (distillChatMemory.ts) against its own
 * existing entries, unchanged; an 'rp' chat instead runs the hookseeker-parity bridge
 * (bridgeChatMemory.ts) against the RAW toArchive transcript (never a summary-of-summary), writing
 * an evolving SCENE + EVENTS text block to chat_memory_entries (topic_key 'scene'/'events') and
 * arc-tagged plot developments as 'proposed' canon_facts rows. An 'rp' chat also runs two more
 * periodic curators every tick, over the same raw transcript: curateWorldMemory.ts (place/thing/
 * concept) and curatePeople.ts (person) — both ported from CNZ the same way the bridge was, both
 * proposing entity_key-tagged canon_facts rows (db/migrations/0064_canon_facts_entity_key.sql).
 * Either branch then writes the chat_chunks rows tied to one chat_sync_points row — created fresh
 * when the eager chunk path hasn't already opened one, reused-and-closed when it has
 * (docs/plans/eager-chunk-sync-plan.md: an eager chunk pass opens a `closed_at`-null point the
 * moment a pair rolls off the live window; this tick consolidates the open point's block and
 * closes it). A
 * mid-pipeline failure rolls the whole transaction back, canon-fact promotion included — the
 * previous sync point is untouched, and the next poll tick just retries from there (self-healing,
 * same "advance state, don't double-count" caution agentRoutineDispatch.ts's own doc explains, just
 * via ROLLBACK instead of an explicit ordering trick). Plot/world/people facts proposed this
 * tick get no special-cased approval — they settle through the exact same promote_canon_facts step,
 * on the chat's next tick, as every other canon fact.
 *
 * Every attempt (ok, skipped, or error-with-which-step) is also recorded into
 * chat_memory_sync_status, one upserted row per chat, through a separate transaction from the
 * work itself — so a rollback of the sync work never erases the record that it failed
 * (bi_principles.md §11: the failure logging already existed here, this is just the read surface
 * for it). server/adminServer.ts's getChatMemorySyncStatus is the read side.
 *
 * The poll tick fires every POLL_INTERVAL_MS while a single pass can take minutes of LLM
 * round-trips, so ticks overlap by construction; the in-flight guard (inFlightSyncs, module-level
 * like cleanupLoop.ts's) keeps at most one pass running per chat. Without it, two overlapping
 * ticks both read the same last-synced ordinal, both compute the same nextOrdinal, and the
 * loser's chat_sync_points insert dies on the (chat_id, ordinal) unique constraint — observed
 * 2026-08-09 ("sync_point: duplicate key value violates unique constraint
 * chat_sync_points_chat_id_ordinal_key"). The per-chat pg_advisory_xact_lock is the DB-side
 * serialization for the same race, in case the in-memory guard is ever bypassed (a second
 * process, a future caller); the unique constraint remains the last-resort backstop.
 *
 * The connection this pipeline's calls run through, and each of the six prompts, are read live
 * every tick from io/orchestratorSettings.ts (chat_memory_profile/chat_memory_live_window_pairs/
 * chat_memory_sync_every_pairs/chat_memory_digest_horizon_pairs/chat_memory_chunk_summary_prompt/
 * chat_memory_distill_prompt/chat_memory_household_memory_prompt/chat_memory_bridge_prompt/
 * chat_memory_world_curator_prompt/chat_memory_people_curator_prompt) — a Settings-tab change
 * takes effect on the very next tick, no restart, mirroring server/httpServer.ts's own per-chat
 * profile-override construction (createLlmProviderForProfile + createGatedLlmProvider) for the
 * "which connection" half. persona_name is also read live here, purely to resolve the bridge and
 * people-curator prompts' {{user}} macro (util/interpolateMacros.ts) the same way
 * SillyTavern-Canonize's own {{user}} resolves against the ST persona.
 *
 * distillChatMemory's second argument is not just the chunk summaries this tick freshly produced —
 * it's the trailing chat_memory_digest_horizon_pairs' worth of chat_chunks.summary rows, oldest
 * first, re-read from the DB every sync (this platform's analogue of SillyTavern-Canonize's
 * bridge-summary horizon). The digest's own chat_memory_entries rows already carry state forward
 * across syncs, so this horizon is a revision window on top of that persistence, not the sole
 * source of continuity — see docs/chat-memory.md.
 *
 * @api-declaration
 * startChatMemorySyncLoop(deps) — begins polling every POLL_INTERVAL_MS
 * runChatMemorySyncTick(deps) — one poll cycle, exported so verify scripts can drive it directly
 * archiveChatMemory(deps, userId, chatId, chatTitle) — the end-of-chat long-term-memory
 *   extraction, called by server/httpServer.ts's archive_chat route once chatSessions.ts's
 *   archiveChat has stamped archived_at
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO, LLM IO; owns the setInterval timer it starts)
 *     state_ownership: [the setInterval timer this starts; the in-flight per-chat guard set that
 *                       keeps overlapping poll ticks from launching a parallel sync pass for a
 *                       chat whose pass is still running]
 *     external_io:     [Postgres, the LLM via the gated provider it builds, the embeddings provider]
 */

import { log } from '../io/logger.js';
import { runWithCallContext, withCallLabel } from '../io/llm/callContext.js';
import { createLlmProviderForProfile } from '../io/llm/index.js';
import type { LlmConnectionStore } from '../io/llmConnections.js';
import { createGatedLlmProvider } from '../io/llm/llmGate.js';
import type { LlmProvider } from '../io/llm/types.js';
import type { EmbeddingProvider } from '../io/embeddings/types.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import type { PostgresClient } from '../io/postgres.js';
import { toPgVectorLiteral } from '../util/pgvector.js';
import { chunkChatTranscript, DEFAULT_CHUNK_PAIRS, type ChatTranscriptMessage } from '../io/chatMemory/chunkChatTranscript.js';
import { summarizeChatChunk } from '../io/chatMemory/classifyChatChunk.js';
import { distillChatMemory, type ChatMemoryEntryDraft } from '../io/chatMemory/distillChatMemory.js';
import { classifyHouseholdMemory } from '../io/chatMemory/classifyHouseholdMemory.js';
import { bridgeChatMemory } from '../io/chatMemory/bridgeChatMemory.js';
import { curateWorldMemory } from '../io/chatMemory/curateWorldMemory.js';
import { curatePeople } from '../io/chatMemory/curatePeople.js';

const POLL_INTERVAL_MS = 30_000; // a rolling digest has no live-conversation urgency — minutes-scale is fine
export const DEFAULT_LIVE_WINDOW_PAIRS = 8; // mirrors Canonize's own default live-context buffer
export const DEFAULT_SYNC_EVERY_PAIRS = 8; // mirrors Canonize's own default sync-window size
const DEFAULT_DIGEST_HORIZON_PAIRS = 24; // smaller than Canonize's 40 — chat_memory_entries already persists state across syncs

/** chatIds whose sync pass is currently running. The poll tick fires every POLL_INTERVAL_MS while
 *  a single pass can take minutes of LLM round-trips, and a chat stays 'due' to every tick until
 *  its pass commits — so without this guard each overlapping tick launches a parallel sync pass
 *  for the same chat. Two such passes read the same last-synced ordinal, both compute the same
 *  nextOrdinal, and the loser's chat_sync_points insert dies on the (chat_id, ordinal) unique
 *  constraint (observed 2026-08-09 on chat 3ffceed3: "sync_point: duplicate key value violates
 *  unique constraint chat_sync_points_chat_id_ordinal_key"). Skip, don't queue: the next tick
 *  re-reads and only picks the chat up again if the committed pass left work behind. Module-level
 *  in-memory only, same lifetime as the timer — a process bounce drops the set and the next tick
 *  re-plans, which is the restart tolerance the tick already has. Mirrors cleanupLoop.ts's own
 *  inFlightRepairs guard, which fixed the same runaway on the cleanup lane. */
const inFlightSyncs = new Set<string>();

// Tags which named stage of runOneChatSync threw, so chat_memory_sync_status (bi_principles.md
// §11 — the read surface for this pipeline's existing log-only failure seams) can record *which*
// step broke, not just that something did.
class SyncStepError extends Error {
  readonly step: string;
  constructor(step: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.step = step;
    this.cause = cause;
  }
}

async function step<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new SyncStepError(name, err);
  }
}

type SyncResult =
  | { status: 'skipped' }
  | { status: 'ok'; chunksAdded: number; entriesUpdated: number };

// Written through deps.db directly (a fresh transaction), never the `session` runOneChatSync ran
// its own work through — so this record survives even when that work's transaction rolled back.
async function recordSyncStatus(
  db: PostgresClient,
  userId: string,
  chatId: string,
  outcome: SyncResult | { status: 'error'; step: string; error: string },
): Promise<void> {
  await db.withUserScope(userId, (session) => {
    if (outcome.status === 'error') {
      return session.query(
        `insert into chat_memory_sync_status (chat_id, user_id, last_attempt_at, last_status, last_step, last_error, consecutive_errors)
         values ($1, $2, now(), 'error', $3, $4, 1)
         on conflict (chat_id) do update set
           last_attempt_at = excluded.last_attempt_at, last_status = 'error',
           last_step = excluded.last_step, last_error = excluded.last_error,
           consecutive_errors = chat_memory_sync_status.consecutive_errors + 1`,
        [chatId, userId, outcome.step, outcome.error],
      );
    }
    if (outcome.status === 'skipped') {
      return session.query(
        `insert into chat_memory_sync_status (chat_id, user_id, last_attempt_at, last_status)
         values ($1, $2, now(), 'skipped')
         on conflict (chat_id) do update set
           last_attempt_at = excluded.last_attempt_at, last_status = 'skipped',
           last_step = null, last_error = null`,
        [chatId, userId],
      );
    }
    return session.query(
      `insert into chat_memory_sync_status
         (chat_id, user_id, last_attempt_at, last_status, last_success_at, last_chunks_added, last_entries_updated, consecutive_errors)
       values ($1, $2, now(), 'ok', now(), $3, $4, 0)
       on conflict (chat_id) do update set
         last_attempt_at = excluded.last_attempt_at, last_status = 'ok', last_step = null, last_error = null,
         last_success_at = excluded.last_success_at, last_chunks_added = excluded.last_chunks_added,
         last_entries_updated = excluded.last_entries_updated, consecutive_errors = 0`,
      [chatId, userId, outcome.chunksAdded, outcome.entriesUpdated],
    );
  });
}

export interface ChatMemorySyncDeps {
  db: PostgresClient;
  llm: LlmProvider;
  embeddings: EmbeddingProvider;
  settings: OrchestratorSettingsStore;
  llmConnections: LlmConnectionStore;
}

interface UserRow {
  user_id: string;
}

interface DueChatRow {
  chat_id: string;
}

interface SyncSettings {
  llm: LlmProvider;
  chunkSummaryPrompt: string | undefined;
  distillPrompt: string | undefined;
  householdMemoryPrompt: string | undefined;
  bridgePrompt: string | undefined;
  worldCuratorPrompt: string | undefined;
  peopleCuratorPrompt: string | undefined;
  personaName: string | undefined;
  liveWindowMessages: number;
  syncEveryMessages: number;
  digestHorizonChunks: number;
  /** Live chat_memory_chunk_pairs (fallback DEFAULT_CHUNK_PAIRS) — turn-pairs per archived chunk. */
  pairsPerChunk: number;
}

function toPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function resolveSyncSettings(deps: ChatMemorySyncDeps, userId: string | undefined, chatId?: string): Promise<SyncSettings> {
  const [
    livePairsRaw,
    syncEveryPairsRaw,
    digestHorizonPairsRaw,
    chunkPairsRaw,
    chunkSummaryPrompt,
    distillPrompt,
    householdMemoryPrompt,
    bridgePrompt,
    worldCuratorPrompt,
    peopleCuratorPrompt,
    personaName,
  ] = await Promise.all([
    deps.settings.get('chat_memory_live_window_pairs'),
    deps.settings.get('chat_memory_sync_every_pairs'),
    deps.settings.get('chat_memory_digest_horizon_pairs'),
    deps.settings.get('chat_memory_chunk_pairs'),
    deps.settings.get('chat_memory_chunk_summary_prompt'),
    deps.settings.get('chat_memory_distill_prompt'),
    deps.settings.get('chat_memory_household_memory_prompt'),
    deps.settings.get('chat_memory_bridge_prompt'),
    deps.settings.get('chat_memory_world_curator_prompt'),
    deps.settings.get('chat_memory_people_curator_prompt'),
    deps.settings.get('persona_name'),
  ]);

  const chatProfile = chatId && userId
    ? await deps.db.withUserScope(userId, async (session) => {
        const rows = await session.query<{ profile: string | null }>(
          `select params->>'profile' as profile from chat_sessions where chat_id = $1`,
          [chatId],
        );
        return rows[0]?.profile ?? undefined;
      })
    : undefined;
  const requestedProfile = chatProfile;
  let llm = deps.llm;
  if (chatId && !requestedProfile) {
    const active = await deps.llmConnections.resolveActive();
    if (!active) throw new Error(`chat ${chatId} has no selected connection and no active connection exists`);
    llm = createGatedLlmProvider(createLlmProviderForProfile(active), deps.db, deps.settings, active);
  }
  if (requestedProfile) {
    const profile = await deps.llmConnections.resolveByName(requestedProfile);
    if (profile) {
      llm = createGatedLlmProvider(createLlmProviderForProfile(profile), deps.db, deps.settings, profile);
    } else {
      throw new Error(`chat ${chatId} names unknown connection "${requestedProfile}"; sync refused to use another connection`);
    }
  }

  const livePairs = toPositiveInt(livePairsRaw, DEFAULT_LIVE_WINDOW_PAIRS);
  const syncEveryPairs = toPositiveInt(syncEveryPairsRaw, DEFAULT_SYNC_EVERY_PAIRS);
  const digestHorizonPairs = toPositiveInt(digestHorizonPairsRaw, DEFAULT_DIGEST_HORIZON_PAIRS);
  // Live chunk size in turn-pairs (docs/plans/completed/chunk-size-resize-plan.md) — the chunker's
  // message count is this × 2. Fallback DEFAULT_CHUNK_PAIRS = today's hardcoded 4-message chunk.
  const pairsPerChunk = toPositiveInt(chunkPairsRaw, DEFAULT_CHUNK_PAIRS);

  return {
    llm,
    chunkSummaryPrompt: chunkSummaryPrompt || undefined,
    distillPrompt: distillPrompt || undefined,
    householdMemoryPrompt: householdMemoryPrompt || undefined,
    bridgePrompt: bridgePrompt || undefined,
    worldCuratorPrompt: worldCuratorPrompt || undefined,
    peopleCuratorPrompt: peopleCuratorPrompt || undefined,
    personaName: personaName || undefined,
    liveWindowMessages: livePairs * 2,
    syncEveryMessages: syncEveryPairs * 2,
    digestHorizonChunks: Math.ceil(digestHorizonPairs / pairsPerChunk),
    pairsPerChunk,
  };
}

async function findDueChats(db: PostgresClient, userId: string, syncEveryMessages: number, liveWindowMessages: number): Promise<string[]> {
  return db.withUserScope(userId, async (session) => {
    // "Due" = unsynced messages (past the last sync point's anchor message, or all of them if
    // never synced) exceed the live window by at least a full sync-window's worth. This is a rough
    // candidate filter only — runOneChatSync's own JS-side slicing (message_id-tiebreak-aware,
    // matching io/chatSessions.ts's own ordering) is the authoritative source of what actually gets
    // archived, and simply no-ops if this filter ever over-selects a chat that isn't really due.
    // archived_at excludes an already-archived chat from ongoing rolling sync entirely — its
    // history is done changing.
    const rows = await session.query<DueChatRow>(
      `select cs.chat_id
       from chat_sessions cs
       left join chat_sync_points sp on sp.chat_id = cs.chat_id
         and sp.ordinal = (select max(ordinal) from chat_sync_points where chat_id = cs.chat_id and closed_at is not null)
       left join chat_messages anchor on anchor.message_id = sp.last_message_id
       where cs.archived_at is null
         and (
           select count(*) from chat_messages m
           where m.chat_id = cs.chat_id and (anchor.created_at is null or m.created_at > anchor.created_at)
         ) >= $1`,
      [syncEveryMessages + liveWindowMessages],
    );
    return rows.map((r) => r.chat_id);
  });
}

/**
 * Turn-start indices into `messages`: a boundary is the first user message of the chat, or any
 * later user message that arrives after at least one assistant reply since the previous boundary.
 * Consecutive user messages with no assistant reply between them share one boundary — they're still
 * the same open turn, not a new one — and a leading assistant-only message (a seeded greeting) never
 * gets a boundary of its own, so it's never orphaned as its own chunk.
 *
 * Exported: eagerChunkSync.ts derives its eligibility in the same turn units through this same
 * function (docs/plans/eager-chunk-sync-plan.md — the seeded greeting is folded into turn 1 by
 * this rule, never its own turn, pair, chunk, or live-window slot).
 */
export function findTurnBoundaries(messages: { role: 'user' | 'assistant' }[]): number[] {
  const boundaries: number[] = [];
  let sawAssistantSinceLastBoundary = false;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === 'user') {
      if (boundaries.length === 0 || sawAssistantSinceLastBoundary) {
        boundaries.push(i);
        sawAssistantSinceLastBoundary = false;
      }
    } else {
      sawAssistantSinceLastBoundary = true;
    }
  }
  return boundaries;
}

interface ExistingEntryRow {
  topic_key: string;
  content: string;
}

// canon_facts.entity_key for a curator-produced person/place/thing/concept entry — category-
// prefixed so a person and a thing that happen to share a name (or a curator-hallucinated name
// collision) never fold into the same dedup group; recallCanonFactsTool.ts's dedup is otherwise
// purely name-keyed. Not exported: only curateWorldMemory/curatePeople's inserts below need it.
function entityKeyFor(category: string, name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${category}:${slug || 'unnamed'}`;
}

async function runOneChatSync(deps: ChatMemorySyncDeps, sync: SyncSettings, userId: string, chatId: string): Promise<SyncResult> {
  // In-flight guard: at most one sync pass per chat at a time. Skip, don't queue — see
  // inFlightSyncs' own doc (and cleanupLoop.ts's inFlightRepairs, the same fix on the cleanup
  // lane). The chat stays 'due' to the next tick if this pass left work behind, so skipping here
  // only delays the re-run by one poll interval, never loses it.
  if (inFlightSyncs.has(chatId)) {
    log.debug(`chat-memory sync: chat ${chatId} already being synced, skipping this tick`);
    return { status: 'skipped' };
  }
  inFlightSyncs.add(chatId);
  return runWithCallContext({ taskId: chatId, kind: 'system', userId }, () =>
    deps.db.withUserScope(userId, async (session): Promise<SyncResult> => {
      // Per-chat advisory lock: serializes same-chat passes at the DB even if the in-memory
      // guard above is ever bypassed (a second orchestrator process, a future caller). First
      // statement of the transaction, so a concurrent pass blocks HERE before any read — under
      // READ COMMITTED its subsequent reads then see the winner's committed sync point and
      // compute a fresh nextOrdinal instead of colliding on the same one. The unique
      // (chat_id, ordinal) constraint stays as the final backstop, last-resort only.
      await session.query('select pg_advisory_xact_lock(hashtext($1))', [chatId]);
      // Canon facts auto-approve at the chat's next sync tick (the user's explicit call — no
      // manual approval gate) rather than at write time, giving a brief settling window before a
      // proposal goes live. Runs first, unconditionally for any chat this function is called for
      // — not gated behind the chunk-eligibility check below, so a quiet chat with only a couple
      // of proposed facts still gets them promoted on schedule instead of waiting on enough new
      // messages to trigger a real chunking pass. Same transaction as the rest of the tick: a
      // failure later in this function rolls the promotion back too, and the (idempotent) retry
      // next tick picks it back up.
      const promoted = await step('promote_canon_facts', () =>
        session.query<{ fact_id: string }>(
          `update canon_facts set status = 'approved', approved_at = now()
           where chat_id = $1 and status = 'proposed'
           returning fact_id`,
          [chatId],
        ),
      );
      if (promoted.length > 0) {
        log.info('chat-memory sync: auto-approved canon facts', { chatId, count: promoted.length });
      }

      const [chatRow] = await session.query<{ kind: 'chat' | 'rp' }>('select kind from chat_sessions where chat_id = $1', [chatId]);
      const kind = chatRow?.kind ?? 'chat';

      const allMessages = await session.query<{
        message_id: string;
        role: 'user' | 'assistant';
        content: string;
        active_swipe_id: string | null;
      }>(
        'select message_id, role, content, active_swipe_id from chat_messages where chat_id = $1 order by created_at, message_id',
        [chatId],
      );

      const lastSynced = await session.query<{ last_message_id: string; ordinal: number }>(
        'select last_message_id, ordinal from chat_sync_points where chat_id = $1 and closed_at is not null order by ordinal desc limit 1',
        [chatId],
      );
      const lastSyncedIdx = lastSynced[0] ? allMessages.findIndex((m) => m.message_id === lastSynced[0]!.last_message_id) : -1;

      // The eager chunk path (docs/plans/eager-chunk-sync-plan.md) may have opened a chunk-only
      // sync point (`closed_at` null) and chunked some of this window already. At most one open
      // point can exist by construction (only the eager path opens one, only this tick closes it,
      // both under the same advisory lock). The tick reuses it (same sync_id for the
      // digest/bridge/curator writes) and closes it at the end; its own chunking step below must
      // top up only what eager chunking didn't cover, never re-chunk the open point's span.
      const [openPoint] = await session.query<{ sync_id: string; last_message_id: string; ordinal: number }>(
        'select sync_id, last_message_id, ordinal from chat_sync_points where chat_id = $1 and closed_at is null order by ordinal desc limit 1',
        [chatId],
      );
      const openPointIdx = openPoint ? allMessages.findIndex((m) => m.message_id === openPoint.last_message_id) : -1;

      // A "turn" starts at a user message and runs through every message after it up to (but not
      // including) the next user message that arrives once at least one assistant reply has landed
      // — so a user message sent again before the assistant has answered (nothing generates that
      // today, but a future "continue" affordance could) doesn't open a second turn on its own.
      // applyCharacterToChatTool.ts's seeded opening greeting is a lone leading 'assistant' message
      // with no user turn of its own; findTurnBoundaries() never marks a boundary there, so it just
      // rides along inside whichever chunk turn 1 ends up in — the "first turn always rolls into the
      // first chunk" case falls out of this rule for free, no extra special-casing needed.
      const turnBoundaries = findTurnBoundaries(allMessages);
      const unsyncedBoundaries = turnBoundaries.filter((idx) => idx > lastSyncedIdx);
      const unsynced = allMessages.slice(lastSyncedIdx + 1);

      const pairsPerChunk = sync.pairsPerChunk;
      const liveWindowPairs = sync.liveWindowMessages / 2;
      const eligibleTurns = unsyncedBoundaries.length - liveWindowPairs;
      const turnsToArchive = eligibleTurns - (eligibleTurns % pairsPerChunk);
      if (turnsToArchive < pairsPerChunk) {
        log.info('chat-memory sync: nothing eligible to archive yet, skipping', { chatId, unsynced: unsynced.length });
        return { status: 'skipped' };
      }
      // The message right before the (turnsToArchive)-th unsynced turn boundary — everything up to
      // there (including the leading greeting, if any) archives; everything from there on stays live.
      const archiveEndIdx = turnsToArchive < unsyncedBoundaries.length ? unsyncedBoundaries[turnsToArchive]! : allMessages.length;
      const toArchiveRows = allMessages.slice(lastSyncedIdx + 1, archiveEndIdx);
      const toArchive: ChatTranscriptMessage[] = toArchiveRows.map((m) => ({
        messageId: m.message_id,
        role: m.role,
        content: m.content,
      }));

      // The tick's own chunking step is a top-up when an open sync point exists: only the span the
      // eager path hasn't chunked yet (after the open point's anchor) feeds chunkChatTranscript,
      // never the whole consolidation span — re-chunking the open point's covered messages would
      // duplicate their content under new ordinals (unique (chat_id, ordinal) stops two rows
      // sharing an ordinal, not two ordinals covering the same message). The consolidation span
      // above (toArchive) stays the digest/bridge/curator boundary — an open point's anchor is
      // chunking progress, not consolidation progress.
      const chunkInput: ChatTranscriptMessage[] =
        openPoint && openPointIdx >= 0
          ? allMessages.slice(openPointIdx + 1, archiveEndIdx).map((m) => ({
              messageId: m.message_id,
              role: m.role,
              content: m.content,
            }))
          : toArchive;

      // docs/plans/vistalyze_integration/segway.md §2.5 (location_status.md §3 Steps 1-2, generalized to
      // characters): the transient location/character rows the post-cleanup scraper anchored to
      // the messages leaving the live window settle here, in the same tick that already
      // auto-approves canon facts. Continuing play on a swipe is the user's explicit signal that
      // its timeline happened (bi_principles.md §3), so the active swipe's rows promote to
      // permanent and every alternate swipe's rows demote to inactive — never deleted. A message
      // with no active swipe (e.g. a greeting inserted outside the scrape path) anchors nothing,
      // so it's a no-op.
      //
      // db/migrations/0096: anchor_swipe_id now lives on location_chat_links/character_chat_links,
      // not on the row itself, and promotion must NOT clear it (that used to sever the row's only
      // FK path back to its chat, leaving promoted rows undeletable — the bug this migration
      // fixed). status is purely "settled vs. still in the live editing window" now; the link row
      // (and its chat_id) is what keeps the row chat-scoped regardless of status.
      await step('settle_transient_records', async () => {
        let promotedLocations = 0;
        let promotedCharacters = 0;
        let demotedLocations = 0;
        let demotedCharacters = 0;
        for (const m of toArchiveRows) {
          if (!m.active_swipe_id) continue;
          const promotedLoc = await session.query<{ location_id: string }>(
            `update locations set status = 'permanent', updated_at = now()
             where user_id = $1 and status = 'transient' and location_id in (
               select location_id from location_chat_links where anchor_swipe_id = $2
             )
             returning location_id`,
            [userId, m.active_swipe_id],
          );
          promotedLocations += promotedLoc.length;
          const promotedChar = await session.query<{ character_id: string }>(
            `update characters set status = 'permanent', updated_at = now()
             where user_id = $1 and status = 'transient' and character_id in (
               select character_id from character_chat_links where anchor_swipe_id = $2
             )
             returning character_id`,
            [userId, m.active_swipe_id],
          );
          promotedCharacters += promotedChar.length;
          const demotedLoc = await session.query<{ location_id: string }>(
            `update locations set status = 'inactive', updated_at = now()
             where user_id = $1 and status = 'transient' and location_id in (
               select location_id from location_chat_links where anchor_swipe_id in (
                 select swipe_id from chat_message_swipes where message_id = $2 and swipe_id <> $3
               )
             )
             returning location_id`,
            [userId, m.message_id, m.active_swipe_id],
          );
          demotedLocations += demotedLoc.length;
          const demotedChar = await session.query<{ character_id: string }>(
            `update characters set status = 'inactive', updated_at = now()
             where user_id = $1 and status = 'transient' and character_id in (
               select character_id from character_chat_links where anchor_swipe_id in (
                 select swipe_id from chat_message_swipes where message_id = $2 and swipe_id <> $3
               )
             )
             returning character_id`,
            [userId, m.message_id, m.active_swipe_id],
          );
          demotedCharacters += demotedChar.length;
        }
        if (promotedLocations + promotedCharacters + demotedLocations + demotedCharacters > 0) {
          log.info('chat-memory sync: settled transient location/character records', {
            chatId,
            promotedLocations,
            promotedCharacters,
            demotedLocations,
            demotedCharacters,
          });
        }
      });

      const chunks = await step('chunk', async () => {
        const [existingChunkCount] = await session.query<{ n: string }>(
          'select count(*)::text as n from chat_chunks where chat_id = $1',
          [chatId],
        );
        const startOrdinal = Number(existingChunkCount?.n ?? '0');
        return chunkChatTranscript(chunkInput, startOrdinal, pairsPerChunk * 2);
      });

      const { summaries, vectors, summaryVectors } = await step('summarize_embed', async () => {
        const summaries = await withCallLabel('sync:chunk-summary', () =>
          Promise.all(chunks.map((c) => summarizeChatChunk(sync.llm, c.content, sync.chunkSummaryPrompt))),
        );
        const vectors = await deps.embeddings.embed(chunks.map((c) => c.content));
        // Stage 5 of the CNZ retrieval port (docs/plans/completed/rag-dynamic-cutoff-plan.md): the header
        // lane — embed each chunk's summary too, into chat_chunks.summary_vector_embed
        // (migration 0094). recallForPrompt.ts's chunk path fuses the content and summary lanes
        // with best-of scoring + Canonize's 1.08× dual-confirmation bonus. Chunks written
        // before 0094 have a NULL summary_vector_embed and stay content-lane-only.
        const summaryVectors = await deps.embeddings.embed(summaries);
        return { summaries, vectors, summaryVectors };
      });

      const nextOrdinal = (lastSynced[0]?.ordinal ?? -1) + 1;
      const syncId = await step('sync_point', async () => {
        if (openPoint) {
          // Reuse-then-close: the point eager chunking opened gets this tick's own consolidation
          // boundary (archiveEnd) and closes. The last_message_id update only runs on this reuse
          // path — the fresh insert below already lands the final value, and writing it on a
          // no-op would risk tripping chat_sync_points' unique (chat_id, last_message_id).
          await session.query('update chat_sync_points set last_message_id = $2, closed_at = now() where sync_id = $1', [
            openPoint.sync_id,
            toArchive[toArchive.length - 1]!.messageId,
          ]);
          return openPoint.sync_id;
        }
        const [syncPoint] = await session.query<{ sync_id: string }>(
          `insert into chat_sync_points (chat_id, user_id, ordinal, last_message_id, closed_at) values ($1, $2, $3, $4, now())
           returning sync_id`,
          [chatId, userId, nextOrdinal, toArchive[toArchive.length - 1]!.messageId],
        );
        return syncPoint!.sync_id;
      });

      await step('insert_chunks', async () => {
        // Lead-in chain (docs/plans/chunk-lead-in-context-plan.md): the batch's first chunk
        // links to the chat's current max-ordinal row (null when the chat has no chunks yet —
        // it becomes the chain head), each subsequent chunk links to the previously inserted
        // row of the batch. We're inside the per-chat advisory lock (and the same transaction),
        // so the read-then-insert is race-free; parent_chunk_id is never inferred from ordinal.
        const [prevChunk] = await session.query<{ chunk_id: string }>(
          'select chunk_id from chat_chunks where chat_id = $1 order by ordinal desc limit 1',
          [chatId],
        );
        let parentChunkId: string | null = prevChunk?.chunk_id ?? null;
        for (const [i, chunk] of chunks.entries()) {
          const [inserted]: { chunk_id: string }[] = await session.query<{ chunk_id: string }>(
            `insert into chat_chunks (chat_id, sync_id, user_id, ordinal, content, summary, vector_embed, summary_vector_embed, parent_chunk_id)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             returning chunk_id`,
            [chatId, syncId, userId, chunk.ordinal, chunk.content, summaries[i], toPgVectorLiteral(vectors[i]!), toPgVectorLiteral(summaryVectors[i]!), parentChunkId],
          );
          parentChunkId = inserted!.chunk_id;
        }
      });

      // The two lanes diverge here — a 'chat' (household) chat gets the flat key-ideas digest
      // (distillChatMemory.ts, fed only the compressed chunk summaries above); an 'rp' chat gets
      // the hookseeker-parity bridge (bridgeChatMemory.ts, fed the RAW toArchive transcript
      // directly, never a summary-of-summary). The two prompts/topic_key vocabularies are mutually
      // exclusive per chat, selected once by chat_sessions.kind — see this file's own header doc.
      if (kind === 'rp') {
        // Shared by the bridge and both curator calls below — one raw transcript of this sync
        // window's toArchive messages, never a summary-of-summary, same "read the real thing every
        // time" property as the bridge's own doc explains.
        const transcriptText = toArchive.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');

        const bridgeResult = await step('bridge', async () => {
          const previousRows = await session.query<{ topic_key: string; content: string }>(
            `select topic_key, content from chat_memory_entries where chat_id = $1 and topic_key in ('scene', 'events')`,
            [chatId],
          );
          const previousScene = previousRows.find((r) => r.topic_key === 'scene')?.content ?? '';
          const previousEvents = previousRows.find((r) => r.topic_key === 'events')?.content ?? '';
          // Reconstructs CNZ's own "PREVIOUS OUTPUT" shape (an EVENTS table followed by a SCENE
          // block) — the bridge's own PART 1/PART 2 instructions read this back as one blob, the
          // same way its live output looked the sync before.
          const previousOutput = previousScene || previousEvents ? `EVENTS:\n${previousEvents}\n\nSCENE:\n${previousScene}` : '';

          // Latest-approved-per-arc_tag, mirroring recallCanonFactsTool.ts's own dedup query — every
          // plot arc_tag is unique by the canon_facts table's own CHECK, so no coalesce needed here.
          const openThreadRows = await session.query<{ arc_tag: string; summary: string; detail: string }>(
            `select distinct on (arc_tag) arc_tag, summary, detail
             from canon_facts
             where chat_id = $1 and category = 'plot' and status = 'approved'
             order by arc_tag, proposed_at desc`,
            [chatId],
          );
          const existingThreads = openThreadRows
            .map((r) => `- #${r.arc_tag}: ${r.summary}${r.detail ? ` — ${r.detail}` : ''}`)
            .join('\n');

          return withCallLabel('sync:bridge', () =>
            bridgeChatMemory(sync.llm, transcriptText, previousOutput, existingThreads, sync.personaName, sync.bridgePrompt),
          );
        });

        await step('upsert_bridge', async () => {
          await session.query(
            `insert into chat_memory_entries (chat_id, sync_id, user_id, topic_key, content)
             values ($1, $2, $3, 'scene', $4)
             on conflict (chat_id, topic_key) do update set
               sync_id = excluded.sync_id, content = excluded.content, updated_at = now()`,
            [chatId, syncId, userId, bridgeResult.scene],
          );
          await session.query(
            `insert into chat_memory_entries (chat_id, sync_id, user_id, topic_key, content)
             values ($1, $2, $3, 'events', $4)
             on conflict (chat_id, topic_key) do update set
               sync_id = excluded.sync_id, content = excluded.content, updated_at = now()`,
            [chatId, syncId, userId, bridgeResult.events],
          );
          // Proposed, not approved — these go through the exact same settling-window auto-approve
          // (this function's own promote_canon_facts step, next tick) as every other canon fact, no
          // special-casing. summary carries the actual 2-4 sentence development (what
          // recall_canon_facts/CanonQueueView show as the fact itself); detail carries the bridge's
          // vivid entry name (a scannable label, secondary).
          for (const entry of bridgeResult.plotEntries) {
            const [vector] = await deps.embeddings.embed([`${entry.name}\n${entry.content}`]);
            await session.query(
              `insert into canon_facts (user_id, category, arc_tag, summary, detail, vector_embed, chat_id, sync_id)
               values ($1, 'plot', $2, $3, $4, $5, $6, $7)`,
              [userId, entry.arcTag, entry.content, entry.name, toPgVectorLiteral(vector!), chatId, syncId],
            );
          }
          // The fully-rendered bridge prompt this pass actually sent the model (0079): the sync
          // point is inserted before the bridge runs (entries need its id), so the prompt lands
          // as an UPDATE on the same transaction — a rollback takes both together.
          await session.query('update chat_sync_points set bridge_prompt = $2 where sync_id = $1', [
            syncId,
            bridgeResult.prompt,
          ]);
        });

        // The two periodic curators (place/thing/concept, and person) run every tick alongside the
        // bridge, over the same transcriptText — CNZ's own real per-cycle cost, not a simplification.
        // Both propose 'proposed' canon_facts rows keyed by entity_key (db/migrations/
        // 0064_canon_facts_entity_key.sql), settling through this function's own promote_canon_facts
        // step next tick, zero special-casing, same as the bridge's plot entries above.
        const worldMemoryResult = await step('curate_world_memory', async () => {
          const existingRows = await session.query<{ category: string; detail: string; summary: string }>(
            `select distinct on (entity_key) category, detail, summary
             from canon_facts
             where chat_id = $1 and category in ('place', 'thing', 'concept') and status = 'approved'
             order by entity_key, proposed_at desc`,
            [chatId],
          );
          const existingBlock = existingRows.map((r) => `**${r.detail}**\n${r.summary}\n#${r.category}`).join('\n\n');
          const entries = await withCallLabel('sync:world-memory', () =>
            curateWorldMemory(sync.llm, transcriptText, existingBlock, sync.worldCuratorPrompt),
          );
          return { entries, existingRows };
        });

        await step('upsert_world_memory', async () => {
          // A 'duplicate' action carries no category of its own — it's flagging an *existing* entry
          // (one of existingRows) as redundant, so its category comes from that row, not the model.
          const categoryByName = new Map(worldMemoryResult.existingRows.map((r) => [r.detail.trim().toLowerCase(), r.category]));
          for (const entry of worldMemoryResult.entries) {
            const category = entry.action === 'duplicate' ? categoryByName.get(entry.name.trim().toLowerCase()) : entry.category;
            const content = entry.action === 'duplicate' ? `Duplicate of ${entry.duplicateOf ?? 'another entry'}.` : entry.content;
            if (!category || !content) {
              log.error('chat-memory sync: world-memory curator entry missing category/content, skipping', { chatId, entry });
              continue;
            }
            const [vector] = await deps.embeddings.embed([`${entry.name}\n${content}`]);
            await session.query(
              `insert into canon_facts (user_id, category, entity_key, summary, detail, vector_embed, chat_id, sync_id)
               values ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [userId, category, entityKeyFor(category, entry.name), content, entry.name, toPgVectorLiteral(vector!), chatId, syncId],
            );
          }
        });

        const peopleResult = await step('curate_people', async () => {
          const existingRows = await session.query<{ detail: string; summary: string }>(
            `select distinct on (entity_key) detail, summary
             from canon_facts
             where chat_id = $1 and category = 'person' and status = 'approved'
             order by entity_key, proposed_at desc`,
            [chatId],
          );
          const existingBlock = existingRows.map((r) => `**${r.detail}**\n${r.summary}`).join('\n\n');
          return withCallLabel('sync:people', () =>
            curatePeople(sync.llm, transcriptText, existingBlock, sync.personaName, sync.peopleCuratorPrompt),
          );
        });

        await step('upsert_people', async () => {
          for (const entry of peopleResult) {
            const content = entry.action === 'duplicate' ? `Duplicate of ${entry.duplicateOf ?? 'another entry'}.` : entry.content;
            if (!content) {
              log.error('chat-memory sync: people curator entry missing content, skipping', { chatId, entry });
              continue;
            }
            const [vector] = await deps.embeddings.embed([`${entry.name}\n${content}`]);
            await session.query(
              `insert into canon_facts (user_id, category, entity_key, summary, detail, vector_embed, chat_id, sync_id)
               values ($1, 'person', $2, $3, $4, $5, $6, $7)`,
              [userId, entityKeyFor('person', entry.name), content, entry.name, toPgVectorLiteral(vector!), chatId, syncId],
            );
            // character-appearance-field-plan.md: the curator-side half of the frozen-once-set
            // rule — a non-empty `appearance` from this entry writes back onto the matching
            // `characters` row, but only when that row's own appearance is still empty (a
            // character describeCharacter.ts already filled, or the operator authored, is left
            // alone — bi_principles.md §3). The lookup is a plain exact case-insensitive name
            // match: a miss (the curator's strict two-word naming diverging from the scraped
            // row's name) just skips the write-back for this tick, never blocks or fails the
            // sync. The write is a no-op idempotent check every tick either way.
            const appearance = entry.appearance?.trim();
            if (appearance) {
              const [charRow] = await session.query<{ character_id: string; appearance: string }>(
                `select character_id, appearance from characters
                 where user_id = $1 and lower(name) = lower($2)`,
                [userId, entry.name],
              );
              if (charRow && charRow.appearance.trim() === '') {
                await session.query(
                  `update characters set appearance = $3, updated_at = now()
                   where character_id = $1 and user_id = $2`,
                  [charRow.character_id, userId, appearance],
                );
                log.info('chat-memory sync: people curator appearance written onto characters', {
                  chatId,
                  characterId: charRow.character_id,
                  entryName: entry.name,
                });
              }
            }
          }
        });

        const entriesUpdated = 2 + bridgeResult.plotEntries.length + worldMemoryResult.entries.length + peopleResult.length;
        log.info('chat-memory sync: bridged rp chat', {
          chatId,
          chunksAdded: chunks.length,
          plotEntries: bridgeResult.plotEntries.length,
          worldMemoryEntries: worldMemoryResult.entries.length,
          peopleEntries: peopleResult.length,
        });
        return { status: 'ok', chunksAdded: chunks.length, entriesUpdated };
      }

      const updates = await step('distill', async () => {
        const existingEntries = await session.query<ExistingEntryRow>(
          'select topic_key, content from chat_memory_entries where chat_id = $1',
          [chatId],
        );
        const drafts: ChatMemoryEntryDraft[] = existingEntries.map((e) => ({ topicKey: e.topic_key, content: e.content }));

        // Widen beyond just this tick's brand-new chunks: re-read the trailing digest-horizon of
        // chat_chunks.summary (oldest first), so a cross-sync-boundary idea gets more than one
        // chunk's worth of chance to register before it ages out — this platform's analogue of
        // Canonize's own bridge-summary horizon re-read.
        const horizonRows = await session.query<{ summary: string }>(
          'select summary from chat_chunks where chat_id = $1 order by ordinal desc limit $2',
          [chatId, sync.digestHorizonChunks],
        );
        const horizonSummaries = horizonRows.map((r) => r.summary).reverse();

        return withCallLabel('sync:distill', () =>
          distillChatMemory(sync.llm, drafts, horizonSummaries, sync.distillPrompt),
        );
      });

      await step('upsert_entries', async () => {
        for (const entry of updates) {
          await session.query(
            `insert into chat_memory_entries (chat_id, sync_id, user_id, topic_key, content)
             values ($1, $2, $3, $4, $5)
             on conflict (chat_id, topic_key) do update set
               sync_id = excluded.sync_id, content = excluded.content, updated_at = now()`,
            [chatId, syncId, userId, entry.topicKey, entry.content],
          );
        }
      });

      log.info('chat-memory sync: synced chat', { chatId, chunksAdded: chunks.length, entriesUpdated: updates.length });
      return { status: 'ok', chunksAdded: chunks.length, entriesUpdated: updates.length };
    }),
  ).finally(() => {
    // The guard is per chat: drop it once the pass is done, whatever happened (committed, skipped
    // after the eligibility check, or the transaction rolled back mid-pipeline). A chat whose
    // pass left work uncovered is legitimately picked up by the next tick — but as a new pass,
    // not as a parallel twin of this one.
    inFlightSyncs.delete(chatId);
  });
}

export async function runChatMemorySyncTick(deps: ChatMemorySyncDeps): Promise<void> {
  const defaults = await resolveSyncSettings(deps, undefined);
  const users = await deps.db.withSystemScope((session) => session.query<UserRow>('select user_id from users'));
  for (const { user_id: userId } of users) {
    const due = await findDueChats(deps.db, userId, defaults.syncEveryMessages, defaults.liveWindowMessages);
    for (const chatId of due) {
      try {
        const sync = await resolveSyncSettings(deps, userId, chatId);
        const result = await runOneChatSync(deps, sync, userId, chatId);
        await recordSyncStatus(deps.db, userId, chatId, result);
      } catch (err) {
        log.error('chat-memory sync: sync failed for one chat, will retry next tick', { chatId, err });
        const step = err instanceof SyncStepError ? err.step : 'unknown';
        const message = err instanceof Error ? err.message : String(err);
        await recordSyncStatus(deps.db, userId, chatId, { status: 'error', step, error: message });
      }
    }
  }
}

export function startChatMemorySyncLoop(deps: ChatMemorySyncDeps): void {
  const tick = () => {
    runChatMemorySyncTick(deps).catch((err) => log.error('chat-memory sync tick failed', err));
  };
  tick();
  setInterval(tick, POLL_INTERVAL_MS).unref();
}

/**
 * The end-of-chat long-term-memory extraction — one judgment call over the whole chat's digest,
 * triggered by server/httpServer.ts's archive_chat route immediately after chatSessions.ts's
 * archiveChat stamps archived_at. Not part of the rolling poll tick above: this fires exactly
 * once, on an explicit signal, never inferred from idle time (bb_principles.md §3).
 */
export async function archiveChatMemory(deps: ChatMemorySyncDeps, userId: string, chatId: string, chatTitle: string): Promise<void> {
  const sync = await resolveSyncSettings(deps, userId, chatId);
  await runWithCallContext({ taskId: chatId, kind: 'system', userId }, () =>
    deps.db.withUserScope(userId, async (session) => {
      const entries = await session.query<ExistingEntryRow>(
        'select topic_key, content from chat_memory_entries where chat_id = $1 order by updated_at',
        [chatId],
      );
      const tail = await session.query<{ role: 'user' | 'assistant'; content: string }>(
        'select role, content from chat_messages where chat_id = $1 order by created_at desc, message_id desc limit 20',
        [chatId],
      );
      const digest = [
        `Chat: ${chatTitle}`,
        entries.length ? `Key ideas:\n${entries.map((e) => `- ${e.content}`).join('\n')}` : 'Key ideas: (none recorded)',
        `Most recent messages (newest first):\n${tail.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n')}`,
      ].join('\n\n');

      const memories = await withCallLabel('sync:household-memory', () =>
        classifyHouseholdMemory(sync.llm, digest, sync.householdMemoryPrompt),
      );
      for (const content of memories) {
        await session.query(
          `insert into household_memory (user_id, source_chat_id, content, source) values ($1, $2, $3, 'inferred')`,
          [userId, chatId, content],
        );
      }
      log.info('chat-memory archive: extracted long-term memories', { chatId, count: memories.length });
    }),
  );
}
