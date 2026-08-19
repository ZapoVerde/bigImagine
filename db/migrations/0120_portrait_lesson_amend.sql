-- Portrait Studio reflection: amend an existing lesson instead of duplicating it
-- (docs/plans/portrait-studio-lesson-amend-plan.md) — reflection always created a NEW
-- visual_lessons row + visual_wiki_entries row, even when an existing lesson already covered the
-- same ground, so the wiki filled up with near-duplicates. visual_lessons.state already had
-- 'superseded' and visual_wiki_revisions.kind already allowed 'amended' (migration 0118) — neither
-- was ever wired up; this migration only adds the one column the amend path needs to find which
-- entry to update. Applied by hand:
--   docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0120_portrait_lesson_amend.sql
--
-- visual_wiki_entries.lesson_id — direct FK from a wiki entry back to the lesson that currently
-- owns it. The reflection index formatter needs it to filter entries by subscription reach
-- (portraits/wiki.ts's new formatLessonIndex), and the amend path needs it to find which entry to
-- update in place. Replaces the fragile origin_episode_id -> visual_lessons.source_episode_id join
-- every prior reflection read used. Nullable — a manually-authored (operator, no reflection
-- origin) entry has none.
alter table visual_wiki_entries add column lesson_id uuid null references visual_lessons(lesson_id);
create index visual_wiki_entries_by_lesson on visual_wiki_entries (lesson_id) where lesson_id is not null;

-- Best-effort backfill for entries reflection already created: match by
-- origin_episode_id -> visual_lessons.source_episode_id, one lesson per episode (the create path
-- has only ever written at most one lesson per episode). A manually-authored or ambiguous entry is
-- simply left null — never an invented link.
update visual_wiki_entries w
set lesson_id = l.lesson_id
from visual_lessons l
where w.lesson_id is null
  and w.origin_episode_id is not null
  and l.source_episode_id = w.origin_episode_id
  and l.user_id = w.user_id;
