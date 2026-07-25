/**
 * @file plugins/notes/src/getNotesTool.ts
 * @stamp 2026-07-24
 * @architectural-role IO Wrapper — lists notes (summaries only)
 * @description
 * Deliberately excludes content — this backs a browsing list (the Notes tab, or "what notes do I
 * have") where full text would be wasted payload; get_note fetches one note's full content once
 * the user/LLM has picked it. search matches title or content case-insensitively, same ILIKE
 * approach chatSessions.listChats uses for chat history search.
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

interface NoteSummaryRow {
  note_id: string;
  title: string;
  updated_at: string;
}

function isGetNotesArgs(value: unknown): value is { search?: string } {
  return typeof value === 'object' && value !== null;
}

export function createGetNotesTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_notes',
      description: "List the user's notes (title and last-updated time only, not full content). Optionally filter by a search term matched against title or content.",
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Optional: only return notes matching this text.' },
        },
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isGetNotesArgs(args)) {
        throw new Error('get_notes requires an object argument');
      }
      const like = args.search?.trim() ? `%${args.search.trim()}%` : null;
      const rows = await ctx.db.query<NoteSummaryRow>(
        `select note_id, title, updated_at from notes
         where user_id = $1 and ($2::text is null or title ilike $2 or content ilike $2)
         order by updated_at desc`,
        [ctx.userId, like],
      );
      return rows.map((r) => ({ noteId: r.note_id, title: r.title, updatedAt: r.updated_at }));
    },
  };
}
