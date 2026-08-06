/**
 * @file orchestrator/src/orchestrator/chatMemorySync.ts
 * @stamp 2026-07-28
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
 * plugins/canonize/src/proposeCanonFactTool.ts), chunk the newly-archived messages
 * (chunkChatTranscript.ts), summarize+embed each chunk (classifyChatChunk.ts + the embeddings
 * provider), distill the chat's "key ideas" digest (distillChatMemory.ts) against its own existing
 * entries, then write one new chat_sync_points row plus the chat_chunks/chat_memory_entries rows
 * tied to it. A mid-pipeline failure rolls the whole transaction back, canon-fact promotion
 * included — the previous sync point is untouched, and the next poll tick just retries from there
 * (self-healing, same "advance state, don't double-count" caution agentRoutineDispatch.ts's own
 * doc explains, just via ROLLBACK instead of an explicit ordering trick).
 *
 * Every attempt (ok, skipped, or error-with-which-step) is also recorded into
 * chat_memory_sync_status, one upserted row per chat, through a separate transaction from the
 * work itself — so a rollback of the sync work never erases the record that it failed
 * (bi_principles.md §11: the failure logging already existed here, this is just the read surface
 * for it). server/adminServer.ts's getChatMemorySyncStatus is the read side.
 *
 * The connection this pipeline's calls run through, and each of the three prompts, are read live
 * every tick from io/orchestratorSettings.ts (chat_memory_profile/chat_memory_live_window_pairs/
 * chat_memory_sync_every_pairs/chat_memory_digest_horizon_pairs/chat_memory_chunk_summary_prompt/
 * chat_memory_distill_prompt/chat_memory_household_memory_prompt) — a Settings-tab change takes
 * effect on the very next tick, no restart, mirroring server/httpServer.ts's own per-chat
 * profile-override construction (createLlmProviderForProfile + createGatedLlmProvider) for the
 * "which connection" half.
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
 *     state_ownership: [the setInterval timer this starts]
 *     external_io:     [Postgres, the LLM via the gated provider it builds, the embeddings provider]
 */

import { log } from '../io/logger.js';
import { runWithCallContext } from '../io/llm/callContext.js';
import { createLlmProviderForProfile } from '../io/llm/index.js';
import { createGatedLlmProvider } from '../io/llm/llmGate.js';
import type { LlmProvider } from '../io/llm/types.js';
import type { LlmProfile } from '../io/llm/profiles.js';
import type { EmbeddingProvider } from '../io/embeddings/types.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import type { PostgresClient } from '../io/postgres.js';
import { toPgVectorLiteral } from '../util/pgvector.js';
import { chunkChatTranscript, MESSAGES_PER_CHUNK, type ChatTranscriptMessage } from '../io/chatMemory/chunkChatTranscript.js';
import { summarizeChatChunk } from '../io/chatMemory/classifyChatChunk.js';
import { distillChatMemory, type ChatMemoryEntryDraft } from '../io/chatMemory/distillChatMemory.js';
import { classifyHouseholdMemory } from '../io/chatMemory/classifyHouseholdMemory.js';

const POLL_INTERVAL_MS = 30_000; // a rolling digest has no live-conversation urgency — minutes-scale is fine
const DEFAULT_LIVE_WINDOW_PAIRS = 8; // mirrors Canonize's own default live-context buffer
const DEFAULT_SYNC_EVERY_PAIRS = 8; // mirrors Canonize's own default sync-window size
const DEFAULT_DIGEST_HORIZON_PAIRS = 24; // smaller than Canonize's 40 — chat_memory_entries already persists state across syncs

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
  llmProfiles: Record<string, LlmProfile>;
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
  liveWindowMessages: number;
  syncEveryMessages: number;
  digestHorizonChunks: number;
}

function toPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function resolveSyncSettings(deps: ChatMemorySyncDeps): Promise<SyncSettings> {
  const [profileName, livePairsRaw, syncEveryPairsRaw, digestHorizonPairsRaw, chunkSummaryPrompt, distillPrompt, householdMemoryPrompt] =
    await Promise.all([
      deps.settings.get('chat_memory_profile'),
      deps.settings.get('chat_memory_live_window_pairs'),
      deps.settings.get('chat_memory_sync_every_pairs'),
      deps.settings.get('chat_memory_digest_horizon_pairs'),
      deps.settings.get('chat_memory_chunk_summary_prompt'),
      deps.settings.get('chat_memory_distill_prompt'),
      deps.settings.get('chat_memory_household_memory_prompt'),
    ]);

  let llm = deps.llm;
  if (profileName) {
    const profile = deps.llmProfiles[profileName];
    if (profile) {
      llm = createGatedLlmProvider(createLlmProviderForProfile(profile), deps.db, deps.settings);
    } else {
      log.error(`chat-memory sync: chat_memory_profile names unknown profile "${profileName}" — falling back to the active connection`);
    }
  }

  const livePairs = toPositiveInt(livePairsRaw, DEFAULT_LIVE_WINDOW_PAIRS);
  const syncEveryPairs = toPositiveInt(syncEveryPairsRaw, DEFAULT_SYNC_EVERY_PAIRS);
  const digestHorizonPairs = toPositiveInt(digestHorizonPairsRaw, DEFAULT_DIGEST_HORIZON_PAIRS);
  const pairsPerChunk = MESSAGES_PER_CHUNK / 2;

  return {
    llm,
    chunkSummaryPrompt: chunkSummaryPrompt || undefined,
    distillPrompt: distillPrompt || undefined,
    householdMemoryPrompt: householdMemoryPrompt || undefined,
    liveWindowMessages: livePairs * 2,
    syncEveryMessages: syncEveryPairs * 2,
    digestHorizonChunks: Math.ceil(digestHorizonPairs / pairsPerChunk),
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
         and sp.ordinal = (select max(ordinal) from chat_sync_points where chat_id = cs.chat_id)
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

interface ExistingEntryRow {
  topic_key: string;
  content: string;
}

async function runOneChatSync(deps: ChatMemorySyncDeps, sync: SyncSettings, userId: string, chatId: string): Promise<SyncResult> {
  return runWithCallContext({ taskId: chatId, kind: 'system', userId }, () =>
    deps.db.withUserScope(userId, async (session): Promise<SyncResult> => {
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

      const allMessages = await session.query<{ message_id: string; role: 'user' | 'assistant'; content: string }>(
        'select message_id, role, content from chat_messages where chat_id = $1 order by created_at, message_id',
        [chatId],
      );

      const lastSynced = await session.query<{ last_message_id: string; ordinal: number }>(
        'select last_message_id, ordinal from chat_sync_points where chat_id = $1 order by ordinal desc limit 1',
        [chatId],
      );
      const lastSyncedIdx = lastSynced[0] ? allMessages.findIndex((m) => m.message_id === lastSynced[0]!.last_message_id) : -1;
      const unsynced = allMessages.slice(lastSyncedIdx + 1);

      const eligibleCount = unsynced.length - sync.liveWindowMessages;
      const toArchiveCount = eligibleCount - (eligibleCount % MESSAGES_PER_CHUNK);
      if (toArchiveCount < MESSAGES_PER_CHUNK) {
        log.info('chat-memory sync: nothing eligible to archive yet, skipping', { chatId, unsynced: unsynced.length });
        return { status: 'skipped' };
      }
      const toArchive: ChatTranscriptMessage[] = unsynced.slice(0, toArchiveCount).map((m) => ({
        messageId: m.message_id,
        role: m.role,
        content: m.content,
      }));

      const chunks = await step('chunk', async () => {
        const [existingChunkCount] = await session.query<{ n: string }>(
          'select count(*)::text as n from chat_chunks where chat_id = $1',
          [chatId],
        );
        const startOrdinal = Number(existingChunkCount?.n ?? '0');
        return chunkChatTranscript(toArchive, startOrdinal);
      });

      const { summaries, vectors } = await step('summarize_embed', async () => {
        const summaries = await Promise.all(chunks.map((c) => summarizeChatChunk(sync.llm, c.content, sync.chunkSummaryPrompt)));
        const vectors = await deps.embeddings.embed(chunks.map((c) => c.content));
        return { summaries, vectors };
      });

      const nextOrdinal = (lastSynced[0]?.ordinal ?? -1) + 1;
      const syncId = await step('sync_point', async () => {
        const [syncPoint] = await session.query<{ sync_id: string }>(
          `insert into chat_sync_points (chat_id, user_id, ordinal, last_message_id) values ($1, $2, $3, $4)
           returning sync_id`,
          [chatId, userId, nextOrdinal, toArchive[toArchive.length - 1]!.messageId],
        );
        return syncPoint!.sync_id;
      });

      await step('insert_chunks', async () => {
        for (const [i, chunk] of chunks.entries()) {
          await session.query(
            `insert into chat_chunks (chat_id, sync_id, user_id, ordinal, content, summary, vector_embed)
             values ($1, $2, $3, $4, $5, $6, $7)`,
            [chatId, syncId, userId, chunk.ordinal, chunk.content, summaries[i], toPgVectorLiteral(vectors[i]!)],
          );
        }
      });

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

        return distillChatMemory(sync.llm, drafts, horizonSummaries, sync.distillPrompt);
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
  );
}

export async function runChatMemorySyncTick(deps: ChatMemorySyncDeps): Promise<void> {
  const sync = await resolveSyncSettings(deps);
  const users = await deps.db.withSystemScope((session) => session.query<UserRow>('select user_id from users'));
  for (const { user_id: userId } of users) {
    const due = await findDueChats(deps.db, userId, sync.syncEveryMessages, sync.liveWindowMessages);
    for (const chatId of due) {
      try {
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

      const memories = await classifyHouseholdMemory(sync.llm, digest, sync.householdMemoryPrompt);
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
