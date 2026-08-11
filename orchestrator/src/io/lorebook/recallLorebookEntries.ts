/**
 * @file orchestrator/src/io/lorebook/recallLorebookEntries.ts
 * @stamp 2026-08-11
 * @architectural-role IO Wrapper — lorebook candidate discovery (vector recall)
 * @description
 * The §4 discovery step of the Lorebook plan (docs/lorebook-plan.md): embeds the query text once
 * and scans the §3b-scoped candidate set by `vector_embed <->` distance — the exact mechanism
 * recall_canon_facts / recallForPrompt.ts already use, per §1/§5. Keyword discovery (ST's
 * key/keysecondary substring scan) is deliberately not ported, not even as a fallback (§5, §9).
 *
 * Scope is resolved entirely in SQL, mirroring canon_facts's "chat/scene/character anchors"
 * (0054) and scene_presence's junction shape (0046): a book is in scope if it has
 * `global_scope`, is linked to the active character, or has an enabled `lorebook_chat_overrides`
 * row for this chat (the quick-add path, §8b); an explicit `enabled = false` chat override beats
 * every in-scope path (a row here beats the book's default, §3b); an `enabled = false` entry
 * override removes a single entry one level down. `disable` entries never fire.
 *
 * `constant` entries are always candidates (§5 — an explicit "never discover this, always include
 * it" author choice, same tier as pinning, not a relevance mechanism). Everything else must have
 * a `vector_embed` to be ranked: a non-constant entry with a NULL embed (imported before its
 * first embedding, or an embed failure) is undiscoverable by construction and excluded — the UI
 * still shows it, it just can't be recalled until embedded. The result is ordered constants
 * first, then similarity-rank (closest first), `order_value` as tiebreak — array order IS the
 * rank order the §5 budget trim consumes, so callers must not reorder.
 *
 * Fail-open by contract, same as buildAutoRecallParts: any error (embedding provider down, DB
 * hiccup) logs a warning and returns [] — discovery must never break or stall a turn.
 *
 * @api-declaration
 * recallLorebookEntries(session, embeddings, userId, characterId, chatId, queryText, topK?) ->
 *   Promise<LorebookEntryCandidate[]> — scoped candidates, constants first then top-K by
 *   similarity. characterId may be null (no active character — the character-link scope simply
 *   never matches). topK defaults to DEFAULT_LOREBOOK_RECALL_TOP_K and is clamped to
 *   MAX_LOREBOOK_RECALL_TOP_K so a corrupt `lorebook_recall_top_k` value can't balloon the set.
 *
 * @contract
 *   assertions:
 *     purity:          impure (embeddings provider call, Postgres IO)
 *     state_ownership: []
 *     external_io:     [embeddings provider, Postgres]
 */

import type { EmbeddingProvider } from '../embeddings/types.js';
import type { DbSession } from '../postgres.js';
import { toPgVectorLiteral } from '../../util/pgvector.js';
import { log } from '../logger.js';

/** One scoped candidate row, carrying every column the §5 gate needs (probability, groups, timed
 *  effects, order_value) plus the content the prompt formatter will inject. `key` is kept for
 *  browsing/round-trip fidelity and is NOT evaluated at runtime (§9). */
export interface LorebookEntryCandidate {
  entry_id: string;
  lorebook_id: string;
  uid: number;
  key: string[];
  comment: string;
  content: string;
  constant: boolean;
  order_value: number;
  probability: number;
  use_probability: boolean;
  group_name: string;
  group_weight: number;
  group_override: boolean;
  sticky: number;
  cooldown: number;
  delay: number;
}

/** Fallback default when the caller resolves no `lorebook_recall_top_k` setting — mirrors
 *  canon_recall_top_k's default (8, recallForPrompt.ts's DEFAULT_FACT_TOP_K), the §11 open
 *  question's agreed answer. */
export const DEFAULT_LOREBOOK_RECALL_TOP_K = 8;

