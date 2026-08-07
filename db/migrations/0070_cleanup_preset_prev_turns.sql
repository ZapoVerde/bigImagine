-- Update the builtin "Cleanup Pass" preset's slot text to embed the {{prev_turns, 2}} macro.
--
-- The cleanup pass's previous-turns contract changed (2026-08-07): history is no longer prepended
-- to the cleanup LLM call as messages; a preset opts into it textually via the {{prev_turns, N}}
-- macro (N turn pairs, default 2), expanded by runCleanupPass through interpolateMacros's
-- resolveArg hook (orchestrator/src/server/httpServer.ts, util/interpolateMacros.ts). The original
-- seed (0066) predates the macro, so the builtin's slot text said "recent conversation history
-- provided before this prompt" — which stopped being true the moment the prepend was removed.
-- This migration rewrites the builtin's custom/system slot to the macro form.
--
-- 0066 was never applied to the live BigImagine database (only fresh volumes get it, via
-- /docker-entrypoint-initdb.d), so this migration both creates the builtin preset when missing
-- (live-DB path) and updates it in place when 0066 already ran (fresh-volume path). The user's own
-- non-builtin presets (e.g. a duplicated "Cleanup" copy) are never touched — this only owns the
-- system user's builtin row, same ownership rule as 0066's seed.
--
-- Applied by hand, same as every post-initdb migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0070_cleanup_preset_prev_turns.sql
--
-- Idempotent: guarded on the builtin preset name; re-running updates the slot text to this same
-- value and never double-seeds.

do $$
declare
  system_user_id uuid := '00000000-0000-0000-0000-000000000000';
  cleanup_preset_id uuid;
  cleanup_slot_id uuid;
  cleanup_text text := $cleanup$
You are the cleanup pass for a character-driven story. You receive the raw text of the most recently generated turn and return a cleaned version. Change nothing about the story, the characters, their actions, or the pacing — your job is presentation only.

PREVIOUS TURNS:
{{prev_turns, 2}}

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
   If either line is missing or malformed, reconstruct both from the PREVIOUS TURNS transcript above plus the message itself: the ongoing location, date, time of day, and current cast come from that context, never from invention. If a character enters or leaves during the turn, Present reflects who remains in the room afterward. If both lines are present and correct, leave them exactly as is.
3. Internal thoughts: hidden character thoughts must live inside the standard details block, exactly this shape, and never as visible narration:

<details><summary>▸</summary>
<inner thoughts>
[Character Name]:
What they are feeling beneath what they are showing.

What they want right now.
</inner thoughts>
</details>

Reformat any stray inner thoughts into this shape. Only include characters actually present in the PREVIOUS TURNS transcript. A turn with no inner thoughts must not gain one.

Return only the cleaned text — no explanations, no preamble, no extra commentary.
$cleanup$;
begin
  if not exists (select 1 from users where user_id = system_user_id) then
    insert into users (user_id, name) values (system_user_id, 'system');
  end if;

  select preset_id into cleanup_preset_id
    from context_stack_presets
   where user_id = system_user_id and name = 'Cleanup Pass' and is_builtin = true;

  if cleanup_preset_id is null then
    insert into context_stack_presets (preset_id, user_id, name, is_builtin)
    values (gen_random_uuid(), system_user_id, 'Cleanup Pass', true)
    returning preset_id into cleanup_preset_id;
  end if;

  select slot_id into cleanup_slot_id
    from context_stack_slots
   where preset_id = cleanup_preset_id and slot_type = 'custom' and custom_role = 'system';

  if cleanup_slot_id is null then
    insert into context_stack_slots (preset_id, position, slot_type, custom_role, custom_content, enabled)
    values (cleanup_preset_id, 0, 'custom', 'system', cleanup_text, true);
  else
    update context_stack_slots set custom_content = cleanup_text where slot_id = cleanup_slot_id;
  end if;
end $$;
