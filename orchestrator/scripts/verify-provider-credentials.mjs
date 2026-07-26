// Proves io/providerCredentials.ts's DB-first/env-fallback-seed/fail-closed-sentinel logic, and
// server/adminServer.ts's request validation — against a fake pool, no real Postgres, mirroring
// verify-field-cipher.mjs and verify-server.mjs's existing style.

import { randomBytes } from 'node:crypto';
import { createFieldCipher } from '../dist/io/fieldCipher.js';
import { createPostgresClient } from '../dist/io/postgres.js';
import {
  CREDENTIAL_NAMES,
  UNMANAGED_SENTINEL,
  createProviderCredentialStore,
} from '../dist/io/providerCredentials.js';
import { withOverriddenApiKeys, withOverriddenSupportsVision } from '../dist/io/llm/profiles.js';
import { parseSetCredentialBody, parseVisionCapableProfiles } from '../dist/server/adminServer.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// --- Fake pool: an in-memory provider_credentials table ---
function createFakePool() {
  const rowsByName = new Map();
  return {
    rowsByName,
    async connect() {
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };

          if (sql.includes('insert into provider_credentials')) {
            const [name, ciphertext] = params;
            rowsByName.set(name, { ciphertext, updated_at: new Date().toISOString() });
            return { rows: [] };
          }
          if (sql.includes('select ciphertext from provider_credentials')) {
            const row = rowsByName.get(params[0]);
            return { rows: row ? [{ ciphertext: row.ciphertext }] : [] };
          }
          if (sql.includes('left join provider_credentials')) {
            return {
              rows: params.map((name) => ({
                name,
                updated_at: rowsByName.has(name) ? rowsByName.get(name).updated_at : null,
              })),
            };
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
const store = createProviderCredentialStore(db, cipher);

// --- list() before any writes ---
{
  const summaries = await store.list();
  assert(summaries.length === CREDENTIAL_NAMES.length, 'list() returns every fixed credential name');
  assert(summaries.every((s) => s.configured === false), 'every credential starts as not configured');
}

// --- resolve() with no row + a real fallback seeds the DB ---
{
  const first = await store.resolve('deepseek_api_key', 'sk-real-fallback-key');
  assert(first === 'sk-real-fallback-key', 'resolve() returns the env fallback when no DB row exists yet');
  assert(pool.rowsByName.has('deepseek_api_key'), 'resolve() seeded the DB with the fallback value');
  assert(
    pool.rowsByName.get('deepseek_api_key').ciphertext !== 'sk-real-fallback-key',
    'the seeded value is stored encrypted, not as plaintext',
  );

  const second = await store.resolve('deepseek_api_key', 'sk-real-fallback-key');
  assert(second === 'sk-real-fallback-key', 'a second resolve() reads the same value back via the DB (decrypted), not the fallback path');
}

// --- resolve() with UNMANAGED_SENTINEL never seeds ---
{
  const result = await store.resolve('openrouter_api_key', UNMANAGED_SENTINEL);
  assert(result === undefined, 'resolve() with the sentinel fallback returns undefined');
  assert(!pool.rowsByName.has('openrouter_api_key'), 'the sentinel fallback never gets written to the DB');
}

// --- resolve() with no row and no fallback ---
{
  const result = await store.resolve('voyage_api_key', undefined);
  assert(result === undefined, 'resolve() with no DB row and no fallback returns undefined');
}

// --- set() upserts, list() reflects it ---
{
  await store.set('notion_token', 'secret-notion-token');
  const summaries = await store.list();
  const notion = summaries.find((s) => s.name === 'notion_token');
  assert(notion.configured === true, 'set() makes the credential show as configured');
  assert(notion.updatedAt !== null, 'set() records an updatedAt timestamp');

  await store.set('notion_token', 'rotated-notion-token');
  const resolved = await store.resolve('notion_token', undefined);
  assert(resolved === 'rotated-notion-token', 'set() overwrites an existing value (on conflict do update)');
}

// --- list() never leaks plaintext or ciphertext ---
{
  const summaries = await store.list();
  const serialized = JSON.stringify(summaries);
  assert(!serialized.includes('rotated-notion-token'), 'list() output never contains a plaintext credential value');
  assert(!serialized.includes(pool.rowsByName.get('notion_token').ciphertext), 'list() output never contains a raw ciphertext value');
}

// --- withOverriddenApiKeys ---
{
  const raw = JSON.stringify({
    deepseek: { kind: 'openai-compatible', model: 'x', apiKey: 'old-deepseek', baseUrl: 'https://x' },
    openrouter: { kind: 'openai-compatible', model: 'y', apiKey: 'old-openrouter', baseUrl: 'https://y' },
  });
  const merged = JSON.parse(withOverriddenApiKeys(raw, { deepseek: 'new-deepseek', openrouter: undefined }));
  assert(merged.deepseek.apiKey === 'new-deepseek', 'withOverriddenApiKeys overrides the named profile present in overrides');
  assert(merged.deepseek.kind === 'openai-compatible' && merged.deepseek.model === 'x' && merged.deepseek.baseUrl === 'https://x', 'withOverriddenApiKeys leaves kind/baseUrl/model untouched');
  assert(merged.openrouter.apiKey === 'old-openrouter', 'an undefined override leaves that profile\'s existing apiKey untouched');
}

// --- withOverriddenSupportsVision (Stage 5 — vision) ---
{
  const raw = JSON.stringify({
    deepseek: { kind: 'openai-compatible', model: 'x', apiKey: 'k', baseUrl: 'https://x' },
    openrouter: { kind: 'openai-compatible', model: 'y', apiKey: 'k', baseUrl: 'https://y' },
    anthropic: { kind: 'anthropic', model: 'z', apiKey: 'k' },
  });
  const merged = JSON.parse(withOverriddenSupportsVision(raw, { openrouter: true }));
  assert(merged.openrouter.supportsVision === true, 'withOverriddenSupportsVision sets true on a profile named in flags');
  assert(merged.deepseek.supportsVision === false, 'a profile not named in flags is explicitly set to false, not left unset');
  assert(merged.anthropic.supportsVision === false, 'every profile gets an explicit value, not just the ones in flags');
  assert(merged.openrouter.kind === 'openai-compatible' && merged.openrouter.model === 'y' && merged.openrouter.baseUrl === 'https://y', 'other fields are left untouched');

  const unsetAgain = JSON.parse(withOverriddenSupportsVision(JSON.stringify(merged), {}));
  assert(unsetAgain.openrouter.supportsVision === false, 'an empty flags object clears every profile\'s flag back to false');

  const staleName = JSON.parse(withOverriddenSupportsVision(raw, { 'removed-profile': true }));
  assert(!('removed-profile' in staleName), 'a flags entry naming a profile not present in raw is silently ignored');
}

// --- parseVisionCapableProfiles (server/adminServer.ts) ---
{
  assert(parseVisionCapableProfiles(undefined).length === 0, 'parseVisionCapableProfiles defaults to [] when unset');
  assert(parseVisionCapableProfiles('not json').length === 0, 'parseVisionCapableProfiles defaults to [] on malformed JSON');
  assert(parseVisionCapableProfiles('{"not":"an array"}').length === 0, 'parseVisionCapableProfiles defaults to [] when the JSON is not an array');
  assert(parseVisionCapableProfiles('["a", 5, "b"]').length === 0, 'parseVisionCapableProfiles defaults to [] when any element is not a string');
  const parsed = parseVisionCapableProfiles('["openrouter","anthropic"]');
  assert(parsed.length === 2 && parsed.includes('openrouter') && parsed.includes('anthropic'), 'parseVisionCapableProfiles parses a well-formed JSON array');
}

// --- parseSetCredentialBody ---
{
  assert(parseSetCredentialBody({ name: 'deepseek_api_key', value: 'abc' })?.name === 'deepseek_api_key', 'parseSetCredentialBody accepts a known name with a non-empty value');
  assert(parseSetCredentialBody({ name: 'not_a_real_name', value: 'abc' }) === undefined, 'parseSetCredentialBody rejects an unknown credential name');
  assert(parseSetCredentialBody({ name: 'deepseek_api_key', value: '' }) === undefined, 'parseSetCredentialBody rejects an empty value');
  assert(parseSetCredentialBody({ name: 'deepseek_api_key' }) === undefined, 'parseSetCredentialBody rejects a missing value');
  assert(parseSetCredentialBody('not an object') === undefined, 'parseSetCredentialBody rejects a non-object body');
  assert(parseSetCredentialBody(null) === undefined, 'parseSetCredentialBody rejects null');
}

if (process.exitCode) {
  console.error('\nprovider credentials verification FAILED');
  process.exit(1);
}
console.log('\nprovider credentials verification passed');
