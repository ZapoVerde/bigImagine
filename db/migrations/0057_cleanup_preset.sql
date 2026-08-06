-- The cleanup pass (docs/turn-loop-plan.md §4, step 5 of the seven-step turn loop): a second,
-- optional, unconditional-when-set LLM call that post-processes a turn's raw reply before it's
-- persisted — banned constructions/names/words, header reconstruction, internal-thoughts-suffix
-- fixups, the same job the user's real-world Triggeryze (TRG) sideCall does today, ported to
-- BigImagine's own architecture. Per the user's explicit direction, this is exposed as its own
-- context_stack_presets row (mostly custom-type slots, {{message}} embedded in their text via
-- util/interpolateMacros.ts's new `message` field), not a second "instruction content" schema —
-- so the only new column needed is which preset a chat should run for cleanup, same shape as
-- prompt_stack_preset_id's own addition in migration 0049.
--
-- Null (the default) means cleanup is off for that chat — the common case until a user opts in;
-- server/httpServer.ts's post-runTurn wiring skips straight to persistence when unset, zero cost.
-- on delete set null, not cascade, matching prompt_stack_preset_id's own choice — deleting a
-- preset shouldn't take a chat down with it, just silently turn its cleanup pass off.
--
-- Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0057_cleanup_preset.sql

alter table chat_sessions add column cleanup_preset_id uuid references context_stack_presets(preset_id) on delete set null;
