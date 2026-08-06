-- Lets a user mark one context_stack_presets row (their own, or a shared builtin) as the prompt
-- stack CharactersView.tsx's startRp() auto-applies to every new RP chat, right after
-- apply_character_to_chat — the same "explicit user signal outranks inference" shape as any other
-- preference here (bi_principles.md §3): nothing is guessed, the user names the default once and
-- every future RP chat honors it until they change it.
--
-- Lives on users, not as an is_default flag on context_stack_presets itself: a preset row is
-- either a user's own (one owner) or a shared builtin (is_builtin = true, owned by the fixed system
-- user, readable by everyone per 0042's select_own_or_builtin policy). Flagging a *builtin* row as
-- default would make that the default for every user in the household at once — exactly the
-- cross-user bleed 0042's RLS split was built to prevent. A nullable FK on users (one row per user
-- already) is the one place "this user's chosen default, which may point at any preset regardless
-- of who owns it" can live without mutating a row other users also read.
--
-- users has no RLS of its own (it never has — see 0002's own comment; it's read across the whole
-- household via db.withSystemScope by cron/dispatch code, and single-user upserts already filter
-- explicitly by user_id, e.g. deleteContextStackPresetTool.ts's `where ... and user_id = $2`). The
-- new tool (setDefaultContextStackPresetTool.ts) follows that same explicit-filter convention.
--
-- on delete set null: deleting a preset that happened to be someone's default (delete_context_stack_preset,
-- own presets only — a builtin can never be deleted) should silently clear that default, not block
-- the delete or leave a dangling reference.
--
-- Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0061_default_context_stack_preset.sql

alter table users
  add column default_context_stack_preset_id uuid references context_stack_presets(preset_id) on delete set null;
