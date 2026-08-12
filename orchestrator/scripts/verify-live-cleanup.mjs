// Proves orchestrator/liveCleanup.ts's incremental in-stream engine against a fake in-memory
// pool, fake settings store, and stub LLM — no server, no network, no Postgres. The pure-engine
// gate (verify-cleanup-heuristics.mjs) covers the decision functions; this suite drives the live
// engine exactly the way runStreamingRpTurn does (a scripted delta sequence through onLiveDelta,
// then finishStream with the caller-provided baseText), asserting the plan's trigger timing and
// event ordering per region (docs/plans/in-stream-cleanup-plan.md Tests):
//   - the header check fires exactly once, at the two-newline boundary or the 400-char cap, and
//     never before; the cap with one newline fires only on 'missing' (waits on 'malformed')
//   - a malformed header produces in-flux then deployed + a patch frame with the header's span
//   - body 'remove' matches patch immediately with no LLM call
//   - a 'replace-paragraph' match dispatches a repair scoped to that paragraph, and its patch
//     span is re-located in the composed buffer when an earlier (header) patch shifted offsets
//   - the final unterminated paragraph is only caught by finishStream's tail body pass
//   - an 'llm'-action rule is never dispatched until finishStream
//   - footer inspection only runs in finishStream
//   - a blank/whitespace buffer never fires a spurious header repair, and resetLiveCleanupContext
//     clears the buffer + region state
//   - abort mid-repair cancels the in-flight call and reports no deployed/flagged transition for
//     that region; finishStream then throws AbortError to the caller

import { randomUUID } from 'node:crypto';
import { createPostgresClient } from '../dist/io/postgres.js';
import {
  createLiveCleanupContext,
  finishStream,
  onLiveDelta,
  resetLiveCleanupContext,
} from '../dist/orchestrator/liveCleanup.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// Flush the fire-and-forget repair resolutions (dispatchStep awaits llm.complete — a microtask
// chain) so assertions see the settled state.
const flush = () => new Promise((r) => setTimeout(r, 0));

