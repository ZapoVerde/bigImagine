/**
 * @file plugins/cards/src/insertCardFromCard.ts
 * @stamp 2026-08-22
 * @architectural-role IO Wrapper — persists an imported Card and Card-owned supporting content
 * @description The shared write path for file and Chub imports. Embedded books use the existing
 * parser/embedding behaviour but link through lorebook_card_links, never lorebook_character_links.
 * @api-declaration insertCardFromCard(db, userId, parsed, sourceJson, embeddings, media?)
 * @contract writes cards, optional Card media, lorebooks, entries, and Card links; never characters.
 */

import type { DbSession } from '@bigbrain/orchestrator/postgres';
import type { EmbeddingProvider } from '@bigbrain/orchestrator/embeddings';
import { parseCharacterBookEntries, characterBookName, type LorebookEntryDraft } from '@bigbrain/orchestrator/parse-character-book-entries';
import { log } from '@bigbrain/orchestrator/logger';
import { toPgVectorLiteral } from '@bigbrain/orchestrator/pgvector';
import { writeCardMedia } from './cardMediaStorage.js';
import type { ParsedCard } from './cardCodec.js';

export interface InsertedCard {
  cardId: string;
  name: string;
  specVersion: 'v2' | 'v3';
  hasAvatar: boolean;
  lorebookEntriesImported: number;
}

export async function insertCardFromCard(
  db: DbSession, userId: string, parsed: ParsedCard, sourceJson: unknown,
  embeddings: EmbeddingProvider, media?: Buffer,
): Promise<InsertedCard> {
  const rows = await db.query<{ card_id: string; name: string }>(
    `insert into cards
       (user_id, name, persona, scenario, system_prompt, example_dialogue, greetings, spec_version, source_json, avatar_path)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10)
     returning card_id, name`,
    [userId, parsed.name, parsed.persona, parsed.scenario, parsed.systemPrompt, parsed.exampleDialogue,
      JSON.stringify(parsed.greetings), parsed.specVersion, JSON.stringify(sourceJson), media ? 'local' : null],
  );
  const card = rows[0]!;
  if (media) await writeCardMedia(card.card_id, media);

  const drafts = parseCharacterBookEntries(sourceJson);
  if (!drafts?.length) {
    return { cardId: card.card_id, name: card.name, specVersion: parsed.specVersion, hasAvatar: media !== undefined, lorebookEntriesImported: 0 };
  }
  const bookName = characterBookName(sourceJson) ?? `${parsed.name}'s Lorebook`;
  const books = await db.query<{ lorebook_id: string }>(
    'insert into lorebooks (user_id, name, global_scope) values ($1, $2, false) returning lorebook_id', [userId, bookName]);
  const lorebookId = books[0]!.lorebook_id;
  await insertLorebookEntries(db, userId, lorebookId, bookName, drafts, embeddings);
  await db.query(
    `insert into lorebook_card_links (lorebook_id, card_id, user_id) values ($1, $2, $3)`,
    [lorebookId, card.card_id, userId]);
  return { cardId: card.card_id, name: card.name, specVersion: parsed.specVersion, hasAvatar: media !== undefined, lorebookEntriesImported: drafts.length };
}

async function insertLorebookEntries(db: DbSession, userId: string, lorebookId: string, bookName: string,
  drafts: LorebookEntryDraft[], embeddings: EmbeddingProvider): Promise<void> {
  let vectors: (string | null)[] | null = null;
  try {
    vectors = (await embeddings.embed(drafts.map((draft) => `${bookName}\n${draft.content}`)))
      .map((vector) => vector?.length ? toPgVectorLiteral(vector) : null);
  } catch (err) {
    log.warn('insertCardFromCard: lorebook embed failed, importing without vectors', { userId, lorebookId, bookName, err });
  }
  const columns = ['lorebook_id', 'user_id', 'uid', 'key', 'keysecondary', 'comment', 'content', 'constant', 'selective', 'disable',
    'order_value', 'position', 'probability', 'depth', 'group_name', 'use_probability', 'group_weight', 'group_override', 'sticky',
    'cooldown', 'delay', 'source_json', 'vector_embed'];
  const params: unknown[] = [];
  const values = drafts.map((draft, index) => {
    const base = index * columns.length;
    params.push(lorebookId, userId, draft.uid, draft.key, draft.keysecondary, draft.comment, draft.content, draft.constant,
      draft.selective, draft.disable, draft.orderValue, draft.position, draft.probability, draft.depth, draft.groupName,
      draft.useProbability, draft.groupWeight, draft.groupOverride, draft.sticky, draft.cooldown, draft.delay,
      JSON.stringify(draft.sourceJson), vectors?.[index] ?? null);
    return `(${columns.map((column, columnIndex) => `$${base + columnIndex + 1}${column === 'source_json' ? '::jsonb' : column === 'vector_embed' ? '::vector' : ''}`).join(', ')})`;
  });
  await db.query(`insert into lorebook_entries (${columns.join(', ')}) values ${values.join(', ')}`, params);
}
