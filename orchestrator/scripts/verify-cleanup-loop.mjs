// Proves orchestrator/cleanupLoop.ts's async heuristic subloop against a fake in-memory pool,
// fake chats store, fake settings store, and fake LLM — no server, no network, no Postgres.
// This is the successor to the retired verify-cleanup-pass.mjs (the inline runCleanupPass is
// gone): it proves the subloop's own mechanics, which the pure-engine gate
// (verify-cleanup-heuristics.mjs) deliberately does not — the roster is RP-only + enabled-only,
// the retro-flood guard only processes messages after cleanup_enabled_at, dedup is exact per
// (message, swipe) via cleanup_jobs (a covered message is never re-processed, so the loop is
// idempotent across ticks), 'remove' rules rewrite without any LLM call, header/footer repairs
// fire one prompt each with {{history, N}} resolved, the 0066 "no inner thoughts → no footer"
// rule holds, every repair records its model reply on the chat's prompt trace (the Prompt
// Inspector's source — the cleaned text replaces the raw reply, so the trace is where it
// survives), every failure lands in the ledger as 'flagged'/'error' rather than throwing, and
// getCleanupStatus derives the pill state (thinking → modified).

import { randomUUID } from 'node:crypto';
import { createPostgresClient } from '../dist/io/postgres.js';
import { getPromptTrace } from '../dist/io/promptTrace.js';
import { runCleanupTick, getCleanupStatus, runCleanupNow, getCleanupJobs } from '../dist/orchestrator/cleanupLoop.js';
import {
  getCleanupSettings,
  parseSetCleanupSettingsBody,
  setCleanupSettings,
} from '../dist/server/adminServer.js';
import { DEFAULT_CLEANUP_CONFIG } from '../dist/orchestrator/cleanupHeuristics.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// --- Fake pool: in-memory users / chat_sessions / chat_messages / chat_message_swipes /
// cleanup_slop_rules / cleanup_jobs, covering exactly the queries cleanupLoop.ts issues. ---
function createFakePool() {
  const users = [];
  const chatSessions = new Map(); // chat_id -> { user_id, kind, cleanup_enabled_at, archived_at }
  const chatMessages = []; // { message_id, chat_id, user_id, role, content, created_at, active_swipe_id }
  const swipes = []; // { swipe_id, message_id, content, created_at }
  const slopRules = []; // cleanup_slop_rules rows (rule_id, set_name, position, pattern, flags, action, replacement, llm_prompt, enabled)
  const jobs = []; // cleanup_jobs rows
  let clock = 1000;
  const now = () => new Date((clock += 1000)).toISOString();

  return {
    users,
    chatSessions,
    chatMessages,
    swipes,
    slopRules,
    jobs,
    now,
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }

          if (sql === 'select user_id from users') {
            return { rows: users.map((u) => ({ user_id: u })) };
          }

          // loadSlopRules
          if (sql.includes('select') && sql.includes('from cleanup_slop_rules')) {
            return { rows: [...slopRules] };
          }

          // replaceSlopRules (admin page save): delete-all then insert-each, same transaction
          if (sql.includes('delete from cleanup_slop_rules')) {
            slopRules.length = 0;
            return { rows: [] };
          }
          if (sql.includes('insert into cleanup_slop_rules')) {
            const [setName, position, pattern, flags, action, replacement, llmPrompt, enabled] = params;
            slopRules.push({
              rule_id: randomUUID(),
              set_name: setName,
              position,
              pattern,
              flags,
              action,
              replacement,
              llm_prompt: llmPrompt,
              enabled,
            });
            return { rows: [] };
          }

          // getCleanupJobs — newest cleanup_jobs rows for one chat, with a content preview
          if (sql.includes('left(m.content, 120) as preview')) {
            const [chatId, limit] = params;
            const rows = jobs
              .filter((j) => j.chat_id === chatId)
              .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '') || b.message_id.localeCompare(a.message_id))
              .slice(0, limit)
              .map((j) => {
                const m = chatMessages.find((x) => x.message_id === j.message_id);
                return {
                  job_id: j.job_id,
                  message_id: j.message_id,
                  status: j.status,
                  changed: j.changed,
                  notes: j.notes,
                  created_at: j.created_at,
                  finished_at: j.finished_at ?? null,
                  preview: m ? m.content.slice(0, 120) : '',
                };
              });
            return { rows };
          }

          // findEnabledChats
          if (sql.includes('select chat_id, cleanup_enabled_at from chat_sessions')) {
            const rows = [...chatSessions.values()]
              .filter((s) => s.user_id === scopedUserId && s.kind === 'rp' && s.cleanup_enabled_at != null && !s.archived_at)
              .map((s) => ({ chat_id: s.chat_id, cleanup_enabled_at: s.cleanup_enabled_at }));
            return { rows };
          }

          // findDueMessages — assistant messages after the stamp with no job for their active swipe
          if (sql.includes('select m.message_id, m.content, m.created_at')) {
            const [chatId, enabledAt] = params;
            const rows = chatMessages
              .filter(
                (m) =>
                  m.chat_id === chatId &&
                  m.role === 'assistant' &&
                  m.created_at > enabledAt &&
                  !jobs.some((j) => j.message_id === m.message_id && j.swipe_id === m.active_swipe_id),
              )
              .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.message_id.localeCompare(b.message_id))
              .map((m) => ({ message_id: m.message_id, content: m.content, created_at: m.created_at }));
            return { rows };
          }

          // loadHistory — messages before the target (chronological boundary)
          if (sql.includes('select role, content from chat_messages')) {
            const [chatId, messageId, createdAt] = params;
            const rows = chatMessages
              .filter(
                (m) =>
                  m.chat_id === chatId &&
                  (m.created_at < createdAt || (m.created_at === createdAt && m.message_id < messageId)),
              )
              .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.message_id.localeCompare(b.message_id))
              .slice(-40)
              .map((m) => ({ role: m.role, content: m.content }));
            return { rows };
          }

          // recordJobForActiveSwipe: content + active swipe read (verified against expectedContent),
          // then job insert
          if (sql.includes('select content, active_swipe_id from chat_messages')) {
            const [messageId, chatId] = params;
            const m = chatMessages.find((x) => x.message_id === messageId && x.chat_id === chatId);
            return { rows: m ? [{ content: m.content, active_swipe_id: m.active_swipe_id }] : [] };
          }
          // recordJob: job insert (the active-swipe variant above shares this exact SQL)
          if (sql.includes('insert into cleanup_jobs')) {
            const [chatId, messageId, swipeId, status, changed, notes] = params;
            const exists = jobs.some((j) => j.message_id === messageId && j.swipe_id === swipeId);
            if (!exists) {
              jobs.push({
                job_id: randomUUID(),
                chat_id: chatId,
                message_id: messageId,
                swipe_id: swipeId,
                status,
                changed,
                notes,
                created_at: now(),
                finished_at: now(),
              });
            }
            return { rows: [] };
          }

          // getCleanupStatus
          if (sql.includes('select kind, cleanup_enabled_at, archived_at from chat_sessions')) {
            const sess = chatSessions.get(params[0]);
            return { rows: sess ? [{ kind: sess.kind, cleanup_enabled_at: sess.cleanup_enabled_at, archived_at: sess.archived_at }] : [] };
          }
          if (sql.includes('select count(*) from chat_messages')) {
            const [chatId] = params;
            const sess = chatSessions.get(chatId);
            const count = chatMessages.filter(
              (m) =>
                m.chat_id === chatId &&
                m.role === 'assistant' &&
                sess &&
                m.created_at > sess.cleanup_enabled_at &&
                !jobs.some((j) => j.message_id === m.message_id && j.swipe_id === m.active_swipe_id),
            ).length;
            return { rows: [{ count: String(count) }] };
          }
          if (sql.includes('select m.message_id, m.created_at from chat_messages')) {
            const [chatId] = params;
            const sess = chatSessions.get(chatId);
            const rows = chatMessages
              .filter((m) => m.chat_id === chatId && m.role === 'assistant' && sess && m.created_at > sess.cleanup_enabled_at)
              .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.message_id.localeCompare(a.message_id))
              .slice(0, 1)
              .map((m) => ({ message_id: m.message_id, created_at: m.created_at }));
            return { rows };
          }
          if (sql.includes('select j.status, j.changed from cleanup_jobs')) {
            const [messageId] = params;
            const m = chatMessages.find((x) => x.message_id === messageId);
            const match = jobs.filter((j) => j.message_id === messageId && m && j.swipe_id === m.active_swipe_id);
            const rows = match.length
              ? [{ status: match[match.length - 1].status, changed: match[match.length - 1].changed }]
              : [];
            return { rows };
          }

          throw new Error(`fake pool: unhandled query: ${sql} (params: ${JSON.stringify(params)})`);
        },
        release() {},
      };
    },
  };
}

