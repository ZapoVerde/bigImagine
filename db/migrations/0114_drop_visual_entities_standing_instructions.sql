-- Drops visual_entities.standing_instructions. It never fed the compiled image prompt —
-- composer.ts's compileTemplate only ever reads `slots` — and duplicated the wiki's now-settled
-- role as the durable per-entity/per-layer guidance mechanism (the wiki's three-path subscription
-- model, wiki.ts). Two LLM-authored surfaces read it: describeStudioSubject's appearance blurb
-- and the create-entity route's optional `seed`/description text, both of which now feed the slot
-- bootstrapper (describeStudioSlots) directly as ephemeral context and are never persisted.
-- Applied by hand against the dedicated BigImagine database, same as every post-0105 migration:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0114_drop_visual_entities_standing_instructions.sql

alter table visual_entities drop column standing_instructions;
