/**
 * @file orchestrator/src/io/characterMedia.ts
 * @stamp 2026-08-16
 * @architectural-role IO Wrapper — a character's raw avatar image bytes on disk
 * @description
 * Character rows never store image bytes in Postgres — same reasoning as plugins/documents'
 * gitRepo.ts keeping document content on disk rather than in a jsonb column. One file per
 * character_id (a random UUID, not guessable), so access control stays where it already lives —
 * the character_id + user_id check each tool/route does before ever calling into this module —
 * rather than a second, redundant per-user directory split. BIGBRAIN_CHARACTER_MEDIA_DIR mirrors
 * BIGBRAIN_DOCUMENTS_DIR's env-configured-directory convention exactly.
 *
 * This is the single source of truth for the on-disk avatar layout. plugins/characters'
 * avatarStorage.ts re-exports these three functions so the plugin's existing consumers
 * (insertCharacterFromCard, getCharacterAvatarTool, exportCharacterCardTool,
 * deleteCharacterTool) keep their `from './avatarStorage.js'` imports, while the orchestrator's
 * own avatar writes (Portrait Studio's winner promotion and set-as-avatar route,
 * docs/plans/studio-character-bridge-plan.md Part C) reach the same code path — the
 * orchestrator never statically depends on a plugin package (pluginLoader.ts's dependency
 * rule), so the shared module lives here.
 *
 * @api-declaration
 * writeAvatar(characterId, bytes) — writes/overwrites the stored PNG for this character
 * readAvatar(characterId) — the stored PNG bytes, or null if none was ever set
 * deleteAvatar(characterId) — removes the stored PNG, a no-op if none exists
 *
 * @contract
 *   assertions:
 *     purity:          impure (filesystem)
 *     state_ownership: []
 *     external_io:     [filesystem]
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const BASE_DIR = resolve(process.env.BIGBRAIN_CHARACTER_MEDIA_DIR ?? '/app/character-media');

function avatarPath(characterId: string): string {
  return join(BASE_DIR, `${characterId}.png`);
}

export async function writeAvatar(characterId: string, bytes: Buffer): Promise<void> {
  await mkdir(BASE_DIR, { recursive: true });
  await writeFile(avatarPath(characterId), bytes);
}

export async function readAvatar(characterId: string): Promise<Buffer | null> {
  try {
    return await readFile(avatarPath(characterId));
  } catch {
    return null;
  }
}

export async function deleteAvatar(characterId: string): Promise<void> {
  await rm(avatarPath(characterId), { force: true });
}