// --- Fake chats store: ensureActiveSwipe + recordSwipe against the pool's in-memory rows. ---
function createFakeChats(pool) {
  return {
    async ensureActiveSwipe(userId, chatId, messageId) {
      const m = pool.chatMessages.find((x) => x.message_id === messageId && x.chat_id === chatId);
      if (!m) return undefined;
      if (m.active_swipe_id) return m.active_swipe_id;
      const swipeId = randomUUID();
      pool.swipes.push({ swipe_id: swipeId, message_id: messageId, content: m.content, created_at: pool.now() });
      m.active_swipe_id = swipeId;
      return swipeId;
    },
    async recordSwipe(userId, chatId, messageId, newContent) {
      const result = await this.recordSwipeIfContent(userId, chatId, messageId, undefined, newContent);
      return result?.message;
    },
    async recordSwipeIfContent(userId, chatId, messageId, expectedContent, newContent) {
      const m = pool.chatMessages.find((x) => x.message_id === messageId && x.chat_id === chatId);
      if (!m) return undefined;
      if (expectedContent !== undefined && m.content !== expectedContent) return undefined;
      const swipeId = randomUUID();
      pool.swipes.push({ swipe_id: swipeId, message_id: messageId, content: newContent, created_at: pool.now() });
      m.content = newContent;
      m.active_swipe_id = swipeId;
      return { newSwipeId: swipeId, message: { messageId, role: m.role, content: newContent, createdAt: m.created_at, swipes: { index: 0, count: pool.swipes.length } } };
    },
  };
}

