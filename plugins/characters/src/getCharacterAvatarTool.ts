/**
 * @file plugins/characters/src/getCharacterAvatarTool.ts
 * @stamp 2026-08-05
 * @architectural-role IO Wrapper — reads back a character's stored avatar bytes
 * @description
 * Backs GET /v1/characters/:id/avatar (orchestrator/src/server/handleCharacterExport.ts) — the
 * Roster list's thumbnails. Kept as its own tool rather than folded into get_character so a list
 * view never has to pull image bytes through the same call as its text fields; each row's img tag
 * makes its own request instead.
 *
 * @api-declaration
 * createGetCharacterAvatarTool() — returns the get_character_avatar RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session, filesystem via avatarStorage)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given), filesystem]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { readAvatar } from './avatarStorage.js';

function isGetCharacterAvatarArgs(value: unknown): value is { characterId: string } {
  const v = value as Record<string, unknown>;
  return typeof value === 'object' && value !== null && typeof v.characterId === 'string' && v.characterId.length > 0;
}

export function createGetCharacterAvatarTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_character_avatar',
      description: "Get a character's stored avatar image, base64-encoded.",
      parameters: {
        type: 'object',
        properties: {
          characterId: { type: 'string' },
        },
        required: ['characterId'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isGetCharacterAvatarArgs(args)) {
        throw new Error('get_character_avatar requires a characterId: string');
      }
      const rows = await ctx.db.query<{ has_avatar: boolean }>(
        'select avatar_path is not null as has_avatar from characters where character_id = $1 and user_id = $2',
        [args.characterId, ctx.userId],
      );
      if (!rows[0]?.has_avatar) return { found: false };
      const bytes = await readAvatar(args.characterId);
      if (!bytes) return { found: false };
      return { found: true, mimeType: 'image/png', base64: bytes.toString('base64') };
    },
  };
}
