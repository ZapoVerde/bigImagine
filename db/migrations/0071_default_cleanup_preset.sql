-- Lets a user mark one context_stack_presets row (their own, or a shared builtin) as the *cleanup*
-- default — the preset CharactersView.tsx's startRp() auto-applies to every new RP chat's
-- cleanup_preset_id right after the default prompt stack, the same explicit-signal shape as 0061
-- (bi_principles.md §3: nothing is guessed, the user names the default once and every future RP
-- chat honors it until they change it).
--
-- The sibling column users.default_context_stack_preset_id (0061) is the prompt-stack default —
-- which prompt stack startRp() applies. This one is the cleanup default — which cleanup preset the
-- turn-loop's cleanup pass runs (chat_sessions.cleanup_preset_id, migration 0057). Both are
-- independent: one preset can be the default for both roles, or two different presets can each
-- own one. set_default_context_stack_preset's `kind` argument ('prompt' | 'cleanup') picks which
-- of the two columns it writes; get_context_stack_presets reports both as isDefault and
-- isCleanupDefault.
--
-- Same design rationale as 0061's own comment, verbatim: lives on users, not as a flag on
-- context_stack_presets itself — flagging a *builtin* row would make that the default for every
-- user in the household at once (the cross-user bleed 0042's RLS split was built to prevent); a
-- nullable FK on users is the one place "this user's chosen default, which may point at any preset
-- regardless of who owns it" can live without mutating a row other users also read. users has no
-- RLS of its own, so the new tool's writes follow the same explicit user_id filter convention
-- (setDefaultContextStackPresetTool.ts).
--
-- on delete set null: deleting a preset that happened to be someone's cleanup default should
-- silently clear that default, not block the delete or leave a dangling reference.
--
-- Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0071_default_cleanup_preset.sql

alter table users
  add column default_cleanup_preset_id uuid references context_stack_presets(preset_id) on delete set null;
