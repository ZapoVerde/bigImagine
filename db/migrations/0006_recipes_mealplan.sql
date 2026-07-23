-- Recipes & Meal Planning. Applied by hand, same as 0003/0004/0005:
--   psql -U bigbrain_admin -d bigbrain -f /docker-entrypoint-initdb.d/0006_recipes_mealplan.sql
-- (bigbrain_admin, not bigbrain_app — ALTER/CREATE TABLE needs owner/superuser privileges
-- bigbrain_app was deliberately never granted.)
--
-- recipes_meals (Phase 1 stub: recipe_id/user_id/meal_name only) gets the fields the
-- create/import flow actually produces. ingredients/instructions are jsonb, not child tables:
-- verified live against schema.org/Recipe (the industry-standard structured-data format every
-- serious recipe site embeds for Google's rich-snippet requirement) that even that spec stores
-- recipeIngredient as flat strings ("3 chicken breasts (300g/10oz each)"), not decomposed
-- qty/unit/item fields — nobody parses ingredient lines that far, including Google's own spec, so
-- there's no reason bigBrain should either. instructions preserves schema.org's optional
-- HowToSection grouping (a plain string, or {section, steps} when the source recipe has stages
-- like "Dry Brine" / "Sauce" / "Assembly") since it's one cheap nesting level and reads back much
-- better in chat than a flattened step list.
alter table recipes_meals add column ingredients   jsonb not null default '[]'::jsonb;
alter table recipes_meals add column instructions  jsonb not null default '[]'::jsonb;
alter table recipes_meals add column tags          text[] not null default '{}';
alter table recipes_meals add column prep_time     text;
alter table recipes_meals add column cook_time     text;
alter table recipes_meals add column servings      text;
alter table recipes_meals add column source_url    text;

-- Meal plan: deliberately just (date, recipe), no calendar/slot system — Communications Gateway
-- (calendar/Gmail, Phase 7) is explicitly parked, and a real slot enum (breakfast/lunch/dinner)
-- would start rebuilding that. meal_label is free text and nullable instead: null implies dinner
-- (the household's actual default), a label like "Breakfast"/"Lunch" only shows up on days that
-- deviate from that (e.g. Christmas: breakfast + lunch planned, no dinner). No uniqueness
-- constraint on (user_id, planned_date, meal_label) — replanning a date is an application-level
-- upsert (see plugins/recipes/src/addMealPlanEntryTool.ts), not a DB-enforced one, since a
-- household deliberately having two things planned for the same date/label is a fine outcome the
-- schema doesn't need to prevent.
create table meal_plan_entries (
  plan_entry_id uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(user_id),
  recipe_id     uuid not null references recipes_meals(recipe_id),
  planned_date  date not null,
  meal_label    text,
  created_at    timestamptz not null default now()
);

alter table meal_plan_entries enable row level security;
alter table meal_plan_entries force row level security;
create policy user_scoped on meal_plan_entries
  using (user_id = app_current_user_id()) with check (user_id = app_current_user_id());

grant select, insert, update, delete on meal_plan_entries to bigbrain_app;
