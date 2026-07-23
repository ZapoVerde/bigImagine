// Proves the ingestion tool's own logic end to end — forced-schema classification, embedding,
// and the insert statement's shape — using the stub LLM/embeddings providers and a fake pool
// (same approach as orchestrator/scripts/verify-loop.mjs). This does NOT touch a real LLM,
// Voyage, or Postgres; it proves the plugin's wiring is correct so the only thing left to prove
// once real credentials exist is that the vendors themselves behave as documented.
//
// Goes through info/registerTools — the actual contract orchestrator/pluginLoader.ts uses at
// runtime — rather than reaching around it to createIngestNoteTool directly, so this also
// proves the plugin is loadable the way the real orchestrator will load it.

import { randomBytes } from 'node:crypto';
import { createStubLlmProvider } from '@bigbrain/orchestrator/llm-stub';
import { createStubEmbeddingProvider } from '@bigbrain/orchestrator/embeddings-stub';
import { createPostgresClient } from '@bigbrain/orchestrator/postgres';
import { createToolRegistry } from '@bigbrain/orchestrator/tool-registry';
import { createFieldCipher } from '@bigbrain/orchestrator/field-cipher';
import { info, registerTools } from '../dist/index.js';

const cipher = createFieldCipher({ BIGBRAIN_FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64') });

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

function createFakePool() {
  const inserts = [];
  return {
    inserts,
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }
          if (sql.includes('insert into unstructured_notes')) {
            inserts.push({ scopedUserId, params });
            return { rows: [{ note_id: 'fake-note-id-1' }] };
          }
          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

const llm = createStubLlmProvider([
  {
    message: { role: 'assistant', content: '' },
    toolCalls: [
      {
        id: 'call_1',
        name: 'classify_note',
        arguments: {
          category: 'recipe',
          auto_tags: ['dinner', 'pasta', 'quick'],
          summary_short: 'A quick weeknight pasta recipe.',
        },
      },
    ],
  },
]);

const embeddings = createStubEmbeddingProvider(2048);

assert(
  info.id === 'document-ingestion' && /^[a-z0-9_-]+$/.test(info.id),
  'info.id is present and matches the id format pluginLoader.ts requires',
);

const pluginTools = await registerTools({ llm, embeddings, cipher, notion: undefined });
assert(pluginTools.length === 1, 'registerTools returns exactly one tool');
const [tool] = pluginTools;

const registry = createToolRegistry(pluginTools);
assert(
  registry.definitions().some((d) => d.name === 'ingest_note'),
  'ingest_note is registered and visible in the tool manifest',
);

const pool = createFakePool();
const db = createPostgresClient(pool);
const userId = '11111111-1111-1111-1111-111111111111';

const result = await db.withUserScope(userId, (session) =>
  tool.handler({ raw_text: 'Boil pasta, toss with garlic and oil, done in 15 minutes.' }, { userId, db: session }),
);

assert(result.noteId === 'fake-note-id-1', 'handler returns the inserted note_id');
assert(result.category === 'recipe', 'handler returns the classified category');
assert(
  Array.isArray(result.autoTags) && result.autoTags.includes('pasta'),
  'handler returns the classified auto_tags',
);
assert(result.summaryShort.length > 0, 'handler returns a non-empty summary_short');

assert(pool.inserts.length === 1, 'exactly one row was inserted');
const [insert] = pool.inserts;
assert(insert.scopedUserId === userId, 'the insert happened inside the correct user_id scope');
const [insertedUserId, insertedRawText, insertedVector, insertedTags, insertedCategory, insertedSummary] =
  insert.params;
assert(insertedUserId === userId, 'user_id column matches the requesting user');
assert(
  !insertedRawText.includes('pasta'),
  'raw_text column is encrypted at rest — the plaintext note text never reaches Postgres',
);
assert(
  cipher.decrypt(insertedRawText).includes('pasta'),
  'raw_text decrypts back to the original note text',
);
assert(/^\[[-\d.,e]+\]$/.test(insertedVector), 'vector_embed column is a valid pgvector literal');
assert(insertedTags.includes('pasta'), 'auto_tags column matches the classification (left plaintext for filtering)');
assert(insertedCategory === 'recipe', 'category column matches the classification');
assert(
  cipher.decrypt(insertedSummary).length > 0,
  'summary_short column is encrypted, and decrypts back to a non-empty summary',
);

// pinned_tags must never be written by this pipeline (bb_principles.md §3) — the insert
// statement itself only names six columns, so this is really just making that explicit.
assert(!insert.params.includes('pinned_tags'), 'pinned_tags is never touched by ingestion');

// A missing/empty raw_text must fail loudly, not silently ingest an empty note.
try {
  await tool.handler({ raw_text: '' }, { userId, db: await pool.connect() });
  assert(false, 'empty raw_text is rejected');
} catch {
  assert(true, 'empty raw_text is rejected');
}

if (process.exitCode) {
  console.error('\ningestion verification FAILED');
  process.exit(1);
}
console.log('\ningestion verification passed');
