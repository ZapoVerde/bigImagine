-- Fixes for docs/plans/cards-runtime-characters/4_ISSUES.md (review of 722f648..cafc832).
-- Issue 1: cards.card_id was created without DEFAULT gen_random_uuid(), unlike the legacy
-- characters.character_id it replaced (0044_characters.sql). Every app insert omits card_id and
-- relies on the DB default — without it, create_card / import_card / Chub imports all fail with
-- NOT NULL. pgcrypto is already enabled (0002_schema.sql), only the default clause was dropped.
-- Issue 2: 0133 backfilled card_id only for Card-backed chats (c.status is null); runtime-Character
-- chats would have stayed nullable until 0134 dropped character_id. Live DB check (2026-08-22):
-- 13 chat_sessions total, 8 rp with card_id, 5 chat-kind with card_id IS NULL and zero
-- character_chat_links — no historical rp chat was orphaned. This migration adds the
-- invariant that was left implicit: rp chats must carry a card_id (check constraint). Plain
-- chat-kind chats legitimately stay null.
-- Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0135_cards_runtime_characters_fixes.sql

begin;

-- Issue 1: restore DB-side ID generation for Cards.
alter table cards alter column card_id set default gen_random_uuid();

-- Issue 2: enforce rp -> card_id invariant going forward.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chat_sessions_rp_requires_card') then
    alter table chat_sessions
      add constraint chat_sessions_rp_requires_card
      check (kind != 'rp' or card_id is not null);
  end if;
end $$;

commit;
