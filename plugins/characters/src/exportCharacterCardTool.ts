/**
 * @file plugins/characters/src/exportCharacterCardTool.ts
 * @stamp 2026-08-05
 * @architectural-role IO Wrapper — exports a character as a card PNG or raw JSON
 * @description
 * The read half of card export (docs/spec.md §6). source_json — the exact JSON originally parsed
 * at import time — is preferred verbatim whenever present, so a card imported from ST and exported
 * again is byte-for-byte the same JSON even though `persona` collapsed description+personality into
 * one column (bi_principles.md §7's lossless-round-trip requirement). A character with no
 * source_json (created via the manual form) falls back to cardCodec.buildCardJson, which has no
 * split to recover and puts the whole persona into `description`. PNG export embeds that JSON into
 * the character's stored avatar via cardCodec.encodePngCard, or a baked-in 1x1 transparent
 * placeholder if no avatar was ever set — a card with no picture is still a valid, importable card.
 *
 * @api-declaration
 * createExportCharacterCardTool() — returns the export_character_card RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session, filesystem via avatarStorage)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given), filesystem]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { readAvatar } from './avatarStorage.js';
import { buildCardJson, encodePngCard } from './cardCodec.js';

interface CharacterExportRow {
  name: string;
  persona: string;
  scenario: string;
  system_prompt: string;
  example_dialogue: string;
  greetings: string[];
  source_json: unknown;
  has_avatar: boolean;
}

// A minimal valid 1x1 transparent PNG — the base image a card gets embedded into when the
// character has no avatar of its own.
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'character';
}

function isExportCharacterCardArgs(value: unknown): value is { characterId: string; format: 'png' | 'json' } {
  const v = value as Record<string, unknown>;
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof v.characterId === 'string' &&
    v.characterId.length > 0 &&
    (v.format === 'png' || v.format === 'json')
  );
}

export function createExportCharacterCardTool(): RegisteredTool {
  return {
    definition: {
      name: 'export_character_card',
      description: 'Export a character as a SillyTavern-compatible card, either a PNG with the card embedded or raw JSON.',
      parameters: {
        type: 'object',
        properties: {
          characterId: { type: 'string' },
          format: { type: 'string', enum: ['png', 'json'] },
        },
        required: ['characterId', 'format'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isExportCharacterCardArgs(args)) {
        throw new Error("export_character_card requires characterId: string and format: 'png' | 'json'");
      }
      const rows = await ctx.db.query<CharacterExportRow>(
        `select name, persona, scenario, system_prompt, example_dialogue, greetings, source_json,
                avatar_path is not null as has_avatar
         from characters where character_id = $1 and user_id = $2`,
        [args.characterId, ctx.userId],
      );
      const row = rows[0];
      if (!row) return { found: false, characterId: args.characterId };

      const cardJson =
        row.source_json ??
        buildCardJson({
          name: row.name,
          persona: row.persona,
          scenario: row.scenario,
          systemPrompt: row.system_prompt,
          exampleDialogue: row.example_dialogue,
          greetings: row.greetings,
        });

      if (args.format === 'json') {
        return { found: true, format: 'json' as const, filename: `${slugify(row.name)}.json`, json: cardJson };
      }

      const baseImage = row.has_avatar ? await readAvatar(args.characterId) : null;
      const pngBytes = encodePngCard(baseImage ?? PLACEHOLDER_PNG, JSON.stringify(cardJson));
      return {
        found: true,
        format: 'png' as const,
        filename: `${slugify(row.name)}.png`,
        mimeType: 'image/png',
        base64: pngBytes.toString('base64'),
      };
    },
  };
}
