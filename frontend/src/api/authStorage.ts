/**
 * @file frontend/src/api/authStorage.ts
 * @stamp 2026-08-04
 * @architectural-role Pure Functions — shared constant
 * @description
 * The localStorage key App.tsx stores the manually-entered API key under. Pulled out to its own
 * file so lib/browserLogger.ts can read the same key at flush time without importing App.tsx.
 * Also holds the admin-key storage key (SettingsView.tsx) — single-user deployments have no
 * household member to withhold admin access from, so it's persisted the same way.
 * @api-declaration
 * API_KEY_STORAGE_KEY — the localStorage key name for the household API key.
 * ADMIN_API_KEY_STORAGE_KEY — the localStorage key name for the admin key.
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

export const API_KEY_STORAGE_KEY = 'bb_api_key';
export const ADMIN_API_KEY_STORAGE_KEY = 'bb_admin_api_key';
