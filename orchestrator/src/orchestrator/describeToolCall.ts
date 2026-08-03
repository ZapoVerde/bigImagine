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
 * describeToolCall(name, args) — e.g. "Updating a list item: milk" or, for an unrecognized tool
 *   with no nameable argument, a humanized fallback like "Log purchase"
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

const LABELS: Record<string, string> = {
  get_recipes: 'Checking your recipes',
  get_recipe: 'Checking a recipe',
  update_recipe: 'Updating a recipe',
  delete_recipe: 'Deleting a recipe',
  get_lists: 'Checking your lists',
  get_list_items: 'Checking a list',
  add_list_item: 'Adding to a list',
  update_list_item: 'Updating a list item',
  delete_list_item: 'Removing a list item',
  complete_list_item: 'Checking off a list item',
  web_search: 'Searching the web',
  ingest_url: 'Reading a page',
  get_weather: 'Checking the weather',
  send_push_notification: 'Sending a notification',
};

// Argument keys worth naming, in priority order — the "what" behind the "what am I doing" (a
// list/recipe/URL/etc.), not the tool's own plumbing (ids, flags).
const DETAIL_KEYS = ['item_name', 'list_name', 'mealName', 'query', 'url', 'title', 'name'];

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
