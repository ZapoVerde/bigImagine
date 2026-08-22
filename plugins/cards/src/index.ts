/**
 * @file plugins/cards/src/index.ts
 * @stamp 2026-08-22
 * @architectural-role IO Wrapper — Cards plugin entry point
 * @description
 * Registers canonical Card CRUD. Cards are reusable source material; runtime Character lifecycle
 * remains owned by the Characters plugin and character_chat_links.
 *
 * @api-declaration
 * info — Cards plugin identity
 * registerTools(deps) — returns get_cards, get_card, create_card, update_card, delete_card
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs tools that do IO)
 *     state_ownership: []
 *     external_io:     []
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { createCreateCardTool } from './createCardTool.js';
import { createDeleteCardTool } from './deleteCardTool.js';
import { createGetCardTool } from './getCardTool.js';
import { createGetCardsTool } from './getCardsTool.js';
import { createUpdateCardTool } from './updateCardTool.js';
import { createImportCardTool } from './importCardTool.js';
import { createImportCardFromUrlTool } from './importCardFromUrlTool.js';
import { createSearchChubCardsTool } from './searchChubCardsTool.js';
import { createExportCardTool } from './exportCardTool.js';
import { createGetCardAvatarTool } from './getCardAvatarTool.js';
import { createApplyCardToChatTool } from './applyCardToChatTool.js';

export const info = {
  id: 'cards',
  name: 'Cards',
  description: 'Reusable Cards: list, inspect, create, edit, and delete Card source material.',
};

export async function registerTools(_deps: PluginDeps): Promise<RegisteredTool[]> {
  return [createGetCardsTool(), createGetCardTool(), createCreateCardTool(), createUpdateCardTool(), createDeleteCardTool(),
    createImportCardTool(), createImportCardFromUrlTool(_deps.settings), createSearchChubCardsTool(_deps.settings),
    createExportCardTool(), createGetCardAvatarTool(), createApplyCardToChatTool()];
}