// --- Fake pool: only what createLiveCleanupContext's loads issue (slop rules, recent history) —
// the settings store below disables the location block, so no location queries ever run. ---
function createFakePool() {
  const chatMessages = []; // { message_id, chat_id, role, content, created_at }
  const slopRules = []; // cleanup_slop_rules rows
  return {
    chatMessages,
    slopRules,
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
            return { rows: [...slopRules] };
          }
          // loadRecentHistory — the boundary-less tail read (limit $2)
          if (sql.includes('select role, content from chat_messages') && sql.includes('limit $2')) {
            const [chatId] = params;
            const rows = chatMessages
              .filter((m) => m.chat_id === chatId)
              .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.message_id.localeCompare(b.message_id))
              .slice(-40)
              .map((m) => ({ role: m.role, content: m.content }));
            return { rows };
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

// --- Stub LLM: replies per the scripted response queue (dispatch order is deterministic). ---
function createScriptedLlm(responses = []) {
  const calls = [];
  return {
    calls,
    name: 'fake',
    supportsVision: false,
    async complete(messages) {
      calls.push(messages);
      const content = responses.shift() ?? 'fallback-reply';
      return { message: { content }, toolCalls: [], usage: undefined };
    },
  };
}

// --- Deferred LLM: each complete() stays pending until the test resolves that call by index —
// lets a test hold a repair in flight while later deltas arrive (re-location, abort). ---
function createDeferredLlm() {
  const calls = [];
  const gates = [];
  return {
    calls,
    name: 'fake',
    supportsVision: false,
    complete(messages) {
      calls.push(messages);
      return new Promise((resolve) => {
        gates.push({ resolve });
      });
    },
    respond(callIndex, content) {
      gates[callIndex].resolve({ message: { content }, toolCalls: [], usage: undefined });
    },
  };
}

function addSlopRule(pool, { pattern, action = 'remove', flags = 'i', replacement = null, enabled = true, set_name = 'test', position = 0 }) {
  pool.slopRules.push({
    rule_id: randomUUID(),
    set_name,
    position,
    pattern,
    flags,
    action,
    replacement,
    llm_prompt: null,
    enabled,
  });
}

const VALID_HEADER = '[ Early Morning | 🗓️ Wednesday, June 15, 2026 AD | 📍 Deck 6 - Observation Deck ]\nPresent: Mair\n';
const MALFORMED_HEADER_LINE1 = '[ Bad | Header | X';
const VALID_FOOTER = '\n<details><summary>▸</summary>\ninner text\n</details>';

// ---------------------------------------------------------------------------
// 1. Header: fires exactly once at the two-newline boundary; malformed → in-flux → deployed
//    + a patch frame spanning the malformed header's own two lines
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const llm = createScriptedLlm(['[ Night | 🗓️ Friday, June 17, 2026 AD | 📍 Bar - Cellar ]\nPresent: Mair, Kael\n']);
  const deps = { db, llm, settings: createFakeSettings(), chats: {} };
  const ctx = await createLiveCleanupContext(deps, 'u1', 'c1');
  const events = [];
  const sink = (e) => events.push(e);
  const signal = new AbortController().signal;

  onLiveDelta(ctx, deps, 'u1', 'c1', `${MALFORMED_HEADER_LINE1}\n`, signal, sink);
  await flush();
  assert(
    events.filter((e) => e.kind === 'status' && e.region === 'header').length === 0,
    'the header check does not fire at one newline',
  );
  assert(llm.calls.length === 0, 'no header repair is dispatched before the two-newline boundary');

  onLiveDelta(ctx, deps, 'u1', 'c1', 'Present: Nobody\n', signal, sink);
  await flush();
  const headerStatuses = events.filter((e) => e.kind === 'status' && e.region === 'header').map((e) => e.state);
  assert(headerStatuses.includes('in-flux'), 'a malformed header goes in-flux at the two-newline boundary');
  assert(headerStatuses.includes('deployed'), 'the header repair resolves to deployed');
  const patch = events.find((e) => e.kind === 'patch' && e.region === 'header');
  assert(!!patch, 'a header patch frame is emitted');
  const expectedEnd = `${MALFORMED_HEADER_LINE1}\nPresent: Nobody`.length;
  assert(patch.start === 0 && patch.end === expectedEnd, `the header patch spans the malformed header (0..${expectedEnd})`);
  assert(
    patch.replacement === '[ Night | 🗓️ Friday, June 17, 2026 AD | 📍 Bar - Cellar ]\nPresent: Mair, Kael\n',
    'the header patch carries the repaired header',
  );

  const before = events.length;
  onLiveDelta(ctx, deps, 'u1', 'c1', 'more body text\n', signal, sink);
  await flush();
  assert(
    events.slice(before).filter((e) => e.kind === 'status' && e.region === 'header').length === 0,
    'the header check fires exactly once per turn',
  );
}

// ---------------------------------------------------------------------------
// 2. Header: the 400-char zero-newline cap fires (and only then), inserting at position 0
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const llm = createScriptedLlm(['[ Night | Bar ]\nPresent: Mair\n']);
  const deps = { db, llm, settings: createFakeSettings(), chats: {} };
  const ctx = await createLiveCleanupContext(deps, 'u1', 'c1');
  const events = [];
  const sink = (e) => events.push(e);
  const signal = new AbortController().signal;
  const chunk = 'a'.repeat(50);

  for (let i = 0; i < 7; i++) {
    onLiveDelta(ctx, deps, 'u1', 'c1', chunk, signal, sink);
  }
  await flush();
  assert(
    events.filter((e) => e.kind === 'status' && e.region === 'header').length === 0,
    'the header check does not fire before 400 characters',
  );
  assert(llm.calls.length === 0, 'no header repair before the cap');

  onLiveDelta(ctx, deps, 'u1', 'c1', chunk, signal, sink); // the 400th character
  await flush();
  const statuses = events.filter((e) => e.kind === 'status' && e.region === 'header').map((e) => e.state);
  assert(statuses.includes('in-flux'), 'the 400-char zero-newline cap fires the header check');
  assert(statuses.includes('deployed'), 'the cap-fired repair resolves to deployed');
  const patch = events.find((e) => e.kind === 'patch' && e.region === 'header');
  assert(!!patch && patch.start === 0 && patch.end === 0, 'a missing-header repair inserts at position 0');
}