// --- Fake settings store: returns undefined for every cleanup key, so the loop falls back to
// DEFAULT_CLEANUP_CONFIG (the canonical header/footer shapes). ---
function createFakeSettings() {
  return { async get() { return undefined; }, async set() {} };
}

// --- Fake LLM: records prompts, replies per `respond`. ---
function createFakeLlm(respond) {
  const calls = [];
  return {
    calls,
    name: 'fake',
    supportsVision: false,
    async complete(messages) {
      calls.push(messages);
      const content = respond ? respond(messages) : 'repaired';
      return { message: { content }, toolCalls: [], usage: undefined };
    },
  };
}

// --- Seed helpers ---
function addUser(pool, userId) {
  pool.users.push(userId);
}

function addChat(pool, { chatId = randomUUID(), userId, kind = 'rp', cleanupEnabledAt = pool.now(), archivedAt = null } = {}) {
  pool.chatSessions.set(chatId, { chat_id: chatId, user_id: userId, kind, cleanup_enabled_at: cleanupEnabledAt, archived_at: archivedAt });
  return chatId;
}

function addMessage(pool, { chatId, userId, role = 'assistant', content, createdAt = pool.now(), messageId = randomUUID() }) {
  const row = { message_id: messageId, chat_id: chatId, user_id: userId, role, content, created_at: createdAt, active_swipe_id: null };
  pool.chatMessages.push(row);
  return row;
}

function addSlopRule(pool, { pattern, action = 'remove', flags = 'i', replacement = null, enabled = true, set_name = 'test', position = 0 }) {
  const rule = {
    rule_id: randomUUID(),
    set_name,
    position,
    pattern,
    flags,
    action,
    replacement,
    llm_prompt: null,
    enabled,
  };
  pool.slopRules.push(rule);
  return rule;
}

const VALID_HEADER = '[ Early Morning | 🗓️ Wednesday, June 15, 2026 AD | 📍 Deck 6 - Observation Deck ]\nPresent: Mair\n';
const VALID_FOOTER = '\n<details><summary>▸</summary>\ninner text\n</details>';
const CLEAN_REPLY = `${VALID_HEADER}She met his gaze and refused to flinch.${VALID_FOOTER}`;

