/**
 * @file plugins/characters/src/index.ts
 * @stamp 2026-08-22
 * @architectural-role IO Wrapper — runtime Characters plugin entry point
 * @description
 * Runtime Characters only (chat-scoped via character_chat_links). Reusable Cards
 * are served by the canonical Cards plugin. No Card import/export/Chub/avatar/Card-to-chat
 * surface is registered here.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [get_characters, get_character, update_character,
 *   delete_character, remove_character_from_chat]
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs tools that do IO)
 *     state_ownership: []
 *     external_io:     []
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { createDeleteCharacterTool } from './deleteCharacterTool.js';
import { createGetCharacterTool } from './getCharacterTool.js';
import { createGetCharactersTool } from './getCharactersTool.js';
import { createRemoveCharacterFromChatTool } from './removeCharacterFromChatTool.js';
import { createUpdateCharacterTool } from './updateCharacterTool.js';

export const info = {
  id: 'characters',
  name: 'Characters',
  description: 'Runtime Characters: chat-scoped cast and scene presence.',
};

export async function registerTools(): Promise<RegisteredTool[]> {
  return [
    createGetCharactersTool(),
    createGetCharacterTool(),
    createUpdateCharacterTool(),
    createDeleteCharacterTool(),
    createRemoveCharacterFromChatTool(),
  ];
}