/**
 * @file orchestrator/src/util/dateContext.ts
 * @stamp 2026-07-24
 * @architectural-role Pure Function — current-date system-message formatting
 * @description
 * LLMs have no reliable sense of "today" on their own — every date-taking tool (get_meal_plan,
 * add_meal_plan_entry, ...) leaves the model to guess what "Thursday" or "next week" resolves to
 * from training data alone, with no way to get it right. server/httpServer.ts's
 * handleChatCompletions prepends this line as its own system message on every turn — unconditionally,
 * whether or not a chat has its own custom system prompt, and for Open WebUI's stateless traffic
 * too, since date confusion isn't specific to bigBrain's own frontend.
 *
 * Takes an IANA zone name (io/orchestratorSettings.ts's household_timezone, admin-set from the
 * Settings tab) rather than assuming the server's own TZ or UTC — "today" flips at local
 * midnight, not at a datacenter's. An invalid zone name throws (Intl does that natively); the
 * caller falls back to 'UTC' before ever reaching here, so this never needs to guess one.
 *
 * @api-declaration
 * formatCurrentDateContext(timeZone: string, now = new Date()) — "Today is <weekday>, <date>
 *   (current local time <time>, <timeZone>)."
 *
 * @contract
 *   assertions:
 *     purity:          pure (Date.now() only via the injectable `now` param, defaulted for real
 *                      callers — same seam verify scripts use elsewhere for deterministic tests)
 *     state_ownership: []
 *     external_io:     []
 */

export function formatCurrentDateContext(timeZone: string, now: Date = new Date()): string {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(now);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  return `Today is ${weekday}, ${date} (current local time ${time}, ${timeZone}).`;
}
