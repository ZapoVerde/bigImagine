-- Seed the builtin "Cleanup Pass" prompt-stack preset — the optional post-processing LLM pass of
-- docs/turn-loop-plan.md §4 / docs/vistalyze_integration/cleanup_prompt.md, ported to BigImagine's
-- own architecture (the job the user's real-world Triggeryze sideCall does today). Migration 0057
-- already added chat_sessions.cleanup_preset_id; this ships the preset that column points at.
--
-- Per docs/vistalyze_integration/cleanup_prompt.md §2.3 and bi_principles.md §18 ("every prompt is
-- surfaced for manual tuning"), the actual prompt text is NOT hardcoded in source: it's one
-- custom-system slot on a builtin context_stack_presets row, readable on the Prompt Stacks page
-- and duplicate-to-edit like any other preset. The single slot's custom_content is the literal
-- prompt sent to the cleanup LLM call ({{message}} embedded where the raw turn goes) — the
-- banned-construction slop list is just text inside that slot, no separate table or config value.
--
-- Same is_builtin = true seed shape migration 0042 used for "Standard"/"Minimal": owned by the
-- fixed system user (readable by everyone via 0042's select_own_or_builtin policy, writable only
-- by bigbrain_admin), inserted directly by this migration's own privilege level. The one slot is
-- custom_role 'system' per cleanup_prompt.md §2.3's "a single custom slot" — a cleanup preset has
-- no card/persona/memory marker fields to draw from, only {{message}}, so a marker slot would
-- have nothing to emit.
--
-- Applied by hand against the dedicated BigImagine database, same as every post-initdb migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0066_cleanup_preset_seed.sql
--
-- Idempotent-safe: guard the insert on the name so re-running after a manual "Duplicate to
-- customize" (which copies it to a normal, user-owned preset) can't double-seed the builtin.

do $$
declare
  system_user_id uuid := '00000000-0000-0000-0000-000000000000';
  cleanup_preset_id uuid;
begin
  if not exists (select 1 from users where user_id = system_user_id) then
    insert into users (user_id, name) values (system_user_id, 'system');
  end if;

  if exists (select 1 from context_stack_presets where user_id = system_user_id and name = 'Cleanup Pass' and is_builtin = true) then
    return;
  end if;

  insert into context_stack_presets (preset_id, user_id, name, is_builtin)
  values (gen_random_uuid(), system_user_id, 'Cleanup Pass', true)
  returning preset_id into cleanup_preset_id;

  insert into context_stack_slots (preset_id, position, slot_type, custom_role, custom_content, enabled)
  values (
    cleanup_preset_id,
    0,
    'custom',
    'system',
    $cleanup$
You are the cleanup pass for a character-driven story. You receive the raw text of the most recently generated turn and return a cleaned version. Change nothing about the story, the characters, their actions, or the pacing — your job is presentation only.

TEXT TO FIX:
{{message}}

Rules:
1. Strip banned constructions, AI clichés, and formatting slop: remove meta-commentary about being an AI or a language model, asides that address the reader, generic filler ("in conclusion", "it's important to note", "let's dive in"), redundant adverb stacks, and any narration that steps outside the story. Never rewrite dialogue or invent new events while doing so.
2. Header block: the message must open with exactly these two lines, in this form, and nothing before them:
[ TimeOfDay | 🗓️ DayOfWeek, Month DD, YYYY Era | 📍 Location - Specific Area ]
Present: Character A, Character B, Character C
   - TimeOfDay: a plain phrase (e.g. "Early Morning", "Late Evening"), not a clock time.
   - Era: "AD"/"BC" by default, or the story's own established custom calendar era if one exists (e.g. "41st Millennium", "3 ABY").
   - Location: "General Area - Specific Room" when a specific room/spot is known, otherwise just the general area.
   - Present: the explicit, comma-separated roster of every character physically in the room at the end of this turn — never invented, never guessed at from off-screen mentions.
   If either line is missing or malformed, reconstruct both from the recent conversation history provided before this prompt plus the message itself: the ongoing location, date, time of day, and current cast come from that context, never from invention. If a character enters or leaves during the turn, Present reflects who remains in the room afterward. If both lines are present and correct, leave them exactly as is.
3. Internal thoughts: hidden character thoughts must live inside the standard details block, exactly this shape, and never as visible narration:

<details><summary>▸</summary>
<inner thoughts>
[Character Name]:
What they are feeling beneath what they are showing.

What they want right now.
</inner thoughts>
</details>

Reformat any stray inner thoughts into this shape. Only include characters actually present in the recent history. A turn with no inner thoughts must not gain one.

Return only the cleaned text — no explanations, no preamble, no extra commentary.
$cleanup$,
    true
  );
end $$;