// ---------------------------------------------------------------------------
// 1. Nothing to fix: a conforming reply costs zero LLM calls, job 'done' changed=false
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  addUser(pool, 'u1');
  const chatId = addChat(pool, { userId: 'u1' });
  const message = addMessage(pool, { chatId, userId: 'u1', content: CLEAN_REPLY });
  const llm = createFakeLlm();
  const chats = createFakeChats(pool);
  const db = createPostgresClient(pool);

  await runCleanupTick({ db, llm, settings: createFakeSettings(), chats });

  assert(llm.calls.length === 0, 'a conforming reply fires no LLM calls');
  assert(pool.jobs.length === 1, 'one cleanup_jobs row is recorded for the conforming reply');
  assert(pool.jobs[0].status === 'done' && pool.jobs[0].changed === false, 'conforming reply job is done+unchanged');
  assert(pool.jobs[0].message_id === message.message_id, 'job is anchored to the processed message');
  assert(pool.swipes.some((s) => s.message_id === message.message_id), 'ensureActiveSwipe materialized a swipe for the job key');
}

// ---------------------------------------------------------------------------
// 2. Dedup: a covered message is never re-processed on the next tick
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  addUser(pool, 'u1');
  const chatId = addChat(pool, { userId: 'u1' });
  addMessage(pool, { chatId, userId: 'u1', content: CLEAN_REPLY });
  const llm = createFakeLlm();
  const chats = createFakeChats(pool);
  const db = createPostgresClient(pool);

  await runCleanupTick({ db, llm, settings: createFakeSettings(), chats });
  const jobsAfterFirst = pool.jobs.length;
  await runCleanupTick({ db, llm, settings: createFakeSettings(), chats });

  assert(pool.jobs.length === jobsAfterFirst, 'a second tick does not re-process an already-covered message');
  assert(llm.calls.length === 0, 'no LLM calls across either tick for a clean reply');
}

// ---------------------------------------------------------------------------
// 3. Retro-flood guard: only messages after cleanup_enabled_at are eligible
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  addUser(pool, 'u1');
  const enabledAt = '2026-06-01T00:00:00.000Z';
  const chatId = addChat(pool, { userId: 'u1', cleanupEnabledAt: enabledAt });
  const beforeStamp = addMessage(pool, { chatId, userId: 'u1', content: `${VALID_HEADER}old\n`, createdAt: '2026-05-15T00:00:00.000Z' });
  const afterStamp = addMessage(pool, { chatId, userId: 'u1', content: CLEAN_REPLY, createdAt: '2026-06-02T00:00:00.000Z' });
  const llm = createFakeLlm();
  const db = createPostgresClient(pool);

  await runCleanupTick({ db, llm, settings: createFakeSettings(), chats: createFakeChats(pool) });

  assert(
    !pool.jobs.some((j) => j.message_id === beforeStamp.message_id),
    'a message created before cleanup_enabled_at is never processed (flood guard)',
  );
  assert(pool.jobs.some((j) => j.message_id === afterStamp.message_id), 'a message created after the stamp is processed');
}

// ---------------------------------------------------------------------------
// 4. RP-only roster: 'chat'-kind chats with cleanup enabled are skipped
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  addUser(pool, 'u1');
  const rpChat = addChat(pool, { userId: 'u1', kind: 'rp' });
  const chatKindChat = addChat(pool, { userId: 'u1', kind: 'chat' });
  const rpMessage = addMessage(pool, { chatId: rpChat, userId: 'u1', content: CLEAN_REPLY });
  const chatMessage = addMessage(pool, { chatId: chatKindChat, userId: 'u1', content: CLEAN_REPLY });
  const llm = createFakeLlm();
  const db = createPostgresClient(pool);

  await runCleanupTick({ db, llm, settings: createFakeSettings(), chats: createFakeChats(pool) });

  assert(pool.jobs.some((j) => j.message_id === rpMessage.message_id), 'the RP chat message is processed');
  assert(
    !pool.jobs.some((j) => j.message_id === chatMessage.message_id),
    'a cleanup-enabled chat-kind chat is never processed (RP-only)',
  );
}

// ---------------------------------------------------------------------------
// 5. 'remove' slop rule: deterministic rewrite, no LLM call
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  addUser(pool, 'u1');
  const chatId = addChat(pool, { userId: 'u1' });
  addSlopRule(pool, { pattern: '\\bas an AI language model\\b' });
  const message = addMessage(pool, { chatId, userId: 'u1', content: `${VALID_HEADER}As an AI language model, I comply.\n` });
  const llm = createFakeLlm();
  const chats = createFakeChats(pool);
  const db = createPostgresClient(pool);

  await runCleanupTick({ db, llm, settings: createFakeSettings(), chats });

  const current = pool.chatMessages.find((m) => m.message_id === message.message_id);
  assert(!current.content.includes('As an AI language model'), 'remove rule stripped the slop phrase');
  assert(current.content.startsWith(VALID_HEADER), 'the header survives the slop rewrite');
  assert(llm.calls.length === 0, 'a remove-only cleanup makes no LLM call');
  const job = pool.jobs.find((j) => j.message_id === message.message_id);
  assert(job && job.status === 'done' && job.changed === true, 'the rewrite job is done+changed');
}

