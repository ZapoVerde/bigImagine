// Proves a deleted Wiki projection is durably dismissed and cannot be regenerated for, or shown
// to, a Studio model. The fake is only the Postgres boundary; the real HTTP handler is exercised.

const { handlePortraitWiki } = await import('../dist/server/portraitRoutes.js');

const USER = '11111111-1111-1111-1111-111111111111';
const ENTRY = '22222222-2222-2222-2222-222222222222';
const LESSON = '33333333-3333-3333-3333-333333333333';
const EPISODE = '44444444-4444-4444-4444-444444444444';
const ENTRY_2 = '55555555-5555-5555-5555-555555555555';
const LESSON_2 = '66666666-6666-6666-6666-666666666666';
const EPISODE_2 = '77777777-7777-7777-7777-777777777777';

function assert(condition, message) {
  if (condition) console.log(`ok: ${message}`);
  else {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
}

function response() {
  return {
    responses: [],
    writeHead(status) { this.statusCode = status; },
    end(payload) { this.responses.push({ status: this.statusCode, body: JSON.parse(payload) }); },
  };
}

const state = {
  lessons: [{ lesson_id: LESSON, user_id: USER, source_episode_id: EPISODE, state: 'provisional', wiki_dismissed_at: null }],
  entries: [{ entry_id: ENTRY, user_id: USER, lesson_id: LESSON, origin_episode_id: EPISODE, title: 'Keep the collar visible', body: 'Keep the collar visible.', tags: [], subscriptions: [] }],
  // Reflection-created entries always get a 'created' revision row (portraitFeedback.ts); the
  // real bug this reproduces is the FK violation from deleting an entry that has revisions.
  revisions: [{ revision_id: 'rev-1', user_id: USER, entry_id: ENTRY }],
};

const db = {
  withUserScope: async (_userId, fn) => fn({
    query: async (sql, params = []) => {
      if (sql.includes('with missing_lessons')) {
        for (const lesson of state.lessons) {
          const hasEntry = state.entries.some((entry) => entry.user_id === lesson.user_id && entry.origin_episode_id === lesson.source_episode_id);
          if (lesson.user_id === params[0] && lesson.state === 'provisional' && lesson.wiki_dismissed_at === null && !hasEntry) {
            state.entries.push({ entry_id: `regenerated-${lesson.lesson_id}`, user_id: USER, lesson_id: lesson.lesson_id, origin_episode_id: lesson.source_episode_id, title: 'Regenerated', body: '', tags: [], subscriptions: [] });
          }
        }
        return [];
      }
      if (sql.startsWith('select entry_id, title, body')) return state.entries.filter((entry) => entry.user_id === params[0]);
      if (sql.includes('with deleted_revisions as')) {
        // visual_wiki_revisions.entry_id is a NOT NULL FK with no cascade — the query must delete
        // an entry's revision rows itself, in the same transaction, or Postgres rejects the entry
        // delete with visual_wiki_revisions_entry_id_fkey. This fake enforces that ordering too.
        if (!sql.includes('delete from visual_wiki_revisions')) {
          throw new Error('update or delete on table "visual_wiki_entries" violates foreign key constraint "visual_wiki_revisions_entry_id_fkey"');
        }
        const index = state.entries.findIndex((entry) => entry.entry_id === params[0] && entry.user_id === params[1]);
        if (index === -1) return [];
        state.revisions = state.revisions.filter((r) => !(r.entry_id === params[0] && r.user_id === params[1]));
        const [deleted] = state.entries.splice(index, 1);
        const lesson = deleted.lesson_id !== null
          ? state.lessons.find((candidate) => candidate.user_id === params[1] && candidate.lesson_id === deleted.lesson_id)
          : state.lessons.find((candidate) => candidate.user_id === params[1] && candidate.source_episode_id === deleted.origin_episode_id);
        if (lesson) lesson.wiki_dismissed_at = 'now';
        return [{ entry_id: deleted.entry_id }];
      }
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
  }),
};

const deps = { db, settings: { get: async () => 'true' } };
const deleteRes = response();
await handlePortraitWiki({ method: 'DELETE' }, deleteRes, deps, USER, new URL(`http://x/v1/portraits/wiki/${ENTRY}`));
assert(deleteRes.responses[0]?.status === 200, 'delete returns success for an entry with revision history');
assert(state.lessons[0].wiki_dismissed_at !== null, 'delete persists the linked lesson dismissal');
assert(!state.revisions.some((r) => r.entry_id === ENTRY), 'delete clears the entry\'s revision rows (no FK violation)');

const listRes = response();
await handlePortraitWiki({ method: 'GET' }, listRes, deps, USER, new URL('http://x/v1/portraits/wiki'));
assert(listRes.responses[0]?.body.entries.length === 0, 'a dismissed lesson is not regenerated on the next Wiki list read');

// Entries created via the missing_lessons auto-projection recovery path predating this fix (or a
// manually-authored entry) can have entry.lesson_id === null — the delete SQL's fallback match
// (origin_episode_id -> visual_lessons.source_episode_id) must still dismiss the right lesson.
state.lessons.push({ lesson_id: LESSON_2, user_id: USER, source_episode_id: EPISODE_2, state: 'provisional', wiki_dismissed_at: null });
state.entries.push({ entry_id: ENTRY_2, user_id: USER, lesson_id: null, origin_episode_id: EPISODE_2, title: 'Unlinked entry', body: 'Unlinked entry.', tags: [], subscriptions: [] });

const deleteRes2 = response();
await handlePortraitWiki({ method: 'DELETE' }, deleteRes2, deps, USER, new URL(`http://x/v1/portraits/wiki/${ENTRY_2}`));
assert(deleteRes2.responses[0]?.status === 200, 'delete of a lesson_id-less entry returns success');
assert(state.lessons.find((l) => l.lesson_id === LESSON_2)?.wiki_dismissed_at !== null, 'delete falls back to origin_episode_id to dismiss the right lesson');
