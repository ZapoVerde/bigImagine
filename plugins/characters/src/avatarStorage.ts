/**
 * @file plugins/characters/src/avatarStorage.ts
 * @stamp 2026-08-16
 * @architectural-role IO Wrapper — re-export shim for the avatar on-disk layout
 * @description
 * The avatar storage implementation now lives in the orchestrator
 * (orchestrator/src/io/characterMedia.ts, exported as `@bigbrain/orchestrator/character-media`):
 * the Portrait Studio's winner promotion and set-as-avatar route (studio-character-bridge-plan.md
 * Part C) write avatars from the orchestrator side, and the orchestrator never statically depends
 * on a plugin package (pluginLoader.ts's dependency rule). This file keeps the plugin's original
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