// ---------------------------------------------------------------------------
// 3. Header: at 400 chars with exactly one newline, the check fires only on 'missing' —
//    a 'malformed' prefix (a genuine header may still be streaming) waits for the second newline
// ---------------------------------------------------------------------------
{
  // Case A: one newline, no header-in-progress evidence ('missing') → fires at the cap.
  const poolA = createFakePool();
  const dbA = createPostgresClient(poolA);
  const llmA = createScriptedLlm(['HDR\n']);
  const depsA = { db: dbA, llm: llmA, settings: createFakeSettings(), chats: {} };
  const ctxA = await createLiveCleanupContext(depsA, 'u1', 'c1');
  const eventsA = [];
  const sinkA = (e) => eventsA.push(e);
  const signalA = new AbortController().signal;
  onLiveDelta(ctxA, depsA, 'u1', 'c1', `${'x'.repeat(50)}\n`, signalA, sinkA);
  for (let i = 0; i < 6; i++) onLiveDelta(ctxA, depsA, 'u1', 'c1', 'x'.repeat(50), signalA, sinkA);
  await flush();
  assert(
    eventsA.filter((e) => e.kind === 'status' && e.region === 'header').length === 0,
    'missing-with-one-newline does not fire before 400 chars',
  );
  onLiveDelta(ctxA, depsA, 'u1', 'c1', 'x'.repeat(50), signalA, sinkA); // crosses 400 with one newline
  await flush();
  assert(
    eventsA.some((e) => e.kind === 'status' && e.region === 'header' && e.state === 'in-flux'),
    "with one newline at the cap, 'missing' fires the header check",
  );

  // Case B: one newline, bracket-opened first line ('malformed') → the cap does NOT fire; the
  // second newline does.
  const poolB = createFakePool();
  const dbB = createPostgresClient(poolB);
  const llmB = createScriptedLlm(['HDR\n']);
  const depsB = { db: dbB, llm: llmB, settings: createFakeSettings(), chats: {} };
  const ctxB = await createLiveCleanupContext(depsB, 'u1', 'c1');
  const eventsB = [];
  const sinkB = (e) => eventsB.push(e);
  const signalB = new AbortController().signal;
  const malformedChunk = '[ x y '.repeat(10);
  onLiveDelta(ctxB, depsB, 'u1', 'c1', `${malformedChunk}\n`, signalB, sinkB);
  for (let i = 0; i < 7; i++) onLiveDelta(ctxB, depsB, 'u1', 'c1', malformedChunk, signalB, sinkB);
  await flush();
  assert(
    eventsB.filter((e) => e.kind === 'status' && e.region === 'header').length === 0,
    "with one newline at the cap, 'malformed' does NOT fire (a genuine header may be streaming)",
  );
  assert(llmB.calls.length === 0, "no repair is dispatched on the 'malformed' one-newline cap");
  onLiveDelta(ctxB, depsB, 'u1', 'c1', '\n', signalB, sinkB); // the second newline
  await flush();
  assert(
    eventsB.some((e) => e.kind === 'status' && e.region === 'header' && e.state === 'in-flux'),
    "the 'malformed' prefix fires once the second newline lands",
  );
}

// ---------------------------------------------------------------------------
// 4. Body: a 'remove' rule patches its closed paragraph immediately, no LLM call
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  addSlopRule(pool, { pattern: '"[^"]*gosh[^"]*"', action: 'remove', replacement: '' });
  const db = createPostgresClient(pool);
  const llm = createScriptedLlm([]);
  const deps = { db, llm, settings: createFakeSettings(), chats: {} };
  const ctx = await createLiveCleanupContext(deps, 'u1', 'c1');
  const events = [];
  const sink = (e) => events.push(e);
  const signal = new AbortController().signal;

  onLiveDelta(ctx, deps, 'u1', 'c1', VALID_HEADER, signal, sink);
  await flush();
  assert(llm.calls.length === 0, 'a valid header fires no LLM call');

  onLiveDelta(ctx, deps, 'u1', 'c1', 'She said "gosh." and shrugged.\n', signal, sink);
  await flush();
  const patch = events.find((e) => e.kind === 'patch' && e.region === 'body');
  assert(!!patch, 'the remove rule emits a body patch frame');
  assert(patch.start === VALID_HEADER.length, 'the remove patch starts at its closed paragraph');
  assert(patch.replacement === 'She said  and shrugged.', 'the remove patch drops the matched text');
  assert(llm.calls.length === 0, 'a remove match patches with no LLM call');
  assert(ctx.composed.includes('She said  and shrugged.'), 'the composed buffer carries the patched paragraph');
  assert(
    events.some((e) => e.kind === 'status' && e.region === 'body' && e.state === 'deployed'),
    'the body pill lands on deployed after a remove patch',
  );
}

