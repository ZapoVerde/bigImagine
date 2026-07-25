/**
 * @file plugins/calendar/src/parseWorkEvent.ts
 * @stamp 2026-07-25
 * @architectural-role Pure Function — redacts a work-calendar event before it reaches Postgres
 * @description
 * Config-driven redaction, not LLM-judged classification — this is masking, not reasoning, so it
 * doesn't touch bb_principles.md §2. Gated by MASK_WORK_CALENDAR (icsSync.ts reads the env var and
 * passes the resulting boolean in here, never the raw process.env) so a household that doesn't
 * need it pays zero cost and this stays trivially testable without env mutation.
 *
 * @api-declaration
 * ParsedIcsEvent — the shape icsSync.ts produces from a node-ical VEVENT, before Postgres
 * applyPrivacyMask(event, shouldMask) — returns event unchanged, or with title/description/
 *   location replaced by a fixed placeholder
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

export interface ParsedIcsEvent {
  externalId: string;
  title: string;
  description: string | null;
  location: string | null;
  startTime: string;
  endTime: string;
  allDay: boolean;
}

const MASKED_TITLE = 'Work Commitment';

export function applyPrivacyMask(event: ParsedIcsEvent, shouldMask: boolean): ParsedIcsEvent {
  if (!shouldMask) return event;
  return {
    ...event,
    title: MASKED_TITLE,
    description: null,
    location: null,
  };
}
