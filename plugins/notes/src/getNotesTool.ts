/**
 * @file plugins/notes/src/getNotesTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — lists notes (summaries only)
 * @description
 * Deliberately excludes content — this backs a browsing list (the Notes tab, or "what notes do I
 * have") where full text would be wasted payload; get_note fetches one note's full content once
 * the user/LLM has picked it. search matches title or content case-insensitively, same ILIKE
 * approach chatSessions.listChats uses for chat history search.
 *
 * Excludes archived notes by default (db/migrations/0024_action_dates_priority.sql's notes.state
 * — same "hidden from browse, still fully searchable" treatment documents.status = 'stale' gets)
 * — pass state to see exactly one state (e.g. 'pinned' for the Landing Deck's reference drawer,
 * §5's addition) or state: 'archived' to browse archived notes specifically. A supplied search
 * term still searches archived notes even without an explicit state filter, since "find that note
 * I archived" is a legitimate ask this shouldn't silently fail.
 *
 * @api-declaration
 * createGetNotesTool() — returns the get_notes RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

const VALID_STATES = ['active', 'pinned', 'archived'];

interface NoteSummaryRow {
  note_id: string;
  title: string;
  state: string;
  updated_at: string;
}

function isGetNotesArgs(value: unknown): value is { search?: string; state?: string } {
  const v = value as Record<string, unknown>;
  if (typeof value !== 'object' || value === null) return false;
  if (v.state !== undefined && !VALID_STATES.includes(v.state as string)) return false;
  return true;
}

export function createGetNotesTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_notes',
      description: "List the user's notes (title and last-updated time only, not full content). Excludes archived notes unless state is given. Optionally filter by a search term matched against title or content.",
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Optional: only return notes matching this text.' },
          state: { type: 'string', enum: VALID_STATES, description: "Optional: only return notes in this state ('active', 'pinned', or 'archived'). Defaults to active+pinned." },
        },
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isGetNotesArgs(args)) {
        throw new Error("get_notes: state, if given, must be one of 'active', 'pinned', 'archived'");
      }
      const like = args.search?.trim() ? `%${args.search.trim()}%` : null;
      // Archived notes are excluded from the default browse, but a search term still reaches them
      // (an explicit state filter always wins over both).
      const excludeArchived = args.state === undefined && like === null;
      const rows = await ctx.db.query<NoteSummaryRow>(
        `select note_id, title, state, updated_at from notes
         where user_id = $1
           and ($2::text is null or title ilike $2 or content ilike $2)
           and ($3::text is null or state = $3)
           and (not $4::boolean or state != 'archived')
         order by updated_at desc`,
        [ctx.userId, like, args.state ?? null, excludeArchived],
      );
      return rows.map((r) => ({ noteId: r.note_id, title: r.title, state: r.state, updatedAt: r.updated_at }));
    },
  };
}