// ---------------------------------------------------------------------------
// 5. Body: a 'replace-paragraph' repair's patch span is re-located in the composed buffer when
//    an earlier patch (the header repair, resolved first) has shifted offsets
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  addSlopRule(pool, { pattern: 'slopword', action: 'replace-paragraph', flags: 'i', set_name: 's1', position: 0 });
  const db = createPostgresClient(pool);
  const llm = createDeferredLlm();
  const deps = { db, llm, settings: createFakeSettings(), chats: {} };
  const ctx = await createLiveCleanupContext(deps, 'u1', 'c1');
  const events = [];
  const sink = (e) => events.push(e);
  const signal = new AbortController().signal;

  onLiveDelta(ctx, deps, 'u1', 'c1', `${MALFORMED_HEADER_LINE1}\n`, signal, sink);
  onLiveDelta(ctx, deps, 'u1', 'c1', 'Present: Nobody\n', signal, sink);
  await flush();
  assert(llm.calls.length === 1, 'the malformed header dispatched one repair');

  onLiveDelta(ctx, deps, 'u1', 'c1', 'First slopword paragraph.\n', signal, sink);
  await flush();
  assert(llm.calls.length === 2, 'the matching paragraph dispatched its repair');
  assert(
    events.some((e) => e.kind === 'status' && e.region === 'body' && e.state === 'in-flux'),
    'the body pill is in-flux while the paragraph repair is out',
  );

  // Resolve the header repair first — replacing [0, 34) with a 29-char header shifts every span
  // after it up by 5. The paragraph's patch span must be re-computed at emission time.
  llm.respond(0, '[ Night | Bar ]\nPresent: Mair\n');
  await flush();
  assert(events.some((e) => e.kind === 'patch' && e.region === 'header'), 'the header repair emitted its patch');

  llm.respond(1, 'Fixed paragraph.');
  await flush();
  const bodyPatch = events.find((e) => e.kind === 'patch' && e.region === 'body');
  const headerPatch = events.find((e) => e.kind === 'patch' && e.region === 'header');
  assert(!!bodyPatch, 'the paragraph repair emitted a patch');
  // The header replacement is shorter than the malformed span it replaced, so the paragraph's
  // start shifts up by (replacement.length - span.length); the paragraph's own '\n' follows the
  // repaired header directly. The patch must be emitted at the SHIFTED position, not the
  // dispatch-time one.
  const shiftedStart = headerPatch.replacement.length + 1;
  assert(
    bodyPatch.start === shiftedStart && bodyPatch.end === shiftedStart + 'First slopword paragraph.'.length,
    'the paragraph patch is re-located past the shifted header',
  );
  assert(
    ctx.composed === '[ Night | Bar ]\nPresent: Mair\n\nFixed paragraph.\n',
    'the composed buffer stays consistent after both patches',
  );
  assert(
    events.some((e) => e.kind === 'status' && e.region === 'body' && e.state === 'deployed'),
    'the body pill lands on deployed after the re-located repair',
  );
}

// ---------------------------------------------------------------------------
// 6. The final unterminated paragraph is only caught by finishStream's tail body pass
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  addSlopRule(pool, { pattern: 'slopword', action: 'replace-paragraph', flags: 'i', set_name: 's1', position: 0 });
  const db = createPostgresClient(pool);
  // Two repairs fire in finishStream here: the tail paragraph and the missing footer.
  const llm = createScriptedLlm(['Fixed tail.', '<details><summary>▸</summary>\nthoughts\n</details>']);
  const deps = { db, llm, settings: createFakeSettings(), chats: {} };
  const ctx = await createLiveCleanupContext(deps, 'u1', 'c1');
  const events = [];
  const sink = (e) => events.push(e);
  const signal = new AbortController().signal;

  onLiveDelta(ctx, deps, 'u1', 'c1', VALID_HEADER, signal, sink);
  onLiveDelta(ctx, deps, 'u1', 'c1', 'clean body paragraph.\n', signal, sink);
  await flush();
  assert(llm.calls.length === 0, 'clean closed paragraphs dispatch no repairs');

  onLiveDelta(ctx, deps, 'u1', 'c1', 'final slopword tail', signal, sink); // no trailing newline
  await flush();
  assert(llm.calls.length === 0, 'the unterminated final paragraph is not dispatched live');
  assert(!events.some((e) => e.kind === 'patch' && e.region === 'body'), 'no body patch before finishStream');

  const result = await finishStream(ctx, deps, ctx.composed, { userId: 'u1', chatId: 'c1', signal, onCleanupEvent: sink });
  const tailPatch = events.find((e) => e.kind === 'patch' && e.region === 'body');
  assert(!!tailPatch && tailPatch.replacement === 'Fixed tail.', "finishStream's tail pass dispatches the final paragraph");
  const tailStart = VALID_HEADER.length + 'clean body paragraph.\n'.length;
  assert(tailPatch.start === tailStart && tailPatch.end === tailStart + 'final slopword tail'.length, 'the tail patch spans the unterminated final paragraph');
  assert(result.composed.startsWith(`${VALID_HEADER}clean body paragraph.\nFixed tail.`), 'the composed text reflects the tail repair');
  assert(result.outcomes.find((o) => o.region === 'body')?.changed === true, 'the body outcome reports the tail repair as changed');
}

