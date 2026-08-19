// Direct coverage for orchestrator/settleTransientRecords.ts's own promote/demote logic — the
// per-turn settling path (called by handleChatCompletions.ts / turnExecution.ts's regenerateSwipe)
// that this codebase's httpServer fake pool (verify-server.mjs) doesn't model, so a failure here
// fails open silently rather than being asserted on. A minimal fake PostgresClient, no HTTP
// scaffolding needed: just chat_messages/chat_message_swipes/locations/characters/
// location_chat_links/character_chat_links rows and the five query shapes
// settleTransientRecordsForMessage issues.
import { settleTransientRecordsForMessage } from '../dist/orchestrator/settleTransientRecords.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function seed() {
  return {
    chatMessages: [{ message_id: 'msg-1', active_swipe_id: 'swipe-active' }],
    locations: [
      { location_id: 'loc-active', user_id: USER_A, status: 'transient' },
      { location_id: 'loc-other', user_id: USER_A, status: 'transient' },
      { location_id: 'loc-already-permanent', user_id: USER_A, status: 'permanent' },
      { location_id: 'loc-other-user', user_id: USER_B, status: 'transient' },
    ],
    characters: [
      { character_id: 'char-active', user_id: USER_A, status: 'transient' },
      { character_id: 'char-other', user_id: USER_A, status: 'transient' },
    ],
    locationChatLinks: [
      { location_id: 'loc-active', chat_id: 'chat-1', anchor_swipe_id: 'swipe-active' },
      { location_id: 'loc-other', chat_id: 'chat-1', anchor_swipe_id: 'swipe-other' },
      { location_id: 'loc-already-permanent', chat_id: 'chat-1', anchor_swipe_id: 'swipe-other' },
      { location_id: 'loc-other-user', chat_id: 'chat-1', anchor_swipe_id: 'swipe-active' },
    ],
    characterChatLinks: [
      { character_id: 'char-active', chat_id: 'chat-1', anchor_swipe_id: 'swipe-active' },
      { character_id: 'char-other', chat_id: 'chat-1', anchor_swipe_id: 'swipe-other' },
    ],
  };
}

function createFakeDb(pool) {
  return {
    withUserScope: async (userId, fn) =>
      fn({
        query: async (sql, params) => {
          if (sql.includes('select active_swipe_id from chat_messages where message_id')) {
            const [messageId] = params;
            const m = pool.chatMessages.find((row) => row.message_id === messageId);
            return m ? [{ active_swipe_id: m.active_swipe_id }] : [];
          }
          if (sql.includes("update locations set status = 'permanent'")) {
            const [uid, activeSwipeId] = params;
            const linked = new Set(
              pool.locationChatLinks.filter((l) => l.anchor_swipe_id === activeSwipeId).map((l) => l.location_id),
            );
            const updated = pool.locations.filter((l) => l.user_id === uid && l.status === 'transient' && linked.has(l.location_id));
            updated.forEach((l) => (l.status = 'permanent'));
            return updated.map((l) => ({ location_id: l.location_id }));
          }
          if (sql.includes("update characters set status = 'permanent'")) {
            const [uid, activeSwipeId] = params;
            const linked = new Set(
              pool.characterChatLinks.filter((l) => l.anchor_swipe_id === activeSwipeId).map((l) => l.character_id),
            );
            const updated = pool.characters.filter((c) => c.user_id === uid && c.status === 'transient' && linked.has(c.character_id));
            updated.forEach((c) => (c.status = 'permanent'));
            return updated.map((c) => ({ character_id: c.character_id }));
          }
          if (sql.includes("update locations set status = 'inactive'")) {
            const [uid, , activeSwipeId] = params;
            const otherSwipeIds = new Set(
              pool.locationChatLinks.filter((l) => l.anchor_swipe_id && l.anchor_swipe_id !== activeSwipeId).map((l) => l.anchor_swipe_id),
            );
            const linked = new Set(
              pool.locationChatLinks.filter((l) => l.anchor_swipe_id && otherSwipeIds.has(l.anchor_swipe_id)).map((l) => l.location_id),
            );
            const updated = pool.locations.filter((l) => l.user_id === uid && l.status === 'transient' && linked.has(l.location_id));
            updated.forEach((l) => (l.status = 'inactive'));
            return updated.map((l) => ({ location_id: l.location_id }));
          }
          if (sql.includes("update characters set status = 'inactive'")) {
            const [uid, , activeSwipeId] = params;
            const otherSwipeIds = new Set(
              pool.characterChatLinks.filter((l) => l.anchor_swipe_id && l.anchor_swipe_id !== activeSwipeId).map((l) => l.anchor_swipe_id),
            );
            const linked = new Set(
              pool.characterChatLinks.filter((l) => l.anchor_swipe_id && otherSwipeIds.has(l.anchor_swipe_id)).map((l) => l.character_id),
            );
            const updated = pool.characters.filter((c) => c.user_id === uid && c.status === 'transient' && linked.has(c.character_id));
            updated.forEach((c) => (c.status = 'inactive'));
            return updated.map((c) => ({ character_id: c.character_id }));
          }
          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
      }),
  };
}

{
  const pool = seed();
  const db = createFakeDb(pool);
  await settleTransientRecordsForMessage(db, USER_A, 'msg-1');

  assert(pool.characters.find((c) => c.character_id === 'char-active').status === 'permanent', 'the active swipe\'s transient character promotes to permanent');
  assert(pool.characters.find((c) => c.character_id === 'char-other').status === 'inactive', 'a demoted (non-active) swipe\'s transient character goes inactive, not deleted');
  assert(pool.locations.find((l) => l.location_id === 'loc-active').status === 'permanent', 'the active swipe\'s transient location promotes to permanent');
  assert(pool.locations.find((l) => l.location_id === 'loc-other').status === 'inactive', 'a demoted (non-active) swipe\'s transient location goes inactive');
  assert(pool.locations.find((l) => l.location_id === 'loc-already-permanent').status === 'permanent', 'an already-permanent row is left alone, never demoted back');
  assert(pool.locations.find((l) => l.location_id === 'loc-other-user').status === 'transient', "another user's row is never touched even if it were (hypothetically) linked");
}

{
  // A message with no active swipe yet (e.g. a header never parsed, so ensureActiveSwipe never
  // ran) must be a clean no-op — not an error, not a query against an undefined swipe id.
  const pool = seed();
  pool.chatMessages[0].active_swipe_id = null;
  const db = createFakeDb(pool);
  await settleTransientRecordsForMessage(db, USER_A, 'msg-1');
  assert(pool.characters.every((c) => c.status === 'transient'), 'a message with no active swipe settles nothing');
}

{
  // The fail-open contract (bi_principles.md §11): a DB error must never throw back into the
  // caller (handleChatCompletions.ts / regenerateSwipe would otherwise fail an already-succeeded
  // turn over bookkeeping).
  const db = {
    withUserScope: async () => {
      throw new Error('boom');
    },
  };
  await settleTransientRecordsForMessage(db, USER_A, 'msg-1');
  assert(true, 'a DB failure is swallowed (fail-open), never thrown back to the caller');
}

if (process.exitCode) {
  console.error('\nsettle-transient-records verification FAILED');
  process.exit(1);
}
console.log('\nsettle-transient-records verification passed');
