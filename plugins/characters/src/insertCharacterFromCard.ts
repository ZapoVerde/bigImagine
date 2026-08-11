/**
 * @file plugins/characters/src/insertCharacterFromCard.ts
 * @stamp 2026-08-11
 * @architectural-role IO Wrapper — inserts a `characters` row from an already-parsed card
 * @description
 * Factored out of importCharacterCardTool.ts (the only caller until now) so
 * importCharacterCardFromUrlTool.ts can share the exact same insert path rather than a second,
 * driftable copy — the two tools differ only in where cardJson/avatar bytes come from (an
 * uploaded file's bytes vs. a chub.ai fetch through pia-proxy), never in what happens once a
 * ParsedCard and the original JSON are in hand.
 *
 * Since chub-lorebook-import-plan.md §A, this file is also the one place a card's embedded
 * lorebook (`data.character_book`) becomes real rows: after the characters insert, if
 * parseCharacterBookEntries returns drafts, the same flow inserts the `lorebooks` row (global
 * scope off — this book belongs to this character), bulk-inserts the mapped `lorebook_entries`,
 * and links the two via `lorebook_character_links`. No second write path for the two import
 * tools (or the ChubCardModal Import button) to drift out of sync. Whether those rows are ever
 * *recalled* stays gated by lorebook-plan.md §2's default-off `lorebook_mode` — this is data
 * tier, same as importing `description`.
 *
 * @api-declaration
 * insertCharacterFromCard(db, userId, parsed, cardJson, avatarBytes?) — inserts the row, writes
 *   avatarBytes via avatarStorage.ts's writeAvatar if given, inserts the embedded lorebook
 *   (if any) and its character link, and returns
 *   {characterId, name, specVersion, hasAvatar, lorebookEntriesImported}
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the given DbSession, filesystem via avatarStorage)
 *     state_ownership: []
 *     external_io:     [Postgres, filesystem]
 */

import type { DbSession } from '@bigbrain/orchestrator/postgres';
import { parseCharacterBookEntries, characterBookName, type LorebookEntryDraft } from '@bigbrain/orchestrator/parse-character-book-entries';
import { writeAvatar } from './avatarStorage.js';
import type { ParsedCard } from './cardCodec.js';

interface CharacterRow {
  character_id: string;
  name: string;
}

export interface InsertedCharacter {
  characterId: string;
  name: string;
  specVersion: 'v2' | 'v3';
  hasAvatar: boolean;
  /** Number of embedded lorebook entries imported from the card's `character_book` (0 when the card has none). */
  lorebookEntriesImported: number;
}

export async function insertCharacterFromCard(
  db: DbSession,
  userId: string,
  parsed: ParsedCard,
  cardJson: unknown,
  avatarBytes?: Buffer,
): Promise<InsertedCharacter> {
  const hasAvatar = avatarBytes !== undefined;

  const rows = await db.query<CharacterRow>(
    `insert into characters
       (user_id, name, persona, scenario, system_prompt, example_dialogue, greetings, spec_version, source_json, avatar_path)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10)
     returning character_id, name`,
    [
      userId,
      parsed.name,
      parsed.persona,
      parsed.scenario,
      parsed.systemPrompt,
      parsed.exampleDialogue,
      JSON.stringify(parsed.greetings),
      parsed.specVersion,
      JSON.stringify(cardJson),
      hasAvatar ? 'local' : null,
    ],
  );
  const row = rows[0]!;

  if (avatarBytes) {
    await writeAvatar(row.character_id, avatarBytes);
  }

  // Embedded lorebook (§A of chub-lorebook-import-plan.md): the same user-scoped session the
  // characters insert already runs in, so RLS passes and the three inserts are one transaction
  // with the character — a card that fails halfway imports nothing, not a half card.
  const drafts = parseCharacterBookEntries(cardJson);
  let lorebookEntriesImported = 0;
  if (drafts && drafts.length > 0) {
    const bookName = characterBookName(cardJson) ?? `${parsed.name}'s Lorebook`;
    const bookRows = await db.query<{ lorebook_id: string }>(
      `insert into lorebooks (user_id, name, global_scope)
       values ($1, $2, false)
       returning lorebook_id`,
      [userId, bookName],
    );
    const lorebookId = bookRows[0]!.lorebook_id;
    await insertLorebookEntries(db, userId, lorebookId, drafts);
    await db.query(
      `insert into lorebook_character_links (lorebook_id, character_id, user_id)
       values ($1, $2, $3)`,
      [lorebookId, row.character_id, userId],
    );
    lorebookEntriesImported = drafts.length;
  }

  return {
    characterId: row.character_id,
    name: row.name,
    specVersion: parsed.specVersion,
    hasAvatar,
    lorebookEntriesImported,
  };
}

function insertLorebookEntries(
  db: DbSession,
  userId: string,
  lorebookId: string,
  drafts: LorebookEntryDraft[],
): Promise<unknown[]> {
  // Same column list the ST-world-info importer uses (adminServer.ts), minus vector_embed — this
  // plan only writes rows, it doesn't embed or recall them (lorebook-plan.md §3c stays dormant
  // for imported character books until the recall engine is turned on).
  const columns = [
    'lorebook_id', 'user_id', 'uid', 'key', 'keysecondary', 'comment', 'content', 'constant',
    'selective', 'disable', 'order_value', 'position', 'probability', 'depth', 'group_name',
    'use_probability', 'group_weight', 'group_override', 'sticky', 'cooldown', 'delay', 'source_json',
  ];
  const casts: Record<string, string> = { source_json: '::jsonb' };
  const params: unknown[] = [];
  const valueRows = drafts.map((d, i) => {
    const base = i * columns.length;
    params.push(
      lorebookId,
      userId,
      d.uid,
      d.key,
      d.keysecondary,
      d.comment,
      d.content,
      d.constant,
      d.selective,
      d.disable,
      d.orderValue,
      d.position,
      d.probability,
      d.depth,
      d.groupName,
      d.useProbability,
      d.groupWeight,
      d.groupOverride,
      d.sticky,
      d.cooldown,
      d.delay,
      JSON.stringify(d.sourceJson),
    );
    const placeholders = columns.map((c, col) => `$${base + col + 1}${casts[c] ?? ''}`).join(', ');
    return `(${placeholders})`;
  });
  const sql = `insert into lorebook_entries (${columns.join(', ')})
               values ${valueRows.join(', ')}`;
  return db.query(sql, params);
}
