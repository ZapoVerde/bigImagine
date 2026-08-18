/**
 * @file orchestrator/src/io/llmConnections.ts
 * @stamp 2026-08-18
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
 * A connection's `kind` names its provider, not just its wire adapter. `deepseek` and `openrouter`
 * are provider kinds (db/migrations/0117_llm_connection_provider_kinds.sql): both still speak the
 * OpenAI-compatible shape, but they store NO per-row key (api_key_ciphertext is null by CHECK) and
 * resolve it at call time from the provider_credentials row of the same name (deepseek_api_key /
 * openrouter_api_key, io/providerCredentials.ts) — one key shared in the background by every
 * connection of that kind, rotated once in Settings. `anthropic` and `openai-compatible` stay
 * freeform: each row owns its own ciphertext, with copyApiKeyFrom (below) as the manual reuse path.
 * Shared-key resolution fails closed with a specific error when the credential is unconfigured
 * (bi_principles.md §6): an active provider-kind connection with no key is a misconfiguration, not a
 * graceful-degrade case.
 *
 * is_active is enforced to at most one row by 0062's partial unique index; activate() flips it
 * atomically in one statement (a CTE clears the old row and sets the new one, so there's no
 * window with zero or two active rows even under concurrent admin requests). remove() refuses to
 * delete the active connection — the caller must activate a different one first, the same
 * "explicit successor" shape the old Settings fieldset's restart-required switch already implied.
 *
 * LlmConnectionInit/Patch's copyApiKeyFrom lets create()/update() of a freeform connection reuse
 * another connection's key by id instead of typing a fresh one — several named connections sharing
 * one underlying provider no longer means re-pasting the same key into each. copyCiphertext() copies
 * the ciphertext column directly; the plaintext never passes through this path. Provider-kind
 * connections reject apiKey/copyApiKeyFrom outright: their key is the shared credential, not a row.
 *
 * @api-declaration
 * LlmConnectionRow — the redacted shape returned to callers (no apiKey plaintext or ciphertext);
 *   provider-kind rows also carry usesSharedKey/sharedKeyConfigured so the Connections UI can show
 *   "shared key not configured" without a second round trip
 * createLlmConnectionStore(db, cipher, credentials) -> LlmConnectionStore
 *   .list() -> Promise<LlmConnectionRow[]>
 *   .create(init) -> Promise<LlmConnectionRow> — provider kinds take no key; freeform kinds need
 *     exactly one of init.apiKey/init.copyApiKeyFrom
 *   .update(id, patch) -> Promise<LlmConnectionRow | undefined> — undefined if id doesn't exist
 *   .remove(id) -> Promise<'ok' | 'not_found' | 'is_active'>
 *   .activate(id) -> Promise<boolean> — false if id doesn't exist
 *   .resolveById(id) -> Promise<LlmProfile | undefined> — decrypts apiKey (or resolves the shared
 *     credential for provider kinds); server-side only, backs the Connections tab's models/providers
 *     preview routes (adminServer.ts)
 *   .resolveByName(name) -> Promise<LlmProfile | undefined> — same, server-side only
 *   .resolveActive() -> Promise<LlmProfile | undefined>
 * isProviderKind(kind) — 'deepseek' | 'openrouter' predicate, shared with adminServer.ts's parsers
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via db.withSystemScope, AES via cipher,
 *                      provider_credentials read for shared-key resolution)
 *     state_ownership: []
 *     external_io:     [Postgres]
 */

import type { FieldCipher } from './fieldCipher.js';
import type { PostgresClient } from './postgres.js';
import type { LlmProfile } from './llm/profiles.js';
import type { CredentialName, ProviderCredentialStore } from './providerCredentials.js';

/** Connection kinds that draw their API key from the shared provider_credentials row of the same
 *  name instead of a per-row ciphertext (db/migrations/0117_llm_connection_provider_kinds.sql).
 *  Both still speak the OpenAI-compatible wire shape; the kind only names the provider. */
