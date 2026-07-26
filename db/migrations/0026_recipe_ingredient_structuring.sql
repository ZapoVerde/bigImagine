-- Recipe scaling (docs/bb_principles.md §2/§8: structuring free-text ingredients into
-- amount/unit/item is an LLM judgment call, scaling by a ratio is deterministic arithmetic —
-- never the LLM's job). Applied by hand, same as 0003-0025:
--   docker exec -i bigbrain-postgres psql -U bigbrain_admin -d bigbrain < db/migrations/0026_recipe_ingredient_structuring.sql
--
-- base_servings is the numeric figure a structuring pass resolves from the existing free-text
-- servings column (e.g. "4-6" -> 5) — servings itself is unchanged and stays the human-readable
-- display value; base_servings is purely the internal number scaling math divides against.
-- Nullable: legacy recipes (ingredients still a bare-string array, never structured) have no
-- base_servings until first touched by scale_recipe/generate_shopping_list_from_meal_plan, which
-- structure-and-persist lazily. Nothing reads/writes ingredients' internal shape via DDL — it
-- stays jsonb either way, holding either bare strings (legacy) or
-- {raw, amount, unit, item, scalable} objects (structured), disambiguated in code, not the schema.
alter table recipes_meals add column base_servings numeric;

-- target_servings is a per-planned-meal override ("scale this recipe to 8 for meal-prep week").
-- Null means "use the recipe's own base_servings, unscaled" — most planned meals never set this.
alter table meal_plan_entries add column target_servings numeric;