// ---------------------------------------------------------------------------
// 6. Header repair: missing header fires the prompt with {{history, 2}} resolved; reply rewritten
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  addUser(pool, 'u1');
  const chatId = addChat(pool, { userId: 'u1' });
  addMessage(pool, { chatId, userId: 'u1', role: 'user', content: 'Where are we?' });
  addMessage(pool, { chatId, userId: 'u1', role: 'assistant', content: `${VALID_HEADER}Prior reply.\n` });
  addMessage(pool, { chatId, userId: 'u1', role: 'user', content: 'Lead us.' });
  const message = addMessage(pool, { chatId, userId: 'u1', content: 'She refused to flinch.\n' });
  const llm = createFakeLlm((messages) => VALID_HEADER.trimEnd());
  const db = createPostgresClient(pool);

  await runCleanupTick({ db, llm, settings: createFakeSettings(), chats: createFakeChats(pool) });

  assert(llm.calls.length === 1, 'a missing header fires exactly one repair prompt');
  const prompt = llm.calls[0][0].content;
  assert(prompt.includes('{{history, 2}}') === false, 'the {{history, N}} macro was expanded, not left literal');
  assert(prompt.includes('User: Where are we?'), '{{history, 2}} includes the oldest of the last two turn pairs');
  assert(prompt.includes('Assistant: [ Early Morning'), '{{history, 2}} includes the second pair\'s assistant turn (header included)');
  assert(prompt.includes('Prior reply.'), '{{history, 2}} includes the full text of the prior assistant reply');
  assert(prompt.includes('User: Lead us.'), '{{history, 2}} includes the newest user turn');
  assert(prompt.includes('She refused to flinch.'), '{{message}} embeds the raw reply being repaired');
  const current = pool.chatMessages.find((m) => m.message_id === message.message_id);
  assert(current.content.startsWith(VALID_HEADER), 'the header repair prompt output replaced the missing header');
  const job = pool.jobs.find((j) => j.message_id === message.message_id);
  assert(job && job.status === 'done' && job.changed === true, 'the header repair job is done+changed');
}

// ---------------------------------------------------------------------------
// 6b. The Prompt Inspector's trace: a successful repair records its model reply (trimmed, exactly
//     what applyRepairSteps consumed) on the 'cleanup' entry; a failed repair leaves no reply
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  addUser(pool, 'u1');
  const chatId = addChat(pool, { userId: 'u1' });
  const message = addMessage(pool, { chatId, userId: 'u1', content: 'She refused to flinch.\n' });
  // Padded on both sides — the loop must record the trimmed output, not the raw reply.
  const llm = createFakeLlm(() => `  ${VALID_HEADER.trimEnd()}  `);
  const db = createPostgresClient(pool);

  await runCleanupTick({ db, llm, settings: createFakeSettings(), chats: createFakeChats(pool) });

  const cleanup = getPromptTrace(chatId).find((e) => e.kind === 'cleanup');
  assert(!!cleanup, "a fired repair records a 'cleanup' entry in the chat's prompt trace");
  assert(
    cleanup.reply === VALID_HEADER.trimEnd(),
    "the trace entry carries the model's trimmed reply — exactly the text applyRepairSteps consumed",
  );
  assert(
    cleanup.items.length === 1 &&
      cleanup.items[0].role === 'user' &&
      cleanup.items[0].content.includes('header'),
    'the trace entry still holds the prompt itself (user role) alongside the reply',
  );
}

