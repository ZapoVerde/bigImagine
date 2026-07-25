/**
 * @file plugins/notes/src/updateNoteTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — edits a note's title/content/tags/state/reminder
 * @description
 * Only the fields actually supplied are changed — same "build the SET clause from present keys"
 * approach as chatSessions.ts's updateChat, so the LLM can say "add this to my grocery-trip note"
 * (content only) without needing to also resend the title. Always bumps updated_at. Declares
 * focusHint (only when found) so editing a note during a chat turn makes/keeps it that chat's
 * Canvas document (orchestrator/src/orchestrator/loop.ts) — a not-found edit must not focus a
 * nonexistent note.
 *
 * state ('active'/'pinned'/'archived') and reminder_at (db/migrations/0024_action_dates_priority.sql)
 * are set explicitly here, same as everything else on this tool — pinning a note for the Landing
 * Deck's reference drawer or archiving it out of the default browse are both just this call with
 * a different state, never inferred.
 *
 * reminder_at accepts null (to clear a reminder once reviewed) as well as an ISO string, unlike
 * every other field here — the JSON Schema below still only advertises string, since there's no
 * real case for the LLM itself to clear a reminder by name rather than just not setting one, but
 * the frontend's NoteEditor calls this same handler directly (via callTool, bypassing the
 * LLM-facing schema entirely) and does need to clear one.
 *
 * @api-declaration
 * createUpdateNoteTool() — returns the update_note RegisteredTool (with a focusHint)
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

const VALID_STATES = ['active', 'pinned', 'archived'];

interface NoteRow {
  note_id: string;
  title: string;
  content: string;
  tags: string[];
  state: string;
  reminder_at: string | null;
  updated_at: string;
}

function isUpdateNoteArgs(
  value: unknown,
): value is {
  note_id: string;
  title?: string;
  content?: string;
  tags?: string[];
  state?: string;
  reminder_at?: string | null;
} {
  const v = value as Record<string, unknown>;
  if (typeof value !== 'object' || value === null || typeof v.note_id !== 'string') return false;
  if (v.state !== undefined && !VALID_STATES.includes(v.state as string)) return false;
  if (v.reminder_at !== undefined && v.reminder_at !== null && typeof v.reminder_at !== 'string') return false;
  return true;
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
          state: { type: 'string', enum: VALID_STATES, description: "'active' (default), 'pinned' (surfaces in the Landing Deck's reference drawer), or 'archived' (hidden from browse, still searchable)." },
          reminder_at: { type: 'string', description: 'ISO timestamp to be reminded to review this note.' },
        },
        required: ['note_id'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isUpdateNoteArgs(args)) {
        throw new Error("update_note requires a note_id: string argument; state (if given) must be 'active'/'pinned'/'archived' and reminder_at (if given) a string");
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
      if (args.state !== undefined) {
        params.push(args.state);
        sets.push(`state = $${params.length}`);
      }
      if (args.reminder_at !== undefined) {
        params.push(args.reminder_at);
        sets.push(`reminder_at = $${params.length}`);
      }
      const [row] = await ctx.db.query<NoteRow>(
        `update notes set ${sets.join(', ')} where note_id = $1 and user_id = $2
         returning note_id, title, content, tags, state, reminder_at, updated_at`,
        params,
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
        updatedAt: row.updated_at,
      };
    },
    focusHint: (result) => {
      const r = result as { found?: boolean; noteId?: string };
      return r.found ? r.noteId ?? null : null;
    },
  };
}
