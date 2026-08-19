-- Preserve an operator's deliberate removal of a generated Wiki projection. Without this marker,
-- GET /v1/portraits/wiki sees a provisional lesson without an entry and immediately recreates it.
-- The lesson ledger remains intact and attributable; only its active Wiki projection is dismissed.
-- Applied by hand:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0124_portrait_wiki_dismissal.sql

alter table visual_lessons add column wiki_dismissed_at timestamptz null;
