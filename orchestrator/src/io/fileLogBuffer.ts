/**
 * @file orchestrator/src/io/fileLogBuffer.ts
 * @stamp 2026-08-04
 * @architectural-role Stateful Owner — a factory whose each call owns exactly one ring buffer and
 * one debounce timer for one destination file
 * @description
 * Extracted from logger.ts so a second log destination (io/clientLogSink.ts, browser-forwarded
 * logs) doesn't duplicate the same buffer/debounce/eviction logic under a different name. Buffers
 * structured entries rather than pre-formatted strings so consecutive-duplicate lines can collapse
 * into one `×N` entry instead of repeating — bi_principles.md doesn't require this, but a chatty
 * loop (a tool retried in a hot path, a flaky provider logging the same warning every round)
 * shouldn't burn ring-buffer slots on identical noise.
 *
 * Deliberately does not decide *when* to flush immediately vs debounce — that's the caller's
 * call (logger.ts flushes ERROR immediately; a different caller could choose differently), this
 * module just executes whichever `write(..., immediate)` it's told.
 *
 * @api-declaration
 * createFileLogBuffer({filePath, maxLines, echoToStdout}) — returns {write, flush}. write(level,
 *   message, meta, tag, immediate) appends or collapses into the last entry if it's an exact
 *   repeat, then flushes now or on a 1s debounce. flush() forces a write to disk immediately.
 *
 * @contract
 *   assertions:
 *     purity:          impure (filesystem, optionally stdout)
 *     state_ownership: [buffer, debounce timer — one instance per factory call]
 *     external_io:     [filesystem]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const DEBOUNCE_MS = 1000;

interface BufferEntry {
  level: string;
  message: string;
  metaStr: string;
  tag: string;
  firstTs: string;
  lastTs: string;
  count: number;
}

export interface FileLogBuffer {
  write(level: string, message: string, metaStr: string, tag: string, immediate: boolean): void;
  flush(): void;
}

function formatEntry(e: BufferEntry): string {
  const tagStr = e.tag ? ` [${e.tag}]` : '';
  if (e.count === 1) {
    return `[${e.firstTs}] [${e.level}]${tagStr} ${e.message}${e.metaStr}`;
  }
  return `[${e.firstTs} - ${e.lastTs}] [${e.level}]${tagStr} ${e.message}${e.metaStr} ×${e.count}`;
}

export function createFileLogBuffer(opts: { filePath: string; maxLines: number; echoToStdout: boolean }): FileLogBuffer {
  const { filePath, maxLines, echoToStdout } = opts;
  let buffer: BufferEntry[] = [];
  let flushTimer: NodeJS.Timeout | undefined;

  function ensureLogDir(): void {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  function flush(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (buffer.length === 0) return;
    ensureLogDir();
    writeFileSync(filePath, buffer.map(formatEntry).join('\n') + '\n');
  }

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, DEBOUNCE_MS);
  }

  function write(level: string, message: string, metaStr: string, tag: string, immediate: boolean): void {
    if (echoToStdout) {
      const line = formatEntry({ level, message, metaStr, tag, firstTs: new Date().toISOString(), lastTs: '', count: 1 });
      (level === 'ERROR' ? console.error : console.log)(line);
    }

    const now = new Date().toISOString();
    const last = buffer[buffer.length - 1];
    if (last && last.level === level && last.tag === tag && last.message === message && last.metaStr === metaStr) {
      last.count += 1;
      last.lastTs = now;
    } else {
      buffer.push({ level, message, metaStr, tag, firstTs: now, lastTs: now, count: 1 });
      if (buffer.length > maxLines) {
        buffer = buffer.slice(buffer.length - maxLines);
      }
    }

    if (immediate) {
      flush();
    } else {
      scheduleFlush();
    }
  }

  return { write, flush };
}
