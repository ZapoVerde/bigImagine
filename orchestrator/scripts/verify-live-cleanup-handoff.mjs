// Proves orchestrator/liveCleanupHandoff.ts — the detached, fire-and-forget end-of-stream handoff
// both server turn paths now run once the raw reply is already persisted
// (docs/plans/cleanup-pass-blocks-turn-slot-plan.md). The send/swipe call sites that used to
// `await finishStream + finalizeCleanupResult` inline (holding the turn slot open) now `void
// runLiveCleanupHandoff(...)`; the plan's Tests section requires the handoff itself to be:
//   - detached + never-rejecting (nothing awaits it; a rejection is a silent unhandled-rejection)
//     and fail-open internally (a non-abort failure still resolves and still releases the guard)
//   - abort-aware: a Stop during the backgrounded pass aborts finishStream's repairs and still
//     resolves + releases the guard (the raw reply is durable; the message stays due for the tick)
//   - metrics-appending: with a turnMetricId it records the pass's wall-time on the turn's own
//     already-written turn_metrics row (appendCleanupDuration), and skips it when absent
//   - guard-releasing exactly once: the caller's releaseLiveCleanupGuard closure runs in the
//     finally iff the pass actually ran (the caller's own guard protects pre-handoff throws)

import { createPostgresClient } from '../dist/io/postgres.js';
import { createLiveCleanupContext } from '../dist/orchestrator/liveCleanup.js';
import { runLiveCleanupHandoff } from '../dist/orchestrator/liveCleanupHandoff.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// --- Fake pool: createLiveCleanupContext's loads (slop rules, recent history — the settings
// store disables the location block), plus finalizeCleanupResult's no-change path
// (recordJobsForActiveSwipe: chat_messages for-update select → cleanup_jobs insert) and
// appendCleanupDuration's turn_metrics update. ---
function createFakePool() {
  const state = {
    chatMessages: [
      // message_id, chat_id, role, content, active_swipe_id — content seeded to the composed
      // body so recordJobsForActiveSwipe's content-match guard passes (the no-change path).
      { message_id: 'm1', chat_id: 'c1', role: 'assistant', content: COMPOSED, active_swipe_id: 's1' },
    ],
    slopRules: [],
    jobsInserts: [],
    turnMetricsUpdates: [],
  };
  return {
    ...state,
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }
          // loadSlopRules
          if (sql.includes('select') && sql.includes('from cleanup_slop_rules')) {
            return { rows: [...state.slopRules] };
          }
          // loadRecentHistory — the boundary-less tail read (limit $2)
          if (sql.includes('select role, content from chat_messages') && sql.includes('limit $2')) {
            const [chatId] = params;
            return {
              rows: state.chatMessages
                .filter((m) => m.chat_id === chatId)
                .map((m) => ({ role: m.role, content: m.content })),
            };
          }
          // recordJobsForActiveSwipe — chat_messages for-update read
          if (sql.includes('select content, active_swipe_id from chat_messages')) {
            const [messageId, chatId] = params;
            const row = state.chatMessages.find((m) => m.message_id === messageId && m.chat_id === chatId);
            if (!row) return { rows: [] };
            return { rows: [{ content: row.content, active_swipe_id: row.active_swipe_id }] };
          }
          // recordJobsForActiveSwipe — cleanup_jobs insert
          if (sql.includes('insert into cleanup_jobs')) {
            state.jobsInserts.push(params);
            return { rows: [] };
          }
          // appendCleanupDuration — turn_metrics update
          if (sql.includes('update turn_metrics set cleanup_duration_ms')) {
            state.turnMetricsUpdates.push(params);
            return { rows: [] };
          }
          throw new Error(`fake pool: unhandled query: ${sql} (params: ${JSON.stringify(params)})`);
        },
        release() {},
      };
    },
  };
}

// --- Fake settings: cleanup keys fall back to DEFAULT_CLEANUP_CONFIG; the location block is
// disabled so loadLocationBlock short-circuits (no location queries in the fake pool). ---
function createFakeSettings() {
  return {
    async get(key) {
      if (key === 'location_injection_enabled') return 'false';
      return undefined;
    },
    async set() {},
  };
}

// --- Stub LLM: should never be called by this suite's clean-path scenarios; a caller is still
// required by the deps shape. ---
function createStubLlm() {
  return {
    name: 'fake',
    supportsVision: false,
    async complete() {
      return { message: { content: 'unexpected-llm-call' }, toolCalls: [], usage: undefined };
    },
  };
}

