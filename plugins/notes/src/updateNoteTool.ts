/**
 * @file plugins/notes/src/updateNoteTool.ts
 * @stamp 2026-07-24
 * @architectural-role IO Wrapper — edits a note's title/content/tags
 * @description
 * Only the fields actually supplied are changed — same "build the SET clause from present keys"
 * approach as chatSessions.ts's updateChat, so the LLM can say "add this to my grocery-trip note"
 * (content only) without needing to also resend the title. Always bumps updated_at.
 *
 * @api-declaration
 * createUpdateNoteTool() — returns the update_note RegisteredTool
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
  updated_at: string;
}

function isUpdateNoteArgs(
  value: unknown,
): value is { note_id: string; title?: string; content?: string; tags?: string[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).note_id === 'string'
  );
}

export function createUpdateNoteTool(): RegisteredTool {
  return {
    definition: {
      name: 'update_note',
      description: "Edit a note's title, content, and/or tags. Only the fields provided are changed.",
      parameters: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: 'The note to edit.' },
          title: { type: 'string' },
          content: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['note_id'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isUpdateNoteArgs(args)) {
        throw new Error('update_note requires a note_id: string argument');
      }
      const sets: string[] = ['updated_at = now()'];
      const params: unknown[] = [args.note_id, ctx.userId];
      if (args.title !== undefined) {
        params.push(args.title);
        sets.push(`title = $${params.length}`);
      }
      if (args.content !== undefined) {
        params.push(args.content);
        sets.push(`content = $${params.length}`);
      }
      if (args.tags !== undefined) {
        params.push(args.tags);
        sets.push(`tags = $${params.length}`);
      }
      const [row] = await ctx.db.query<NoteRow>(
        `update notes set ${sets.join(', ')} where note_id = $1 and user_id = $2
         returning note_id, title, content, tags, updated_at`,
        params,
      );
      if (!row) return { found: false, noteId: args.note_id };
      return {
        found: true,
        noteId: row.note_id,
        title: row.title,
        content: row.content,
        tags: row.tags,
        updatedAt: row.updated_at,
      };
    },
  };
}
