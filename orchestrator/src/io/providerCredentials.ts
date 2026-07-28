/**
 * @file orchestrator/src/io/providerCredentials.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — encrypted, DB-backed secret storage
 * @description
 * Backs the credentials named below (db/migrations/0008_provider_credentials.sql,
 * 0014_calendar_ics_credentials.sql, 0016_web_search_credentials.sql,
 * 0018_google_calendar_oauth.sql, 0034_notifications_credentials_settings.sql) with
 * createFieldCipher (io/fieldCipher.ts) — reused as-is, no
 * crypto reimplemented here. resolve() is this codebase's first decrypt-on-read call site;
 * fieldCipher.ts's own preamble notes none existed yet, only the encrypt-on-write idiom in
 * ingestNoteTool.ts.
 *
 * The one shape every secret in this codebase uses (docs/bb_principles.md §12): a closed, named
 * vocabulary, encrypted at rest, never returned in plaintext or ciphertext once set — a new secret
 * is a new name added to CREDENTIAL_NAMES plus a migration widening the CHECK constraint, not a
 * new parallel mechanism. Non-secret config that merely selects or configures behavior (a user id,
 * a feature flag) never belongs in this vocabulary — see BIGBRAIN_NOTION_OWNER_USER_ID and
 * BIGBRAIN_CALENDAR_OWNER_USER_ID, both deliberately plain env instead.
 *
 * resolve()'s env-fallback-and-seed behavior is what lets this ship against an existing,
 * non-empty deployment without a manual DB write on cutover day: if no row exists yet, it uses
 * the caller-supplied legacy env value for *this* boot and persists it, so every boot after the
 * first reads only from the DB. UNMANAGED_SENTINEL lets an operator later replace a scrubbed env
 * var with an explicit "this is not a real fallback" marker, so a since-deleted DB row fails
 * closed (bb_principles.md §6) instead of silently booting on stale placeholder text — index.ts
 * is where that fail-closed check actually happens, for the LLM keys; this module just refuses
 * to treat the sentinel as a usable fallback.
 *
 * No RLS applies to provider_credentials (it has no user_id — see the migration), so this reads
 * PostgresClient.withSystemScope, never withUserScope.
 *
 * @api-declaration
 * CREDENTIAL_NAMES — the fixed vocabulary (mirrors 0008's CHECK constraint)
 * UNMANAGED_SENTINEL — env value treated as "no fallback available" post-cutover
 * createProviderCredentialStore(db, cipher) -> ProviderCredentialStore
 *   .list() -> Promise<CredentialSummary[]> — always all CREDENTIAL_NAMES; never plaintext/ciphertext
 *   .resolve(name, envFallback) -> Promise<string | undefined> — DB value if a row exists; else
 *     seeds+returns envFallback if it's set and isn't UNMANAGED_SENTINEL; else undefined
 *   .set(name, plaintext) -> Promise<void> — encrypt + upsert; the only admin-route write path
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via db.withSystemScope, AES via cipher)
 *     state_ownership: []
 *     external_io:     [Postgres]
 */

import type { FieldCipher } from './fieldCipher.js';
import type { PostgresClient } from './postgres.js';

export const CREDENTIAL_NAMES = [
  'deepseek_api_key',
  'openrouter_api_key',
  'voyage_api_key',
  'notion_token',
  'cozi_ics_url',
  'outlook_ics_url',
  'brave_api_key',
  'google_calendar_client_secret',
  'google_calendar_refresh_token',
  'ntfy_topic',
] as const;
export type CredentialName = (typeof CREDENTIAL_NAMES)[number];

export const UNMANAGED_SENTINEL = 'unused-managed-in-db';

export interface CredentialSummary {
  name: CredentialName;
  configured: boolean;
  updatedAt: string | null;
}

export interface ProviderCredentialStore {
  list(): Promise<CredentialSummary[]>;
  resolve(name: CredentialName, envFallback: string | undefined): Promise<string | undefined>;
  set(name: CredentialName, plaintext: string): Promise<void>;
}

export function createProviderCredentialStore(db: PostgresClient, cipher: FieldCipher): ProviderCredentialStore {
  async function set(name: CredentialName, plaintext: string): Promise<void> {
    await db.withSystemScope((session) =>
      session.query(
        `insert into provider_credentials (name, ciphertext, updated_at) values ($1, $2, now())
         on conflict (name) do update set ciphertext = excluded.ciphertext, updated_at = now()`,
        [name, cipher.encrypt(plaintext)],
      ),
    );
  }

  return {
    async list(): Promise<CredentialSummary[]> {
      const placeholders = CREDENTIAL_NAMES.map((_, i) => `($${i + 1})`).join(', ');
      const rows = await db.withSystemScope((session) =>
        session.query<{ name: CredentialName; updated_at: string | null }>(
          `select v.name as name, pc.updated_at as updated_at
           from (values ${placeholders}) as v(name)
           left join provider_credentials pc using (name)
           order by v.name`,
          [...CREDENTIAL_NAMES],
        ),
      );
      return rows.map((row) => ({
        name: row.name,
        updatedAt: row.updated_at,
        configured: row.updated_at !== null,
      }));
    },

    async resolve(name, envFallback) {
      const rows = await db.withSystemScope((session) =>
        session.query<{ ciphertext: string }>('select ciphertext from provider_credentials where name = $1', [name]),
      );
      if (rows[0]) return cipher.decrypt(rows[0].ciphertext);
      if (!envFallback || envFallback === UNMANAGED_SENTINEL) return undefined;
      await set(name, envFallback);
      return envFallback;
    },

    set,
  };
}
