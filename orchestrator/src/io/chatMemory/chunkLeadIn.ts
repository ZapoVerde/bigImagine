/**
 * @file orchestrator/src/io/chatMemory/chunkLeadIn.ts
 * @stamp 2026-08-17
 * @architectural-role IO Wrapper — the "turn-order lead-in context" query from
 * docs/plans/chunk-lead-in-context-plan.md, one recursive CTE that walks the persisted
 * parent_chunk_id chain (migration 0100) from a set of retrieved chunks.
 * @description
 * Given the chunkIds a recall pass just retrieved and a resolved leadInCount, returns the
 * leadInCount chunks immediately before each retrieved chunk in the actual conversation — the
 * chain is walked via parent_chunk_id, never inferred from ordinal adjacency (ordinal is a
 * count(*) artifact that any future subset deletion makes untrustworthy; the persisted edge is
 * the whole point of this plan). Each lead-in row carries its existing summary (computed at
 * archival time by classifyChatChunk.ts — no new summarization anywhere on this path), and the
 * SQL itself does the dedup structurally: `distinct` collapses a chunk reachable from two
 * retrieved chunks' chains, and `chunk_id != all($3)` guarantees a chunk that was itself
 * retrieved never surfaces as its own (or anyone's) lead-in.
 *
 * The depth arithmetic is deliberate and pinned by a regression test (see the plan's Tests):
 * the seed rows are the retrieved chunks at depth 0, the bound is `li.depth < leadInCount`, and
 * the result filter is `depth > 0` — so leadInCount = 1 returns exactly the immediate
 * predecessors, leadInCount = 3 exactly three hops back. (An earlier draft seeded depth at 1,
 * which returned leadInCount - 1 rows and made leadInCount = 1 return nothing.)
 *
 * @api-declaration
 * resolveLeadInRows(session, userId, chatId, chunkIds, leadInCount) ->
 *   Promise<LeadInRow[]> — LeadInRow = { chunkId, ordinal, summary }. Never returns a chunkId
 *   present in the input chunkIds; never returns duplicates; returns exactly leadInCount rows
 *   per retrievable chain when the chain has that many ancestors, fewer (never zero for
 *   leadInCount >= 1 with a non-head chunk) when it runs out. leadInCount <= 0 (or an empty
 *   chunkIds) short-circuits to [] with no query issued.
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the caller's session)
 *     state_ownership: []
 *     external_io:     [Postgres]
 */

import type { DbSession } from '../postgres.js';

export interface LeadInRow {
  chunkId: string;
  ordinal: number;
  summary: string;
}

/** Resolve the lead-in rows for a set of retrieved chunks: each retrieved chunk's
 *  `leadInCount` immediate predecessors via the persisted parent chain, deduped structurally by
 *  the SQL (a chunk reachable from two retrieved chunks' chains appears once; a chunk that was
 *  itself retrieved never appears at all). Returns rows ordered by ordinal ascending per chain
 *  (the caller merges and re-sorts the combined list by ordinal anyway). */
export async function resolveLeadInRows(
  session: DbSession,
  userId: string,
  chatId: string,
  chunkIds: string[],
  leadInCount: number,
): Promise<LeadInRow[]> {
  if (leadInCount <= 0 || chunkIds.length === 0) {
    return []; // feature off, or nothing retrieved — no query, no work
  }

  const rows = await session.query<{ chunk_id: string; ordinal: number; summary: string }>(
    `with recursive lead_in as (
       select chunk_id, parent_chunk_id, ordinal, summary, 0 as depth
       from chat_chunks
       where user_id = $1 and chat_id = $2 and chunk_id = any($3)
       union all
       select c.chunk_id, c.parent_chunk_id, c.ordinal, c.summary, li.depth + 1
       from chat_chunks c
       join lead_in li on c.chunk_id = li.parent_chunk_id
       where c.user_id = $1 and c.chat_id = $2 and li.depth < $4
     )
     select distinct chunk_id, ordinal, summary
     from lead_in
     where depth > 0 and chunk_id != all($3)`,
    [userId, chatId, chunkIds, leadInCount],
  );

  return rows.map((r) => ({ chunkId: r.chunk_id, ordinal: r.ordinal, summary: r.summary }));
}
