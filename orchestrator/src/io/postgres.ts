/**
 * @file orchestrator/src/io/postgres.ts
 * @stamp 2026-07-21
 * @architectural-role IO Wrapper — Postgres access, scoped per request
 * @description
 * The only module allowed to open a database connection. Every query runs inside
 * withUserScope(userId, fn): a transaction that sets app.current_user_id via set_config(...,
 * true) before fn runs, so the RLS policies from db/migrations/0002_schema.sql (which read
 * app_current_user_id()) enforce themselves against whatever this module was told the request's
 * user is — never against anything a query or its caller claims about itself
 * (bb_principles.md §4). set_config's value is passed as a bound parameter, not interpolated,
 * so a hostile userId can't inject SQL through the scoping call itself.
 *
 * Callers only ever see DbSession (query-only) inside the callback — never the pool or a raw
 * client — so nothing downstream can open a second, differently-scoped connection mid-request.
 *
 * @api-declaration
 * createPostgresClient(pool) — pool only needs a `connect()` returning a pg-Client-shaped
 *   object; production code passes a real pg.Pool, tests pass a fake satisfying the same shape
 * PostgresClient.withUserScope(userId, fn) — runs fn(session) inside a scoped transaction,
 *   committing on success and rolling back if fn throws
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
}

export interface PoolClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

export interface Pool {
  connect(): Promise<PoolClient>;
}

export function createPostgresClient(pool: Pool): PostgresClient {
  return {
    async withUserScope<T>(userId: string, fn: (session: DbSession) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("select set_config('app.current_user_id', $1, true)", [userId]);

        const session: DbSession = {
          query: async <R>(sql: string, params?: unknown[]) => {
            const result = await client.query(sql, params);
            return result.rows as R[];
          },
        };

        const value = await fn(session);
        await client.query('COMMIT');
        return value;
      } catch (err) {
        await client.query('ROLLBACK').catch((rollbackErr) => {
          log.error('rollback failed after an earlier error', rollbackErr);
        });
        log.error(`withUserScope failed for user ${userId}`, err);
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