// ---------------------------------------------------------------------------
// 7. An 'llm'-action rule is never dispatched until finishStream (whole-message rewrite)
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  addSlopRule(pool, { pattern: 'terrible writing', action: 'llm', flags: 'i', set_name: 's1', position: 0 });
  const db = createPostgresClient(pool);
  const llm = createScriptedLlm(['<REWRITTEN WHOLE MESSAGE>']);
  const deps = { db, llm, settings: createFakeSettings(), chats: {} };
  const ctx = await createLiveCleanupContext(deps, 'u1', 'c1');
  const events = [];
  const sink = (e) => events.push(e);
  const signal = new AbortController().signal;

  onLiveDelta(ctx, deps, 'u1', 'c1', VALID_HEADER, signal, sink);
  onLiveDelta(ctx, deps, 'u1', 'c1', 'this is terrible writing in a paragraph.\n', signal, sink);
  onLiveDelta(ctx, deps, 'u1', 'c1', VALID_FOOTER, signal, sink);
  await flush();
  assert(llm.calls.length === 0, "an 'llm'-action rule is never dispatched live");

  const result = await finishStream(ctx, deps, ctx.composed, { userId: 'u1', chatId: 'c1', signal, onCleanupEvent: sink });
  assert(llm.calls.length === 1, "the 'llm' rule dispatches exactly once, in finishStream");
  const patch = events.find((e) => e.kind === 'patch' && e.region === 'body');
  assert(!!patch && patch.start === 0 && patch.replacement === '<REWRITTEN WHOLE MESSAGE>', 'the llm rewrite patches the whole message');
  assert(result.composed === '<REWRITTEN WHOLE MESSAGE>', 'the llm rewrite replaces the composed text');
  assert(result.outcomes.find((o) => o.region === 'body')?.changed === true, 'the body outcome reports the rewrite as changed');
}

// ---------------------------------------------------------------------------
// 8. Footer inspection only runs in finishStream; a missing footer is repaired there
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const llm = createScriptedLlm(['<details><summary>▸</summary>\nthoughts\n</details>']);
  const deps = { db, llm, settings: createFakeSettings(), chats: {} };
  const ctx = await createLiveCleanupContext(deps, 'u1', 'c1');
  const events = [];
  const sink = (e) => events.push(e);
  const signal = new AbortController().signal;

  onLiveDelta(ctx, deps, 'u1', 'c1', VALID_HEADER, signal, sink);
  onLiveDelta(ctx, deps, 'u1', 'c1', 'a clean body paragraph without a footer.\n', signal, sink);
  await flush();
  assert(llm.calls.length === 0, 'footer inspection does not run during the stream');
  assert(!events.some((e) => e.kind === 'status' && e.region === 'footer'), 'no footer events before finishStream');

  const result = await finishStream(ctx, deps, ctx.composed, { userId: 'u1', chatId: 'c1', signal, onCleanupEvent: sink });
  assert(llm.calls.length === 1, 'the footer repair dispatches once, in finishStream');
  assert(
    events.some((e) => e.kind === 'status' && e.region === 'footer' && e.state === 'in-flux'),
    'the footer pill is in-flux while the repair is out',
  );
  assert(
    events.some((e) => e.kind === 'status' && e.region === 'footer' && e.state === 'deployed'),
    'the footer pill lands on deployed after the repair',
  );
  const patch = events.find((e) => e.kind === 'patch' && e.region === 'footer');
  const expectedEnd = ctx.composed.length - '<details><summary>▸</summary>\nthoughts\n</details>'.length;
  assert(!!patch && patch.start === expectedEnd && patch.end === expectedEnd, 'the missing footer appends at the end of the text');
  assert(
    result.composed === `${VALID_HEADER}a clean body paragraph without a footer.\n<details><summary>▸</summary>\nthoughts\n</details>`,
    'the composed text ends with the repaired footer',
  );
  assert(result.outcomes.find((o) => o.region === 'footer')?.changed === true, 'the footer outcome reports the repair as changed');
}

