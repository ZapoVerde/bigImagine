/**
 * @file orchestrator/src/orchestrator/chatMemorySync.ts
 * @stamp 2026-08-20
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
 * takes effect on the very next tick, no restart. The connection half is resolved exclusively
 * through resolveChatMemoryLlm() (this file's shared resolver, reused by eagerChunkSync.ts and
 * chatChunkResize.ts): chat_memory_profile names the connection (createLlmProviderForProfile +
 * createGatedLlmProvider, the same construction server/httpServer.ts uses for a per-chat override),
 * falling back to the household's active connection when unset or unknown — never a chat's own
 * params->>'profile' (that is the narrator/generation connection, a different configuration
 * domain). persona_name is also read live here, purely to resolve the bridge and people-curator
 * prompts' {{user}} macro (util/interpolateMacros.ts) the same way SillyTavern-Canonize's own
 * {{user}} resolves against the ST persona.
 *
 * distillChatMemory's second argument is not just the chunk summaries this tick freshly produced —
 * it's the trailing chat_memory_digest_horizon_pairs' worth of chat_chunks.summary rows, oldest
 * first, re-read from the DB every sync (this platform's analogue of SillyTavern-Canonize's
 * bridge-summary horizon). The digest's own chat_memory_entries rows already carry state forward
 * across syncs, so this horizon is a revision window on top of that persistence, not the sole
 * source of continuity — see docs/chat-memory.md.
 *
 * @api-declaration
 * resolveChatMemoryLlm(deps) — the shared chat-memory connection resolver (also used by
 *   eagerChunkSync.ts and chatChunkResize.ts): reads the live chat_memory_profile setting and
 *   returns a gated provider on that connection, falling back to the household's active connection
 *   (resolved live) when unset or unknown. Never reads chat_sessions.params->>'profile'.
 * resolveChatMemoryProfile(deps) — the profile half of the above (LlmProfile | undefined), split
 *   out so the failure_signature (chatMemoryProfileSignature) comes from the same resolution the
 *   failing provider ran through.
 * chatMemoryProfileSignature(profile) — kind|model|baseUrl fingerprint, the failure_signature a
 *   permanent sync failure is stamped with (migration 0127).
 * computeChatSyncHealth(input) — pure derivation of a chat's sync health (healthy/warning/blocked)
 *   from its turn boundaries vs. the last closed sync point's anchor and the live/sync window pairs.
 * loadChatSyncHealth(deps, userId, chatId, messages, liveWindowPairs, syncEveryPairs) — the DB
 *   reads behind computeChatSyncHealth, shared by handleChatCompletions's 409 CHAT_SYNC_STALLED
 *   guard and chatSessions.ts's getChatSyncStatus.
 * startChatMemorySyncLoop(deps) — begins polling every POLL_INTERVAL_MS
 * runChatMemorySyncTick(deps) — one poll cycle, exported so verify scripts can drive it directly.
 *   Resolves all settings (including the connection) once per tick; excludes permanently-failing
 *   chats while suppression is active.
 * archiveChatMemory(deps, userId, chatId, chatTitle) — the end-of-chat long-term-memory
 *   extraction, called by server/httpServer.ts's archive_chat route once chatSessions.ts's
 *   archiveChat has stamped archived_at
 *
 * Permanent-failure suppression (bi_principles.md §11 follow-up, migration 0127): a sync pass that
 * fails with a permanent error — a 400/401/403/404 HTTP status, or a real-but-unusable response
 * (io/llm/llmFailureClassify.ts) — would otherwise fail identically every 30s poll tick forever
 * (observed ×1500 consecutive on a dead "No endpoints found for <model>" 404). The catch stamps
 * the chat's chat_memory_sync_status row with last_error_kind='permanent' plus the connection's
 * failure_signature; findDueChats then excludes the chat until either the signature differs (a
 * Settings-tab edit — chat_memory_profile switched, the active connection's model/baseUrl changed —
 * retries on the very next tick) or PERMANENT_FAILURE_RETRY_MS (~30min) elapses. An excluded chat
 * is silently absent (recordSyncStatus is never called for it), preserving the error row — the
 * skipped branch would clear it, and a suppressed failure is not a skip. Recovery needs no locked
 * flag: everything derives from the status row.
 *
 * RP-progression blocking: the frontend turns the same health into a warning/blocked banner, and
 * handleChatCompletions.ts refuses a NEW turn with 409 CHAT_SYNC_STALLED while the chat is
 * blocked (live window + two sync windows behind — one full sync interval of grace past due).
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
import { classifyLlmFailure } from '../io/llm/llmFailureClassify.js';
import type { LlmConnectionStore } from '../io/llmConnections.js';
import { createGatedLlmProvider } from '../io/llm/llmGate.js';
import type { LlmProfile } from '../io/llm/profiles.js';
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

/** How long a suppressed permanent failure stays quiet before the loop tries again even though
 *  nothing about the connection changed — a provider that comes back from the dead without an
 *  operator touching anything deserves another chance eventually, just not every 30s. Far enough
 *  out that the observed ×1500-in-a-row 404 spam (one attempt per 30s poll tick, ~12h of it)
 *  becomes roughly one retry per half hour. A chat_memory_profile/active-connection edit lifts
 *  suppression immediately regardless of this window — see isPermanentFailureSuppressed. */
