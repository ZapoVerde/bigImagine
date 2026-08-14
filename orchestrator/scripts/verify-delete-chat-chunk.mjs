// Proves io/chatMemory/deleteChatChunk.ts — the single-row chat_chunks deletion primitive from
// docs/plans/chunk-lead-in-context-plan.md. The wrapper runs one transaction's worth of
// statements against the caller's session (relink → renumber → delete, in that exact order,
// under the per-chat advisory lock), so a fake session-shaped object can drive it without any
// Postgres. What's pinned here is the statement sequence and its effect on an in-memory
// chain: a middle delete splices the child up onto the target's parent and shifts every
// higher ordinal down by one (contiguous, no gaps); a head delete makes the former child the
// new head; a tail delete relinks/renumbers nothing; a repeated delete on the same chunkId is
// a silent no-op. The advisory lock is DB-side serialization (pg_advisory_xact_lock is
// transaction-scoped), so the fake only pins that it is the FIRST statement issued — the same
// per-chat lock every other chat_chunks writer takes, which is what makes a delete serialize
// against a concurrent sync/eager/resize pass for the same chat.
import { deleteChatChunk } from '../dist/io/chatMemory/deleteChatChunk.js';

const USER = 'user-1';
const CHAT = 'chat-1';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// Stateful fake: rows are { chunk_id, user_id, chat_id, ordinal, parent_chunk_id }; the query
// handlers mirror deleteChatChunk's five statements exactly (lock, target read, child read,
// relink, renumber-with-returning, delete). Returns rows in the DbSession T[] shape the
// wrapper reads (target[0], children[0], renumbered.length).
function createChain(rows) {
  const log = [];
  const state = { rows };
  const session = {
    async query(sql, params = []) {
      log.push(sql);
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('select chunk_id, ordinal, parent_chunk_id') && sql.includes('from chat_chunks')) {
        const [, , chunkId] = params;
        return rows.filter((r) => r.chunk_id === chunkId);
      }
      if (sql.includes('select chunk_id from chat_chunks where parent_chunk_id = $1')) {
        return rows.filter((r) => r.parent_chunk_id === params[0]).map((r) => ({ chunk_id: r.chunk_id }));
      }
      if (sql.includes('update chat_chunks set parent_chunk_id = $1')) {
        const [newParent, chunkId] = params;
        const r = rows.find((x) => x.chunk_id === chunkId);
        r.parent_chunk_id = newParent;
        return [];
      }
      if (sql.includes('set ordinal = ordinal - 1')) {
        const [chatId, ord] = params;
        const affected = rows.filter((r) => r.chat_id === chatId && r.ordinal > ord);
        for (const r of affected) r.ordinal -= 1;
        return affected.map((r) => ({ chunk_id: r.chunk_id }));
      }
      if (sql.includes('delete from chat_chunks where chunk_id = $1')) {
        const idx = rows.findIndex((r) => r.chunk_id === params[0]);
        if (idx >= 0) rows.splice(idx, 1);
        return [];
      }
      throw new Error(`fake session got an unexpected query: ${sql}`);
    },
  };
  return { state, log, session };
}

function makeChainRow(id, ordinal, parentChunkId) {
  return { chunk_id: id, user_id: USER, chat_id: CHAT, ordinal, parent_chunk_id: parentChunkId };
}

// --- Middle deletion: child relinks to the target's own parent; higher ordinals shift down by
// exactly one; the row disappears — the chain stays contiguous. ---
{
  const chain = createChain([
    makeChainRow('a', 0, null),
    makeChainRow('b', 1, 'a'),
    makeChainRow('c', 2, 'b'),
    makeChainRow('d', 3, 'c'),
  ]);
  await deleteChatChunk(chain.session, USER, CHAT, 'b');
  const rows = chain.state.rows.sort((x, y) => x.ordinal - y.ordinal);
  assert(rows.length === 3, 'a middle delete removes exactly the target row');
  assert(!rows.some((r) => r.chunk_id === 'b'), 'the deleted chunk is gone');
  assert(
    rows.map((r) => r.ordinal).join(',') === '0,1,2' && rows[1].chunk_id === 'c',
    'every higher ordinal shifts down by exactly one — the sequence stays contiguous (no gap)',
  );
  assert(
    rows[1].parent_chunk_id === 'a',
    "the deleted chunk's child relinks to the deleted chunk's own parent (spliced out of the chain)",
  );
  assert(rows[0].parent_chunk_id === null && rows[2].parent_chunk_id === 'c', 'the rest of the chain is untouched');
}

