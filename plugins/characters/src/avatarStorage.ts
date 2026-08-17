/**
 * @file plugins/characters/src/avatarStorage.ts
 * @stamp 2026-08-16
 * @architectural-role IO Wrapper — re-export shim for the avatar on-disk layout
 * @description
 * The avatar storage implementation now lives in the orchestrator
 * (orchestrator/src/io/characterMedia.ts, exported as `@bigbrain/orchestrator/character-media`) —
 * see that file's own doc comment for why the location stayed orchestrator-side even though
 * Portrait Studio's old orchestrator-side avatar writes have since been retired
 * (portrait-studio-standalone-subjects-plan.md). This file keeps the plugin's original
 * public surface — every existing `from './avatarStorage.js'` consumer in this package imports
 * the same three functions, unchanged.
 *
 * @api-declaration
 * writeAvatar(characterId, bytes) — writes/overwrites the stored PNG for this character
 * readAvatar(characterId) — the stored PNG bytes, or null if none was ever set
 * deleteAvatar(characterId) — removes the stored PNG, a no-op if none exists
 *
 * @contract
 *   assertions:
 *     purity:          impure (filesystem, via the orchestrator module)
 *     state_ownership: []
 *     external_io:     [filesystem]
 */

export { writeAvatar, readAvatar, deleteAvatar } from '@bigbrain/orchestrator/character-media';