export type ProviderKind = 'deepseek' | 'openrouter';
export type LlmConnectionKind = 'anthropic' | 'openai-compatible' | ProviderKind;

const PROVIDER_KINDS: ReadonlySet<LlmConnectionKind> = new Set<LlmConnectionKind>(['deepseek', 'openrouter']);

export function isProviderKind(kind: LlmConnectionKind): kind is ProviderKind {
  return PROVIDER_KINDS.has(kind);
}

/** The shared provider_credentials name behind each provider kind (io/providerCredentials.ts's
 *  CREDENTIAL_NAMES — both names already exist there). */
export const SHARED_CREDENTIAL_BY_KIND: Record<ProviderKind, CredentialName> = {
  deepseek: 'deepseek_api_key',
  openrouter: 'openrouter_api_key',
};

/** Fixed base URL for each provider kind — a deepseek/openrouter connection never needs a freeform
 *  one (unlike openai-compatible), so the row always stores the canonical value and the editor hides
 *  the field. */
const CANONICAL_BASE_URL: Record<ProviderKind, string> = {
  deepseek: 'https://api.deepseek.com',
  openrouter: 'https://openrouter.ai/api/v1',
};

export interface LlmConnectionRow {
  id: string;
  name: string;
  kind: LlmConnectionKind;
  model: string;
  baseUrl: string | null;
  supportsVision: boolean;
  /** True for provider-kind (deepseek/openrouter) rows: their key comes from the shared
   *  provider_credentials row, not this connection's own ciphertext. */
  usesSharedKey: boolean;
  /** Whether the shared credential behind a provider-kind row is configured — the "key set?" readout
   *  the Connections UI shows for these kinds. Always true for freeform rows (they own their key). */
  sharedKeyConfigured: boolean;
  providerOrder: string[] | null;
  allowFallbacks: boolean;
  quantizations: string[] | null;
  priceInputPerMillion?: number;
  priceOutputPerMillion?: number;
  priceCacheHitPerMillion?: number;
  /** Peak tier (migration 0109's price_peak_* columns) — USD per 1M tokens for the hours
   *  DeepSeek bills at the higher rate (docs/plans/deepseek-pricing-sync.md). Same nullable
   *  contract as the base tier: undefined means "not configured". */
  pricePeakInputPerMillion?: number;
  pricePeakOutputPerMillion?: number;
  pricePeakCacheHitPerMillion?: number;
  /** When the pricing sync (orchestrator/src/io/deepseekPricingSync.ts) last wrote this row's
   *  rates — read-only to admins; the editor's "last synced" line and the Stats page read it. */
  priceSyncedAt?: string;
  isActive: boolean;
  updatedAt: string;
}

export interface LlmConnectionInit {
  name: string;
  kind: LlmConnectionKind;
  model: string;
  /** Exactly one of apiKey/copyApiKeyFrom must be given for freeform kinds (anthropic /
   *  openai-compatible) — see copyApiKeyFrom below. Provider kinds (deepseek/openrouter) take
   *  neither: their key is the shared provider_credentials row of the same name. */
  apiKey?: string;
  /**
   * Id of an existing connection whose key to reuse, instead of typing a fresh one — the two share
   * a provider often enough (several named OpenRouter connections, one model each) that re-pasting
   * the same key into every one of them was the friction that prompted this. Copies the ciphertext
   * column directly; the plaintext key is never re-read or exposed to do this. Freeform kinds only —
   * provider-kind connections have no row key to copy.
   */
  copyApiKeyFrom?: string;
  baseUrl?: string;
  supportsVision?: boolean;
  providerOrder?: string[];
  allowFallbacks?: boolean;
  quantizations?: string[];
  /** USD per 1M tokens for the Prompt Inspector's cost receipt — undefined means "not
   *  configured", so the inspector shows token counts only, never a fabricated $0.00. */
  priceInputPerMillion?: number;
  priceOutputPerMillion?: number;
  priceCacheHitPerMillion?: number;
  /** Peak tier — USD per 1M tokens, same nullable contract as the base tier above
   *  (docs/plans/deepseek-pricing-sync.md). */
  pricePeakInputPerMillion?: number;
  pricePeakOutputPerMillion?: number;
  pricePeakCacheHitPerMillion?: number;
}

