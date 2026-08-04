/**
 * @file orchestrator/src/io/logger.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — writes structured log lines to a bounded local file
 * @description
 * Adapted from SillyTavern-Loggeryze's server-side pattern (debounced flush on info-level
 * noise, immediate flush on errors, a capped ring buffer overwritten on each flush instead of
 * size/date-based rotation — nothing to configure, the file just never grows past MAX_LINES).
 * Deliberately diverges from that source in two ways: it's an explicit module other code
 * imports and calls, not a monkey-patch of the global `console` (bi_principles.md §8 keeps IO
 * Wrappers as ordinary called modules, not ambient side effects) — and every line can carry a
 * request id via AsyncLocalStorage, which Loggeryze's own server log notably lacks, and which
 * matters here because the orchestrator juggles concurrent multi-user requests.
 *
 * Buffering/dedup/eviction is delegated to io/fileLogBuffer.ts (shared with io/clientLogSink.ts's
 * browser-forwarded log) — this file owns only what's specific to the *server* log: the
 * request-id tag, the uncaught-exception/rejection handlers, and session/restart tracking.
 *
 * Session/restart tracking (ported from Loggeryze, which uses the identical mechanism): a random
 * session id and a persistent restart counter, read from and written back to logs/session.json
 * at module load, then logged as an immediate-flush banner line. Filesystem-only, no DB read —
 * this module is wired up (including the uncaughtException handler) before anything has proven
 * Postgres is reachable, and a restart counter that itself depended on the database would be
 * useless for diagnosing exactly the kind of crash-loop it exists to help diagnose.
 *
 * Every call also prints to stdout, so `docker logs` / Dockge's console tail still shows
 * everything live — the file exists so history survives past the console's scrollback.
 *
 * @api-declaration
 * log.debug/info/warn/error(message, meta?) — write one line; error() flushes immediately,
 *   the others are debounced (1s)
 * runWithRequestId(requestId, fn) — every log call made during fn (including in awaited async
 *   work it kicks off) is tagged with requestId
 *
 * @contract
 *   assertions:
 *     purity:          impure (filesystem, stdout, process exit on fatal error)
 *     state_ownership: [session id, restart counter]
 *     external_io:     [filesystem]
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createFileLogBuffer } from './fileLogBuffer.js';

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_FILE = process.env.BIGBRAIN_LOG_FILE ?? './logs/orchestrator.log';
const MAX_LINES = Number(process.env.BIGBRAIN_LOG_MAX_LINES ?? 2000);
const SESSION_FILE = join(dirname(LOG_FILE), 'session.json');

const requestContext = new AsyncLocalStorage<{ requestId: string }>();

const buffer = createFileLogBuffer({ filePath: LOG_FILE, maxLines: MAX_LINES, echoToStdout: true });

function serializeMeta(meta: unknown): string {
  if (meta === undefined) return '';
  if (meta instanceof Error) return ` ${meta.stack ?? meta.message}`;
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ` ${String(meta)}`;
  }
}

function write(level: Level, message: string, meta: unknown, immediate: boolean): void {
  const requestId = requestContext.getStore()?.requestId ?? '';
  buffer.write(level, message, serializeMeta(meta), requestId, immediate);
}

export const log = {
  debug: (message: string, meta?: unknown) => write('DEBUG', message, meta, false),
  info: (message: string, meta?: unknown) => write('INFO', message, meta, false),
  warn: (message: string, meta?: unknown) => write('WARN', message, meta, false),
  error: (message: string, meta?: unknown) => write('ERROR', message, meta, true),
};

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId }, fn);
}

function recordSessionAndAnnounce(): void {
  interface SessionState {
    session: string;
    restart: number;
    startedAt: string;
  }
  let prior: SessionState | undefined;
  try {
    if (existsSync(SESSION_FILE)) {
      prior = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as SessionState;
    }
  } catch {
    // Corrupt or unreadable — treat as no prior session rather than crash boot over a stats file.
  }

  const state: SessionState = {
    session: randomUUID().slice(0, 8),
    restart: (prior?.restart ?? 0) + 1,
    startedAt: new Date().toISOString(),
  };

  try {
    mkdirSync(dirname(SESSION_FILE), { recursive: true });
    writeFileSync(SESSION_FILE, JSON.stringify(state));
  } catch (err) {
    log.warn('failed to persist session.json', err);
  }

  log.info(`===== orchestrator session #${state.restart} | ${state.startedAt} | session: ${state.session} =====`);
  buffer.flush();
}

recordSessionAndAnnounce();

// Fatal-path logging: same reasoning as Loggeryze's immediate-flush-on-error, but this process
// is expected to be the only thing running (unlike a plugin inside a long-lived ST server), so
// an uncaught exception logs then exits rather than leaving the process limping in an unknown
// state.
process.on('uncaughtException', (err) => {
  log.error('uncaughtException', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', reason);
});