// --- Fail-open reply: a repair that throws still records the prompt (recorded before the call)
//     but carries no reply --------------------------------------------------------
{
  const pool = createFakePool();
  addUser(pool, 'u1');
  const chatId = addChat(pool, { userId: 'u1' });
  addMessage(pool, { chatId, userId: 'u1', content: 'She refused to flinch.\n' });
  const llm = createFakeLlm(() => {
    throw new Error('provider timeout');
  });
  const db = createPostgresClient(pool);

  await runCleanupTick({ db, llm, settings: createFakeSettings(), chats: createFakeChats(pool) });

  const cleanup = getPromptTrace(chatId).find((e) => e.kind === 'cleanup');
  assert(!!cleanup, 'a failed repair still records the prompt (recorded before the call went out)');
  assert(cleanup.reply === undefined, 'a failed repair carries no reply on its trace entry');
}

// ---------------------------------------------------------------------------
// 7. Footer rule: a clean reply with no inner thoughts must not gain one (0066 rule 3)
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  addUser(pool, 'u1');
  const chatId = addChat(pool, { userId: 'u1' });
  const message = addMessage(pool, { chatId, userId: 'u1', content: `${VALID_HEADER}She refused to flinch.\n` });
  const llm = createFakeLlm();
  const db = createPostgresClient(pool);

  await runCleanupTick({ db, llm, settings: createFakeSettings(), chats: createFakeChats(pool) });

  assert(llm.calls.length === 0, 'no footer repair fires for a reply with no inner-thought evidence');
  const job = pool.jobs.find((j) => j.message_id === message.message_id);
  assert(job && job.status === 'done' && job.changed === false, 'no-evidence reply is done+unchanged');
}

// ---------------------------------------------------------------------------
// 8. Fail-open: a repair LLM that throws lands a 'flagged' job, text untouched, tick survives
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  addUser(pool, 'u1');
  const chatId = addChat(pool, { userId: 'u1' });
  const message = addMessage(pool, { chatId, userId: 'u1', content: 'She refused to flinch.\n' });
  const llm = createFakeLlm(() => {
    throw new Error('provider timeout');
  });
  const chats = createFakeChats(pool);
  const db = createPostgresClient(pool);

  await runCleanupTick({ db, llm, settings: createFakeSettings(), chats });

  assert(
    pool.chatMessages.find((m) => m.message_id === message.message_id).content === 'She refused to flinch.\n',
    'a failed repair leaves the raw text untouched (fail-open)',
  );
  const job = pool.jobs.find((j) => j.message_id === message.message_id);
  assert(job && job.status === 'flagged' && job.changed === false, 'a failed repair is recorded as flagged, not thrown');
}

// ---------------------------------------------------------------------------
// 9. Mid-flight guard: a user regeneration while the repair LLM runs is never clobbered
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  addUser(pool, 'u1');
  const chatId = addChat(pool, { userId: 'u1' });
  const message = addMessage(pool, { chatId, userId: 'u1', content: 'No header here.\n' });
  // The repair "succeeds", but between plan and writeback the user regenerates the message.
  const llm = createFakeLlm((messages) => {
    const m = pool.chatMessages.find((x) => x.message_id === message.message_id);
    m.content = 'The user regenerated this mid-flight.\n';
    return VALID_HEADER.trimEnd();
  });
  const db = createPostgresClient(pool);

  await runCleanupTick({ db, llm, settings: createFakeSettings(), chats: createFakeChats(pool) });

  assert(
    pool.chatMessages.find((m) => m.message_id === message.message_id).content === 'The user regenerated this mid-flight.\n',
    'a regeneration during the repair leaves the user\'s new content intact (no clobber)',
  );
  assert(
    !pool.jobs.some((j) => j.message_id === message.message_id),
    'no job is recorded for the stale swipe — the new content is picked up by a later tick',
  );
}

// ---------------------------------------------------------------------------
// 9b. No-change path also verifies the swipe: a message regenerated mid-repair with nothing to
//     fix never gets a job keyed to the user's new (unprocessed) content
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  addUser(pool, 'u1');
  const chatId = addChat(pool, { userId: 'u1' });
  // An 'llm'-action rule fires a repair step. The stub mutates the message mid-call (simulating a
  // regen) yet returns byte-identical text, so the loop lands in the no-change bookkeeping — which
  // must verify the active swipe still holds what we processed before keying a job to it.
  addSlopRule(pool, { pattern: 'delve', action: 'llm' });
  const message = addMessage(pool, { chatId, userId: 'u1', content: 'She refused to delve.\n' });
  const llm = createFakeLlm((messages) => {
    const m = pool.chatMessages.find((x) => x.message_id === message.message_id);
    m.content = 'The user regenerated this mid-flight.\n';
    return 'She refused to delve.\n'; // byte-identical — the no-change branch
  });
  const db = createPostgresClient(pool);

  await runCleanupTick({ db, llm, settings: createFakeSettings(), chats: createFakeChats(pool) });

  assert(
    pool.chatMessages.find((m) => m.message_id === message.message_id).content === 'The user regenerated this mid-flight.\n',
    'a no-change repair leaves a mid-flight regeneration intact',
  );
  assert(
    !pool.jobs.some((j) => j.message_id === message.message_id),
    'a no-change message regenerated mid-flight gets no job keyed to the new unprocessed content',
  );
}

