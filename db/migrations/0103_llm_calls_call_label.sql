-- Widens llm_calls with call_label, the finer one-level-deeper label for 'system'-kind calls
-- (docs/plans/llm-call-label-breakdown-plan.md):
--
--   call_label  text — e.g. 'cleanup:header' / 'sync:bridge' / 'bg:location-description'.
--                     Null = kind 'chat'/'agent_routine' rows (out of scope — they already have
--                     their own distinct kind), rows written before this migration, or any
--                     'system' call this plan doesn't label.
--
-- Nullable, no backfill: pre-migration rows can't be reconstructed, and — unlike provider_kind/
-- model, where null always means "written before 0101" — a null call_label isn't necessarily a
-- pre-migration artifact (it may just be an unlabeled system call), so the admin endpoint and
-- the Stats page treat null as "no finer label" rather than substituting anything. The closed
-- label vocabulary this plan produces lives in the plan doc itself; the column stays plain text
-- so a future label needs no schema change.
--
-- Table-level grants already cover new columns (column-agnostic), so no grant change is needed —
-- same note as 0101.
--
-- Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0103_llm_calls_call_label.sql

alter table llm_calls
  add column call_label text;
