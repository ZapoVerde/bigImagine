/**
 * @file plugins/characters/src/insertCharacterFromCard.ts
 * @stamp 2026-08-05
 * @architectural-role IO Wrapper — inserts a `characters` row from an already-parsed card
 * @description
 * Factored out of importCharacterCardTool.ts (the only caller until now) so
 * importCharacterCardFromUrlTool.ts can share the exact same insert path rather than a second,
 * driftable copy — the two tools differ only in where cardJson/avatar bytes come from (an
 * uploaded file's bytes vs. a chub.ai fetch through pia-proxy), never in what happens once a
 * ParsedCard and the original JSON are in hand.
 *
 * @api-declaration
 * insertCharacterFromCard(db, userId, parsed, cardJson, avatarBytes?) — inserts the row, writes
 *   avatarBytes via avatarStorage.ts's writeAvatar if given, and returns
 *   {characterId, name, specVersion, hasAvatar}
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the given DbSession, filesystem via avatarStorage)
 *     state_ownership: []
 *     external_io:     [Postgres, filesystem]
 */

import type { DbSession } from '@bigbrain/orchestrator/postgres';
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

  return { characterId: row.character_id, name: row.name, specVersion: parsed.specVersion, hasAvatar };
}
