-- Per-turn character visual state (docs/plans/character-visual-state-plan.md) — the canonical
-- current-status snapshot for every character in the trusted scene roster: inner thoughts, a
-- one-word expression, and a fixed six-slot outfit, parsed from the Cleaner's hidden
-- `<details><summary>▸</summary>` footer each processed turn. Applied by hand against the
-- dedicated BigImagine database, same as every post-initdb migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0125_character_visual_states.sql
--
-- Five new tables (all following visual_*'s RLS shape in 0105/0118: user_id references users,
-- enable + force row level security, a user_scoped policy, grants to bigimagine_app):
--
-- 1. character_visual_states — the current snapshot, one row per (user, chat, character),
--    user-scoped. chat_id cascades off chat_sessions (state follows the chat's lifecycle);
--    message_id/swipe_id are soft provenance that set-null when the message/swipe goes (the
--    snapshot outlives any one turn — deleting a turn or cycling a swipe must not erase it).
--    The unique (user_id, chat_id, character_id) makes Pipeline Stage 3's upsert well-defined.
--
-- 2. character_visual_state_events — the append-only audit ledger: one row per character per
--    turn where Expression or Outfit actually changed (event_type 'visible_change'), plus the
--    initial-snapshot record ('initialized'). changed_fields is the JSONB list of visibly
--    changed slot names; before_state/after_state hold the full normalized snapshots for audit.
--    Never written for an inner-thoughts-only change.
--
-- 3. character_subject_visuals — the one-shot Subject mint, keyed by character_id (PK). slots
--    is the Subject-layer slot map from describeStudioSlots; source_appearance_hash is the
--    sha256 of the characters.appearance text it was minted from, so an appearance edit
--    (detected by hash mismatch) forces a lazy re-mint on the next autofire call instead of
--    serving a stale Subject.
--
-- 4. visual_expression_definitions — the global-per-user Expression mint cache: translating a
--    normalized word ("grumpy") into Expression-layer slots costs an LLM call, so the result is
--    memoized per user. unique (user_id, word), with word already normalized (trim + casefold,
--    matching Stage 3's diff normalization).
--
-- 5. character_visual_combinations — the chat-scoped rendered-image cache: the same
--    outfit+expression on the same character in a *different* chat is not assumed to be the
--    same picture, so chat_id is in the cache key. outfit_key is the canonical join of the six
--    normalized outfit fields; expression_key the normalized word. composed_prompt is audit
--    provenance (same style as visual_candidates). On a provider failure no row is written, so
--    the next real trigger retries from scratch rather than caching a failure.
--
-- No orchestrator_settings CHECK rebuild is needed: the revised Cleaner footer prompt reuses
-- the existing cleanup_footer_prompt key (the plan's explicit call).

create table character_visual_states (
  visual_state_id  uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(user_id),
  chat_id          uuid not null references chat_sessions(chat_id) on delete cascade,
  character_id     uuid not null references characters(character_id),
  message_id       uuid references chat_messages(message_id) on delete set null,
  swipe_id         uuid references chat_message_swipes(swipe_id) on delete set null,
  source_turn_at   timestamptz not null default now(),
  inner_thoughts   text not null default '',
  expression       text not null default '',
  outerwear        text not null default '',
  top              text not null default '',
  bottom           text not null default '',
  underwear_top    text not null default '',
  underwear_bottom text not null default '',
  accessory        text not null default '',
  updated_at       timestamptz not null default now(),
  unique (user_id, chat_id, character_id)
);
alter table character_visual_states enable row level security;
alter table character_visual_states force row level security;
create policy user_scoped on character_visual_states using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());
grant select, insert, update, delete on character_visual_states to bigimagine_app;

create table character_visual_state_events (
  event_id        uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(user_id),
  chat_id         uuid not null references chat_sessions(chat_id) on delete cascade,
  character_id    uuid not null references characters(character_id),
  message_id      uuid references chat_messages(message_id) on delete set null,
  swipe_id        uuid references chat_message_swipes(swipe_id) on delete set null,
  event_type      text not null check (event_type in ('initialized', 'visible_change')),
  changed_fields  jsonb not null default '{}',
  before_state    jsonb not null default '{}',
  after_state     jsonb not null default '{}',
  created_at      timestamptz not null default clock_timestamp()
);
create index character_visual_state_events_by_character on character_visual_state_events (user_id, chat_id, character_id, created_at);
alter table character_visual_state_events enable row level security;
alter table character_visual_state_events force row level security;
create policy user_scoped on character_visual_state_events using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());
grant select, insert, update, delete on character_visual_state_events to bigimagine_app;

create table character_subject_visuals (
  character_id           uuid primary key references characters(character_id) on delete cascade,
  user_id                uuid not null references users(user_id),
  slots                  jsonb not null default '{}',
  source_appearance_hash text not null default '',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
alter table character_subject_visuals enable row level security;
alter table character_subject_visuals force row level security;
create policy user_scoped on character_subject_visuals using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());
grant select, insert, update, delete on character_subject_visuals to bigimagine_app;

create table visual_expression_definitions (
  definition_id uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(user_id),
  word          text not null,
  slots         jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  unique (user_id, word)
);
alter table visual_expression_definitions enable row level security;
alter table visual_expression_definitions force row level security;
create policy user_scoped on visual_expression_definitions using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());
grant select, insert, update, delete on visual_expression_definitions to bigimagine_app;

create table character_visual_combinations (
  combination_id  uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(user_id),
  chat_id         uuid not null references chat_sessions(chat_id) on delete cascade,
  character_id    uuid not null references characters(character_id),
  outfit_key      text not null,
  expression_key  text not null,
  image_url       text null,
  composed_prompt text not null default '',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, chat_id, character_id, outfit_key, expression_key)
);
create index character_visual_combinations_by_character on character_visual_combinations (user_id, chat_id, character_id);
alter table character_visual_combinations enable row level security;
alter table character_visual_combinations force row level security;
create policy user_scoped on character_visual_combinations using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());
grant select, insert, update, delete on character_visual_combinations to bigimagine_app;