// A body whose header is already perfect and whose single final paragraph needs no repair: the
// header check judges it 'ok' (no dispatch), the tail pass finds no slop, the footer check finds
// the footer present — so finishStream makes no LLM call and leaves composed === baseText, which
// drives finalizeCleanupResult down its no-change path (recordJobsForActiveSwipe). The footer is
// the canonical inner-thoughts block (character-visual-state-plan.md) — a conforming footer under
// the structure-aware footer regex (the <summary>▸</summary> header and the outfit slots are
// optional).
const COMPOSED =
  '[ Early Morning | 🗓️ Wednesday, June 15, 2026 AD | 📍 Deck 6 - Observation Deck ]\nPresent: Mair\n\n' +
  'A clean opening paragraph that needs no repair.\n\n' +
  '<details><summary>▸</summary>\n' +
  '<Mair>\n' +
  'Inner thoughts: What Mair is feeling beneath what she is showing.\n' +
  'Expression: calm\n' +
  'Outfit:\n' +
  '- Outerwear: none\n' +
  '- Top: blouse\n' +
  '- Bottom: skirt\n' +
  '- Underwear top: none\n' +
  '- Underwear bottom: none\n' +
  '- Accessory: none\n' +
  '</Mair>\n' +
  '</details>\n';

// ---------------------------------------------------------------------------
// A: clean no-change handoff — never rejects, runs the writeback's no-change path,
//    appends the cleanup duration, and releases the guard exactly once
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const deps = { db, llm: createStubLlm(), settings: createFakeSettings(), chats: {} };
  const ctx = await createLiveCleanupContext(deps, 'u1', 'c1');
  // The composed buffer is authoritative post-stream: seed it with the same clean body so
  // finishStream's no-change path holds (composed === reply on return).
  ctx.composed = COMPOSED;
  ctx.bodyCursor = COMPOSED.length;

  let releaseCalls = 0;
  await runLiveCleanupHandoff(
    deps,
    ctx,
    'u1',
    'c1',
    'm1',
    COMPOSED,
    new AbortController(),
    () => { releaseCalls += 1; },
    { turnMetricId: 'tm-1' },
  );

  assert(releaseCalls === 1, 'cleanup guard is released exactly once on the clean path');
  assert(
    pool.turnMetricsUpdates.some((p) => p[1] === 'tm-1' && typeof p[0] === 'number' && p[0] >= 0),
    'cleanup duration is appended to the turn_metrics row (turnMetricId tm-1)',
  );
  // finalizeCleanupResult's no-change branch records per-region jobs against the still-active
  // swipe (composed === reply, content matches) — exactly what the poll tick's writeback does.
  assert(pool.jobsInserts.length >= 1, 'the no-change writeback records cleanup_jobs rows');
}

// ---------------------------------------------------------------------------
// B: pre-aborted Stop during the backgrounded pass — still resolves, still releases
//    the guard, still appends duration, records nothing (message stays due for the tick)
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const deps = { db, llm: createStubLlm(), settings: createFakeSettings(), chats: {} };
  const ctx = await createLiveCleanupContext(deps, 'u1', 'c2');
  ctx.composed = COMPOSED;
  ctx.bodyCursor = COMPOSED.length;

  const controller = new AbortController();
  controller.abort(); // a Stop already landed before/at the handoff start

  let releaseCalls = 0;
  await runLiveCleanupHandoff(
    deps,
    ctx,
    'u1',
    'c2',
    'm2',
    COMPOSED,
    controller,
    () => { releaseCalls += 1; },
    { turnMetricId: 'tm-2' },
  );

  assert(releaseCalls === 1, 'the guard is still released exactly once after an abort');
  assert(
    pool.turnMetricsUpdates.some((p) => p[1] === 'tm-2'),
    'the duration append still runs after an abort (fail-open finally)',
  );
  assert(
    pool.jobsInserts.length === 0,
    'an aborted pass records no cleanup_jobs (the message stays due for the poll tick)',
  );
}

// ---------------------------------------------------------------------------
// C: no turnMetricId — the append is skipped, but the guard is still released
//    (the poll-tick dedup key and cleanup abort-registry entry still drop)
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const deps = { db, llm: createStubLlm(), settings: createFakeSettings(), chats: {} };
  const ctx = await createLiveCleanupContext(deps, 'u1', 'c3');
  ctx.composed = COMPOSED;
  ctx.bodyCursor = COMPOSED.length;

  let releaseCalls = 0;
  await runLiveCleanupHandoff(
    deps,
    ctx,
    'u1',
    'c3',
    'm3',
    COMPOSED,
    new AbortController(),
    () => { releaseCalls += 1; },
    {}, // no turnMetricId
  );

  assert(releaseCalls === 1, 'the guard is still released exactly once with no turnMetricId');
  assert(
    pool.turnMetricsUpdates.length === 0,
    "no turn_metrics update is issued when turnMetricId is absent",
  );
}

console.log('live cleanup handoff verification complete');