// ---------------------------------------------------------------------------
// 9. A whitespace-only buffer never fires a spurious header repair; the blank-retry reset
//    clears the buffer + region state so a retry starts fresh
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const llm = createScriptedLlm([]);
  const deps = { db, llm, settings: createFakeSettings(), chats: {} };
  const ctx = await createLiveCleanupContext(deps, 'u1', 'c1');
  const events = [];
  const sink = (e) => events.push(e);
  const signal = new AbortController().signal;

  // 450 whitespace chars with zero newlines would trip the 400-char cap — the whitespace guard
  // must hold (a blank first attempt can't dispatch a repair on nothing).
  for (let i = 0; i < 9; i++) onLiveDelta(ctx, deps, 'u1', 'c1', ' '.repeat(50), signal, sink);
  await flush();
  assert(llm.calls.length === 0, 'a whitespace-only buffer never fires a header repair');
  assert(!events.some((e) => e.kind === 'status' && e.region === 'header'), 'no header status events for a whitespace buffer');

  resetLiveCleanupContext(ctx);
  assert(ctx.composed === '' && ctx.bodyCursor === 0 && ctx.headerVerdict === 'pending', 'the reset clears the buffer and verdict');
  assert(
    ctx.headerState === 'not-called' && ctx.bodyState === 'not-called' && ctx.footerState === 'not-called',
    'the reset clears the region states',
  );

  onLiveDelta(ctx, deps, 'u1', 'c1', VALID_HEADER, signal, sink);
  await flush();
  assert(
    events.some((e) => e.kind === 'status' && e.region === 'header' && e.state === 'not-called'),
    'a valid header after the reset is judged ok (not-called)',
  );
}

// ---------------------------------------------------------------------------
// 10. Abort mid-repair: the in-flight call is cancelled and no deployed/flagged transition is
//     reported for that region; finishStream then throws AbortError to the caller
// ---------------------------------------------------------------------------
{
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const llm = createDeferredLlm();
  const deps = { db, llm, settings: createFakeSettings(), chats: {} };
  const ctx = await createLiveCleanupContext(deps, 'u1', 'c1');
  const events = [];
  const sink = (e) => events.push(e);
  const controller = new AbortController();

  onLiveDelta(ctx, deps, 'u1', 'c1', `${MALFORMED_HEADER_LINE1}\n`, controller.signal, sink);
  onLiveDelta(ctx, deps, 'u1', 'c1', 'Present: Nobody\n', controller.signal, sink);
  await flush();
  assert(llm.calls.length === 1, 'the header repair dispatched');
  assert(
    events.some((e) => e.kind === 'status' && e.region === 'header' && e.state === 'in-flux'),
    'the header pill is in-flux while the repair is out',
  );

  controller.abort();
  llm.respond(0, 'ignored'); // the upstream call resolves anyway — the abort must suppress it
  await flush();
  assert(
    !events.some((e) => e.kind === 'status' && e.region === 'header' && (e.state === 'deployed' || e.state === 'flagged')),
    'an aborted repair reports no deployed/flagged transition',
  );
  assert(ctx.headerState === 'in-flux', 'the header region stays in-flux after an aborted repair');

  let threwAbort = false;
  try {
    await finishStream(ctx, deps, ctx.composed, { userId: 'u1', chatId: 'c1', signal: controller.signal, onCleanupEvent: sink });
  } catch (err) {
    threwAbort = err instanceof Error && err.name === 'AbortError';
  }
  assert(threwAbort, 'finishStream throws AbortError when the signal is aborted');
}

if (process.exitCode) {
  console.error('live cleanup verification FAILED');
} else {
  console.log('live cleanup verification passed');
}
