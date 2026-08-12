-- Per-region cleanup job tracking (docs/plans/in-stream-cleanup-plan.md).
--
-- Cleanup work now splits into three regions — header / body / footer — each evaluated and
-- recorded independently, so a message can be "covered" for one region while another is still
-- due (the live stream path records body+footer itself and lets the 5s poll tick own header,
-- or any combination the fail-open fallback needs). The old unique index keyed one job row per
-- (message, swipe); a message is now due until its active swipe has one row per region, so the
-- uniqueness constraint must move down to (message_id, swipe_id, region).
--
-- `default 'header'` only satisfies the not-null constraint for any pre-migration rows — every
-- row written from this plan onward always sets `region` explicitly. Migrations are append-only
-- per existing convention; old rows are deliberately not backfilled to a "correct" region.
--
-- The region column is covered by the existing table-level RLS policy and grants (they are
-- column-agnostic), so no grant or policy change is needed.
--
-- Applied by hand against the dedicated BigImagine database:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0090_cleanup_per_region_jobs.sql

alter table cleanup_jobs
  add column region text not null default 'header'
  check (region in ('header', 'body', 'footer'));

drop index cleanup_jobs_msg_swipe;

create unique index cleanup_jobs_msg_swipe_region
  on cleanup_jobs (message_id, swipe_id, region);
