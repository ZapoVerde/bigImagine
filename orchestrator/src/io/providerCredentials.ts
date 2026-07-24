/**
 * @file orchestrator/src/io/providerCredentials.ts
 * @stamp 2026-07-24
 * @architectural-role IO Wrapper — encrypted, DB-backed provider API key storage
 * @description
 * Backs the four credentials named below (db/migrations/0008_provider_credentials.sql) with
 * createFieldCipher (io/fieldCipher.ts) — reused as-is, no crypto reimplemented here. resolve()
 * is this codebase's first decrypt-on-read call site; fieldCipher.ts's own preamble notes none
 * existed yet, only the encrypt-on-write idiom in ingestNoteTool.ts.
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

export const CREDENTIAL_NAMES = ['deepseek_api_key', 'openrouter_api_key', 'voyage_api_key', 'notion_token'] as const;
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
      const rows = await db.withSystemScope((session) =>
        session.query<{ name: CredentialName; updated_at: string | null }>(
          `select v.name as name, pc.updated_at as updated_at
           from (values ($1), ($2), ($3), ($4)) as v(name)
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
