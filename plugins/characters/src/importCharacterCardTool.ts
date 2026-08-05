/**
 * @file plugins/characters/src/importCharacterCardTool.ts
 * @stamp 2026-08-05
 * @architectural-role IO Wrapper — creates a character from an uploaded PNG or JSON card
 * @description
 * The write half of PNG/JSON card import (docs/spec.md §6). Takes the raw uploaded file already
 * base64-encoded by the caller — orchestrator/src/server/handleCharacterImport.ts does the actual
 * multipart parsing and hands this tool the bytes, since plugins own their own IO but never the raw
 * HTTP request (bi_principles.md's IO Wrapper split, same shape every other tool in this plugin
 * already follows). PNG vs JSON is decided by content (PNG magic bytes), not the filename, since a
 * client-supplied filename is untrusted. The exact parsed JSON is stored verbatim as source_json —
 * the field export_character_card prefers, so export stays a lossless round-trip
 * (bi_principles.md §7) even though persona collapses description+personality into one column.
 *
 * @api-declaration
 * createImportCharacterCardTool() — returns the import_character_card RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session, filesystem via avatarStorage)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given), filesystem]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { writeAvatar } from './avatarStorage.js';
import { decodePngCard, parseCardJson } from './cardCodec.js';

interface CharacterRow {
  character_id: string;
  name: string;
}

function isImportCharacterCardArgs(value: unknown): value is { filename: string; fileBase64: string } {
  const v = value as Record<string, unknown>;
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof v.filename === 'string' &&
    typeof v.fileBase64 === 'string' &&
    v.fileBase64.length > 0
  );
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function createImportCharacterCardTool(): RegisteredTool {
  return {
    definition: {
      name: 'import_character_card',
      description: 'Import a character from an uploaded card file (a SillyTavern-compatible PNG card, or its raw JSON).',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Original filename, used only for error messages.' },
          fileBase64: { type: 'string', description: "The uploaded file's bytes, base64-encoded." },
        },
        required: ['filename', 'fileBase64'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isImportCharacterCardArgs(args)) {
        throw new Error('import_character_card requires filename: string and fileBase64: string');
      }
      const bytes = Buffer.from(args.fileBase64, 'base64');
      const isPng = bytes.subarray(0, 8).equals(PNG_MAGIC);

      let cardJson: unknown;
      if (isPng) {
        cardJson = JSON.parse(decodePngCard(bytes));
      } else {
        try {
          cardJson = JSON.parse(bytes.toString('utf8'));
        } catch {
          throw new Error(`${args.filename} is neither a valid card PNG nor valid card JSON`);
        }
      }

      const parsed = parseCardJson(cardJson);

      const rows = await ctx.db.query<CharacterRow>(
        `insert into characters
           (user_id, name, persona, scenario, system_prompt, example_dialogue, greetings, spec_version, source_json, avatar_path)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
         returning character_id, name`,
        [
          ctx.userId,
          parsed.name,
          parsed.persona,
          parsed.scenario,
          parsed.systemPrompt,
          parsed.exampleDialogue,
          parsed.greetings,
          parsed.specVersion,
          JSON.stringify(cardJson),
          isPng ? 'local' : null,
        ],
      );
      const row = rows[0]!;

      if (isPng) {
        await writeAvatar(row.character_id, bytes);
      }

      return { characterId: row.character_id, name: row.name, specVersion: parsed.specVersion, hasAvatar: isPng };
    },
  };
}
