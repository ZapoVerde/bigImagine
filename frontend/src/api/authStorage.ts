/**
 * @file frontend/src/api/authStorage.ts
 * @stamp 2026-08-04
 * @architectural-role Pure Functions — shared constant
 * @description
 * The localStorage key App.tsx stores the manually-entered API key under. Pulled out to its own
 * file so lib/browserLogger.ts can read the same key at flush time without importing App.tsx.
 * @api-declaration
 * API_KEY_STORAGE_KEY — the localStorage key name.
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

export const API_KEY_STORAGE_KEY = 'bb_api_key';