export interface LlmConnectionPatch {
  name?: string;
  kind?: LlmConnectionKind;
  model?: string;
  /** Undefined leaves the stored key untouched — only present when the admin is rotating it.
   *  Provider kinds reject this: their key is rotated in Settings, never per connection. */
  apiKey?: string;
  /** Rotate this connection's key by copying another connection's, instead of typing one — see LlmConnectionInit.copyApiKeyFrom. Mutually exclusive with apiKey. Provider kinds reject this too. */
  copyApiKeyFrom?: string;
  baseUrl?: string | null;
  supportsVision?: boolean;
  providerOrder?: string[] | null;
  allowFallbacks?: boolean;
  quantizations?: string[] | null;
  /** number-or-null: undefined leaves the stored price untouched, null explicitly clears it
   *  (same three-state convention baseUrl already uses). */
  priceInputPerMillion?: number | null;
  priceOutputPerMillion?: number | null;
  priceCacheHitPerMillion?: number | null;
  /** Peak tier — number-or-null, same three-state convention as the base tier above. */
  pricePeakInputPerMillion?: number | null;
  pricePeakOutputPerMillion?: number | null;
  pricePeakCacheHitPerMillion?: number | null;
  /** Written only by the pricing sync (orchestrator/src/io/deepseekPricingSync.ts), never by the
   *  admin editor — parseUpdateConnectionBody in server/adminServer.ts deliberately never sets it,
   *  so a PATCH can't spoof "last synced". */
  priceSyncedAt?: string;
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
  kind: LlmConnectionKind;
  model: string;
  base_url: string | null;
  supports_vision: boolean;
  api_key_ciphertext: string | null;
  provider_order: string[] | null;
  allow_fallbacks: boolean;
  quantizations: string[] | null;
  price_input_per_million: string | null;
  price_output_per_million: string | null;
  price_cache_hit_per_million: string | null;
  price_peak_input_per_million: string | null;
  price_peak_output_per_million: string | null;
  price_peak_cache_hit_per_million: string | null;
  price_synced_at: string | null;
  is_active: boolean;
  updated_at: string;
}

const ROW_COLUMNS = `id, name, kind, model, base_url, supports_vision, api_key_ciphertext,
  provider_order, allow_fallbacks, quantizations, price_input_per_million,
  price_output_per_million, price_cache_hit_per_million, price_peak_input_per_million,
  price_peak_output_per_million, price_peak_cache_hit_per_million, price_synced_at, is_active, updated_at`;

// numeric columns come back from pg as strings; a null column means "not configured", which maps
// to undefined end to end (the plan's "tokens only, never $0.00" contract).
function toPrice(value: string | null): number | undefined {
  return value === null ? undefined : Number(value);
}

/** Which of the two provider credentials are configured — the "key set?" readout for provider-kind
 *  rows (usesSharedKey/sharedKeyConfigured). One query for both names, reused by list/create/update. */
async function sharedKeyStatus(db: PostgresClient): Promise<Record<ProviderKind, boolean>> {
  const rows = await db.withSystemScope((session) =>
    session.query<{ name: string }>(
      `select name from provider_credentials where name in ('deepseek_api_key', 'openrouter_api_key')`,
    ),
  );
  const configured = new Set(rows.map((r) => r.name));
  return {
    deepseek: configured.has('deepseek_api_key'),
    openrouter: configured.has('openrouter_api_key'),
  };
}