/** Sanity cap so a corrupt top_k setting can't balloon the candidate set into the prompt stack.
 *  Same reasoning as recallForPrompt.ts's MAX_FACT_TOP_K: beyond ~50 the marginal recall value
 *  is nil while the token cost is real. */
const MAX_LOREBOOK_RECALL_TOP_K = 50;

/** Query-text cleanup, CNZ-style: collapse whitespace runs so the embedded query is about words,
 *  not layout — the same shape buildAutoRecallQuery already uses. */
function cleanForEmbedding(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export async function recallLorebookEntries(
  session: DbSession,
  embeddings: EmbeddingProvider,
  userId: string,
  characterId: string | null,
  chatId: string,
  queryText: string,
  topK = DEFAULT_LOREBOOK_RECALL_TOP_K,
): Promise<LorebookEntryCandidate[]> {
  try {
    const query = cleanForEmbedding(queryText);
    if (!query) return [];

    const [vector] = await embeddings.embed([query]);
    if (!vector) return [];

    const k = Math.min(Math.max(1, Math.floor(topK)), MAX_LOREBOOK_RECALL_TOP_K);
    // A null characterId (a chat with no active character) must not short-circuit the character
    // link into an invalid uuid comparison — the all-zero uuid is a legal literal that no
    // character row can ever match, so the clause stays in the query and simply never fires.
    const scopedCharacterId = characterId ?? '00000000-0000-0000-0000-000000000000';

    const rows = await session.query<LorebookEntryCandidate>(
      `with scoped as (
         select e.entry_id, e.lorebook_id, e.uid, e.key, e.comment, e.content, e.constant,
                e.order_value, e.probability, e.use_probability, e.group_name, e.group_weight,
                e.group_override, e.sticky, e.cooldown, e.delay, e.vector_embed
         from lorebook_entries e
         join lorebooks b on b.lorebook_id = e.lorebook_id
         where e.user_id = $1
           and not e.disable
           and (
             b.global_scope
             or exists (select 1 from lorebook_character_links lcl
                        where lcl.lorebook_id = b.lorebook_id and lcl.character_id = $2)
             or exists (select 1 from lorebook_chat_overrides lco
                        where lco.lorebook_id = b.lorebook_id and lco.chat_id = $3 and lco.enabled)
           )
           and not exists (select 1 from lorebook_chat_overrides lco
                           where lco.lorebook_id = b.lorebook_id and lco.chat_id = $3 and not lco.enabled)
           and not exists (select 1 from lorebook_entry_overrides leo
                           where leo.entry_id = e.entry_id and leo.chat_id = $3 and not leo.enabled)
       ),
       constants as (select * from scoped where constant),
       ranked as (
         select * from scoped
         where not constant and vector_embed is not null
         order by vector_embed <-> $4
         limit $5
       )
       select entry_id, lorebook_id, uid, key, comment, content, constant, order_value,
              probability, use_probability, group_name, group_weight, group_override,
              sticky, cooldown, delay
       from (
         select 0 as _sort, c.entry_id, c.lorebook_id, c.uid, c.key, c.comment, c.content,
                c.constant, c.order_value, c.probability, c.use_probability, c.group_name,
                c.group_weight, c.group_override, c.sticky, c.cooldown, c.delay, c.vector_embed
         from constants c
         union all
         select 1 as _sort, r.entry_id, r.lorebook_id, r.uid, r.key, r.comment, r.content,
                r.constant, r.order_value, r.probability, r.use_probability, r.group_name,
                r.group_weight, r.group_override, r.sticky, r.cooldown, r.delay, r.vector_embed
         from ranked r
       ) t
       order by t._sort, t.vector_embed <-> $4 nulls last, t.order_value`,
      [userId, scopedCharacterId, chatId, toPgVectorLiteral(vector), k],
    );
    return rows;
  } catch (err) {
    // Fail-open: a discovery error must never break the turn. Log and continue empty.
    log.warn('recallLorebookEntries: recall failed, returning no candidates', { userId, chatId, err });
    return [];
  }
}
