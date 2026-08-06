// Proves propose/approve/reject/get_proposals through info/registerTools (the real loader
// contract) using a fake embeddings provider + stateful fake Postgres pool simulating the
// canon_facts table — same style as verify-notes.mjs, plus the stub-embedding precedent.
// Every canon fact now requires a chat context (db/migrations/0058_canon_facts_chat_scoped.sql),
// and get_canon_fact_proposals/reject_canon_fact both now span 'proposed' and already-'approved'
// rows (facts auto-approve at the chat's next sync tick, not on a human click — see
// orchestrator/chatMemorySync.ts, proven separately in verify-chat-memory-sync.mjs).

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

function createFakePool() {
  const facts = [];
  let counter = 0;
  let clock = 1000;

  return {
    facts,
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }

          if (sql.startsWith('insert into canon_facts')) {
            const [userId, sceneId, category, arcTag, summary, detail, vector, linkedCharacterIds, linkedLocationId, chatId, anchorMessageId] = params;
            assert(scopedUserId === userId, 'propose_canon_fact is scoped to the requesting user');
            const row = {
              fact_id: `fact-${++counter}`,
              user_id: userId,
              scene_id: sceneId,
              category,
              arc_tag: arcTag,
              summary,
              detail,
              vector_embed: vector,
              status: 'proposed',
              linked_character_ids: linkedCharacterIds,
              linked_location_id: linkedLocationId,
              chat_id: chatId,
              anchor_message_id: anchorMessageId,
              proposed_at: new Date((clock += 1000)).toISOString(),
              approved_at: null,
            };
            facts.push(row);
            return { rows: [{ fact_id: row.fact_id }] };
          }

          if (sql.startsWith('update canon_facts')) {
            const [factId] = params;
            // approve_canon_fact only ever targets a still-'proposed' row; reject_canon_fact
            // (widened by db/migrations/0058_canon_facts_chat_scoped.sql's auto-promotion design)
            // targets either a 'proposed' or an already-'approved' row — disambiguated by which
            // literal status each tool's own SQL sets, not by substring overlap ("approved" appears
            // in both the approve SQL's SET clause and reject's WHERE-list).
            const isApproval = sql.includes("set status = 'approved'");
            const eligibleStatuses = isApproval ? ['proposed'] : ['proposed', 'approved'];
            const fact = facts.find((f) => f.fact_id === factId && f.user_id === scopedUserId && eligibleStatuses.includes(f.status));
            if (!fact) return { rows: [] };
            fact.status = isApproval ? 'approved' : 'rejected';
            if (isApproval) fact.approved_at = new Date((clock += 1000)).toISOString();
            return { rows: [{ fact_id: fact.fact_id, status: fact.status }] };
          }

          if (sql.startsWith('select fact_id, category, arc_tag, summary, detail')) {
            const [userId, category] = params;
            assert(scopedUserId === userId, 'get_canon_fact_proposals is scoped to the requesting user');
            const rows = facts
              .filter((f) => f.user_id === userId && (f.status === 'proposed' || f.status === 'approved') && (category === null || f.category === category))
              .sort((a, b) => (a.proposed_at < b.proposed_at ? 1 : -1))
              .map((f) => ({
                fact_id: f.fact_id,
                category: f.category,
                arc_tag: f.arc_tag,
                summary: f.summary,
                detail: f.detail,
                linked_character_ids: f.linked_character_ids,
                linked_location_id: f.linked_location_id,
                scene_id: f.scene_id,
                chat_id: f.chat_id,
                status: f.status,
                proposed_at: f.proposed_at,
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

assert(info.id === 'canonize' && /^[a-z0-9_-]+$/.test(info.id), 'info.id is present and matches the required format');

const embeddings = createStubEmbeddingProvider(2048);
const pluginTools = await registerTools({ llm: null, embeddings, cipher: null, db: null, credentials: null, settings: null });
assert(pluginTools.length === 5, 'registerTools returns exactly five tools');

const registry = createToolRegistry(pluginTools);
for (const name of ['propose_canon_fact', 'approve_canon_fact', 'reject_canon_fact', 'get_canon_fact_proposals', 'recall_canon_facts']) {
  assert(registry.definitions().some((d) => d.name === name), `${name} is registered`);
}

const pool = createFakePool();
const db = createPostgresClient(pool);
const userId = '11111111-1111-1111-1111-111111111111';
const otherUserId = '22222222-2222-2222-2222-222222222222';
const sceneId = '33333333-3333-3333-3333-333333333333';
const chatId = '44444444-4444-4444-4444-444444444444';
const otherChatId = '55555555-5555-5555-5555-555555555555';

const proposeTool = registry.get('propose_canon_fact');
const approveTool = registry.get('approve_canon_fact');
const rejectTool = registry.get('reject_canon_fact');
const getProposalsTool = registry.get('get_canon_fact_proposals');

// --- propose_canon_fact writes a 'proposed' row with an embedding ---
const proposal = await db.withUserScope(userId, (session) =>
  proposeTool.handler(
    { category: 'person', summary: 'Elara distrusts the Foundation.', scene_id: sceneId },
    { userId, chatId, db: session },
  ),
);
assert(proposal.factId.length > 0 && proposal.status === 'proposed', 'propose_canon_fact returns a proposed fact id');
assert(embeddings.dimension === 2048, 'proposals are embedded at the repo\'s 2048-dimension width');

// --- proposing outside a chat context is rejected before it reaches SQL (db/migrations/
// 0058_canon_facts_chat_scoped.sql: every canon fact must belong to a chat) ---
let threw = false;
try {
  await db.withUserScope(userId, (session) =>
    proposeTool.handler({ category: 'person', summary: 'No chat here.' }, { userId, db: session }),
  );
} catch {
  threw = true;
}
assert(threw, 'propose_canon_fact requires ctx.chatId — a proposal with no chat context is rejected before SQL');

// --- plot category requires arc_tag (rejected before SQL) ---
threw = false;
try {
  await db.withUserScope(userId, (session) =>
    proposeTool.handler({ category: 'plot', summary: 'The siege begins.' }, { userId, chatId, db: session }),
  );
} catch (err) {
  threw = true;
}
assert(threw, 'a plot-category proposal without arc_tag is rejected before it reaches SQL');

const plotOk = await db.withUserScope(userId, (session) =>
  proposeTool.handler({ category: 'plot', summary: 'The siege begins.', arc_tag: '#foundation_contest', scene_id: sceneId }, { userId, chatId, db: session }),
);
assert(plotOk.status === 'proposed', 'a plot-category proposal with arc_tag is accepted');

// --- invalid category rejected before SQL ---
threw = false;
try {
  await db.withUserScope(userId, (session) =>
    proposeTool.handler({ category: 'not_real', summary: 'x' }, { userId, chatId, db: session }),
  );
} catch {
  threw = true;
}
assert(threw, 'an unknown category is rejected before reaching SQL');

// --- get_canon_fact_proposals lists proposed rows (an audit/undo queue now, not strictly a
// pre-approval one — see below) ---
const proposals = await db.withUserScope(userId, (session) => getProposalsTool.handler({}, { userId, db: session }));
assert(proposals.length === 2, 'get_canon_fact_proposals lists the proposed rows');
assert(!proposals.some((p) => p.status === 'approved'), 'nothing is approved yet at this point');
assert(proposals.every((p) => p.chatId === chatId), 'each listed row carries the chat it was proposed in');

const personOnly = await db.withUserScope(userId, (session) => getProposalsTool.handler({ category: 'person' }, { userId, db: session }));
assert(personOnly.length === 1 && personOnly[0].category === 'person', 'get_canon_fact_proposals can filter by category');

// --- approve_canon_fact transitions to approved ---
const approved = await db.withUserScope(userId, (session) =>
  approveTool.handler({ fact_id: proposal.factId }, { userId, db: session }),
);
assert(approved.status === 'approved', 'approve_canon_fact transitions a proposed row to approved');

const afterApprove = await db.withUserScope(userId, (session) => getProposalsTool.handler({}, { userId, db: session }));
assert(afterApprove.length === 2, 'an approved fact still appears in the queue (audit/undo, not a pre-approval gate)');
assert(
  afterApprove.find((p) => p.factId === proposal.factId)?.status === 'approved',
  'the queue reflects the approved fact\'s current status',
);

// --- reject_canon_fact transitions to rejected, kept on record ---
const rejected = await db.withUserScope(userId, (session) =>
  rejectTool.handler({ fact_id: plotOk.factId }, { userId, db: session }),
);
assert(rejected.status === 'rejected', 'reject_canon_fact transitions a proposed row to rejected');

const afterReject = await db.withUserScope(userId, (session) => getProposalsTool.handler({}, { userId, db: session }));
assert(afterReject.length === 1, 'a rejected fact no longer appears in the queue');
assert(pool.facts.some((f) => f.fact_id === plotOk.factId && f.status === 'rejected'), 'a rejected fact is kept, never deleted');

// --- reject_canon_fact also undoes an already-approved row, not just a still-proposed one (the
// point of widening its WHERE clause: most facts a human wants to undo will already be
// auto-approved by the time they look) ---
const rejectedAfterApproval = await db.withUserScope(userId, (session) =>
  rejectTool.handler({ fact_id: proposal.factId }, { userId, db: session }),
);
assert(rejectedAfterApproval.status === 'rejected', 'reject_canon_fact can undo an already-approved fact, not just a pending one');
const afterRejectApproved = await db.withUserScope(userId, (session) => getProposalsTool.handler({}, { userId, db: session }));
assert(afterRejectApproved.length === 0, 'once undone, the fact drops out of the queue same as any other rejection');

// --- approve/reject only touch the row they target ---
const otherUsersProposal = await db.withUserScope(otherUserId, (session) =>
  proposeTool.handler({ category: 'thing', summary: 'Not yours' }, { userId: otherUserId, chatId: otherChatId, db: session }),
);
const crossApprove = await db.withUserScope(userId, (session) =>
  approveTool.handler({ fact_id: otherUsersProposal.factId }, { userId, db: session }),
);
assert(crossApprove.notFound === true, "approve_canon_fact cannot touch another user's proposal");

// --- already-approved rows are not re-approvable ---
const otherApproved = await db.withUserScope(otherUserId, (session) =>
  approveTool.handler({ fact_id: otherUsersProposal.factId }, { userId: otherUserId, db: session }),
);
assert(otherApproved.status === 'approved', 'sanity: the other user can approve their own proposal');
const doubleApprove = await db.withUserScope(otherUserId, (session) =>
  approveTool.handler({ fact_id: otherUsersProposal.factId }, { userId: otherUserId, db: session }),
);
assert(doubleApprove.notFound === true, 'approving an already-approved row is a no-op');

if (process.exitCode) {
  console.error('\ncanon facts verification FAILED');
  process.exit(1);
}
console.log('\ncanon facts verification passed');