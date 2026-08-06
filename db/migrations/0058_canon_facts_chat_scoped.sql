-- Canon facts always belong to a chat now — the user's explicit call: "there shouldn't be any
-- facts that don't belong to a chat." Supersedes 0054's "a platform-global fact has no scene and
-- no chat" framing; that branch of the design is gone, not just unused. canon_facts is currently
-- empty in the live DB (extraction is still unwired — canonExtraction.ts's own doc comment), so no
-- backfill is needed. Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0058_canon_facts_chat_scoped.sql
--
-- `on delete cascade` (was `set null`): once every fact must have a chat, a fact whose chat no
-- longer exists can't fall back to "globally visible" the way 0054 intended — it has nowhere left
-- to be scoped to, so it goes with the chat. This is a real narrowing of bi_principles.md §15's
-- "reviewable, not erased" (which still governs `rejected` rows staying on record *within* a
-- chat's lifetime) — deleting the chat itself is the one case that now also removes its canon.
--
-- anchor_message_id stays nullable/`on delete set null`: a fact can belong to a chat as a whole
-- without pinning to one specific turn (e.g. a fact distilled at sync time rather than proposed
-- mid-turn), so losing the anchor is a soft degradation, not the "fact has nowhere to live" case
-- chat_id's own tightening addresses.

alter table canon_facts drop constraint canon_facts_chat_id_fkey;
alter table canon_facts alter column chat_id set not null;
alter table canon_facts add constraint canon_facts_chat_id_fkey
  foreign key (chat_id) references chat_sessions(chat_id) on delete cascade;
