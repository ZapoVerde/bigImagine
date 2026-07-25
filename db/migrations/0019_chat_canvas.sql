-- Canvas: which note (if any) a chat's document panel is currently focused on — applied by hand:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0019_chat_canvas.sql
--
-- Set by httpServer.ts at the end of any turn where a notes-plugin tool call's own focusHint
-- (orchestrator/src/orchestrator/toolRegistry.ts) surfaced a note id — create_note/update_note/
-- get_note all declare one (plugins/notes/src/), "most recently focused wins" for the turn.
-- Cleared by the frontend's Canvas panel close action (POST /v1/chats/:id, canvas_note_id: null).
-- Null means the chat has no attached document panel. No RLS/grant changes needed: chat_sessions'
-- existing user_scoped policy and grants (0009_chat_sessions.sql) apply per-row, already covering
-- any column including this one.

alter table chat_sessions add column canvas_note_id uuid references notes(note_id) on delete set null;