// ---------------------------------------------------------------------------
// 10. getCleanupStatus: disabled chat → enabled:false; enabled chat → thinking → modified;
//     non-RP/archived chats with a stray stamp report enabled:false (roster mirror)
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  addUser(pool, 'u1');
  const db = createPostgresClient(pool);

  const offChat = addChat(pool, { userId: 'u1', cleanupEnabledAt: null });
  const off = await getCleanupStatus(db, 'u1', offChat);
  assert(off && off.enabled === false && off.pending === 0 && off.latest === null, 'cleanup-off chat reports enabled:false');

  const chatKindChat = addChat(pool, { userId: 'u1', kind: 'chat' });
  const chatKindStatus = await getCleanupStatus(db, 'u1', chatKindChat);
  assert(chatKindStatus && chatKindStatus.enabled === false, 'a chat-kind chat with a stamp reports enabled:false (the loop never processes it)');

  const archivedChat = addChat(pool, { userId: 'u1', archivedAt: '2026-06-01T00:00:00.000Z' });
  const archivedStatus = await getCleanupStatus(db, 'u1', archivedChat);
  assert(archivedStatus && archivedStatus.enabled === false, 'an archived chat with a stamp reports enabled:false (the loop never processes it)');

  const onChat = addChat(pool, { userId: 'u1' });
  const msg = addMessage(pool, { chatId: onChat, userId: 'u1', content: 'No header here.\n' });
  const before = await getCleanupStatus(db, 'u1', onChat);
  assert(before && before.enabled === true && before.latest?.state === 'thinking', 'an uncovered new message reads thinking');

  const llm = createFakeLlm((messages) => VALID_HEADER.trimEnd());
  await runCleanupTick({ db, llm, settings: createFakeSettings(), chats: createFakeChats(pool) });
  const after = await getCleanupStatus(db, 'u1', onChat);
  assert(after && after.latest?.state === 'modified', 'after the loop rewrites it, the pill reads modified');
  assert(after.latest.messageId === msg.message_id, 'the pill tracks the newest eligible message');
  assert(after.pending === 0, 'no messages remain pending after the tick');
}

// ---------------------------------------------------------------------------
// 11. runCleanupNow: one-chat immediate pass processes only that chat
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  addUser(pool, 'u1');
  const chatA = addChat(pool, { userId: 'u1' });
  const chatB = addChat(pool, { userId: 'u1' });
  const msgA = addMessage(pool, { chatId: chatA, userId: 'u1', content: 'No header in A.\n' });
  const msgB = addMessage(pool, { chatId: chatB, userId: 'u1', content: 'No header in B.\n' });
  const llm = createFakeLlm((messages) => VALID_HEADER.trimEnd());
  const db = createPostgresClient(pool);

  await runCleanupNow({ db, llm, settings: createFakeSettings(), chats: createFakeChats(pool) }, 'u1', chatA);

  assert(pool.jobs.some((j) => j.message_id === msgA.message_id), 'run-now processes the targeted chat');
  assert(
    !pool.jobs.some((j) => j.message_id === msgB.message_id),
    'run-now leaves every other chat to the poll tick',
  );
}

// ---------------------------------------------------------------------------
// 12. getCleanupSettings: default config when no settings keys are set, seeded slop rules read
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  addSlopRule(pool, { pattern: '\\bdelve\\b', set_name: 'ai-cliches', position: 0 });
  const db = createPostgresClient(pool);
  const settings = createFakeSettings(); // every key undefined → DEFAULT_CLEANUP_CONFIG

  const cfg = await getCleanupSettings(settings, db);
  assert(cfg.headerRegex === DEFAULT_CLEANUP_CONFIG.headerRegex, 'unset header regex falls back to the default');
  assert(cfg.headerPrompt === DEFAULT_CLEANUP_CONFIG.headerPrompt, 'unset header prompt falls back to the default');
  assert(cfg.footerRegex === DEFAULT_CLEANUP_CONFIG.footerRegex, 'unset footer regex falls back to the default');
  assert(cfg.footerPrompt === DEFAULT_CLEANUP_CONFIG.footerPrompt, 'unset footer prompt falls back to the default');
  assert(cfg.slopRules.length === 1 && cfg.slopRules[0].setName === 'ai-cliches', 'seeded slop rules are read back');
}

