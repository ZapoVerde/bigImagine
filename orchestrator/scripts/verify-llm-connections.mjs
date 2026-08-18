// Proves io/llmConnections.ts's provider-kind (deepseek/openrouter) key semantics from
// db/migrations/0117_llm_connection_provider_kinds.sql — the real store, against a fake pool, no
// real Postgres (mirroring verify-provider-credentials.mjs's style):
//   * create() rejects a provider kind carrying apiKey/copyApiKeyFrom, and a freeform kind without
//     exactly one of them; a provider-kind create stores a null ciphertext + the canonical base URL
//   * list() surfaces usesSharedKey/sharedKeyConfigured, flipping to configured once the shared
//     provider_credentials row exists
//   * update() rejects a per-connection key on a provider-kind target and a kind switch away from a
//     shared-key kind without supplying a key; a provider-kind update forces the canonical base URL
//   * resolve*() fails closed (specific, actionable error) when the shared credential is unconfigured
//     and resolves it once set, exactly like the runtime's resolveSharedKey

import { randomBytes } from 'node:crypto';
import { createFieldCipher } from '../dist/io/fieldCipher.js';
import { createPostgresClient } from '../dist/io/postgres.js';
import { createLlmConnectionStore } from '../dist/io/llmConnections.js';
import { createProviderCredentialStore } from '../dist/io/providerCredentials.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const ROW_COLUMNS = `id, name, kind, model, base_url, supports_vision, api_key_ciphertext,
  provider_order, allow_fallbacks, quantizations, price_input_per_million,
  price_output_per_million, price_cache_hit_per_million, price_peak_input_per_million,
  price_peak_output_per_million, price_peak_cache_hit_per_million, price_synced_at, is_active, updated_at`;

const PRICE_COLS = [
  'price_input_per_million',
  'price_output_per_million',
  'price_cache_hit_per_million',
  'price_peak_input_per_million',
  'price_peak_output_per_million',
  'price_peak_cache_hit_per_million',
];

// --- Fake pool: an in-memory llm_connections table + provider_credentials names ---
function createFakePool() {
  const rows = [];
  let nextId = 1;
  const sharedCredentials = new Map();
  const iso = () => new Date().toISOString();
  function toDbRow(partial) {
    const row = {
      id: partial.id ?? `conn-${nextId++}`,
      name: partial.name,
      kind: partial.kind,
      model: partial.model,
      base_url: partial.base_url ?? null,
      supports_vision: partial.supports_vision ?? false,
      api_key_ciphertext: partial.api_key_ciphertext ?? null,
      provider_order: partial.provider_order ?? null,
      allow_fallbacks: partial.allow_fallbacks ?? true,
      quantizations: partial.quantizations ?? null,
      price_input_per_million: null,
      price_output_per_million: null,
      price_cache_hit_per_million: null,
      price_peak_input_per_million: null,
      price_peak_output_per_million: null,
      price_peak_cache_hit_per_million: null,
      price_synced_at: partial.price_synced_at ?? null,
      is_active: partial.is_active ?? false,
      updated_at: partial.updated_at ?? iso(),
    };
    for (const col of PRICE_COLS) {
      if (partial[col] !== undefined) row[col] = String(partial[col]);
    }
    return row;
  }
  function priceFieldsFromParams(params, offset) {
    // params order after allowFallbacks/quantizations: the six price_* values (create only).
    const values = {};
    PRICE_COLS.forEach((col, i) => {
      const v = params[offset + i];
      if (v !== null && v !== undefined) values[col] = String(v);
    });
    return values;
  }
  return {
    rows,
    sharedCredentials,
    async connect() {
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };

          if (sql.includes('insert into llm_connections')) {
            const [name, kind, model, apiKeyCiphertext, baseUrl, supportsVision, providerOrder, allowFallbacks, quantizations] = params;
            const row = toDbRow({
              name,
              kind,
              model,
              base_url: baseUrl,
              api_key_ciphertext: apiKeyCiphertext,
              supports_vision: supportsVision,
              provider_order: providerOrder,
              allow_fallbacks: allowFallbacks,
              quantizations,
              ...priceFieldsFromParams(params, 9),
            });
            rows.push(row);
            return { rows: [row] };
          }

          if (sql.startsWith('update llm_connections set is_active = false')) {
            for (const r of rows) r.is_active = false;
            return { rows: [] };
          }
          if (sql.startsWith('update llm_connections set is_active = true')) {
            const row = rows.find((r) => r.id === params.at(-1));
            if (!row) return { rows: [] };
            for (const r of rows) r.is_active = false;
            row.is_active = true;
            row.updated_at = iso();
            return { rows: [{ id: row.id }] };
          }
          if (sql.startsWith('update llm_connections set')) {
            const whereId = params.at(-1);
            const row = rows.find((r) => r.id === whereId);
            if (!row) return { rows: [] };
            const setPart = sql.slice(sql.indexOf(' set ') + 5, sql.indexOf(' where '));
            for (const clause of setPart.split(', ')) {
              const eq = clause.indexOf(' = ');
              const col = clause.slice(0, eq);
              const expr = clause.slice(eq + 3);
              if (expr === 'now()') {
                row.updated_at = iso();
                continue;
              }
              row[col] = params[Number(expr.slice(1)) - 1];
            }
            return { rows: [row] };
          }

          if (sql.includes('delete from llm_connections')) {
            const idx = rows.findIndex((r) => r.id === params[0]);
            if (idx >= 0) rows.splice(idx, 1);
            return { rows: [] };
          }

          if (sql.includes('select api_key_ciphertext from llm_connections')) {
            const row = rows.find((r) => r.id === params[0]);
            return { rows: row ? [{ api_key_ciphertext: row.api_key_ciphertext }] : [] };
          }

          if (sql.includes('select ciphertext from provider_credentials')) {
            const entry = sharedCredentials.get(params[0]);
            return { rows: entry ? [{ ciphertext: entry.ciphertext }] : [] };
          }

          if (sql.includes('insert into provider_credentials')) {
            const [name, ciphertext] = params;
            sharedCredentials.set(name, { ciphertext, updated_at: iso() });
            return { rows: [] };
          }

          if (sql.includes('select name from provider_credentials')) {
            return { rows: [...sharedCredentials.keys()].map((name) => ({ name })) };
          }

          if (sql.includes('from llm_connections')) {
            let matched = rows;
            if (sql.includes('where id = $1')) matched = rows.filter((r) => r.id === params[0]);
            else if (sql.includes('where name = $1')) matched = rows.filter((r) => r.name === params[0]);
            else if (sql.includes('where is_active')) matched = rows.filter((r) => r.is_active);
            return { rows: matched.map((r) => ({ ...r })) };
          }

          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

const cipher = createFieldCipher({ BIGBRAIN_FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
const pool = createFakePool();
const db = createPostgresClient(pool);
const credentials = createProviderCredentialStore(db, cipher);
const store = createLlmConnectionStore(db, cipher, credentials);

// --- create() key rules, provider kinds ---
{
  const rejected = await store
    .create({ name: 'bad-deepseek', kind: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'sk-x' })
    .then(() => null, (err) => err);
  assert(rejected instanceof Error && /apiKey\/copyApiKeyFrom are not allowed/.test(rejected.message), 'create() rejects a provider kind carrying apiKey');

  const copyRejected = await store
    .create({ name: 'bad-openrouter', kind: 'openrouter', model: 'deepseek/deepseek-chat', copyApiKeyFrom: 'conn-x' })
    .then(() => null, (err) => err);
  assert(copyRejected instanceof Error && /apiKey\/copyApiKeyFrom are not allowed/.test(copyRejected.message), 'create() rejects a provider kind carrying copyApiKeyFrom');

  const freeformNoKey = await store
    .create({ name: 'freeform-no-key', kind: 'openai-compatible', model: 'x', baseUrl: 'https://example.invalid/x' })
    .then(() => null, (err) => err);
  assert(freeformNoKey instanceof Error && /exactly one of apiKey\/copyApiKeyFrom/.test(freeformNoKey.message), 'create() rejects a freeform kind with neither key field');

  const bothKeys = await store
    .create({ name: 'freeform-both', kind: 'anthropic', model: 'x', apiKey: 'sk-a', copyApiKeyFrom: 'conn-x' })
    .then(() => null, (err) => err);
  assert(bothKeys instanceof Error && /exactly one of apiKey\/copyApiKeyFrom/.test(bothKeys.message), 'create() rejects a freeform kind with both key fields');
}

// --- a provider-kind create stores no key and the canonical base URL ---
{
  const created = await store.create({ name: 'native-deepseek', kind: 'deepseek', model: 'deepseek-v4-flash' });
  const stored = pool.rows.find((r) => r.id === created.id);
  assert(stored.api_key_ciphertext === null, 'a provider-kind create stores a null api_key_ciphertext');
  assert(stored.base_url === 'https://api.deepseek.com', 'a provider-kind create stores the canonical base URL');
  assert(created.usesSharedKey === true && created.sharedKeyConfigured === false, 'list-shape row reports usesSharedKey and an unconfigured shared key');
  assert(created.baseUrl === 'https://api.deepseek.com', 'the created row reports the canonical base URL');
}

// --- resolve*() fails closed while the shared credential is unconfigured ---
{
  const err = await store.resolveByName('native-deepseek').then(() => null, (e) => e);
  assert(
    err instanceof Error && /is not configured/.test(err.message) && /deepseek_api_key/.test(err.message),
    'resolveByName() on a provider-kind row with no shared credential fails closed with the actionable error',
  );
}

// --- seeding the shared credential flips list()'s readout and unblocks resolve ---
{
  await credentials.set('deepseek_api_key', 'sk-shared-deepseek');
  const listed = await store.list();
  const row = listed.find((r) => r.name === 'native-deepseek');
  assert(row && row.sharedKeyConfigured === true, 'list() reports the shared key as configured once the credential exists');

  const profile = await store.resolveByName('native-deepseek');
  assert(
    profile && profile.kind === 'deepseek' && profile.apiKey === 'sk-shared-deepseek' && profile.baseUrl === 'https://api.deepseek.com',
    'resolveByName() resolves the shared credential and the canonical base URL for a provider-kind row',
  );
}

// --- update() key rules and canonical forcing ---
{
  const id = (await store.list()).find((r) => r.name === 'native-deepseek').id;
  const rotateRejected = await store
    .update(id, { apiKey: 'sk-rotate' })
    .then(() => null, (err) => err);
  assert(rotateRejected instanceof Error && /apiKey\/copyApiKeyFrom are not allowed/.test(rotateRejected.message), 'update() rejects a per-connection key on a provider-kind target');

  const switchNoKey = await store
    .update(id, { kind: 'openai-compatible' })
    .then(() => null, (err) => err);
  assert(
    switchNoKey instanceof Error && /needs its own key/.test(switchNoKey.message),
    'update() rejects leaving a shared-key kind without supplying a per-connection key',
  );

  // Switching provider kind -> provider kind forces the new canonical URL and keeps no row key.
  await store.update(id, { kind: 'openrouter' });
  const switched = pool.rows.find((r) => r.id === id);
  assert(switched.base_url === 'https://openrouter.ai/api/v1', 'update() forces the canonical base URL when switching provider kinds');
  assert(switched.api_key_ciphertext === null, 'update() keeps a provider-kind row keyless through a kind switch');

  // Leaving the shared-key kind with a fresh key stores its own ciphertext.
  await store.update(id, { kind: 'openai-compatible', apiKey: 'sk-fresh', baseUrl: 'https://example.invalid/x' });
  const freed = pool.rows.find((r) => r.id === id);
  assert(freed.api_key_ciphertext !== null && freed.api_key_ciphertext !== 'sk-fresh', 'update() stores the fresh key encrypted, not as plaintext');
  const freedProfile = await store.resolveById(id);
  assert(freedProfile && freedProfile.apiKey === 'sk-fresh', 'resolveById() returns the fresh per-connection key after leaving the shared-key kind');
}

// --- a provider-kind freeform-style connection still resolves through the shared credential ---
{
  const created = await store.create({ name: 'native-openrouter', kind: 'openrouter', model: 'deepseek/deepseek-chat' });
  await credentials.set('openrouter_api_key', 'sk-shared-openrouter');
  const profile = await store.resolveById(created.id);
  assert(
    profile && profile.apiKey === 'sk-shared-openrouter' && profile.baseUrl === 'https://openrouter.ai/api/v1',
    'resolveById() resolves an openrouter connection through its shared credential',
  );
}

if (process.exitCode) {
  console.error('\nllm connections verification FAILED');
  process.exit(1);
}
console.log('\nllm connections verification passed');