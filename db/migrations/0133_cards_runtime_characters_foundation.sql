-- Cards/runtime Characters foundation (docs/plans/cards-runtime-characters/3_IMPLEMENTATION_PLAN.md §1.1).
-- Additive only: Cards are copied out of the legacy status-null characters bucket, while the
-- legacy rows and chat_sessions.character_id remain until the consumer cutover is complete.
-- Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0133_cards_runtime_characters_foundation.sql

begin;

create table cards (
  card_id          uuid primary key,
  user_id          uuid not null references users(user_id),
  name             text not null,
  persona          text not null default '',
  appearance       text not null default '',
  scenario         text not null default '',
  system_prompt    text not null default '',
  example_dialogue text not null default '',
  greetings        jsonb not null default '[]'::jsonb,
  avatar_path      text,
  spec_version     text not null default 'v2' check (spec_version in ('v2', 'v3')),
  source_json      jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index cards_by_user_name on cards (user_id, name);
alter table cards add constraint cards_card_id_user_id_key unique (card_id, user_id);

alter table cards enable row level security;
alter table cards force row level security;
create policy user_scoped on cards
  using (user_id = app_current_user_id())
  with check (user_id = app_current_user_id());

grant select, insert, update, delete on cards to bigimagine_app;

-- The status-null bucket is the legacy Card/library discriminator. Runtime rows created by the
-- presence path carry a lifecycle status and are intentionally excluded from this copy.
insert into cards (
  card_id, user_id, name, persona, appearance, scenario, system_prompt, example_dialogue, greetings,
  avatar_path, spec_version, source_json, created_at, updated_at
)
select
  character_id, user_id, name, persona, appearance, scenario, system_prompt, example_dialogue, greetings,
  avatar_path, spec_version, source_json, created_at, updated_at
from characters
where status is null;

alter table chat_sessions
  add column card_id uuid references cards(card_id);
alter table chat_sessions add constraint chat_sessions_chat_id_user_id_key unique (chat_id, user_id);
alter table chat_sessions drop constraint chat_sessions_card_id_fkey;
alter table chat_sessions add constraint chat_sessions_card_user_fk
  foreign key (card_id, user_id) references cards(card_id, user_id);
create index chat_sessions_by_card on chat_sessions (card_id);

-- Only chats whose legacy source row is a Card receive the new source reference. Chats that
-- reference a runtime Character remain nullable until the later RP consumer cutover decides how
-- those historical non-Card chats should be represented.
update chat_sessions s
set card_id = c.character_id
from characters c
where s.character_id = c.character_id
  and c.status is null;

create table lorebook_card_links (
  lorebook_id uuid not null,
  card_id     uuid not null,
  user_id     uuid not null references users(user_id),
  joined_at   timestamptz not null default now(),
  primary key (lorebook_id, card_id)
);
alter table lorebooks add constraint lorebooks_lorebook_id_user_id_key unique (lorebook_id, user_id);
alter table lorebook_card_links add constraint lorebook_card_links_lorebook_user_fk
  foreign key (lorebook_id, user_id) references lorebooks(lorebook_id, user_id) on delete cascade;
alter table lorebook_card_links add constraint lorebook_card_links_card_user_fk
  foreign key (card_id, user_id) references cards(card_id, user_id) on delete cascade;
create index lorebook_card_links_by_card on lorebook_card_links (card_id);

alter table lorebook_card_links enable row level security;
alter table lorebook_card_links force row level security;
create policy user_scoped on lorebook_card_links
  using (user_id = app_current_user_id())
  with check (user_id = app_current_user_id());

grant select, insert, update, delete on lorebook_card_links to bigimagine_app;

-- Keep the legacy association intact for old consumers, while adding the canonical Card-owned
-- relationship. No character_chat_links rows are inserted or changed here.
insert into lorebook_card_links (lorebook_id, card_id, user_id)
select distinct lcl.lorebook_id, c.character_id, c.user_id
from lorebook_character_links lcl
join characters c on c.character_id = lcl.character_id
where c.status is null;

commit;