const PERMANENT_FAILURE_RETRY_MS = 30 * 60_000;

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

/** An error outcome is stamped with the failure's classification and the signature of the
 *  connection it ran through — the two columns the permanent-failure suppression (migration 0127)
 *  reads to decide whether the identical failure should stop hammering every 30s tick. */
interface SyncErrorResult {
  status: 'error';
  step: string;
  error: string;
  kind: 'permanent' | 'transient';
  signature: string;
}

// Written through deps.db directly (a fresh transaction), never the `session` runOneChatSync ran
// its own work through — so this record survives even when that work's transaction rolled back.
async function recordSyncStatus(
  db: PostgresClient,
  userId: string,
  chatId: string,
  outcome: SyncResult | SyncErrorResult,
): Promise<void> {
  await db.withUserScope(userId, (session) => {
    if (outcome.status === 'error') {
      return session.query(
        `insert into chat_memory_sync_status
           (chat_id, user_id, last_attempt_at, last_status, last_step, last_error, last_error_kind, failure_signature, consecutive_errors)
         values ($1, $2, now(), 'error', $3, $4, $5, $6, 1)
         on conflict (chat_id) do update set
           last_attempt_at = excluded.last_attempt_at, last_status = 'error',
           last_step = excluded.last_step, last_error = excluded.last_error,
           last_error_kind = excluded.last_error_kind, failure_signature = excluded.failure_signature,
           consecutive_errors = chat_memory_sync_status.consecutive_errors + 1`,
        [chatId, userId, outcome.step, outcome.error, outcome.kind, outcome.signature],
      );
    }
    if (outcome.status === 'skipped') {
      return session.query(
        `insert into chat_memory_sync_status (chat_id, user_id, last_attempt_at, last_status)
         values ($1, $2, now(), 'skipped')
         on conflict (chat_id) do update set
           last_attempt_at = excluded.last_attempt_at, last_status = 'skipped',
           last_step = null, last_error = null, last_error_kind = null, failure_signature = null`,
        [chatId, userId],
      );
    }
    return session.query(
      `insert into chat_memory_sync_status
         (chat_id, user_id, last_attempt_at, last_status, last_success_at, last_chunks_added, last_entries_updated, consecutive_errors)
       values ($1, $2, now(), 'ok', now(), $3, $4, 0)
       on conflict (chat_id) do update set
         last_attempt_at = excluded.last_attempt_at, last_status = 'ok', last_step = null, last_error = null,
         last_error_kind = null, failure_signature = null,
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
  /** kind|model|baseUrl fingerprint of the connection `llm` runs through (the resolved
   *  chat_memory_profile or the fallback active connection) — the failure_signature a permanent
   *  sync failure gets stamped with (migration 0127), so the suppression retries the moment a
   *  Settings-tab edit changes the connection rather than waiting out PERMANENT_FAILURE_RETRY_MS. */
  profileSignature: string;
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

/** The chat-memory pipeline's connection resolution, shared by this tick, the eager chunk path
 *  (eagerChunkSync.ts), and the chunk-resize backfill (chatChunkResize.ts) — one policy so it
 *  can never drift again. Every chat-memory LLM call resolves exclusively through the live
 *  `chat_memory_profile` setting, never through a chat's own `params->>'profile'` (that is the
 *  narrator/generation connection, a different configuration domain). An unset profile falls back
 *  to the household's active connection, resolved live each call so a Settings-tab activation
 *  switch takes effect without restart. A profile naming a connection that no longer exists logs
 *  clearly and falls back to the active connection too — deliberately NOT the calling chat's
 *  narrator profile. Returns undefined only when neither a profile nor an active connection exists
 *  (resolveChatMemoryLlm then falls back to the process default provider). */
export async function resolveChatMemoryProfile(deps: ChatMemorySyncDeps): Promise<LlmProfile | undefined> {
  const profileName = await deps.settings.get('chat_memory_profile');
  if (profileName) {
    const profile = await deps.llmConnections.resolveByName(profileName);
    if (profile) {
      return profile;
    }
    log.error(`chat-memory: chat_memory_profile names unknown connection "${profileName}" — falling back to the active connection`);
  }
  const active = await deps.llmConnections.resolveActive();
  if (active) {
    return active;
  }
  log.error('chat-memory: no active LLM connection — falling back to the default provider');
  return undefined;
}

/** The failure_signature (migration 0127) for a resolved chat-memory connection: enough of the
 *  connection's identity that a Settings-tab edit (chat_memory_profile switched, the active
 *  connection's model/baseUrl changed) produces a different signature and immediately un-suppresses
 *  a permanent failure, while a cosmetic edit (apiKey rotated, name changed) does not. */
export function chatMemoryProfileSignature(profile: LlmProfile | undefined): string {
  return profile ? `${profile.kind}|${profile.model}|${profile.baseUrl ?? ''}` : 'default';
}

export async function resolveChatMemoryLlm(deps: ChatMemorySyncDeps): Promise<LlmProvider> {
  const profile = await resolveChatMemoryProfile(deps);
  if (profile) {
    return createGatedLlmProvider(createLlmProviderForProfile(profile), deps.db, deps.settings, profile);
  }
  return deps.llm;
}

async function resolveSyncSettings(deps: ChatMemorySyncDeps): Promise<SyncSettings> {
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

  // The whole pipeline's connection, resolved through the shared chat-memory resolver — read
  // live every tick from chat_memory_profile, never from this chat's own params->>'profile' (that
  // is the narrator/generation connection, a different configuration domain). The profile itself
  // is resolved here (not just via resolveChatMemoryLlm) because its kind|model|baseUrl
  // fingerprint is the failure_signature a permanent failure gets stamped with — the signature
  // must come from the same resolution the failing provider ran through, once per tick like the
  // rest of the settings.
  const profile = await resolveChatMemoryProfile(deps);
  const llm = profile
    ? createGatedLlmProvider(createLlmProviderForProfile(profile), deps.db, deps.settings, profile)
    : deps.llm;

  const livePairs = toPositiveInt(livePairsRaw, DEFAULT_LIVE_WINDOW_PAIRS);
  const syncEveryPairs = toPositiveInt(syncEveryPairsRaw, DEFAULT_SYNC_EVERY_PAIRS);
  const digestHorizonPairs = toPositiveInt(digestHorizonPairsRaw, DEFAULT_DIGEST_HORIZON_PAIRS);
  // Live chunk size in turn-pairs (docs/plans/completed/chunk-size-resize-plan.md) — the chunker's
  // message count is this × 2. Fallback DEFAULT_CHUNK_PAIRS = today's hardcoded 4-message chunk.
  const pairsPerChunk = toPositiveInt(chunkPairsRaw, DEFAULT_CHUNK_PAIRS);

  return {
    llm,
    profileSignature: chatMemoryProfileSignature(profile),
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

async function findDueChats(
  db: PostgresClient,
  userId: string,
  syncEveryMessages: number,
  liveWindowMessages: number,
  profileSignature: string,
): Promise<string[]> {
  return db.withUserScope(userId, async (session) => {
    // "Due" = unsynced messages (past the last sync point's anchor message, or all of them if
    // never synced) exceed the live window by at least a full sync-window's worth. This is a rough
    // candidate filter only — runOneChatSync's own JS-side slicing (message_id-tiebreak-aware,
    // matching io/chatSessions.ts's own ordering) is the authoritative source of what actually gets
    // archived, and simply no-ops if this filter ever over-selects a chat that isn't really due.
    // archived_at excludes an already-archived chat from ongoing rolling sync entirely — its
    // history is done changing.
    //
    // Permanent-failure suppression (bi_principles.md §11 follow-up, migration 0127): a chat whose
    // last attempt was a permanent failure (400/401/403/404, or a malformed/empty response) under
    // the SAME connection signature (chat_memory_profile/active-connection identity) is excluded
    // here — folded into the due-filter rather than checked per-chat in the tick so it costs zero
    // extra queries. It was observed hammering a dead "No endpoints found for <model>" 404 once
    // per 30s tick forever (×1500 in a row); this stops that. An excluded chat is silently absent
    // from the loop (never recorded), preserving the error row; suppression lifts when the
    // signature changes (a Settings-tab edit retries on the very next tick) or after
    // PERMANENT_FAILURE_RETRY_MS.
    const rows = await session.query<DueChatRow>(
      `select cs.chat_id
       from chat_sessions cs
       left join chat_sync_points sp on sp.chat_id = cs.chat_id
         and sp.ordinal = (select max(ordinal) from chat_sync_points where chat_id = cs.chat_id and closed_at is not null)
       left join chat_messages anchor on anchor.message_id = sp.last_message_id
       left join chat_memory_sync_status st on st.chat_id = cs.chat_id
       where cs.archived_at is null
         and (
           select count(*) from chat_messages m
           where m.chat_id = cs.chat_id and (anchor.created_at is null or m.created_at > anchor.created_at)
         ) >= $1
         and not (
           st.last_status = 'error' and st.last_error_kind = 'permanent'
           and st.failure_signature = $2
           and now() - st.last_attempt_at < make_interval(secs => $3)
         )`,
      [syncEveryMessages + liveWindowMessages, profileSignature, PERMANENT_FAILURE_RETRY_MS / 1000],
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

/** Machine-readable health of a chat's rolling-memory sync, for the RP chat screen's block/warn
 *  banner (and the server-side 409 CHAT_SYNC_STALLED guard). `state` is derived purely from how
 *  far the chat has fallen behind sync, in turn units (never raw message counts — findTurnBoundaries):
 *
 *  - healthy:    unsyncedTurns below the due threshold — nothing to surface.
 *  - warning:    unsyncedTurns past the due threshold (live window + one sync window) — the chat
 *                can keep advancing, but the banner tells the user sync has fallen behind.
 *  - blocked:    unsyncedTurns past the block threshold (live window + TWO sync windows — one full
 *                sync interval of grace beyond due, the agreed "allow one sync interval of lag,
 *                then block" budget). New turns are refused server-side; `blocking` is the flag
 *                the client checks to disable its composer.
 *
 *  `turnsUntilBlock` is meaningful only in warning: the number of additional turns the chat can
 *  advance before it crosses into blocked (blockThreshold - unsyncedTurns). It is null in every
 *  other state.
 */
export interface ChatSyncHealth {
  state: 'healthy' | 'warning' | 'blocked';
  blocking: boolean;
  lastStatus: 'ok' | 'skipped' | 'error' | null;
  lastStep: string | null;
  lastError: string | null;
  consecutiveErrors: number;
  turnsUntilBlock: number | null;
}

export function computeChatSyncHealth(input: {
  messages: { messageId: string; role: 'user' | 'assistant' }[];
  /** The newest CLOSED sync point's anchor message id — everything at or before it is consumed
   *  (the same closed-only narrowing getChatSyncStatus/findDueChats use; an eagerly-opened,
   *  closed_at-null point is chunk-progress only, never a consolidation boundary). */
  anchorMessageId: string | null;
  lastStatus: 'ok' | 'skipped' | 'error' | null;
  lastStep: string | null;
  lastError: string | null;
  consecutiveErrors: number;
  liveWindowPairs: number;
  syncEveryPairs: number;
}): ChatSyncHealth {
  const anchorIdx = input.anchorMessageId ? input.messages.findIndex((m) => m.messageId === input.anchorMessageId) : -1;
  const unsyncedTurns = findTurnBoundaries(input.messages).filter((idx) => idx > anchorIdx).length;
  const dueThreshold = input.liveWindowPairs + input.syncEveryPairs;
  const blockThreshold = input.liveWindowPairs + 2 * input.syncEveryPairs;
  const state = unsyncedTurns >= blockThreshold ? 'blocked' : unsyncedTurns >= dueThreshold ? 'warning' : 'healthy';
  return {
    state,
    blocking: state === 'blocked',
    lastStatus: input.lastStatus,
    lastStep: input.lastStep,
    lastError: input.lastError,
    consecutiveErrors: input.consecutiveErrors,
    turnsUntilBlock: state === 'warning' ? blockThreshold - unsyncedTurns : null,
  };
}

interface SyncStatusRow {
  last_status: 'ok' | 'skipped' | 'error' | null;
  last_step: string | null;
  last_error: string | null;
  consecutive_errors: number | string;
}

/** The DB reads behind computeChatSyncHealth, shared by the RP turn guard (handleChatCompletions)
 *  and the status endpoint (io/chatSessions.ts's getChatSyncStatus) so both compute health from
 *  the same anchor + status row. Pure computation stays in computeChatSyncHealth (testable without
 *  a pool); this is only the fetching half. */
export async function loadChatSyncHealth(
  deps: ChatMemorySyncDeps,
  userId: string,
  chatId: string,
  messages: { messageId: string; role: 'user' | 'assistant' }[],
  liveWindowPairs: number,
  syncEveryPairs: number,
): Promise<ChatSyncHealth> {
  return deps.db.withUserScope(userId, async (session) => {
    const [anchor] = await session.query<{ last_message_id: string }>(
      `select last_message_id from chat_sync_points
       where chat_id = $1 and closed_at is not null order by ordinal desc limit 1`,
      [chatId],
    );
    const [status] = await session.query<SyncStatusRow>(
      `select last_status, last_step, last_error, consecutive_errors
       from chat_memory_sync_status where chat_id = $1`,
      [chatId],
    );
    return computeChatSyncHealth({
      messages,
      anchorMessageId: anchor?.last_message_id ?? null,
      lastStatus: status?.last_status ?? null,
      lastStep: status?.last_step ?? null,
      lastError: status?.last_error ?? null,
      consecutiveErrors: Number(status?.consecutive_errors ?? 0),
      liveWindowPairs,
      syncEveryPairs,
    });
  });
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
      //
      // Now a backstop, not the primary settling path: settleTransientRecords.ts runs this same
      // promote/demote per-turn (handleChatCompletions.ts / turnExecution.ts's regenerateSwipe),
      // right when a swipe becomes active, instead of waiting for a message to age out of the live
      // window here. That used to mean a swiped-away character stayed visibly "eligible" for
      // however long the chat kept growing before this tick got to it — sometimes never. This step
      // stays for anything that reaches archival without having gone through that path (idempotent:
      // the `status = 'transient'` guards make a re-run of an already-settled message a no-op).
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
  // Settings (including the pipeline's connection) are resolved ONCE per tick and shared by every
  // due chat — previously each chat re-resolved them inside the loop, so N due chats paid N
  // settings reads plus N connection resolutions for the same answer, and could even disagree
  // with each other if a Settings-tab edit landed mid-tick.
  const defaults = await resolveSyncSettings(deps);
  const users = await deps.db.withSystemScope((session) => session.query<UserRow>('select user_id from users'));
  for (const { user_id: userId } of users) {
    // findDueChats also applies permanent-failure suppression (migration 0127): a chat whose last
    // attempt was a permanent failure under the current connection signature is excluded from the
    // loop entirely until the signature changes or PERMANENT_FAILURE_RETRY_MS elapses — a dead
    // "No endpoints found for <model>" 404 no longer re-fires once per 30s tick forever.
    const due = await findDueChats(deps.db, userId, defaults.syncEveryMessages, defaults.liveWindowMessages, defaults.profileSignature);
    for (const chatId of due) {
      try {
        const result = await runOneChatSync(deps, defaults, userId, chatId);
        await recordSyncStatus(deps.db, userId, chatId, result);
      } catch (err) {
        log.error('chat-memory sync: sync failed for one chat, will retry next tick', { chatId, err });
        const step = err instanceof SyncStepError ? err.step : 'unknown';
        const message = err instanceof Error ? err.message : String(err);
        const kind = classifyLlmFailure(err);
        await recordSyncStatus(deps.db, userId, chatId, {
          status: 'error',
          step,
          error: message,
          kind,
          signature: defaults.profileSignature,
        });
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
  const sync = await resolveSyncSettings(deps);
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
