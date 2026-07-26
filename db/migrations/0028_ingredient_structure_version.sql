-- Explicit structuring-contract version for recipes_meals.ingredients, replacing the ad hoc
-- "does this row have a `modifier` key" trick (recipeIngredientSchema.ts) as the signal for
-- "needs re-structuring." That trick doesn't extend to a second contract change (a row already
-- re-structured for `modifier` wouldn't get flagged for metric unit conversion too) — a real
-- version number does, indefinitely. Nullable: every existing row (including ones already
-- re-structured for `modifier` earlier this feature's life) is null, and ensureStructuredIngredients.ts
-- treats null (or anything below CURRENT_STRUCTURE_VERSION, recipeIngredientSchema.ts) as
-- needing one more lazy re-structure, same self-healing shape as always — no backfill migration.
-- Applied by hand, same as 0026/0027:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0028_ingredient_structure_version.sql

alter table recipes_meals add column ingredient_structure_version integer;
