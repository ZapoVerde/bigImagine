/**
 * @file plugins/temporal/src/setTimerTool.ts
 * @stamp 2026-07-27
 * @architectural-role IO Wrapper — the set_timer RegisteredTool
 * @description
 * `end_at` is computed once, at creation, as an absolute timestamp (now + durationSeconds) —
 * db/migrations/0031_active_timers.sql's whole point is that a running timer survives an
 * orchestrator container restart with the correct remaining time, which only works if the stored
 * deadline is absolute rather than a "seconds remaining" value that would go stale the instant
 * the process holding it restarts. Computed in JS (`new Date(Date.now() + durationSeconds * 1000)`)
 * and passed as its own bound timestamptz parameter, not via SQL's `make_interval` — reusing one
 * placeholder as both the plain `duration_seconds` column value and `make_interval`'s argument hit
 * a real bug caught live (not by verify-temporal.mjs's fake pool, which never round-trips through
 * real Postgres): the server deduces one placeholder's type from every occurrence in the
 * statement, and a bare `integer`-column usage next to a `double precision`-cast usage of the same
 * `$n` is a genuine conflict, not something an explicit cast on just one side resolves — Postgres
 * fails at parse time with "inconsistent types deduced for parameter" before assignment casts ever
 * get a chance to run. Binding two separate parameters to the same JS value sidesteps the ambiguity
 * entirely, and matches how every other derived timestamp in this codebase (nextOccurrence.ts,
 * dateContext.ts) is already computed in JS rather than in SQL.
 *
 * linkedListItemId/linkedNoteId/linkedChatId are optional, set-once-at-creation pointers, same
 * shape as calendar_events' linked_list_item_id/linked_note_id (plugins/calendar) — not
 * validated against their target table here (a bad id just fails the FK constraint and the
 * insert throws, same as any other FK column in this codebase).
 *
 * @api-declaration
 * createSetTimerTool() — returns the set_timer RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface SetTimerRow {
  timer_id: string;
  label: string;
  duration_seconds: number;
  end_at: string;
  status: string;
}

interface SetTimerArgs {
  durationSeconds: number;
  label?: string;
  linkedListItemId?: string;
  linkedNoteId?: string;
  linkedChatId?: string;
}

function isSetTimerArgs(value: unknown): value is SetTimerArgs {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.durationSeconds !== 'number' || !Number.isFinite(v.durationSeconds) || v.durationSeconds <= 0) return false;
  if (v.label !== undefined && typeof v.label !== 'string') return false;
  for (const key of ['linkedListItemId', 'linkedNoteId', 'linkedChatId'] as const) {
    if (v[key] !== undefined && typeof v[key] !== 'string') return false;
  }
  return true;
}

export function createSetTimerTool(): RegisteredTool {
  return {
    definition: {
      name: 'set_timer',
      description: 'Start a countdown timer (e.g. a focus sprint or a break). Runs server-side and survives a restart.',
      parameters: {
        type: 'object',
        properties: {
          durationSeconds: { type: 'number', description: 'How long the timer runs, in seconds (e.g. 600 for 10 minutes).' },
          label: { type: 'string', description: 'What the timer is for, e.g. "Focus sprint" or "Break". Defaults to "Timer".' },
          linkedListItemId: { type: 'string', description: 'Optional: a list item this timer relates to.' },
          linkedNoteId: { type: 'string', description: 'Optional: a note this timer relates to.' },
          linkedChatId: { type: 'string', description: 'Optional: the chat session this timer relates to.' },
        },
        required: ['durationSeconds'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isSetTimerArgs(args)) {
        throw new Error('set_timer requires durationSeconds: number > 0; label/linkedListItemId/linkedNoteId/linkedChatId (if given) must be strings');
      }
      const endAt = new Date(Date.now() + args.durationSeconds * 1000);
      const [row] = await ctx.db.query<SetTimerRow>(
        `insert into active_timers (user_id, label, duration_seconds, end_at, linked_list_item_id, linked_note_id, linked_chat_id)
         values ($1, coalesce($2, 'Timer'), $3, $4, $5, $6, $7)
         returning timer_id, label, duration_seconds, end_at, status`,
        [
          ctx.userId,
          args.label?.trim() || null,
          args.durationSeconds,
          endAt.toISOString(),
          args.linkedListItemId ?? null,
          args.linkedNoteId ?? null,
          args.linkedChatId ?? null,
        ],
      );
      return {
        timerId: row!.timer_id,
        label: row!.label,
        durationSeconds: row!.duration_seconds,
        endAt: row!.end_at,
        status: row!.status,
      };
    },
  };
}
