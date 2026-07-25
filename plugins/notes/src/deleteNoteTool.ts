/**
 * @file plugins/notes/src/deleteNoteTool.ts
 * @stamp 2026-07-24
 * @architectural-role IO Wrapper — deletes a note
 * @description
 * A real delete, no soft-delete/archive concept — same as chat_sessions and lists.
 *
 * @api-declaration
 * createDeleteNoteTool() — returns the delete_note RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

function isDeleteNoteArgs(value: unknown): value is { note_id: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).note_id === 'string'
  );
}

export function createDeleteNoteTool(): RegisteredTool {
  return {
    definition: {
      name: 'delete_note',
      description: 'Delete a note by id.',
      parameters: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: 'The note to delete.' },
        },
        required: ['note_id'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isDeleteNoteArgs(args)) {
        throw new Error('delete_note requires a note_id: string argument');
      }
      const rows = await ctx.db.query<{ note_id: string }>(
        'delete from notes where note_id = $1 and user_id = $2 returning note_id',
        [args.note_id, ctx.userId],
      );
      return { deleted: rows.length > 0 };
    },
  };
}
