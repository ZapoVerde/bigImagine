/**
 * @file plugins/cards/src/cardMedia.ts
 * @stamp 2026-08-22
 * @architectural-role IO Wrapper — Card-owned media cleanup adapter
 * @description
 * Card CRUD owns cleanup of the existing UUID-keyed imported-image storage. This adapter keeps the
 * physical storage detail out of Card deletion logic and makes missing files harmless.
 *
 * @api-declaration
 * deleteCardMedia(cardId) — removes the locally stored imported Card image, if present
 *
 * @contract
 *   assertions:
 *     purity:          impure (filesystem through the shared media wrapper)
 *     state_ownership: []
 *     external_io:     [filesystem]
 */

import { deleteCardMedia as deleteStoredCardMedia } from './cardMediaStorage.js';

export async function deleteCardMedia(cardId: string): Promise<void> {
  await deleteStoredCardMedia(cardId);
}
