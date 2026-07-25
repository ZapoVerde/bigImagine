/**
 * @file plugins/notes/src/createNoteTool.ts
 * @stamp 2026-07-24
 * @architectural-role IO Wrapper — creates a note
 * @description
 * A note is just a title + freeform content blob, nothing structured — unlike lists (many items
 * per list) or chats (many messages per session), there is exactly one row per note. title
 * defaults to "Untitled note" when omitted, same fallback the Notes tab itself uses for a
 * freshly-created note before the user names it.
 *
 * @api-declaration
 * createCreateNoteTool() — returns the create_note RegisteredTool
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
}

function isCreateNoteArgs(value: unknown): value is { title?: string; content: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).content === 'string'
  );
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
        },
        required: ['content'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isCreateNoteArgs(args)) {
        throw new Error('create_note requires a content: string argument');
      }
      const [row] = await ctx.db.query<CreateNoteRow>(
        `insert into notes (user_id, title, content) values ($1, coalesce($2, 'Untitled note'), $3)
         returning note_id, title, content`,
        [ctx.userId, args.title?.trim() || null, args.content],
      );
      return { noteId: row!.note_id, title: row!.title, content: row!.content };
    },
  };
}
