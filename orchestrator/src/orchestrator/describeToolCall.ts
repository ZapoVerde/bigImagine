/**
 * @file orchestrator/src/orchestrator/describeToolCall.ts
 * @stamp 2026-08-03
 * @architectural-role Pure Function module — turns one tool call into a short human-readable label
 * @description
 * turnStatus.ts (Stateful Owner) needs something to show the frontend while a turn is still
 * mid-flight across several tool rounds — this is the one place that decides what that label says.
 * Everywhere else (loop.ts, the status route, the frontend) just relays whatever it returns.
 *
 * @api-declaration
 * describeToolCall(name, args) — e.g. "Searching the web: dragons" or, for an unrecognized tool
 *   with no nameable argument, a humanized fallback like "Cancel timer"
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

const LABELS: Record<string, string> = {
  web_search: 'Searching the web',
  ingest_url: 'Reading a page',
  send_push_notification: 'Sending a notification',
};

// Argument keys worth naming, in priority order — the "what" behind the "what am I doing",
// not the tool's own plumbing (ids, flags).
const DETAIL_KEYS = ['query', 'url', 'title', 'name'];

export function describeToolCall(name: string, args: unknown): string {
  const base = LABELS[name] ?? humanizeToolName(name);
  const detail = pickDetail(args);
  return detail ? `${base}: ${detail}` : base;
}

function humanizeToolName(name: string): string {
  const words = name.split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function pickDetail(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of DETAIL_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}