// --- Head deletion: the former child becomes the new head (parent_chunk_id → null); later
// ordinals still shift down. ---
{
  const chain = createChain([
    makeChainRow('a', 0, null),
    makeChainRow('b', 1, 'a'),
    makeChainRow('c', 2, 'b'),
  ]);
  await deleteChatChunk(chain.session, USER, CHAT, 'a');
  const rows = chain.state.rows.sort((x, y) => x.ordinal - y.ordinal);
  assert(rows.length === 2, 'a head delete removes exactly the head row');
  assert(rows[0].chunk_id === 'b' && rows[0].parent_chunk_id === null, "the former child becomes the new head (parent null)");
  assert(rows[0].ordinal === 0 && rows[1].ordinal === 1 && rows[1].parent_chunk_id === 'b', 'later ordinals shift down, chain intact');
}

// --- Tail deletion: no child to relink (the renumber still runs — it's unconditional — but
// shifts nothing, returning 0 rows, which the wrapper logs as renumbered: 0). ---
{
  const chain = createChain([
    makeChainRow('a', 0, null),
    makeChainRow('b', 1, 'a'),
  ]);
  await deleteChatChunk(chain.session, USER, CHAT, 'b');
  assert(chain.state.rows.length === 1 && chain.state.rows[0].chunk_id === 'a', 'a tail delete removes just the last row');
  assert(
    !chain.log.some((sql) => sql.includes('update chat_chunks set parent_chunk_id')),
    'a tail delete issues no relink — there is no child to splice up the chain',
  );
}

// --- Idempotence: deleting the same chunkId twice is a no-op the second time. ---
{
  const chain = createChain([makeChainRow('a', 0, null), makeChainRow('b', 1, 'a')]);
  await deleteChatChunk(chain.session, USER, CHAT, 'b');
  const logLenAfterFirst = chain.log.length;
  const rowsAfterFirst = chain.state.rows.length;
  await deleteChatChunk(chain.session, USER, CHAT, 'b');
  assert(
    chain.state.rows.length === rowsAfterFirst &&
      chain.log.length === logLenAfterFirst + 2 &&
      chain.log[logLenAfterFirst].includes('pg_advisory_xact_lock') &&
      chain.log[logLenAfterFirst + 1].includes('select chunk_id, ordinal, parent_chunk_id'),
    'a second delete on the same chunkId short-circuits after the lock + target read — no relink/renumber/delete, state unchanged',
  );
}

// --- Statement order + the advisory lock: the per-chat lock is the FIRST statement, and the
// relink precedes the renumber which precedes the delete (the plan's explicit order). ---
{
  const chain = createChain([
    makeChainRow('a', 0, null),
    makeChainRow('b', 1, 'a'),
    makeChainRow('c', 2, 'b'),
  ]);
  await deleteChatChunk(chain.session, USER, CHAT, 'b');
  const kinds = chain.log.map((sql) =>
    sql.includes('pg_advisory_xact_lock')
      ? 'lock'
      : sql.includes('select chunk_id, ordinal, parent_chunk_id')
        ? 'target'
        : sql.includes('select chunk_id from chat_chunks where parent_chunk_id')
          ? 'child'
          : sql.includes('update chat_chunks set parent_chunk_id')
            ? 'relink'
            : sql.includes('set ordinal = ordinal - 1')
              ? 'renumber'
              : sql.includes('delete from chat_chunks')
                ? 'delete'
                : '?',
  );
  assert(
    kinds[0] === 'lock' && kinds.indexOf('relink') < kinds.indexOf('renumber') && kinds.indexOf('renumber') < kinds.indexOf('delete'),
    'statement order: advisory lock first, then relink → renumber → delete, exactly as the plan specifies',
  );
}

console.log('\ndelete-chat-chunk verification passed');
if (process.exitCode) process.exit(process.exitCode);
