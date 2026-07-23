/**
 * @file orchestrator/src/io/logger.ts
 * @stamp 2026-07-21
 * @architectural-role IO Wrapper — writes structured log lines to a bounded local file
 * @description
 * Adapted from SillyTavern-Loggeryze's server-side pattern (debounced flush on info-level
 * noise, immediate flush on errors, a capped ring buffer overwritten on each flush instead of
 * size/date-based rotation — nothing to configure, the file just never grows past MAX_LINES).
 * Deliberately diverges from that source in two ways: it's an explicit module other code
 * imports and calls, not a monkey-patch of the global `console` (bb_principles.md §8 keeps IO
 * Wrappers as ordinary called modules, not ambient side effects) — and every line can carry a
 * request id via AsyncLocalStorage, which Loggeryze's own server log notably lacks, and which
 * matters here because the orchestrator juggles concurrent multi-user requests.
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
 *     state_ownership: [in-memory line buffer, debounce timer]
 *     external_io:     [filesystem]
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_FILE = process.env.BIGBRAIN_LOG_FILE ?? './logs/orchestrator.log';
const MAX_LINES = Number(process.env.BIGBRAIN_LOG_MAX_LINES ?? 2000);
const DEBOUNCE_MS = 1000;

const requestContext = new AsyncLocalStorage<{ requestId: string }>();

let buffer: string[] = [];
let flushTimer: NodeJS.Timeout | undefined;

function ensureLogDir(): void {
  mkdirSync(dirname(LOG_FILE), { recursive: true });
}

function serializeMeta(meta: unknown): string {
  if (meta === undefined) return '';
  if (meta instanceof Error) return ` ${meta.stack ?? meta.message}`;
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ` ${String(meta)}`;
  }
}

function formatLine(level: Level, message: string, meta: unknown): string {
  const requestId = requestContext.getStore()?.requestId;
  const tag = requestId ? ` [${requestId}]` : '';
  return `[${new Date().toISOString()}] [${level}]${tag} ${message}${serializeMeta(meta)}`;
}

function flush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (buffer.length === 0) return;
  ensureLogDir();
  writeFileSync(LOG_FILE, buffer.join('\n') + '\n');
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, DEBOUNCE_MS);
}

function write(level: Level, message: string, meta: unknown, immediate: boolean): void {
  const line = formatLine(level, message, meta);
  (level === 'ERROR' ? console.error : console.log)(line);

  buffer.push(line);
  if (buffer.length > MAX_LINES) {
    buffer = buffer.slice(buffer.length - MAX_LINES);
  }

  if (immediate) {
    flush();
  } else {
    scheduleFlush();
  }
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