function toRow(row: ConnectionDbRow, shared: Record<ProviderKind, boolean>): LlmConnectionRow {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    model: row.model,
    baseUrl: row.base_url,
    supportsVision: row.supports_vision,
    usesSharedKey: isProviderKind(row.kind),
    sharedKeyConfigured: isProviderKind(row.kind) ? shared[row.kind] : true,
    providerOrder: row.provider_order,
    allowFallbacks: row.allow_fallbacks,
    quantizations: row.quantizations,
    priceInputPerMillion: toPrice(row.price_input_per_million),
    priceOutputPerMillion: toPrice(row.price_output_per_million),
    priceCacheHitPerMillion: toPrice(row.price_cache_hit_per_million),
    pricePeakInputPerMillion: toPrice(row.price_peak_input_per_million),
    pricePeakOutputPerMillion: toPrice(row.price_peak_output_per_million),
    pricePeakCacheHitPerMillion: toPrice(row.price_peak_cache_hit_per_million),
    priceSyncedAt: row.price_synced_at ?? undefined,
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

/** Resolve a provider-kind row's API key from the shared provider_credentials row of the same name,
 *  failing closed with a specific, actionable error when it's unconfigured (bi_principles.md §6) —
 *  the same fail-closed posture index.ts's seed uses for a missing provider key. */
async function resolveSharedKey(kind: ProviderKind, credentials: ProviderCredentialStore): Promise<string> {
  const name = SHARED_CREDENTIAL_BY_KIND[kind];
  const apiKey = await credentials.resolve(name, undefined);
  if (!apiKey) throw new Error(`${name} is not configured — set the shared ${kind} key in Settings`);
  return apiKey;
}

async function toProfile(row: ConnectionDbRow, cipher: FieldCipher, credentials: ProviderCredentialStore): Promise<LlmProfile> {
  const apiKey = isProviderKind(row.kind)
    ? await resolveSharedKey(row.kind, credentials)
    : cipher.decrypt(row.api_key_ciphertext!);
  return {
    kind: row.kind,
    model: row.model,
    apiKey,
    baseUrl: row.base_url ?? undefined,
    supportsVision: row.supports_vision,
    provider: toProviderConfig(row),
    priceInputPerMillion: toPrice(row.price_input_per_million),
    priceOutputPerMillion: toPrice(row.price_output_per_million),
    priceCacheHitPerMillion: toPrice(row.price_cache_hit_per_million),
    pricePeakInputPerMillion: toPrice(row.price_peak_input_per_million),
    pricePeakOutputPerMillion: toPrice(row.price_peak_output_per_million),
    pricePeakCacheHitPerMillion: toPrice(row.price_peak_cache_hit_per_million),
  };
}

// Backs LlmConnectionInit.create's/patch's copyApiKeyFrom — copies the ciphertext column directly
// rather than decrypt-then-re-encrypt, so the plaintext key never passes through this code path at
// all (it's already an independent AES-GCM ciphertext of the same plaintext; nothing about reusing
// it verbatim across two rows weakens either row's own encryption).
async function copyCiphertext(db: PostgresClient, sourceId: string): Promise<string> {
  const rows = await db.withSystemScope((session) =>
    session.query<{ api_key_ciphertext: string }>('select api_key_ciphertext from llm_connections where id = $1', [sourceId]),
  );
  if (!rows[0]) throw new Error(`copyApiKeyFrom names unknown connection id "${sourceId}"`);
  return rows[0].api_key_ciphertext;
}

export function createLlmConnectionStore(
  db: PostgresClient,
  cipher: FieldCipher,
  credentials: ProviderCredentialStore,
): LlmConnectionStore {
  return {
    async list() {
      const [rows, shared] = await Promise.all([
        db.withSystemScope((session) =>
          session.query<ConnectionDbRow>(`select ${ROW_COLUMNS} from llm_connections order by name`),
        ),
        sharedKeyStatus(db),
      ]);
      return rows.map((row) => toRow(row, shared));
    },

    async create(init) {
      if (isProviderKind(init.kind)) {
        if (init.apiKey !== undefined || init.copyApiKeyFrom !== undefined) {
          throw new Error(`kind "${init.kind}" uses the shared ${init.kind} key — apiKey/copyApiKeyFrom are not allowed`);
        }
      } else if ((init.apiKey === undefined) === (init.copyApiKeyFrom === undefined)) {
        throw new Error('exactly one of apiKey/copyApiKeyFrom is required for this connection kind');
      }
      const apiKeyCiphertext = isProviderKind(init.kind)
        ? null
        : init.copyApiKeyFrom
          ? await copyCiphertext(db, init.copyApiKeyFrom)
          : cipher.encrypt(init.apiKey!);
      const baseUrl = isProviderKind(init.kind) ? CANONICAL_BASE_URL[init.kind] : (init.baseUrl ?? null);
      const rows = await db.withSystemScope((session) =>
        session.query<ConnectionDbRow>(
          `insert into llm_connections
             (name, kind, model, api_key_ciphertext, base_url, supports_vision, provider_order, allow_fallbacks, quantizations,
              price_input_per_million, price_output_per_million, price_cache_hit_per_million,
              price_peak_input_per_million, price_peak_output_per_million, price_peak_cache_hit_per_million)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           returning ${ROW_COLUMNS}`,
          [
            init.name,
            init.kind,
            init.model,
            apiKeyCiphertext,
            baseUrl,
            init.supportsVision ?? false,
            init.providerOrder ? JSON.stringify(init.providerOrder) : null,
            init.allowFallbacks ?? true,
            init.quantizations ? JSON.stringify(init.quantizations) : null,
            init.priceInputPerMillion ?? null,
            init.priceOutputPerMillion ?? null,
            init.priceCacheHitPerMillion ?? null,
            init.pricePeakInputPerMillion ?? null,
            init.pricePeakOutputPerMillion ?? null,
            init.pricePeakCacheHitPerMillion ?? null,
          ],
        ),
      );
      return toRow(rows[0], await sharedKeyStatus(db));
    },

    async update(id, patch) {
      // Read the current row up front: kind transitions decide whether the per-row key is nulled
      // (freeform -> provider kind) or must be re-supplied (provider kind -> freeform), and the
      // no-change path below needs it anyway.
      const current = await db.withSystemScope((session) =>
        session.query<ConnectionDbRow>(`select ${ROW_COLUMNS} from llm_connections where id = $1`, [id]),
      );
      const row = current[0];
      if (!row) return undefined;
      const targetKind = patch.kind ?? row.kind;
      const switchingFromProvider = !isProviderKind(targetKind) && isProviderKind(row.kind);

      if (isProviderKind(targetKind)) {
        if (patch.apiKey !== undefined || patch.copyApiKeyFrom !== undefined) {
          throw new Error(`kind "${targetKind}" uses the shared ${targetKind} key — apiKey/copyApiKeyFrom are not allowed`);
        }
      }
      if (switchingFromProvider && patch.apiKey === undefined && patch.copyApiKeyFrom === undefined) {
        throw new Error(`kind "${targetKind}" needs its own key — provide apiKey or copyApiKeyFrom when leaving the shared-key "${row.kind}" kind`);
      }

      const sets: string[] = [];
      const values: unknown[] = [];
      function set(column: string, value: unknown): void {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      }
      if (patch.name !== undefined) set('name', patch.name);
      if (patch.kind !== undefined) set('kind', patch.kind);
      if (patch.model !== undefined) set('model', patch.model);
      if (isProviderKind(targetKind)) {
        // Provider kinds always draw the shared credential and the canonical base URL — a per-row
        // key or a supplied baseUrl change is either already rejected above or ignored.
        set('api_key_ciphertext', null);
        set('base_url', CANONICAL_BASE_URL[targetKind]);
      } else {
        if (patch.copyApiKeyFrom !== undefined) {
          set('api_key_ciphertext', await copyCiphertext(db, patch.copyApiKeyFrom));
        } else if (patch.apiKey !== undefined) {
          set('api_key_ciphertext', cipher.encrypt(patch.apiKey));
        }
        if (patch.baseUrl !== undefined) set('base_url', patch.baseUrl);
      }
      if (patch.supportsVision !== undefined) set('supports_vision', patch.supportsVision);
      if (patch.providerOrder !== undefined) set('provider_order', patch.providerOrder ? JSON.stringify(patch.providerOrder) : null);
      if (patch.allowFallbacks !== undefined) set('allow_fallbacks', patch.allowFallbacks);
      if (patch.quantizations !== undefined) set('quantizations', patch.quantizations ? JSON.stringify(patch.quantizations) : null);
      if (patch.priceInputPerMillion !== undefined) set('price_input_per_million', patch.priceInputPerMillion);
      if (patch.priceOutputPerMillion !== undefined) set('price_output_per_million', patch.priceOutputPerMillion);
      if (patch.priceCacheHitPerMillion !== undefined) set('price_cache_hit_per_million', patch.priceCacheHitPerMillion);
      if (patch.pricePeakInputPerMillion !== undefined) set('price_peak_input_per_million', patch.pricePeakInputPerMillion);
      if (patch.pricePeakOutputPerMillion !== undefined) set('price_peak_output_per_million', patch.pricePeakOutputPerMillion);
      if (patch.pricePeakCacheHitPerMillion !== undefined) set('price_peak_cache_hit_per_million', patch.pricePeakCacheHitPerMillion);
      if (patch.priceSyncedAt !== undefined) set('price_synced_at', patch.priceSyncedAt);
      if (sets.length === 0) return toRow(row, await sharedKeyStatus(db));
      sets.push('updated_at = now()');
      values.push(id);
      const rows = await db.withSystemScope((session) =>
        session.query<ConnectionDbRow>(
          `update llm_connections set ${sets.join(', ')} where id = $${values.length} returning ${ROW_COLUMNS}`,
          values,
        ),
      );
      return rows[0] ? toRow(rows[0], await sharedKeyStatus(db)) : undefined;
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
      // Two statements, not one UPDATE ... WITH cleared AS (...) — a single writable-CTE statement
      // hit llm_connections_one_active (0062's partial unique index) in production, because both
      // sub-updates run against the same query-start snapshot rather than seeing each other's
      // effect. Sequential statements inside this one withSystemScope transaction do see each
      // other (a normal command-counter bump between statements), so the constraint never sees two
      // active rows even transiently.
      return db.withSystemScope(async (session) => {
        await session.query('update llm_connections set is_active = false where is_active and id != $1', [id]);
        const rows = await session.query<{ id: string }>(
          'update llm_connections set is_active = true, updated_at = now() where id = $1 returning id',
          [id],
        );
        return rows.length > 0;
      });
    },

    async resolveById(id) {
      const rows = await db.withSystemScope((session) =>
        session.query<ConnectionDbRow>(`select ${ROW_COLUMNS} from llm_connections where id = $1`, [id]),
      );
      return rows[0] ? toProfile(rows[0], cipher, credentials) : undefined;
    },

    async resolveByName(name) {
      const rows = await db.withSystemScope((session) =>
        session.query<ConnectionDbRow>(`select ${ROW_COLUMNS} from llm_connections where name = $1`, [name]),
      );
      return rows[0] ? toProfile(rows[0], cipher, credentials) : undefined;
    },

    async resolveActive() {
      const rows = await db.withSystemScope((session) =>
        session.query<ConnectionDbRow>(`select ${ROW_COLUMNS} from llm_connections where is_active`),
      );
      return rows[0] ? toProfile(rows[0], cipher, credentials) : undefined;
    },
  };
}
