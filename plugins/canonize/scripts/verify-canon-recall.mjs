// Proves recall_canon_facts's scene-scoped semantic search (canonize-plan.md §10,
// verify-canon-recall): a fact linked to a character not present in the scene is excluded; a
// fact linked to the scene's active location is included; a 'proposed' or 'rejected' fact never
// comes back regardless of scope; a plot arc with three superseding proposals returns only the
// latest approved one. Uses the stub embeddings provider for deterministic vectors and a fake
// Postgres pool that implements exactly the three queries the handler issues.

import { createPostgresClient } from '@bigbrain/orchestrator/postgres';
import { createToolRegistry } from '@bigbrain/orchestrator/tool-registry';
import { createStubEmbeddingProvider } from '@bigbrain/orchestrator/embeddings-stub';
import { info, registerTools } from '../dist/index.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// Deterministic cosine distance between two vectors (matches pgvector's <-> on unit vectors).
function cosineDistance(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function createFakePool(embeddings, facts, presence, scenes) {
  return {
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }

          if (sql.startsWith('select character_id from scene_presence')) {
            const [sceneId] = params;
            const rows = presence
              .filter((p) => p.scene_id === sceneId && p.user_id === scopedUserId)
              .map((p) => ({ character_id: p.character_id }));
            return { rows };
          }

          if (sql.startsWith('select active_location_id from scenes')) {
            const [sceneId] = params;
            const scene = scenes.find((s) => s.scene_id === sceneId && s.user_id === scopedUserId);
            return { rows: scene ? [{ active_location_id: scene.active_location_id }] : [] };
          }

          if (sql.startsWith('with candidates as')) {
            const [userId, presentIds, activeLocationId, sceneId, vectorLiteral, topK] = params;
            assert(scopedUserId === userId, 'recall_canon_facts is scoped to the requesting user');
            const queryVector = vectorLiteral.slice(1, -1).split(',').map(Number);

            // Scope filter — mirrors the handler's SQL clause mechanically.
            const candidates = facts.filter((f) => {
              if (f.user_id !== userId) return false;
              if (f.status !== 'approved') return false;
              if (presentIds && f.linked_character_ids.some((id) => presentIds.includes(id))) return true;
              if (f.linked_location_id !== null && f.linked_location_id === activeLocationId) return true;
              if (f.scene_id === sceneId && f.linked_character_ids.length === 0 && f.linked_location_id === null) return true;
              if (f.scene_id === null && f.linked_character_ids.length === 0 && f.linked_location_id === null) return true;
              return false;
            });

            // DISTINCT ON (coalesce(arc_tag, fact_id::text)): keep the most-recently-approved row
            // per arc_tag; a fact with no arc_tag is keyed by its own fact_id, so it never merges
            // with any other arc_tag-less fact. Final order is purely by vector distance.
            const byGroup = new Map();
            for (const f of candidates) {
              const key = f.arc_tag ?? f.fact_id;
              const existing = byGroup.get(key);
              if (!existing || f.approved_at > existing.approved_at) {
                byGroup.set(key, f);
              }
            }
            const deduped = [...byGroup.values()];
            deduped.sort((a, b) => cosineDistance(a.vector_embed, queryVector) - cosineDistance(b.vector_embed, queryVector));

            const rows = deduped.slice(0, topK).map((f) => ({
              fact_id: f.fact_id,
              category: f.category,
              summary: f.summary,
              detail: f.detail,
            }));
            return { rows };
          }

          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

const embeddings = createStubEmbeddingProvider(2048);
const pluginTools = await registerTools({ llm: null, embeddings, cipher: null, db: null, credentials: null, settings: null });
const registry = createToolRegistry(pluginTools);
const recallTool = registry.get('recall_canon_facts');

const userId = '11111111-1111-1111-1111-111111111111';
const otherUserId = '22222222-2222-2222-2222-222222222222';
const sceneId = '33333333-3333-3333-3333-333333333333';
const charPresent = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const charAbsent = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const activeLoc = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

async function embedText(text) {
  const [v] = await embeddings.embed([text]);
  return v;
}

const facts = [];
const presence = [];
const scenes = [];

// --- seed: a variety of facts across scope dimensions ---
facts.push({
  fact_id: 'f-person-present',
  user_id: userId,
  scene_id: null,
  category: 'person',
  arc_tag: null,
  summary: 'Elara distrusts the Foundation.',
  detail: '',
  vector_embed: await embedText('Elara distrusts the Foundation.'),
  status: 'approved',
  linked_character_ids: [charPresent],
  linked_location_id: null,
  proposed_at: '2026-08-01T00:00:00Z',
  approved_at: '2026-08-01T00:00:01Z',
});
facts.push({
  fact_id: 'f-person-absent',
  user_id: userId,
  scene_id: null,
  category: 'person',
  arc_tag: null,
  summary: 'Kael resents the captain.',
  detail: '',
  vector_embed: await embedText('Kael resents the captain.'),
  status: 'approved',
  linked_character_ids: [charAbsent],
  linked_location_id: null,
  proposed_at: '2026-08-01T00:00:00Z',
  approved_at: '2026-08-01T00:00:01Z',
});
facts.push({
  fact_id: 'f-location-active',
  user_id: userId,
  scene_id: null,
  category: 'place',
  arc_tag: null,
  summary: 'The tavern has a hidden cellar.',
  detail: '',
  vector_embed: await embedText('The tavern has a hidden cellar.'),
  status: 'approved',
  linked_character_ids: [],
  linked_location_id: activeLoc,
  proposed_at: '2026-08-01T00:00:00Z',
  approved_at: '2026-08-01T00:00:01Z',
});
facts.push({
  fact_id: 'f-location-other',
  user_id: userId,
  scene_id: null,
  category: 'place',
  arc_tag: null,
  summary: 'The mine is collapsing.',
  detail: '',
  vector_embed: await embedText('The mine is collapsing.'),
  status: 'approved',
  linked_character_ids: [],
  linked_location_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
  proposed_at: '2026-08-01T00:00:00Z',
  approved_at: '2026-08-01T00:00:01Z',
});
facts.push({
  fact_id: 'f-scene-global',
  user_id: userId,
  scene_id: sceneId,
  category: 'concept',
  arc_tag: null,
  summary: 'The pact forbids sorcery within the walls.',
  detail: '',
  vector_embed: await embedText('The pact forbids sorcery within the walls.'),
  status: 'approved',
  linked_character_ids: [],
  linked_location_id: null,
  proposed_at: '2026-08-01T00:00:00Z',
  approved_at: '2026-08-01T00:00:01Z',
});
facts.push({
  fact_id: 'f-platform-global',
  user_id: userId,
  scene_id: null,
  category: 'concept',
  arc_tag: null,
  summary: 'The crown passes by blood right.',
  detail: '',
  vector_embed: await embedText('The crown passes by blood right.'),
  status: 'approved',
  linked_character_ids: [],
  linked_location_id: null,
  proposed_at: '2026-08-01T00:00:00Z',
  approved_at: '2026-08-01T00:00:01Z',
});
// proposed/rejected never return regardless of scope
facts.push({
  fact_id: 'f-proposed-in-scope',
  user_id: userId,
  scene_id: sceneId,
  category: 'plot',
  arc_tag: '#foundation_contest',
  summary: 'Proposed but not approved.',
  detail: '',
  vector_embed: await embedText('Proposed but not approved.'),
  status: 'proposed',
  linked_character_ids: [charPresent],
  linked_location_id: null,
  proposed_at: '2026-08-01T00:00:00Z',
  approved_at: null,
});
facts.push({
  fact_id: 'f-rejected-in-scope',
  user_id: userId,
  scene_id: sceneId,
  category: 'person',
  arc_tag: null,
  summary: 'Rejected and must stay out.',
  detail: '',
  vector_embed: await embedText('Rejected and must stay out.'),
  status: 'rejected',
  linked_character_ids: [charPresent],
  linked_location_id: null,
  proposed_at: '2026-08-01T00:00:00Z',
  approved_at: null,
});
// plot arc with three superseding proposals — only the latest approved comes back
const arcSummaries = ['The siege begins.', 'The siege closes in.', 'The siege breaks the gate.'];
for (let i = 0; i < 3; i++) {
  facts.push({
    fact_id: `f-plot-${i}`,
    user_id: userId,
    scene_id: sceneId,
    category: 'plot',
    arc_tag: '#foundation_contest',
    summary: arcSummaries[i],
    detail: '',
    vector_embed: await embedText(arcSummaries[i]),
    status: 'approved',
    linked_character_ids: [],
    linked_location_id: null,
    proposed_at: `2026-08-0${i + 1}T00:00:00Z`,
    approved_at: `2026-08-0${i + 1}T00:00:01Z`,
  });
}
// another user's fact is invisible
facts.push({
  fact_id: 'f-other-user',
  user_id: otherUserId,
  scene_id: null,
  category: 'person',
  arc_tag: null,
  summary: 'Someone else’s truth.',
  detail: '',
  vector_embed: await embedText('Someone else\'s truth.'),
  status: 'approved',
  linked_character_ids: [charPresent],
  linked_location_id: null,
  proposed_at: '2026-08-01T00:00:00Z',
  approved_at: '2026-08-01T00:00:01Z',
});

// scenes + presence for the recall
scenes.push({ scene_id: sceneId, user_id: userId, active_location_id: activeLoc });
presence.push({ scene_id: sceneId, character_id: charPresent, user_id: userId });

const pool = createFakePool(embeddings, facts, presence, scenes);
const db = createPostgresClient(pool);

async function recall(query) {
  return db.withUserScope(userId, (session) =>
    recallTool.handler({ query, scene_id: sceneId }, { userId, db: session }),
  );
}

// --- scope filter proof ---
const results = await recall('jealousy distrust relationships');
const ids = results.map((r) => r.factId);
assert(ids.includes('f-person-present'), 'a fact linked to a present character is included');
assert(!ids.includes('f-person-absent'), 'a fact linked to a character not present in the scene is excluded');
assert(ids.includes('f-location-active'), 'a fact linked to the scene\'s active location is included');
assert(!ids.includes('f-location-other'), 'a fact linked to a different location is excluded');
assert(ids.includes('f-scene-global'), 'a scene-global fact is included');
assert(ids.includes('f-platform-global'), 'a platform-global fact is included');
assert(!ids.includes('f-proposed-in-scope'), "a 'proposed' fact never comes back regardless of scope");
assert(!ids.includes('f-rejected-in-scope'), "a 'rejected' fact never comes back regardless of scope");
assert(!ids.includes('f-other-user'), "another user's fact is never returned");

// --- plot arc continuity: only the latest approved row per arc_tag ---
const plotResults = await recall('siege situation');
const plotRows = plotResults.filter((r) => r.category === 'plot');
assert(plotRows.length === 1, 'a plot arc with three superseding approvals returns only one row');
assert(plotRows[0].summary === 'The siege breaks the gate.', 'the latest approved row per arc_tag is the one returned');

// --- top_k honored ---
const top2 = await db.withUserScope(userId, (session) =>
  recallTool.handler({ query: 'truth', scene_id: sceneId, top_k: 2 }, { userId, db: session }),
);
assert(top2.length === 2, 'top_k limits the returned rows');

if (process.exitCode) {
  console.error('\ncanon recall verification FAILED');
  process.exit(1);
}
console.log('\ncanon recall verification passed');