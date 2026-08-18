/**
 * @file plugins/characters/src/index.ts
 * @stamp 2026-08-05
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The Character Roster (docs/spec.md §6): structured character records plus full SillyTavern-
 * compatible PNG/JSON card import/export (cardCodec.ts), avatar storage (avatarStorage.ts), and
 * loading a character into a chat's system prompt + opening greeting (applyCharacterToChatTool.ts).
 * Extraction never touches this table — it proposes canon_facts rows instead
 * (canonize-plan.md §3.3). Most of these tools need only ctx.db/ctx.userId, supplied per-call —
 * import_character_card_from_url and search_chub_characters are the exception, needing
 * deps.settings (io/piaProxyFetch.ts's pia_proxy_url) at construction time, since chub.ai blocks
 * Australian IPs and every fetch to it has to go through the pia-proxy tunnel.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [create_character, get_characters, get_character,
 *   update_character, delete_character, import_character_card, import_character_card_from_url,
 *   search_chub_characters, export_character_card, get_character_avatar, apply_character_to_chat,
 *   remove_character_from_chat]
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs tools that do IO)
 *     state_ownership: []
 *     external_io:     []
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { createApplyCharacterToChatTool } from './applyCharacterToChatTool.js';
import { createCreateCharacterTool } from './createCharacterTool.js';
import { createDeleteCharacterTool } from './deleteCharacterTool.js';
import { createExportCharacterCardTool } from './exportCharacterCardTool.js';
import { createGetCharacterAvatarTool } from './getCharacterAvatarTool.js';
import { createGetCharacterTool } from './getCharacterTool.js';
import { createGetCharactersTool } from './getCharactersTool.js';
import { createImportCharacterCardTool } from './importCharacterCardTool.js';
import { createImportCharacterCardFromUrlTool } from './importCharacterCardFromUrlTool.js';
import { createRemoveCharacterFromChatTool } from './removeCharacterFromChatTool.js';
import { createSearchChubCharactersTool } from './searchChubCharactersTool.js';
import { createUpdateCharacterTool } from './updateCharacterTool.js';

export const info = {
  id: 'characters',
  name: 'Characters',
  description:
    'The Character Roster: create, edit, delete, import (PNG/JSON card, or a chub.ai URL/search), export, and list characters, and load one into a chat.',
};

export async function registerTools(deps: PluginDeps): Promise<RegisteredTool[]> {
  return [
    createCreateCharacterTool(),
    createGetCharactersTool(),
    createGetCharacterTool(),
    createUpdateCharacterTool(),
    createDeleteCharacterTool(),
    createImportCharacterCardTool(),
    createImportCharacterCardFromUrlTool(deps.settings),
    createSearchChubCharactersTool(deps.settings),
    createExportCharacterCardTool(),
    createGetCharacterAvatarTool(),
    createApplyCharacterToChatTool(),
    createRemoveCharacterFromChatTool(),
  ];
}