/**
 * @file orchestrator/src/io/chatMemory/deleteChatChunk.ts
 * @stamp 2026-08-17
 * @architectural-role IO Wrapper — the single-row chat_chunks deletion primitive from
 * docs/plans/chunk-lead-in-context-plan.md. Built deliberately ahead of any caller (the user's
 * direction: the safe primitive exists before anything needs it, so nothing is ever tempted to
 * `delete from chat_chunks where chunk_id = $1` directly).
 * @description
 * Deletes ONE archived chunk without ever leaving the parent chain or the ordinal sequence
 * broken, in the exact statement order the user asked for: relink, then renumber, then delete —
 * all before the row disappears, never as a side effect after it. The parent chain and the
 * (chat_id, ordinal) uniqueness are both `deferrable initially deferred` (migration 0100), which
 * is what makes the relink/renumber legal mid-transaction: a plain per-row check would throw the
 * classic "swap two unique values in one statement" error on real data.
 *
 * Concurrency: takes the same per-chat pg_advisory_xact_lock(hashtext(chatId)) every other
 * chat_chunks writer takes (chatMemorySync.ts's runOneChatSync, eagerChunkSync.ts's
 * maybeEagerChunk, chatChunkResize.ts's resizeOneChat), so a delete can never race a concurrent
 * sync/eager/resize pass on the same chat's sequence. The caller owns the transaction
 * (withUserScope/withSystemScope) — this wrapper is one session's worth of statements.
 *
 * @api-declaration
 * deleteChatChunk(session, userId, chatId, chunkId) -> Promise<void> — idempotent (unknown
 * chunkId is a silent no-op, safe to call twice); relinks the chain and closes the ordinal gap
 * before removing the row. Logs one line per actual deletion (bi_principles.md §11): chatId,
 * deleted chunkId, whether a relink happened, how many rows were renumbered.
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the caller's session, logs)
 *     state_ownership: []
 *     external_io:     [Postgres]
 */

import type { DbSession } from '../postgres.js';
import { log } from '../logger.js';

/** Delete one chat_chunks row with its parent chain and ordinal sequence intact — relink, then
 *  renumber, then delete, one transaction's worth of statements (the caller owns the
 *  transaction). Idempotent: an unknown chunkId returns without doing anything, so a retried
 *  call (e.g. after a timeout that already committed) is harmless. */
export async function deleteChatChunk(
  session: DbSession,
  userId: string,
  chatId: string,
  chunkId: string,
): Promise<void> {
  // Same per-chat lock every other chat_chunks writer takes — the delete serializes against
  // concurrent sync/eager/resize passes on this chat (pg_advisory_xact_lock is transaction-
  // scoped, so it is held for the caller's whole transaction, not just this statement).
  await session.query('select pg_advisory_xact_lock(hashtext($1))', [chatId]);

  const target = await session.query<{
    chunk_id: string;
    ordinal: number;
    parent_chunk_id: string | null;
  }>(
    `select chunk_id, ordinal, parent_chunk_id
     from chat_chunks
     where user_id = $1 and chat_id = $2 and chunk_id = $3`,
    [userId, chatId, chunkId],
  );
  if (target.length === 0) {
    return; // idempotent no-op — nothing to delete, nothing to relink or renumber
  }

  // At most one child exists, guaranteed by chat_chunks_parent_unique (unique parent_chunk_id,
  // deferred) — the linear-chain invariant means every non-first chunk has exactly one parent
  // and every non-last chunk is someone's parent.
  const children = await session.query<{ chunk_id: string }>(
    'select chunk_id from chat_chunks where parent_chunk_id = $1',
    [chunkId],
  );

  let relinked = false;
  if (children.length > 0) {
    const child = children[0];
    // Splice the target out of the chain: its child now points at the target's own parent
    // (which may be null, if the target was the chain's head — the child becomes the new head).
    // Legal only because the parent uniqueness is deferred to commit-time: mid-transaction the
    // child's new parent is a value another row (the target) still momentarily holds.
    await session.query('update chat_chunks set parent_chunk_id = $1 where chunk_id = $2', [
      target[0].parent_chunk_id,
      child.chunk_id,
    ]);
    relinked = true;
  }

  // Close the ordinal gap the deletion is about to leave. Legal only because the
  // (chat_id, ordinal) uniqueness is deferred to commit-time — this statement transiently
  // collides with the target's own still-present ordinal before the delete below runs.
  const renumbered = await session.query<{ chunk_id: string }>(
    `update chat_chunks set ordinal = ordinal - 1
     where chat_id = $1 and ordinal > $2
     returning chunk_id`,
    [chatId, target[0].ordinal],
  );

  await session.query('delete from chat_chunks where chunk_id = $1', [chunkId]);

  log.info('deleteChatChunk: deleted chunk', {
    chatId,
    chunkId,
    relinked,
    renumbered: renumbered.length,
  });
}
