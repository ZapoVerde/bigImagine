-- characters.appearance — physical-description column split out of persona
-- (docs/plans/character-appearance-field-plan.md). `persona` keeps its existing role (card-export
-- description, prompt-stack description slot) untouched; `appearance` is a new fixed-at-creation
-- column holding only physically inherent traits ("body type, height, build, bone structure,
-- facial features, natural hair colour and texture, permanent features such as scars or
-- birthmarks" — exclude clothing, accessories, current hairstyle, injuries), the exact line
-- SillyTavern-Canonize's people curator already draws for its `## Appearance` section and the
-- field Portrait Studio's from-character seeding prefers. Same shape as the existing `persona`
-- column (text not null default ''), so an empty value is the "never described" sentinel and the
-- two fields are independently frozen-once-set (bi_principles.md §3, applied per-column).
--
-- Table-level grants already cover new columns, so no grant change is needed.
--
-- Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0110_character_appearance.sql

alter table characters add column appearance text not null default '';
