// Proves recall_canon_facts's chat-scoped semantic search (db/migrations/
// 0058_canon_facts_chat_scoped.sql, canonize-plan.md §10): a fact belonging to a different chat
// (even the same user's) is excluded; a fact belonging to another user is excluded; a 'proposed'
// or 'rejected' fact never comes back regardless of chat; a plot arc with three superseding
// proposals returns only the latest approved one; recall requires an active chat context.
// The original scene/character/location scoping design has been dropped (see
// recallCanonFactsTool.ts's own doc comment) — this file no longer exercises it.
// Uses the stub embeddings provider for deterministic vectors and a fake Postgres pool that
// implements exactly the queries the handler issues.

import { createPostgresClient } from '@bigbrain/orchestrator/postgres';
import { createToolRegistry } from '@bigbrain/orchestrator/tool-registry';
import { createStubEmbeddingProvider } from '@bigbrain/orchestrator/embeddings-stub';
import { registerTools } from '../dist/index.js';

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

function createFakePool(facts, chatMessages) {
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

          // as_of_message_id resolution — recallCanonFactsTool.ts resolves the anchor's own chat
          // and created_at before it ever reaches the main query, so it can reject an anchor from
          // the wrong chat up front.
          if (sql.startsWith('select chat_id, created_at from chat_messages')) {
            const [messageId, userId] = params;
            const m = chatMessages.find((cm) => cm.message_id === messageId && cm.user_id === userId);
            return { rows: m ? [{ chat_id: m.chat_id, created_at: m.created_at }] : [] };
          }

          if (sql.startsWith('with anchor as')) {
            const [userId, chatId, vectorLiteral, topK, asOfCreatedAt, asOfMessageId] = params;
            assert(scopedUserId === userId, 'recall_canon_facts is scoped to the requesting user');
            const queryVector = vectorLiteral.slice(1, -1).split(',').map(Number);

            // Scope filter — mirrors the handler's SQL clause mechanically: user + chat + approved.
            const candidates = facts.filter((f) => {
              if (f.user_id !== userId) return false;
              if (f.chat_id !== chatId) return false;
              if (f.status !== 'approved') return false;

              // as_of_message_id filter — mirrors the handler's `left join chat_messages` + tuple
              // compare: a fact with no anchor (chat-wide, not turn-pinned) is always visible; an
              // anchored fact needs its own anchor at or before the given one.
              if (asOfMessageId === null) return true;
              if (f.anchor_message_id == null) return true;
              const anchor = chatMessages.find((cm) => cm.message_id === f.anchor_message_id);
              if (!anchor) return false;
              return anchor.created_at <= asOfCreatedAt && f.anchor_message_id <= asOfMessageId;
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
const chatId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const otherChatId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'; // same user, different chat

async function embedText(text) {
  const [v] = await embeddings.embed([text]);
  return v;
}

const facts = [];

// --- seed: a variety of facts across chat/status/user dimensions ---
facts.push({
  fact_id: 'f-in-chat',
  user_id: userId,
  chat_id: chatId,
  category: 'person',
  arc_tag: null,
  summary: 'Elara distrusts the Foundation.',
  detail: '',
  vector_embed: await embedText('Elara distrusts the Foundation.'),
  status: 'approved',
  anchor_message_id: null,
  proposed_at: '2026-08-01T00:00:00Z',
  approved_at: '2026-08-01T00:00:01Z',
});
facts.push({
  fact_id: 'f-proposed-in-chat',
  user_id: userId,
  chat_id: chatId,
  category: 'person',
  arc_tag: null,
  summary: 'Not approved yet.',
  detail: '',
  vector_embed: await embedText('Not approved yet.'),
  status: 'proposed',
  anchor_message_id: null,
  proposed_at: '2026-08-01T00:00:00Z',
  approved_at: null,
});
facts.push({
  fact_id: 'f-rejected-in-chat',
  user_id: userId,
  chat_id: chatId,
  category: 'person',
  arc_tag: null,
  summary: 'Rejected and must stay out.',
  detail: '',
  vector_embed: await embedText('Rejected and must stay out.'),
  status: 'rejected',
  anchor_message_id: null,
  proposed_at: '2026-08-01T00:00:00Z',
  approved_at: null,
});
facts.push({
  fact_id: 'f-other-chat-same-user',
  user_id: userId,
  chat_id: otherChatId,
  category: 'concept',
  arc_tag: null,
  summary: 'Belongs to a different chat entirely.',
  detail: '',
  vector_embed: await embedText('Belongs to a different chat entirely.'),
  status: 'approved',
  anchor_message_id: null,
  proposed_at: '2026-08-01T00:00:00Z',
  approved_at: '2026-08-01T00:00:01Z',
});
facts.push({
  fact_id: 'f-other-user',
  user_id: otherUserId,
  chat_id: chatId,
  category: 'person',
  arc_tag: null,
  summary: "Someone else's truth.",
  detail: '',
  vector_embed: await embedText("Someone else's truth."),
  status: 'approved',
  anchor_message_id: null,
  proposed_at: '2026-08-01T00:00:00Z',
  approved_at: '2026-08-01T00:00:01Z',
});
// plot arc with three superseding proposals — only the latest approved comes back
const arcSummaries = ['The siege begins.', 'The siege closes in.', 'The siege breaks the gate.'];
for (let i = 0; i < 3; i++) {
  facts.push({
    fact_id: `f-plot-${i}`,
    user_id: userId,
    chat_id: chatId,
    category: 'plot',
    arc_tag: '#foundation_contest',
    summary: arcSummaries[i],
    detail: '',
    vector_embed: await embedText(arcSummaries[i]),
    status: 'approved',
    anchor_message_id: null,
    proposed_at: `2026-08-0${i + 1}T00:00:00Z`,
    approved_at: `2026-08-0${i + 1}T00:00:01Z`,
  });
}

// --- point-in-time recall: a chat with three messages, one fact anchored at each ---
const chatMessages = [
  { message_id: 'm-1', chat_id: chatId, user_id: userId, created_at: '2026-08-01T00:00:01Z' },
  { message_id: 'm-2', chat_id: chatId, user_id: userId, created_at: '2026-08-01T00:00:02Z' },
  { message_id: 'm-3', chat_id: chatId, user_id: userId, created_at: '2026-08-01T00:00:03Z' },
  { message_id: 'm-other-chat', chat_id: otherChatId, user_id: userId, created_at: '2026-08-01T00:00:01Z' },
];
facts.push({
  fact_id: 'f-anchor-early',
  user_id: userId,
  chat_id: chatId,
  category: 'concept',
  arc_tag: 'gate-status',
  summary: 'The gate was still standing.',
  detail: '',
  vector_embed: await embedText('The gate was still standing.'),
  status: 'approved',
  anchor_message_id: 'm-1',
  proposed_at: '2026-08-01T00:00:01Z',
  approved_at: '2026-08-01T00:00:01Z',
});
facts.push({
  fact_id: 'f-anchor-late',
  user_id: userId,
  chat_id: chatId,
  category: 'concept',
  arc_tag: 'gate-status',
  summary: 'The gate has fallen.',
  detail: '',
  vector_embed: await embedText('The gate has fallen.'),
  status: 'approved',
  anchor_message_id: 'm-3',
  proposed_at: '2026-08-01T00:00:03Z',
  approved_at: '2026-08-01T00:00:03Z',
});

const pool = createFakePool(facts, chatMessages);
const db = createPostgresClient(pool);

async function recall(query, extra = {}) {
  return db.withUserScope(userId, (session) =>
    recallTool.handler({ query, ...extra }, { userId, chatId, db: session }),
  );
}

// --- chat + status scope filter proof ---
const results = await recall('jealousy distrust relationships');
const ids = results.map((r) => r.factId);
assert(ids.includes('f-in-chat'), "a fact belonging to this chat's approved canon is included");
assert(!ids.includes('f-proposed-in-chat'), "a 'proposed' fact never comes back regardless of chat");
assert(!ids.includes('f-rejected-in-chat'), "a 'rejected' fact never comes back regardless of chat");
assert(!ids.includes('f-other-chat-same-user'), 'a fact belonging to a different chat is excluded, even for the same user');
assert(!ids.includes('f-other-user'), "another user's fact is never returned");

// --- plot arc continuity: only the latest approved row per arc_tag ---
const plotResults = await recall('siege situation');
const plotRows = plotResults.filter((r) => r.category === 'plot');
assert(plotRows.length === 1, 'a plot arc with three superseding approvals returns only one row');
assert(plotRows[0].summary === 'The siege breaks the gate.', 'the latest approved row per arc_tag is the one returned');

// --- top_k honored ---
const top1 = await recall('truth', { top_k: 1 });
assert(top1.length === 1, 'top_k limits the returned rows');

// --- recall_canon_facts requires an active chat context ---
{
  let threw = false;
  try {
    await db.withUserScope(userId, (session) => recallTool.handler({ query: 'anything' }, { userId, db: session }));
  } catch {
    threw = true;
  }
  assert(threw, 'recall_canon_facts requires ctx.chatId — a call outside a chat context is rejected');
}

// --- point-in-time recall (as_of_message_id) ---
{
  const live = await recall('the gate');
  const liveIds = live.map((r) => r.factId);
  assert(liveIds.includes('f-anchor-late') && !liveIds.includes('f-anchor-early'), 'without as_of_message_id, only the current/live state comes back — later facts win, not earlier ones');
}
{
  const asOfEarly = await recall('the gate', { as_of_message_id: 'm-1' });
  const asOfEarlyIds = asOfEarly.map((r) => r.factId);
  assert(
    asOfEarlyIds.includes('f-anchor-early') && !asOfEarlyIds.includes('f-anchor-late'),
    'as_of_message_id set to an early point excludes a fact anchored later in the same chat',
  );
}
{
  const asOfLate = await recall('the gate', { as_of_message_id: 'm-3' });
  const asOfLateIds = asOfLate.map((r) => r.factId);
  assert(asOfLateIds.includes('f-anchor-late'), "as_of_message_id set to the anchor's own point includes that fact");
}
{
  const asOfEarly = await recall('jealousy distrust relationships', { as_of_message_id: 'm-1' });
  const asOfEarlyIds = asOfEarly.map((r) => r.factId);
  assert(
    asOfEarlyIds.includes('f-in-chat'),
    'a fact with no anchor_message_id (chat-wide, not turn-pinned) is always visible in an as_of query',
  );
}
{
  let threw = false;
  try {
    await recall('the gate', { as_of_message_id: 'no-such-message' });
  } catch {
    threw = true;
  }
  assert(threw, 'an as_of_message_id that does not resolve to a real message is rejected, not silently ignored');
}
{
  let threw = false;
  try {
    await recall('the gate', { as_of_message_id: 'm-other-chat' });
  } catch {
    threw = true;
  }
  assert(threw, "an as_of_message_id belonging to a different chat than ctx.chatId is rejected");
}

if (process.exitCode) {
  console.error('\ncanon recall verification FAILED');
  process.exit(1);
}
console.log('\ncanon recall verification passed');
