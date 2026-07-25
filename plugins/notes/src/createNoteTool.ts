/**
 * @file plugins/notes/src/createNoteTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — creates a note
 * @description
 * A note is just a title + freeform content blob, nothing structured — unlike lists (many items
 * per list) or chats (many messages per session), there is exactly one row per note. title
 * defaults to "Untitled note" when omitted, same fallback the Notes tab itself uses for a
 * freshly-created note before the user names it. Declares focusHint so creating a note during a
 * chat turn makes it that chat's Canvas document (orchestrator/src/orchestrator/loop.ts).
 *
 * Always starts in state = 'active' (the column default) — pinning/archiving happens later via
 * update_note, never at creation. reminder_at (db/migrations/0024_action_dates_priority.sql) is
 * optional, for the "remind me to look at this again" case at creation time (e.g. "note down the
 * itinerary, remind me to review it Friday").
 *
 * @api-declaration
 * createCreateNoteTool() — returns the create_note RegisteredTool (with a focusHint)
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface CreateNoteRow {
  note_id: string;
  title: string;
  content: string;
  reminder_at: string | null;
}

function isCreateNoteArgs(value: unknown): value is { title?: string; content: string; reminder_at?: string } {
  const v = value as Record<string, unknown>;
  if (typeof value !== 'object' || value === null || typeof v.content !== 'string') return false;
  if (v.reminder_at !== undefined && typeof v.reminder_at !== 'string') return false;
  return true;
}

export function createCreateNoteTool(): RegisteredTool {
  return {
    definition: {
      name: 'create_note',
      description: 'Create a new freeform note with a title and content.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Optional title. Defaults to "Untitled note".' },
          content: { type: 'string', description: 'The note text.' },
          reminder_at: { type: 'string', description: 'Optional: ISO timestamp to be reminded to review this note.' },
        },
        required: ['content'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isCreateNoteArgs(args)) {
        throw new Error('create_note requires a content: string argument; reminder_at (if given) must be a string');
      }
      const [row] = await ctx.db.query<CreateNoteRow>(
        `insert into notes (user_id, title, content, reminder_at) values ($1, coalesce($2, 'Untitled note'), $3, $4)
         returning note_id, title, content, reminder_at`,
        [ctx.userId, args.title?.trim() || null, args.content, args.reminder_at ?? null],
      );
      return { noteId: row!.note_id, title: row!.title, content: row!.content, reminderAt: row!.reminder_at };
    },
    focusHint: (result) => (result as { noteId?: string }).noteId ?? null,
  };
}