// ---------------------------------------------------------------------------
// 13. setCleanupSettings + replaceSlopRules: keys persist, slop rules are a full-set replace
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  addSlopRule(pool, { pattern: 'old-rule' });
  const db = createPostgresClient(pool);
  const written = new Map();
  const settings = { async get() { return undefined; }, async set(key, value) { written.set(key, value); } };

  const body = {
    header_regex: '^\\[new header\\]',
    header_prompt: 'Repair the header.',
    slop_rules: [
      { set_name: 'custom', position: 0, pattern: '\\bnew-rule\\b', flags: 'i', action: 'remove', replacement: null, llm_prompt: null, enabled: true },
      { set_name: 'custom', position: 1, pattern: '\\bllm-rule\\b', flags: '', action: 'llm', replacement: null, llm_prompt: 'Fix this.', enabled: true },
    ],
  };
  const parsed = parseSetCleanupSettingsBody(body);
  assert(parsed !== undefined, 'a valid cleanup settings body parses');
  await setCleanupSettings(settings, db, parsed);

  assert(written.get('cleanup_header_regex') === '^\\[new header\\]', 'header regex key is persisted');
  assert(written.get('cleanup_header_prompt') === 'Repair the header.', 'header prompt key is persisted');
  assert(pool.slopRules.length === 2, 'slop rules are replaced, not appended (old rule gone)');
  assert(pool.slopRules.every((r) => r.set_name === 'custom'), 'all replaced rules land in the given set');
  assert(pool.slopRules[1].action === 'llm' && pool.slopRules[1].llm_prompt === 'Fix this.', 'llm-action rule fields survive the round trip');
}

// ---------------------------------------------------------------------------
// 14. getCleanupJobs: newest-first, per chat, with content preview and fail-open notes
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  addUser(pool, 'u1');
  const chatId = addChat(pool, { userId: 'u1' });
  const older = addMessage(pool, { chatId, userId: 'u1', content: 'older message with no header\n', createdAt: '2026-06-01T00:00:00.000Z' });
  const newer = addMessage(pool, { chatId, userId: 'u1', content: 'newer message with no header\n', createdAt: '2026-06-02T00:00:00.000Z' });
  // Seed two jobs directly (job insertion order = created_at order in the fake pool's clock, so
  // seed older first and newer second → the ledger's newest-first sort puts 'newer' first)
  const db = createPostgresClient(pool);
  await db.withUserScope('u1', (session) =>
    session.query(
      `insert into cleanup_jobs (chat_id, message_id, swipe_id, status, changed, notes, finished_at)
       values ($1, $2, $3, $4, $5, $6, now()) on conflict (message_id, swipe_id) do nothing`,
      [chatId, older.message_id, 's-older', 'done', true, 'header:ok'],
    ),
  );
  await db.withUserScope('u1', (session) =>
    session.query(
      `insert into cleanup_jobs (chat_id, message_id, swipe_id, status, changed, notes, finished_at)
       values ($1, $2, $3, $4, $5, $6, now()) on conflict (message_id, swipe_id) do nothing`,
      [chatId, newer.message_id, 's-newer', 'flagged', false, 'header:missing'],
    ),
  );

  const jobs = await getCleanupJobs(db, 'u1', chatId, 20);
  assert(jobs.length === 2, 'both jobs are returned for the chat');
  assert(jobs[0].messageId === newer.message_id && jobs[0].status === 'flagged', 'newest job is first (newest-first order)');
  assert(jobs[0].preview.includes('newer message'), 'flagged job carries a content preview');
  assert(jobs[1].changed === true && jobs[1].notes === 'header:ok', 'done+changed job fields round-trip');
}

if (process.exitCode) {
  console.error('cleanup loop verification FAILED');
} else {
  console.log('cleanup loop verification passed');
}
