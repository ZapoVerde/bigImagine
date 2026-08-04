/**
 * @file orchestrator/src/io/clientLogSink.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — receives browser-forwarded log batches and writes them to a
 * bounded local file
 * @description
 * Server-side counterpart to frontend/src/lib/browserLogger.ts. Reuses io/fileLogBuffer.ts (the
 * same ring-buffer/dedup/debounce engine io/logger.ts owns for the server's own log) pointed at a
 * second file, so browser noise never dilutes the server log's own MAX_LINES budget.
 *
 * Validation here is defensive rather than strict: a malformed individual entry (missing message,
 * unrecognized level) is dropped or coerced in isolation — it never fails the whole batch, since
 * the request that sent it may be reporting the very error that made its own state inconsistent.
 *
 * @api-declaration
 * recordClientLogBatch(entries, meta) — writes each valid entry as one line tagged
 *   `[sess:xxxxxxxx]` (the browser session id), best-effort `userId` attribution from meta.
 *   Synchronous, never throws.
 *
 * @contract
 *   assertions:
 *     purity:          impure (filesystem)
 *     state_ownership: [one fileLogBuffer instance]
 *     external_io:     [filesystem]
 */

import { createFileLogBuffer } from './fileLogBuffer.js';

const LOG_FILE = process.env.BIGBRAIN_CLIENT_LOG_FILE ?? './logs/frontend.log';
const MAX_LINES = Number(process.env.BIGBRAIN_CLIENT_LOG_MAX_LINES ?? 2000);

const buffer = createFileLogBuffer({ filePath: LOG_FILE, maxLines: MAX_LINES, echoToStdout: false });

const VALID_LEVELS = new Set(['LOG', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'JS_ERROR', 'UNHANDLED', 'NET_ERR']);

export interface ClientLogEntry {
  level?: unknown;
  message?: unknown;
  meta?: unknown;
  session?: unknown;
  ts?: unknown;
}

function coerceLevel(level: unknown): string {
  return typeof level === 'string' && VALID_LEVELS.has(level) ? level : 'LOG';
}

function serializeMeta(meta: unknown): string {
  if (meta === undefined || meta === null) return '';
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ` ${String(meta)}`;
  }
}

export function recordClientLogBatch(entries: ClientLogEntry[], meta: { userId?: string }): void {
  for (const entry of entries) {
    if (typeof entry?.message !== 'string' || entry.message.length === 0) continue;

    const level = coerceLevel(entry.level);
    const session = typeof entry.session === 'string' && entry.session.length > 0 ? entry.session : 'unknown';
    const tag = meta.userId ? `sess:${session} user:${meta.userId}` : `sess:${session}`;
    const immediate = level === 'ERROR' || level === 'JS_ERROR' || level === 'UNHANDLED';

    buffer.write(level, entry.message, serializeMeta(entry.meta), tag, immediate);
  }
}
