/**
 * @file orchestrator/src/io/orchestratorSettings.ts
 * @stamp 2026-07-24
 * @architectural-role IO Wrapper — DB-backed household-wide orchestrator settings
 * @description
 * Backs orchestrator_settings (db/migrations/0010_orchestrator_settings.sql) — the plaintext
 * counterpart to providerCredentials.ts's encrypted store. Same fixed-vocabulary, no-RLS,
 * household-wide shape, but values here are never secret (a connection profile/model/timezone
 * *name*, not an API key), so get() can just hand the plaintext back — unlike
 * providerCredentials.ts, this store is meant to be read back and displayed, not only reported as
 * "configured".
 *
 * household_timezone (an IANA zone name, e.g. "America/New_York") is read fresh on every chat
 * turn (server/httpServer.ts's handleChatCompletions, via util/dateContext.ts) rather than baked
 * into anything at boot — unlike active_llm_profile/active_llm_model, changing it takes effect
 * immediately, no restart needed, since it's just interpolated into a system message per request.
 *
 * calendar_owner_user_id/mask_work_calendar (plugins/calendar) and notion_owner_user_id/
 * notion_lists_data_source_id (io/notion.ts) are boot-time, same restart-on-save shape as
 * active_llm_profile — each is read once when the client/background job it configures is
 * constructed, with its legacy BIGBRAIN_*-prefixed env var as the fallback when unset in the DB
 * (docs/bb_principles.md §13). Neither is a secret (§12) — get() hands the plaintext back for the
 * same reason household_timezone does.
 *
 * @api-declaration
 * SETTING_NAMES — the fixed vocabulary (mirrors 0010's CHECK constraint)
 * createOrchestratorSettingsStore(db) -> OrchestratorSettingsStore
 *   .get(key) -> Promise<string | undefined> — the stored value, or undefined if never set
 *   .set(key, value) -> Promise<void> — upsert
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via db.withSystemScope)
 *     state_ownership: []
 *     external_io:     [Postgres]
 */

import type { PostgresClient } from './postgres.js';

export const SETTING_NAMES = [
  'active_llm_profile',
  'active_llm_model',
  'household_timezone',
  'calendar_owner_user_id',
  'mask_work_calendar',
  'notion_owner_user_id',
  'notion_lists_data_source_id',
] as const;
export type SettingName = (typeof SETTING_NAMES)[number];

export interface OrchestratorSettingsStore {
  get(key: SettingName): Promise<string | undefined>;
  set(key: SettingName, value: string): Promise<void>;
}

export function createOrchestratorSettingsStore(db: PostgresClient): OrchestratorSettingsStore {
  return {
    async get(key) {
      const rows = await db.withSystemScope((session) =>
        session.query<{ value: string }>('select value from orchestrator_settings where key = $1', [key]),
      );
      return rows[0]?.value;
    },

    async set(key, value) {
      await db.withSystemScope((session) =>
        session.query(
          `insert into orchestrator_settings (key, value, updated_at) values ($1, $2, now())
           on conflict (key) do update set value = excluded.value, updated_at = now()`,
          [key, value],
        ),
      );
    },
  };
}
