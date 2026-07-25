/**
 * @file plugins/notes/src/getNoteTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — reads one note's full content
 * @description
 * Companion to get_notes: that lists titles only, this fetches everything for one note once it's
 * been picked. found: false (rather than throwing) when the id doesn't exist or belongs to
 * another user — RLS makes cross-user rows simply not match, same as every other by-id lookup in
 * this codebase. Declares focusHint (only when found) so the LLM re-reading a note to continue
 * editing it also (re-)focuses that chat's Canvas document, not just create/update_note.
 *
 * @api-declaration
 * createGetNoteTool() — returns the get_note RegisteredTool (with a focusHint)
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface NoteRow {
  note_id: string;
  title: string;
  content: string;
  tags: string[];
  state: string;
  reminder_at: string | null;
  created_at: string;
  updated_at: string;
}

function isGetNoteArgs(value: unknown): value is { note_id: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).note_id === 'string'
  );
}

export function createGetNoteTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_note',
      description: "Get one note's full content by id.",
      parameters: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: 'The note to fetch.' },
        },
        required: ['note_id'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isGetNoteArgs(args)) {
        throw new Error('get_note requires a note_id: string argument');
      }
      const [row] = await ctx.db.query<NoteRow>(
        'select note_id, title, content, tags, state, reminder_at, created_at, updated_at from notes where note_id = $1 and user_id = $2',
        [args.note_id, ctx.userId],
      );
      if (!row) return { found: false, noteId: args.note_id };
      return {
        found: true,
        noteId: row.note_id,
        title: row.title,
        content: row.content,
        tags: row.tags,
        state: row.state,
        reminderAt: row.reminder_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },
    focusHint: (result) => {
      const r = result as { found?: boolean; noteId?: string };
      return r.found ? r.noteId ?? null : null;
    },
  };
}
