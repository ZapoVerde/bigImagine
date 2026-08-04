-- Canon facts — the approval-gated canonical record Canonize maintains (Canonize plan §3.2/§4,
-- bi_principles.md §15). Applied by hand, same as 0044/0045/0046:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0047_canon_facts.sql
--
-- category is the MECE curator tag (place/thing/concept/person/plot); arc_tag is required exactly
-- when category = 'plot' and, unlike SillyTavern-Canonize's in-place UPDATE, every proposal for a
-- continuing arc_tag gets its own row here — full audit history is kept, and recall_canon_facts
-- (plugins/canonize) selects only the most-recently-approved row per arc_tag at read time, not at
-- write time. Rejected rows are kept too, never deleted (bi_principles.md §15's "a proposal is
-- reviewable, not erased").
--
-- vector_embed is vector(2048), matching the repo's Voyage AI embedding width (db/migrations/0003's
-- resize, chat_chunks.vector_embed) — not the vector(1024) placeholder an earlier plan draft had.
-- No index on vector_embed: pgvector's hnsw/ivfflat indexes cap out at 2000 dimensions, so a 2048-
-- wide column can never be indexed — the same reason chat_chunks.vector_embed and
-- document_chunks.vector_embed (both vector(2048)) have no vector index either. recall_canon_facts
-- relies on a brute-force scan over the (already scene-scoped) candidate set, same as every other
-- vector search in this repo.
--
-- linked_character_ids is uuid[] (the repo's actual primary-key convention), not the int[] spec.md's
-- diagram shows — flagged as a spec.md correction in canonize-plan.md §13.

create table canon_facts (
  fact_id               uuid primary key default gen_random_uuid(),
  user_id               uuid not null references users(user_id),
  scene_id              uuid references scenes(scene_id) on delete set null,
  category              text not null check (category in ('place', 'thing', 'concept', 'person', 'plot')),
  arc_tag               text check (category <> 'plot' or arc_tag is not null),
  summary               text not null,
  detail                text not null default '',
  vector_embed          vector(2048),
  status                text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected')),
  linked_character_ids  uuid[] not null default '{}',
  linked_location_id    uuid references locations(location_id) on delete set null,
  proposed_at           timestamptz not null default now(),
  approved_at           timestamptz
);
create index canon_facts_arc_tag_idx on canon_facts (arc_tag) where arc_tag is not null;
create index canon_facts_by_user_status on canon_facts (user_id, status);

alter table canon_facts enable row level security;
alter table canon_facts force row level security;
create policy user_scoped on canon_facts using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

grant select, insert, update, delete on canon_facts to bigbrain_app;
