-- Cross-domain linking (docs/spec.md's Landing Deck / temporal-primitives addition) — applied by
-- hand, same as 0004/0009/0011/0013/etc:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0025_calendar_links_visibility.sql
--
-- linked_list_item_id/linked_note_id are one-directional pointers set once, at creation, by
-- whichever tool creates the calendar_events row (createCalendarEventTool.ts, when a list item or
-- note is explicitly "promoted" to a real calendar event). They are NOT kept in sync afterward —
-- list_items.due_at/notes.reminder_at stay the sole source of truth for the task/note's own
-- deadline, and the promoted calendar_events row becomes its own independent scheduling
-- commitment. This deliberately avoids a dual-write: the lists/notes plugins never need to know
-- calendar_events exists, and calendar_events never needs a background job reconciling against
-- other plugins' tables. `on delete set null` (same pattern as chat_sessions.canvas_note_id,
-- 0019_chat_canvas.sql) — deleting the source task/note clears the pointer but never deletes the
-- calendar event itself.
--
-- visibility controls only whether a native/google row is pushed to the external Google Calendar
-- connection (googleOutboundSync.ts) — it does not hide a row from get_calendar_schedule, which
-- still returns it for bigBrain's own Calendar tab either way. Default 'shared' preserves today's
-- behavior for every event created through the existing "Add" form (still pushes to Google exactly
-- as before); createCalendarEventTool.ts separately defaults new *linked* events to 'private'
-- unless told otherwise, so promoting a task/note deadline doesn't flood the household's real
-- Google Calendar with private to-do deadlines by default.

alter table calendar_events add column visibility text not null default 'shared' check (visibility in ('private', 'shared'));
alter table calendar_events add column linked_list_item_id uuid references list_items(item_id) on delete set null;
alter table calendar_events add column linked_note_id uuid references notes(note_id) on delete set null;
