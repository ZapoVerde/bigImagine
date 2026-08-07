-- entity_key is canon_facts' dictionary-identity column for the person/place/thing/concept
-- categories — deliberately separate from arc_tag, not a reuse of it. arc_tag groups successive
-- proposals into one continuing *plot arc*; entity_key groups successive proposals into one
-- continuing *dictionary-style definition* of a named person/place/thing/concept. The two concepts
-- happen to want the same "most-recent-approved-wins" SQL shape (recallCanonFactsTool.ts's dedup),
-- but conflating the columns would mean a plot arc and a lorebook entry could collide on the same
-- key by coincidence — the user's explicit call after reviewing an earlier draft of this migration
-- that reused arc_tag.
--
-- Nullable, unconstrained: only the new lorebook/people curators (io/chatMemory/curateLorebook.ts,
-- curatePeople.ts) populate it. Turn-time propose_canon_fact (plugins/canonize/src/
-- proposeCanonFactTool.ts) is unchanged — its facts stay atomic, unnamed notes, never carrying an
-- entity_key. Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0064_canon_facts_entity_key.sql

alter table canon_facts add column entity_key text;
create index canon_facts_entity_key_idx on canon_facts (entity_key) where entity_key is not null;
