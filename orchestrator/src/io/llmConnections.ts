/**
 * @file orchestrator/src/io/llmConnections.ts
 * @stamp 2026-08-06
 * @architectural-role IO Wrapper — DB-backed, admin-managed LLM connection registry
 * @description
 * Replaces BIGBRAIN_LLM_PROFILES (io/llm/profiles.ts) as the runtime source of truth for LLM
 * connections (db/migrations/0062_llm_connections.sql). Where profiles.ts's withOverridden*
 * functions could only splice a field onto an *existing* env-defined profile, this store owns real
 * CRUD — a connection is created/renamed/deleted here, not just field-overridden. index.ts still
 * uses profiles.ts's parseLlmProfiles once, at first boot only, to seed this table from
 * BIGBRAIN_LLM_PROFILES so an existing deployment's connections/keys carry over unattended.
 *
 * api_key_ciphertext follows io/providerCredentials.ts's own shape (io/fieldCipher.ts,
 * AES-256-GCM): never returned in plaintext by list()/get()-shaped reads, only decrypted by
 * resolveByName/resolveActive, which hand back an io/llm/profiles.ts LlmProfile for
 * io/llm/index.ts's createLlmProviderForProfile to consume — the one place plaintext ever exists
 * outside this module.
 *
 * is_active is enforced to at most one row by 0062's partial unique index; activate() flips it
 * atomically in one statement (a CTE clears the old row and sets the new one, so there's no
 * window with zero or two active rows even under concurrent admin requests). remove() refuses to
 * delete the active connection — the caller must activate a different one first, the same
 * "explicit successor" shape the old Settings fieldset's restart-required switch already implied.
 *
 * @api-declaration
 * LlmConnectionRow — the redacted shape returned to callers (no apiKey plaintext or ciphertext)
 * createLlmConnectionStore(db, cipher) -> LlmConnectionStore
 *   .list() -> Promise<LlmConnectionRow[]>
 *   .create(init) -> Promise<LlmConnectionRow>
 *   .update(id, patch) -> Promise<LlmConnectionRow | undefined> — undefined if id doesn't exist
 *   .remove(id) -> Promise<'ok' | 'not_found' | 'is_active'>
 *   .activate(id) -> Promise<boolean> — false if id doesn't exist
 *   .resolveById(id) -> Promise<LlmProfile | undefined> — decrypts apiKey; server-side only, backs
 *     the Connections tab's models/providers preview routes (adminServer.ts)
 *   .resolveByName(name) -> Promise<LlmProfile | undefined> — decrypts apiKey; server-side only
 *   .resolveActive() -> Promise<LlmProfile | undefined>
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via db.withSystemScope, AES via cipher)
 *     state_ownership: []
 *     external_io:     [Postgres]
 */

import type { FieldCipher } from './fieldCipher.js';
import type { PostgresClient } from './postgres.js';
import type { LlmProfile } from './llm/profiles.js';

export interface LlmConnectionRow {
  id: string;
  name: string;
  kind: 'anthropic' | 'openai-compatible';
  model: string;
  baseUrl: string | null;
  supportsVision: boolean;
  providerOrder: string[] | null;
  allowFallbacks: boolean;
  quantizations: string[] | null;
  isActive: boolean;
  updatedAt: string;
}

export interface LlmConnectionInit {
  name: string;
  kind: 'anthropic' | 'openai-compatible';
  model: string;
  apiKey: string;
  baseUrl?: string;
  supportsVision?: boolean;
  providerOrder?: string[];
  allowFallbacks?: boolean;
  quantizations?: string[];
}

export interface LlmConnectionPatch {
  name?: string;
  model?: string;
  /** Undefined leaves the stored key untouched — only present when the admin is rotating it. */
  apiKey?: string;
  baseUrl?: string | null;
  supportsVision?: boolean;
  providerOrder?: string[] | null;
  allowFallbacks?: boolean;
  quantizations?: string[] | null;
}

export interface LlmConnectionStore {
  list(): Promise<LlmConnectionRow[]>;
  create(init: LlmConnectionInit): Promise<LlmConnectionRow>;
  update(id: string, patch: LlmConnectionPatch): Promise<LlmConnectionRow | undefined>;
  remove(id: string): Promise<'ok' | 'not_found' | 'is_active'>;
  activate(id: string): Promise<boolean>;
  resolveById(id: string): Promise<LlmProfile | undefined>;
  resolveByName(name: string): Promise<LlmProfile | undefined>;
  resolveActive(): Promise<LlmProfile | undefined>;
}

interface ConnectionDbRow {
  id: string;
  name: string;
  kind: 'anthropic' | 'openai-compatible';
  model: string;
  base_url: string | null;
  supports_vision: boolean;
  api_key_ciphertext: string;
  provider_order: string[] | null;
  allow_fallbacks: boolean;
  quantizations: string[] | null;
  is_active: boolean;
  updated_at: string;
}

const ROW_COLUMNS = `id, name, kind, model, base_url, supports_vision, api_key_ciphertext,
  provider_order, allow_fallbacks, quantizations, is_active, updated_at`;

function toRow(row: ConnectionDbRow): LlmConnectionRow {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    model: row.model,
    baseUrl: row.base_url,
    supportsVision: row.supports_vision,
    providerOrder: row.provider_order,
    allowFallbacks: row.allow_fallbacks,
    quantizations: row.quantizations,
    isActive: row.is_active,
    updatedAt: row.updated_at,
  };
}

