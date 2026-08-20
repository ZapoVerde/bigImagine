/**
 * @file orchestrator/src/io/postgres.ts
 * @stamp 2026-07-24
 * @architectural-role IO Wrapper — Postgres access, scoped per request
 * @description
 * The only module allowed to open a database connection. Every user-facing query runs inside
 * withUserScope(userId, fn): a transaction that sets app.current_user_id via set_config(...,
 * true) before fn runs, so the RLS policies from db/migrations/0002_schema.sql (which read
 * app_current_user_id()) enforce themselves against whatever this module was told the request's
 * user is — never against anything a query or its caller claims about itself
 * (bb_principles.md §4). set_config's value is passed as a bound parameter, not interpolated,
 * so a hostile userId can't inject SQL through the scoping call itself.
 *
 * withSystemScope(fn) is the same transaction/rollback shape minus the set_config call, for
 * tables with no per-user meaning at all — currently only provider_credentials
 * (db/migrations/0008_provider_credentials.sql), which is exempt from RLS the same way `users`
 * itself is. Never use this for a user_id-scoped table; it does not set app.current_user_id, so
 * RLS policies that read it would silently see no scope at all rather than the caller's identity.
 *
 * Callers only ever see DbSession (query-only) inside the callback — never the pool or a raw
 * client — so nothing downstream can open a second, differently-scoped connection mid-request.
 *
 * @api-declaration
 * createPostgresClient(pool) — pool only needs a `connect()` returning a pg-Client-shaped
 *   object; production code passes a real pg.Pool, tests pass a fake satisfying the same shape
 * PostgresClient.withUserScope(userId, fn) — runs fn(session) inside a scoped transaction,
 *   committing on success and rolling back if fn throws
 * PostgresClient.withSystemScope(fn) — same, for tables with no user_id at all
 *
 * @contract
 *   assertions:
 *     purity:          impure (network I/O to Postgres)
 *     state_ownership: []
 *     external_io:     [Postgres]
 */

import { log } from './logger.js';

export interface DbSession {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface PostgresClient {
  withUserScope<T>(userId: string, fn: (session: DbSession) => Promise<T>): Promise<T>;
  withSystemScope<T>(fn: (session: DbSession) => Promise<T>): Promise<T>;
}

export interface PoolClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
  /** Real pg.PoolClient is an EventEmitter; a checked-out client's own connection errors (the
   *  server killing it server-side — e.g. idle_in_transaction_session_timeout firing while fn()
   *  awaits an LLM call with no query in flight) surface here, not through any pending query
   *  promise. Optional so every existing fake pool in the verify-*.mjs suites (none of which wire
   *  this up) still satisfies the shape untouched. */
  on?(event: 'error', listener: (err: Error) => void): void;
  /** Pairs with `on` above — pg's Pool hands back the same underlying Client across checkouts once
   *  it's released and reconnected, so a listener added in inTransaction and never removed
   *  accumulates one per checkout on that same object forever (observed as Node's own
   *  MaxListenersExceededWarning within the first few ticks of a real deploy, 2026-08-20). */
  off?(event: 'error', listener: (err: Error) => void): void;
}

export interface Pool {
  connect(): Promise<PoolClient>;
}

async function inTransaction<T>(
  pool: Pool,
  scopeLabel: string,
  setupScope: (client: PoolClient) => Promise<void>,
  fn: (session: DbSession) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  // Without this listener, a connection the server terminates while checked out (idle_in_transaction
  // timeout mid-LLM-call is the observed case, 2026-08-20 — 3 orchestrator crashes in 48h) throws an
  // uncaught exception and kills the whole process: node-postgres emits 'error' on the client itself
  // for a dead connection with no in-flight query to reject, and an EventEmitter with no 'error'
  // listener throws synchronously. Recording it here instead lets the client's next query (COMMIT,
  // or a query setupScope/fn already had in flight) fail normally and fall into the catch below.
  let connectionError: Error | null = null;
  const onConnectionError = (err: Error): void => {
    connectionError = err;
    log.error(`${scopeLabel}: connection error while checked out`, err);
  };
  client.on?.('error', onConnectionError);
  try {
    await client.query('BEGIN');
    await setupScope(client);

    const session: DbSession = {
      query: async <R>(sql: string, params?: unknown[]) => {
        const result = await client.query(sql, params);
        return result.rows as R[];
      },
    };

    const value = await fn(session);
    if (connectionError) throw connectionError as Error;
    await client.query('COMMIT');
    return value;
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr) => {
      log.error('rollback failed after an earlier error', rollbackErr);
    });
    log.error(`${scopeLabel} failed`, err);
    throw err;
  } finally {
    client.off?.('error', onConnectionError);
    client.release();
  }
}

export function createPostgresClient(pool: Pool): PostgresClient {
  return {
    withUserScope<T>(userId: string, fn: (session: DbSession) => Promise<T>): Promise<T> {
      return inTransaction(
        pool,
        `withUserScope(${userId})`,
        (client) => client.query("select set_config('app.current_user_id', $1, true)", [userId]).then(() => undefined),
        fn,
      );
    },

    withSystemScope<T>(fn: (session: DbSession) => Promise<T>): Promise<T> {
      return inTransaction(pool, 'withSystemScope', async () => undefined, fn);
    },
  };
}
