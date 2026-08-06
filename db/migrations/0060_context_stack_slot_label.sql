-- Custom prompt-stack slots had no name of their own: markerLabel() gives marker slots a label for
-- free from marker_key (frontend/src/views/PromptStacksView.tsx), but a 'custom' slot rendered as
-- the indistinguishable "Custom block (system)" no matter what it actually said — noticed while
-- porting SillyTavern's "Comfy 2" preset in, where 8 of its custom blocks (Earthy Physicality, POV,
-- Location Tracker, ...) all collapsed to that one string in the UI.
--
-- Purely cosmetic: assemblePromptStack.ts's PromptStackSlot type deliberately stays "assembly-
-- relevant fields" only (its own doc comment) and does not gain a label field — a slot's assembled
-- output is unaffected either way, so this does not touch bi_principles.md §17's pure-function/
-- byte-identical-prefix contract. Nullable, no default: existing rows (the Standard/Minimal
-- builtins, and the Comfy 2 slots this migration's own follow-up backfills by hand) are unaffected
-- until a caller sets one.
--
-- Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0060_context_stack_slot_label.sql

alter table context_stack_slots add column label text;