// Undefined means "OpenRouter's own default full-set routing" — omitted from the request body
// entirely (openaiCompatible.ts) rather than sent as a no-op {allow_fallbacks: true}.
function toProviderConfig(row: ConnectionDbRow): LlmProfile['provider'] {
  const order = row.provider_order && row.provider_order.length > 0 ? row.provider_order : undefined;
  const quantizations = row.quantizations && row.quantizations.length > 0 ? row.quantizations : undefined;
  if (!order && !quantizations && row.allow_fallbacks) return undefined;
  return { order, allowFallbacks: row.allow_fallbacks, quantizations };
}

function toProfile(row: ConnectionDbRow, cipher: FieldCipher): LlmProfile {
  return {
    kind: row.kind,
    model: row.model,
    apiKey: cipher.decrypt(row.api_key_ciphertext),
    baseUrl: row.base_url ?? undefined,
    supportsVision: row.supports_vision,
    provider: toProviderConfig(row),
  };
}

export function createLlmConnectionStore(db: PostgresClient, cipher: FieldCipher): LlmConnectionStore {
  return {
    async list() {
      const rows = await db.withSystemScope((session) =>
        session.query<ConnectionDbRow>(`select ${ROW_COLUMNS} from llm_connections order by name`),
      );
      return rows.map(toRow);
    },

    async create(init) {
      const rows = await db.withSystemScope((session) =>
        session.query<ConnectionDbRow>(
          `insert into llm_connections
             (name, kind, model, api_key_ciphertext, base_url, supports_vision, provider_order, allow_fallbacks, quantizations)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           returning ${ROW_COLUMNS}`,
          [
            init.name,
            init.kind,
            init.model,
            cipher.encrypt(init.apiKey),
            init.baseUrl ?? null,
            init.supportsVision ?? false,
            init.providerOrder ? JSON.stringify(init.providerOrder) : null,
            init.allowFallbacks ?? true,
            init.quantizations ? JSON.stringify(init.quantizations) : null,
          ],
        ),
      );
      return toRow(rows[0]);
    },

    async update(id, patch) {
      const sets: string[] = [];
      const values: unknown[] = [];
      function set(column: string, value: unknown): void {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      }
      if (patch.name !== undefined) set('name', patch.name);
      if (patch.model !== undefined) set('model', patch.model);
      if (patch.apiKey !== undefined) set('api_key_ciphertext', cipher.encrypt(patch.apiKey));
      if (patch.baseUrl !== undefined) set('base_url', patch.baseUrl);
      if (patch.supportsVision !== undefined) set('supports_vision', patch.supportsVision);
      if (patch.providerOrder !== undefined) set('provider_order', patch.providerOrder ? JSON.stringify(patch.providerOrder) : null);
      if (patch.allowFallbacks !== undefined) set('allow_fallbacks', patch.allowFallbacks);
      if (patch.quantizations !== undefined) set('quantizations', patch.quantizations ? JSON.stringify(patch.quantizations) : null);
      if (sets.length === 0) {
        const rows = await db.withSystemScope((session) =>
          session.query<ConnectionDbRow>(`select ${ROW_COLUMNS} from llm_connections where id = $1`, [id]),
        );
        return rows[0] ? toRow(rows[0]) : undefined;
      }
      sets.push('updated_at = now()');
      values.push(id);
      const rows = await db.withSystemScope((session) =>
        session.query<ConnectionDbRow>(
          `update llm_connections set ${sets.join(', ')} where id = $${values.length} returning ${ROW_COLUMNS}`,
          values,
        ),
      );
      return rows[0] ? toRow(rows[0]) : undefined;
    },

    async remove(id) {
      const rows = await db.withSystemScope((session) =>
        session.query<{ is_active: boolean }>('select is_active from llm_connections where id = $1', [id]),
      );
      if (!rows[0]) return 'not_found';
      if (rows[0].is_active) return 'is_active';
      await db.withSystemScope((session) => session.query('delete from llm_connections where id = $1', [id]));
      return 'ok';
    },

    async activate(id) {
      const rows = await db.withSystemScope((session) =>
        session.query<{ id: string }>(
          `with cleared as (
             update llm_connections set is_active = false where is_active
           )
           update llm_connections set is_active = true, updated_at = now() where id = $1
           returning id`,
          [id],
        ),
      );
      return rows.length > 0;
    },

    async resolveById(id) {
      const rows = await db.withSystemScope((session) =>
        session.query<ConnectionDbRow>(`select ${ROW_COLUMNS} from llm_connections where id = $1`, [id]),
      );
      return rows[0] ? toProfile(rows[0], cipher) : undefined;
    },

    async resolveByName(name) {
      const rows = await db.withSystemScope((session) =>
        session.query<ConnectionDbRow>(`select ${ROW_COLUMNS} from llm_connections where name = $1`, [name]),
      );
      return rows[0] ? toProfile(rows[0], cipher) : undefined;
    },

    async resolveActive() {
      const rows = await db.withSystemScope((session) =>
        session.query<ConnectionDbRow>(`select ${ROW_COLUMNS} from llm_connections where is_active`),
      );
      return rows[0] ? toProfile(rows[0], cipher) : undefined;
    },
  };
}
