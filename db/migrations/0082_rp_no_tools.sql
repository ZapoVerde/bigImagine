-- 0082: the RP lane runs with NO tools at all (2026-08-10 user direction: "We simply let it
-- execute the comfy 2 stack, with no funny business" — the model sometimes created characters,
-- which is not what the loop is for). New rp chats already default tool_names to '{}' via
-- DEFAULT_RP_TOOLS (orchestrator/src/io/chatSessions.ts); this migration normalizes EXISTING rp
-- rows: the legacy recall pair ({recall_chat_history,recall_canon_facts}) AND any null
-- (= all registered tools, the pre-allow-list behavior) collapse to '{}' = no tools.
--
-- The load-bearing guarantee is server-side, not this column: every rp-kind turn gets an empty
-- tool registry regardless of stored tool_names (server/httpServer.ts chat-completions + swipe
-- regeneration, orchestrator/agentRoutineDispatch.ts) — so even a future non-empty value can't
-- leak tools to the RP model. Auto-recall is unaffected: it injects into the prompt stack
-- server-side (io/chatMemory/recallForPrompt.ts) and never needed a model tool call.
update chat_sessions
   set tool_names = '{}'::text[]
 where kind = 'rp'
   and tool_names is distinct from '{}'::text[];
