/**
 * @file frontend/src/lib/browserLogger.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — captures browser console/error/fetch activity and forwards it
 * to the orchestrator's POST /v1/client-logs (io/clientLogSink.ts)
 * @description
 * Server-side counterpart is orchestrator/src/io/clientLogSink.ts. Installed once, as a
 * side-effect import at the very top of main.tsx, before the app mounts — active before
 * App.tsx's own mount-time whoami() call, so a crash during initial mount is still captured.
 *
 * Deliberate deviation from io/logger.ts's no-monkeypatch stance: window.onerror,
 * unhandledrejection, and a global fetch failure have no explicit-import alternative — they're
 * only observable via global hooks, unlike every server-side console.* call, which is a
 * traceable import. Patching is the only mechanism this capture surface has.
 *
 * Safe-patching discipline: original console/fetch references are saved before patching; every
 * patched implementation calls the original first (real devtools output is untouched, zero
 * recursion risk); every hook body is wrapped in try/catch so a bug here can never break the
 * app; this module's own upload call uses the saved original fetch directly, never the patched
 * window.fetch — structurally impossible to self-trigger, no exclusion-list needed.
 *
 * @api-declaration
 * (side-effect only — no exports). Importing this module installs the hooks immediately.
 *
 * @contract
 *   assertions:
 *     purity:          impure (patches globals, network IO)
 *     state_ownership: [pending-entry buffer, debounce timer, saved original console/fetch
 *                       references, session id]
 *     external_io:     [browser console (pass-through), network (POST /v1/client-logs)]
 */

import { API_KEY_STORAGE_KEY } from '../api/authStorage';

const DEBOUNCE_MS = 1000;
const MAX_PENDING_ENTRIES = 200;

type ClientLogLevel = 'LOG' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'JS_ERROR' | 'UNHANDLED' | 'NET_ERR';

interface PendingEntry {
  level: ClientLogLevel;
  message: string;
  meta?: unknown;
  session: string;
  ts: string;
}

const session = crypto.randomUUID().slice(0, 8);
const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
  debug: console.debug.bind(console),
};
const originalFetch = window.fetch.bind(window);

let pending: PendingEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

function enqueue(level: ClientLogLevel, message: string, meta: unknown, immediate: boolean): void {
  pending.push({ level, message, meta, session, ts: new Date().toISOString() });
  if (pending.length > MAX_PENDING_ENTRIES) {
    pending = pending.slice(pending.length - MAX_PENDING_ENTRIES);
  }
  if (immediate) {
    flush();
  } else if (!flushTimer) {
    flushTimer = setTimeout(flush, DEBOUNCE_MS);
  }
}

function flush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (pending.length === 0) return;
  const entries = pending;
  pending = [];

  const apiKey = localStorage.getItem(API_KEY_STORAGE_KEY);
  originalFetch('/v1/client-logs', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ entries }),
  }).catch(() => {
    // Best-effort — a failed upload of log entries must never surface as a user-visible error.
  });
}

function installConsoleHooks(): void {
  (['log', 'warn', 'error', 'info', 'debug'] as const).forEach((method) => {
    const levelMap: Record<typeof method, ClientLogLevel> = {
      log: 'LOG',
      warn: 'WARN',
      error: 'ERROR',
      info: 'INFO',
      debug: 'DEBUG',
    };
    const level = levelMap[method];
    console[method] = (...args: unknown[]) => {
      originalConsole[method](...args);
      try {
        enqueue(level, formatArgs(args), undefined, level === 'ERROR');
      } catch {
        // Never let a logging failure disrupt the original console call above.
      }
    };
  });
}

function installErrorHooks(): void {
  window.addEventListener('error', (event) => {
    try {
      enqueue('JS_ERROR', event.message, { filename: event.filename, lineno: event.lineno, colno: event.colno }, true);
    } catch {
      // Swallow — this handler must never itself throw.
    }
  });

  window.addEventListener('unhandledrejection', (event) => {
    try {
      const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
      enqueue('UNHANDLED', reason, undefined, true);
    } catch {
      // Swallow — this handler must never itself throw.
    }
  });
}

function installFetchHook(): void {
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    try {
      const res = await originalFetch(...args);
      if (!res.ok) {
        const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : args[0].url;
        try {
          enqueue('NET_ERR', `${res.status} ${res.statusText} — ${url}`, undefined, false);
        } catch {
          // Swallow — logging failure must never affect the real response below.
        }
      }
      return res;
    } catch (err) {
      const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : args[0].url;
      try {
        enqueue('NET_ERR', `network failure — ${url}`, { error: err instanceof Error ? err.message : String(err) }, false);
      } catch {
        // Swallow — logging failure must never mask the original error being rethrown below.
      }
      throw err;
    }
  };
}

installConsoleHooks();
installErrorHooks();
installFetchHook();
enqueue('INFO', 'browser session start', undefined, true);
