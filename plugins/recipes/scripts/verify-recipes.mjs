// Proves all eight tools end to end through info/registerTools (the real loader contract), using a
// stateful fake Postgres pool (recipes_meals/meal_plan_entries/lists/list_items/notion_sync_map),
// a fake LLM provider for the forced-schema extraction path, and a stubbed global fetch for the
// URL-import path — including a real-shaped schema.org/Recipe JSON-LD fixture (mirroring what was
// verified live against an actual recipetineats.com page) so the deterministic parse path is
// proven against realistic markup, not just a hand-simplified shape.

import { createPostgresClient } from '@bigbrain/orchestrator/postgres';
import { createToolRegistry } from '@bigbrain/orchestrator/tool-registry';
import { info, registerTools } from '../dist/index.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

function createFakePool() {
  const recipesMeals = [];
  const mealPlanEntries = [];
  const shoppingLogs = [];
  const lists = [];
  const listItems = [];
  const syncMap = [];
  let recipeCounter = 0;
  let planEntryCounter = 0;
  let listCounter = 0;
  let itemCounter = 0;

  return {
    recipesMeals,
    mealPlanEntries,
    shoppingLogs,
    lists,
    listItems,
    syncMap,
    async connect() {
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) return { rows: [] };

          if (sql.startsWith('insert into recipes_meals')) {
            const [userId, mealName, ingredients, instructions, tags, prepTime, cookTime, servings, sourceUrl] = params;
            const recipe_id = `recipe-${++recipeCounter}`;
            recipesMeals.push({
              recipe_id,
              user_id: userId,
              meal_name: mealName,
              ingredients: JSON.parse(ingredients),
              instructions: JSON.parse(instructions),
              tags,
              prep_time: prepTime,
              cook_time: cookTime,
              servings,
              base_servings: null,
              source_url: sourceUrl,
              is_favorite: false,
              ingredient_structure_version: null,
            });
            return { rows: [{ recipe_id }] };
          }

          // ensureStructuredIngredients.ts / structureNewRecipeBestEffort's persistence call —
          // checked before the generic 'update recipes_meals set' branch below, which it would
          // otherwise also match (same prefix).
          if (sql === 'update recipes_meals set ingredients = $1, base_servings = $2, ingredient_structure_version = $3 where recipe_id = $4') {
            const [ingredients, baseServings, structureVersion, recipeId] = params;
            const recipe = recipesMeals.find((r) => r.recipe_id === recipeId);
            if (recipe) {
              recipe.ingredients = JSON.parse(ingredients);
              recipe.base_servings = baseServings;
              recipe.ingredient_structure_version = structureVersion;
            }
            return { rows: [] };
          }

          if (sql.startsWith('update recipes_meals set')) {
            const [recipeId, userId, ...rest] = params;
            const recipe = recipesMeals.find((r) => r.recipe_id === recipeId && r.user_id === userId);
            if (!recipe) return { rows: [] };
            // sets order matches updateRecipeTool.ts: mealName?, ingredients?, instructions?, tags?, prepTime?, cookTime?, servings?, isFavorite?, base_servings?
            let i = 0;
            if (sql.includes('meal_name = $')) recipe.meal_name = rest[i++];
            if (sql.includes('ingredients = $')) recipe.ingredients = JSON.parse(rest[i++]);
            if (sql.includes('instructions = $')) recipe.instructions = JSON.parse(rest[i++]);
            if (sql.includes('tags = $')) recipe.tags = rest[i++];
            if (sql.includes('prep_time = $')) recipe.prep_time = rest[i++];
            if (sql.includes('cook_time = $')) recipe.cook_time = rest[i++];
            if (sql.includes('servings = $')) recipe.servings = rest[i++];
            if (sql.includes('is_favorite = $')) recipe.is_favorite = rest[i++];
            if (sql.includes('base_servings = $')) recipe.base_servings = rest[i++];
            return {
              rows: [
                {
                  recipe_id: recipe.recipe_id,
                  meal_name: recipe.meal_name,
                  ingredients: recipe.ingredients,
                  instructions: recipe.instructions,
                  tags: recipe.tags,
                  prep_time: recipe.prep_time,
                  cook_time: recipe.cook_time,
                  servings: recipe.servings,
                  base_servings: recipe.base_servings,
                  is_favorite: recipe.is_favorite,
                },
              ],
            };
          }

          if (sql.includes('unnest(tags)')) {
            const [userId, tag] = params;
            const rows = recipesMeals
              .filter((r) => r.user_id === userId && r.tags.some((t) => t.toLowerCase() === tag.toLowerCase()))
              .sort((a, b) => a.meal_name.localeCompare(b.meal_name));
            return { rows };
          }
          if (sql.startsWith('select recipe_id, meal_name, tags, prep_time, cook_time, servings, base_servings, is_favorite from recipes_meals')) {
            const [userId] = params;
            return { rows: recipesMeals.filter((r) => r.user_id === userId).sort((a, b) => a.meal_name.localeCompare(b.meal_name)) };
          }

          if (sql.includes('ingredients, instructions, tags')) {
            const [userId, likePattern, exact] = params;
            const needle = likePattern.replace(/%/g, '').toLowerCase();
            const match = recipesMeals
              .filter((r) => r.user_id === userId && r.meal_name.toLowerCase().includes(needle))
              .sort((a, b) => (a.meal_name.toLowerCase() === exact.toLowerCase() ? -1 : 1))[0];
            return { rows: match ? [match] : [] };
          }

          // scale_recipe's narrower select (no instructions/tags)
          if (sql.startsWith('select recipe_id, meal_name, ingredients, servings, base_servings, ingredient_structure_version')) {
            const [userId, likePattern, exact] = params;
            const needle = likePattern.replace(/%/g, '').toLowerCase();
            const match = recipesMeals
              .filter((r) => r.user_id === userId && r.meal_name.toLowerCase().includes(needle))
              .sort((a, b) => (a.meal_name.toLowerCase() === exact.toLowerCase() ? -1 : 1))[0];
            return { rows: match ? [match] : [] };
          }

          if (sql.startsWith('select recipe_id, meal_name from recipes_meals')) {
            const [userId, likePattern, exact] = params;
            const needle = likePattern.replace(/%/g, '').toLowerCase();
            const match = recipesMeals
              .filter((r) => r.user_id === userId && r.meal_name.toLowerCase().includes(needle))
              .sort((a, b) => (a.meal_name.toLowerCase() === exact.toLowerCase() ? -1 : 1))[0];
            return { rows: match ? [{ recipe_id: match.recipe_id, meal_name: match.meal_name }] : [] };
          }

          if (sql.includes('select plan_entry_id from meal_plan_entries')) {
            const [userId, plannedDate, mealLabel] = params;
            const match = mealPlanEntries.find(
              (e) => e.user_id === userId && e.planned_date === plannedDate && (e.meal_label ?? null) === (mealLabel ?? null),
            );
            return { rows: match ? [{ plan_entry_id: match.plan_entry_id }] : [] };
          }
          if (sql.startsWith('update meal_plan_entries')) {
            const [planEntryId, recipeId, targetServings] = params;
            const entry = mealPlanEntries.find((e) => e.plan_entry_id === planEntryId);
            if (entry) {
              entry.recipe_id = recipeId;
              entry.target_servings = targetServings ?? null;
            }
            return { rows: [] };
          }
          if (sql.startsWith('insert into meal_plan_entries')) {
            const [userId, recipeId, plannedDate, mealLabel, targetServings] = params;
            mealPlanEntries.push({
              plan_entry_id: `plan-${++planEntryCounter}`,
              user_id: userId,
              recipe_id: recipeId,
              planned_date: plannedDate,
              meal_label: mealLabel ?? null,
              target_servings: targetServings ?? null,
            });
            return { rows: [] };
          }

          if (sql.includes('mpe.planned_date, mpe.meal_label')) {
            const [userId, start, end] = params;
            const rows = mealPlanEntries
              .filter((e) => e.user_id === userId && e.planned_date >= start && e.planned_date <= end)
              .map((e) => {
                const recipe = recipesMeals.find((r) => r.recipe_id === e.recipe_id);
                return {
                  planned_date: e.planned_date,
                  meal_label: e.meal_label,
                  meal_name: recipe.meal_name,
                  recipe_id: recipe.recipe_id,
                  target_servings: e.target_servings ?? null,
                };
              })
              .sort((a, b) => a.planned_date.localeCompare(b.planned_date));
            return { rows };
          }

          if (sql.startsWith('select planned_date from meal_plan_entries')) {
            const [recipeId, userId] = params;
            const rows = mealPlanEntries
              .filter((e) => e.recipe_id === recipeId && e.user_id === userId)
              .map((e) => ({ planned_date: e.planned_date }));
            return { rows };
          }
          if (sql.startsWith('select count(*)::text as count from shopping_logs')) {
            const [recipeId, userId] = params;
            const count = shoppingLogs.filter((l) => l.recipe_id === recipeId && l.user_id === userId).length;
            return { rows: [{ count: String(count) }] };
          }
          if (sql.startsWith('delete from recipes_meals')) {
            const [recipeId, userId] = params;
            const idx = recipesMeals.findIndex((r) => r.recipe_id === recipeId && r.user_id === userId);
            if (idx === -1) return { rows: [] };
            const [removed] = recipesMeals.splice(idx, 1);
            return { rows: [{ recipe_id: removed.recipe_id, meal_name: removed.meal_name }] };
          }

          if (sql.startsWith('select rm.recipe_id, rm.meal_name, rm.ingredients')) {
            const [userId, start, end] = params;
            const rows = mealPlanEntries
              .filter((e) => e.user_id === userId && e.planned_date >= start && e.planned_date <= end)
              .map((e) => {
                const recipe = recipesMeals.find((r) => r.recipe_id === e.recipe_id);
                return {
                  recipe_id: recipe.recipe_id,
                  meal_name: recipe.meal_name,
                  ingredients: recipe.ingredients,
                  servings: recipe.servings,
                  base_servings: recipe.base_servings ?? null,
                  target_servings: e.target_servings ?? null,
                  ingredient_structure_version: recipe.ingredient_structure_version ?? null,
                };
              });
            return { rows };
          }

          if (sql.includes('select section_order from lists where list_id')) {
            const [listId] = params;
            const list = lists.find((l) => l.list_id === listId);
            return { rows: list ? [{ section_order: list.section_order ?? [] }] : [] };
          }
          if (sql.startsWith('select list_id from lists')) {
            const [userId, name] = params;
            const match = lists.find((l) => l.user_id === userId && l.name.toLowerCase() === name.toLowerCase());
            return { rows: match ? [{ list_id: match.list_id }] : [] };
          }
          if (sql.startsWith('insert into lists')) {
            const [userId, name] = params;
            const list_id = `list-${++listCounter}`;
            lists.push({ list_id, user_id: userId, name, section_order: [] });
            return { rows: [{ list_id }] };
          }
          if (sql.startsWith('select item_name from list_items')) {
            const [listId] = params;
            return { rows: listItems.filter((i) => i.list_id === listId && i.status === 'pending').map((i) => ({ item_name: i.item_name })) };
          }
          if (sql.startsWith('insert into list_items')) {
            const [listId, userId, itemName, section] = params;
            const item_id = `item-${++itemCounter}`;
            listItems.push({ item_id, list_id: listId, user_id: userId, item_name: itemName, section: section ?? null, status: 'pending' });
            return { rows: [{ item_id }] };
          }
          if (sql.startsWith('insert into notion_sync_map')) {
            const [userId, sourceTable, sourceRowId, notionDatabaseId, notionPageId] = params;
            syncMap.push({ user_id: userId, source_table: sourceTable, source_row_id: sourceRowId, notion_database_id: notionDatabaseId, notion_page_id: notionPageId });
            return { rows: [] };
          }

          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

// A safe, generic response for structureIngredientsWithLlm.ts's forced structure_ingredients call
// — every ingredient line comes back non-scalable, using the original line text as `item`, so
// aggregateScaledIngredients.ts still dedupes/names items exactly the way tests written before the
// structuring feature already expect (e.g. "flour" in, "flour" out). baseServings is a fixed
// nonzero placeholder: shoppingListFromMealPlanTool.ts's ratio always resolves to 1 in these tests
// (no meal_plan_entries.target_servings is ever set), so its actual value never affects scaling —
// it only has to be non-null so the recipe doesn't get skipped as "no discoverable serving count".
const FAKE_STRUCTURED_BASE_SERVINGS = 4;

function defaultStructureIngredientsResponse(messages) {
  const content = messages[1].content;
  const ingredientsSection = content.split('Ingredients:\n')[1] ?? '';
  const items = ingredientsSection
    .split('\n')
    .filter(Boolean)
    .map((line) => line.replace(/^\d+\.\s*/, ''));
  return {
    lines: items.map((item) => ({ amount: null, unit: null, item, modifier: null, scalable: false })),
    baseServings: FAKE_STRUCTURED_BASE_SERVINGS,
  };
}

function createFakeLlm(responder) {
  const calls = [];
  return {
    name: 'fake',
    calls,
    async complete(messages, _tools, options) {
      calls.push({ messages, options });
      // create_recipe/import_recipe (best-effort, eager) and scale_recipe/shopping-list
      // (required, lazy) all funnel through this one forced tool — handled generically here so
      // every test's own `responder` only ever has to answer for extraction/classification, the
      // calls it actually cares about.
      if (options.forceTool === 'structure_ingredients') {
        return {
          message: { role: 'assistant', content: '' },
          toolCalls: [{ id: `call-${calls.length}`, name: 'structure_ingredients', arguments: defaultStructureIngredientsResponse(messages) }],
        };
      }
      return { message: { role: 'assistant', content: '' }, toolCalls: [{ id: 'call-1', name: options.forceTool, arguments: responder(messages) }] };
    },
  };
}

function createFakeNotion(ownerUserId = userId) {
  const calls = [];
  let pageCounter = 0;
  return {
    calls,
    listsDataSourceId: 'fake-data-source-id',
    ownerUserId,
    async upsertListItemPage(args) {
      calls.push(args);
      return { pageId: `notion-page-${++pageCounter}` };
    },
  };
}

const RECIPE_JSON_LD_HTML = `<html><head>
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'Article', headline: 'irrelevant' },
    {
      '@type': 'Recipe',
      name: 'Test Tacos',
      recipeIngredient: ['2 cups flour', '1 onion, diced', '1 tsp salt'],
      recipeInstructions: [
        { '@type': 'HowToSection', name: 'Filling:', itemListElement: [{ '@type': 'HowToStep', text: 'Cook the onion.' }] },
      ],
      recipeYield: ['4'],
      prepTime: 'PT10M',
      cookTime: 'PT20M',
      recipeCategory: ['Mains'],
      recipeCuisine: ['Mexican'],
      keywords: 'tacos, dinner',
    },
  ],
})}</script>
</head><body>whatever</body></html>`;

const NO_MARKUP_HTML = `<html><body><h1>Grandma's Soup</h1><p>2 cups broth</p><p>Boil it for 10 minutes.</p></body></html>`;

assert(info.id === 'recipes' && /^[a-z0-9_-]+$/.test(info.id), 'info.id is present and matches the id format pluginLoader.ts requires');

const userId = '11111111-1111-1111-1111-111111111111';

// --- import_recipe: raw_text goes straight to the LLM extraction path ---
{
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const llm = createFakeLlm(() => ({
    mealName: 'Grandma Soup',
    ingredients: ['2 cups broth', 'noodles'],
    instructions: ['Boil the broth.', 'Add noodles.'],
    tags: ['Soup'],
    prepTime: '5 min',
    cookTime: '15 min',
  }));
  const notion = createFakeNotion();
  const tools = await registerTools({ llm, embeddings: null, cipher: null, notion });
  assert(tools.length === 10, 'registerTools returns exactly ten tools');
  const registry = createToolRegistry(tools);
  for (const name of [
    'import_recipe',
    'create_recipe',
    'get_recipes',
    'get_recipe',
    'update_recipe',
    'delete_recipe',
    'add_meal_plan_entry',
    'get_meal_plan',
    'generate_shopping_list_from_meal_plan',
    'scale_recipe',
  ]) {
    assert(registry.definitions().some((d) => d.name === name), `${name} is registered`);
  }

  const result = await db.withUserScope(userId, (session) =>
    registry.get('import_recipe').handler({ raw_text: 'broth, noodles, boil it' }, { userId, db: session }),
  );
  assert(llm.calls.filter((c) => c.options.forceTool === 'extract_recipe').length === 1, 'raw_text import called the LLM extraction path');
  assert(llm.calls.some((c) => c.options.forceTool === 'structure_ingredients'), 'the imported recipe was also best-effort structured');
  assert(result.mealName === 'Grandma Soup', 'the LLM-extracted recipe was inserted');
  assert(pool.recipesMeals[0].ingredients.length === 2, 'ingredients were stored as a parsed array');
  assert(pool.recipesMeals[0].source_url === null, 'no source_url is recorded for a raw_text import');
  assert(typeof pool.recipesMeals[0].base_servings === 'number', 'structuring persisted a base_servings for the newly-imported recipe');
}

// --- import_recipe: url with real-shaped schema.org/Recipe JSON-LD takes the deterministic path ---
{
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const llm = createFakeLlm(() => {
    throw new Error('LLM should not be called when JSON-LD parsing succeeds');
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(RECIPE_JSON_LD_HTML, { status: 200 });
  try {
    const tools = await registerTools({ llm, embeddings: null, cipher: null, notion: undefined });
    const registry = createToolRegistry(tools);
    const result = await db.withUserScope(userId, (session) =>
      registry.get('import_recipe').handler({ url: 'https://example.com/tacos' }, { userId, db: session }),
    );
    assert(result.mealName === 'Test Tacos', 'the schema.org Recipe node was parsed deterministically');
    const stored = pool.recipesMeals[0];
    assert(stored.ingredients.length === 3, 'ingredients were taken verbatim as flat strings, not decomposed');
    assert(stored.instructions[0].section === 'Filling:' && stored.instructions[0].steps[0] === 'Cook the onion.', 'HowToSection grouping was preserved');
    assert(stored.tags.includes('Mains') && stored.tags.includes('Mexican') && stored.tags.includes('tacos'), 'category/cuisine/keywords were folded into tags');
    assert(stored.prep_time === '10 min' && stored.cook_time === '20 min', 'ISO 8601 durations were humanized');
    assert(stored.source_url === 'https://example.com/tacos', 'the source URL is recorded');
    assert(
      llm.calls.length === 1 && llm.calls[0].options.forceTool === 'structure_ingredients',
      'the LLM was never asked to extract (deterministic parse succeeded) but was still used for best-effort structuring afterward',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- import_recipe: url with no JSON-LD falls back to the LLM path over the page's stripped text ---
{
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const llm = createFakeLlm((messages) => {
    const sourceText = messages[1].content;
    if (!sourceText.includes("Grandma's Soup")) throw new Error('expected stripped page text to reach the LLM');
    return { mealName: "Grandma's Soup", ingredients: ['2 cups broth'], instructions: ['Boil it.'], tags: [] };
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(NO_MARKUP_HTML, { status: 200 });
  try {
    const tools = await registerTools({ llm, embeddings: null, cipher: null, notion: undefined });
    const registry = createToolRegistry(tools);
    const result = await db.withUserScope(userId, (session) =>
      registry.get('import_recipe').handler({ url: 'https://example.com/soup' }, { userId, db: session }),
    );
    assert(llm.calls.filter((c) => c.options.forceTool === 'extract_recipe').length === 1, 'a page with no JSON-LD falls back to the LLM path');
    assert(llm.calls.some((c) => c.options.forceTool === 'structure_ingredients'), 'the fallback-extracted recipe was also best-effort structured');
    assert(result.mealName === "Grandma's Soup", 'the LLM-fallback recipe was inserted');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- import_recipe: args validation rejects neither-or-both ---
{
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const llm = createFakeLlm(() => ({ mealName: 'x', ingredients: ['x'], instructions: [], tags: [] }));
  const tools = await registerTools({ llm, embeddings: null, cipher: null, notion: undefined });
  const registry = createToolRegistry(tools);
  for (const badArgs of [{}, { url: 'https://a', raw_text: 'b' }]) {
    try {
      await db.withUserScope(userId, (session) => registry.get('import_recipe').handler(badArgs, { userId, db: session }));
      assert(false, `import_recipe rejects ${JSON.stringify(badArgs)}`);
    } catch {
      assert(true, `import_recipe rejects ${JSON.stringify(badArgs)}`);
    }
  }
}

// --- create_recipe: structured fields inserted directly (no extraction call), but still
// best-effort structures ingredients/base_servings afterward, same as import_recipe ---
{
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const llm = createFakeLlm(() => {
    throw new Error('create_recipe must never call the LLM for extraction — it already has structured fields');
  });
  const tools = await registerTools({ llm, embeddings: null, cipher: null, notion: undefined });
  const registry = createToolRegistry(tools);
  const createTool = registry.get('create_recipe');

  const result = await db.withUserScope(userId, (session) =>
    createTool.handler(
      {
        mealName: 'Weeknight Stir Fry',
        ingredients: ['2 chicken breasts', '1 bell pepper'],
        instructions: ['Slice everything.', 'Stir fry over high heat.'],
        tags: ['Quick'],
        prepTime: '10 min',
      },
      { userId, db: session },
    ),
  );
  assert(
    llm.calls.length === 1 && llm.calls[0].options.forceTool === 'structure_ingredients',
    'create_recipe never calls the LLM for extraction — only once, best-effort, to structure ingredients',
  );
  assert(result.mealName === 'Weeknight Stir Fry' && result.ingredientCount === 2, 'create_recipe stores the given fields directly');
  const stored = pool.recipesMeals.find((r) => r.recipe_id === result.recipeId);
  assert(stored.source_url === null, 'create_recipe records no source_url — nothing was imported');
  assert(stored.prep_time === '10 min' && stored.cook_time === null, 'create_recipe stores given optional fields and defaults omitted ones to null');

  const untagged = await db.withUserScope(userId, (session) =>
    createTool.handler({ mealName: 'Toast', ingredients: ['bread'], instructions: ['Toast it.'] }, { userId, db: session }),
  );
  assert(untagged.tags.length === 0, 'create_recipe defaults tags to an empty array when omitted');

  for (const badArgs of [{ mealName: 'No ingredients', ingredients: [], instructions: [] }, { ingredients: ['x'], instructions: [] }]) {
    try {
      await db.withUserScope(userId, (session) => createTool.handler(badArgs, { userId, db: session }));
      assert(false, `create_recipe rejects ${JSON.stringify(badArgs)}`);
    } catch {
      assert(true, `create_recipe rejects ${JSON.stringify(badArgs)}`);
    }
  }
}

// --- update_recipe: partial-patch semantics and cross-user isolation ---
{
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const llm = createFakeLlm(() => {
    throw new Error('update_recipe must never call the LLM for extraction/classification');
  });
  const tools = await registerTools({ llm, embeddings: null, cipher: null, notion: undefined });
  const registry = createToolRegistry(tools);
  const createTool = registry.get('create_recipe');
  const updateTool = registry.get('update_recipe');
  const otherUserId = '22222222-2222-2222-2222-222222222222';

  const created = await db.withUserScope(userId, (session) =>
    createTool.handler({ mealName: 'Draft Curry', ingredients: ['curry paste'], instructions: ['Simmer.'], tags: ['Thai'] }, { userId, db: session }),
  );
  const callsAfterSeedCreate = llm.calls.length; // one best-effort structuring call from create_recipe above

  const updated = await db.withUserScope(userId, (session) =>
    updateTool.handler({ recipe_id: created.recipeId, ingredients: ['curry paste', 'coconut milk'] }, { userId, db: session }),
  );
  assert(updated.found === true && updated.ingredients.length === 2, 'update_recipe changes only the given field');
  assert(updated.mealName === 'Draft Curry', 'update_recipe leaves an unspecified field untouched');

  const updateMissing = await db.withUserScope(userId, (session) =>
    updateTool.handler({ recipe_id: 'does-not-exist', mealName: 'x' }, { userId, db: session }),
  );
  assert(updateMissing.found === false, 'update_recipe reports not-found for a missing recipe rather than throwing');

  const crossUserUpdate = await db.withUserScope(otherUserId, (session) =>
    updateTool.handler({ recipe_id: created.recipeId, mealName: 'Hijacked' }, { userId: otherUserId, db: session }),
  );
  assert(crossUserUpdate.found === false, 'update_recipe cannot modify another user\'s recipe');

  try {
    await db.withUserScope(userId, (session) => updateTool.handler({ recipe_id: created.recipeId }, { userId, db: session }));
    assert(false, 'update_recipe rejects a call with no fields to change');
  } catch {
    assert(true, 'update_recipe rejects a call with no fields to change');
  }

  assert(llm.calls.length === callsAfterSeedCreate, 'update_recipe itself never calls the LLM (only the seed create_recipe call above did)');
}

// --- get_recipes / get_recipe, and the meal-plan + shopping-list flow, sharing one populated pool ---
{
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const llm = createFakeLlm(() => ({ mealName: 'unused', ingredients: ['x'], instructions: [], tags: [] }));
  const notion = createFakeNotion();
  const tools = await registerTools({ llm, embeddings: null, cipher: null, notion });
  const registry = createToolRegistry(tools);
  const withUser = (fn) => db.withUserScope(userId, (session) => fn({ userId, db: session }));
  const call = (name, args) => withUser((ctx) => registry.get(name).handler(args, ctx));

  const insertRecipe = (mealName, ingredients, tags = []) =>
    pool.recipesMeals.push({
      recipe_id: `seed-${mealName}`,
      user_id: userId,
      meal_name: mealName,
      ingredients,
      instructions: [],
      tags,
      prep_time: null,
      cook_time: null,
      servings: null,
      base_servings: null,
      source_url: null,
      is_favorite: false,
      ingredient_structure_version: null,
    });

  insertRecipe('Chicken Parmigiana', ['chicken breast', 'flour', 'onion'], ['Italian', 'Mains']);
  insertRecipe('Pancakes', ['flour', 'eggs', 'milk'], ['Breakfast']);

  // --- get_recipes ---
  const all = await call('get_recipes', {});
  assert(all.length === 2, 'get_recipes lists every recipe for the user');
  const italianOnly = await call('get_recipes', { tag: 'italian' });
  assert(italianOnly.length === 1 && italianOnly[0].mealName === 'Chicken Parmigiana', 'get_recipes filters case-insensitively by tag');

  // --- get_recipe ---
  const found = await call('get_recipe', { meal_name: 'pancakes' });
  assert(found.found === true && found.ingredients.length === 3, 'get_recipe finds a recipe case-insensitively with full detail');
  const notFound = await call('get_recipe', { meal_name: 'nonexistent dish' });
  assert(notFound.found === false, 'get_recipe returns found:false rather than throwing for no match');

  // --- add_meal_plan_entry: unknown recipe ---
  const unknownPlan = await call('add_meal_plan_entry', { meal_name: 'nonexistent dish', planned_date: '2026-12-25' });
  assert(unknownPlan.planned === false, 'planning a nonexistent recipe fails softly');

  // --- add_meal_plan_entry: the Christmas scenario — breakfast + lunch planned, no dinner ---
  await call('add_meal_plan_entry', { meal_name: 'Pancakes', planned_date: '2026-12-25', meal_label: 'Breakfast' });
  await call('add_meal_plan_entry', { meal_name: 'Chicken Parmigiana', planned_date: '2026-12-25', meal_label: 'Lunch' });
  assert(pool.mealPlanEntries.filter((e) => e.planned_date === '2026-12-25').length === 2, 'two differently-labeled entries coexist on the same date');

  // --- add_meal_plan_entry: default dinner (no label), then replanning replaces it ---
  const firstPlan = await call('add_meal_plan_entry', { meal_name: 'Pancakes', planned_date: '2026-12-20' });
  assert(firstPlan.replaced === false && firstPlan.mealLabel === null, 'a plain plan entry defaults to no label (implied dinner)');
  const replacedPlan = await call('add_meal_plan_entry', { meal_name: 'Chicken Parmigiana', planned_date: '2026-12-20' });
  assert(replacedPlan.replaced === true, 'replanning the same date/label replaces rather than duplicates');
  assert(pool.mealPlanEntries.filter((e) => e.planned_date === '2026-12-20' && e.meal_label === null).length === 1, 'only one entry exists for that date/label after replanning');

  // --- get_meal_plan ---
  const range = await call('get_meal_plan', { start_date: '2026-12-25', end_date: '2026-12-25' });
  assert(range.length === 2, 'get_meal_plan returns both Christmas entries for that date');
  assert(range.some((e) => e.mealLabel === 'Breakfast') && range.some((e) => e.mealLabel === 'Lunch'), 'both labels are present');
  const noArgsRange = await call('get_meal_plan', {});
  assert(Array.isArray(noArgsRange), 'get_meal_plan with no args uses its default date range without throwing');

  // --- generate_shopping_list_from_meal_plan: aggregates + dedupes across both Christmas meals ---
  const shoppingList = await call('generate_shopping_list_from_meal_plan', { start_date: '2026-12-25', end_date: '2026-12-25' });
  assert(shoppingList.mealsConsidered === 2, 'both Christmas meals were considered');
  assert(shoppingList.itemsAdded.length === new Set(shoppingList.itemsAdded.map((i) => i.toLowerCase())).size, 'no duplicate ingredient names within the added list');
  assert(shoppingList.itemsAdded.some((i) => i.toLowerCase() === 'flour'), 'flour (shared by both meals) was added exactly once, not twice');
  assert(pool.lists.some((l) => l.name === 'Grocery List'), 'the default "Grocery List" was created');
  assert(notion.calls.length === shoppingList.itemsAdded.length, 'every newly-added item was pushed to Notion');
  assert(pool.syncMap.length === shoppingList.itemsAdded.length, 'a notion_sync_map row exists for every newly-added item');

  // --- running it again for an overlapping range skips already-pending items ---
  const secondRun = await call('generate_shopping_list_from_meal_plan', { start_date: '2026-12-25', end_date: '2026-12-25' });
  assert(secondRun.itemsAdded.length === 0, 'a second run over the same range adds nothing new');
  assert(secondRun.itemsSkipped.length > 0, 'ingredients already pending on the list are reported as skipped');
}

// --- generate_shopping_list_from_meal_plan: notion undefined is a clean no-op ---
{
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const llm = createFakeLlm(() => ({ mealName: 'unused', ingredients: ['x'], instructions: [], tags: [] }));
  const tools = await registerTools({ llm, embeddings: null, cipher: null, notion: undefined });
  const registry = createToolRegistry(tools);
  pool.recipesMeals.push({
    recipe_id: 'seed-only',
    user_id: userId,
    meal_name: 'Only Dish',
    ingredients: ['salt'],
    instructions: [],
    tags: [],
    prep_time: null,
    cook_time: null,
    servings: null,
    base_servings: null,
    source_url: null,
    is_favorite: false,
    ingredient_structure_version: null,
  });
  await db.withUserScope(userId, (session) =>
    registry.get('add_meal_plan_entry').handler({ meal_name: 'Only Dish', planned_date: '2026-08-01' }, { userId, db: session }),
  );
  const result = await db.withUserScope(userId, (session) =>
    registry.get('generate_shopping_list_from_meal_plan').handler({ start_date: '2026-08-01', end_date: '2026-08-01' }, { userId, db: session }),
  );
  assert(result.itemsAdded.length === 1, 'shopping list generation still works with Notion unconfigured');
  assert(pool.syncMap.length === 0, 'no sync bookkeeping happens when notion is undefined');
}

// --- generate_shopping_list_from_meal_plan: a non-owner user's items stay Postgres-only, even
// though Notion IS configured — this gateway syncs one workspace to one owning user only ---
{
  const nonOwnerUserId = '55555555-5555-5555-5555-555555555555'; // deliberately not notion.ownerUserId
  const notion = createFakeNotion(userId); // ownerUserId is the main test user, not nonOwnerUserId
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const llm = createFakeLlm(() => ({ mealName: 'unused', ingredients: ['x'], instructions: [], tags: [] }));
  const tools = await registerTools({ llm, embeddings: null, cipher: null, notion });
  const registry = createToolRegistry(tools);
  pool.recipesMeals.push({
    recipe_id: 'seed-nonowner',
    user_id: nonOwnerUserId,
    meal_name: 'Non-Owner Dish',
    ingredients: ['pepper'],
    instructions: [],
    tags: [],
    prep_time: null,
    cook_time: null,
    servings: null,
    base_servings: null,
    source_url: null,
    is_favorite: false,
    ingredient_structure_version: null,
  });
  await db.withUserScope(nonOwnerUserId, (session) =>
    registry.get('add_meal_plan_entry').handler({ meal_name: 'Non-Owner Dish', planned_date: '2026-08-01' }, { userId: nonOwnerUserId, db: session }),
  );
  const result = await db.withUserScope(nonOwnerUserId, (session) =>
    registry
      .get('generate_shopping_list_from_meal_plan')
      .handler({ start_date: '2026-08-01', end_date: '2026-08-01' }, { userId: nonOwnerUserId, db: session }),
  );
  assert(result.itemsAdded.length === 1, "a non-owner user's shopping list generation still works in Postgres");
  assert(notion.calls.length === 0, "a non-owner user's items never reach the Notion API, even with Notion configured");
  assert(pool.syncMap.length === 0, 'no notion_sync_map row is created for a non-owner user');
}

// --- generate_shopping_list_from_meal_plan: classifies each new item into its target list's
// section_order, same as plugins/lists' add_list_item does for manually-added items ---
{
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const sectionLlm = createFakeLlm((messages) => {
    const itemName = messages[1].content.toLowerCase();
    return { section: itemName.includes('flour') ? 'baking' : itemName.includes('onion') ? 'veggies' : 'other' };
  });
  const tools = await registerTools({ llm: sectionLlm, embeddings: null, cipher: null, notion: undefined });
  const registry = createToolRegistry(tools);

  pool.recipesMeals.push({
    recipe_id: 'seed-sectioned',
    user_id: userId,
    meal_name: 'Sectioned Dish',
    ingredients: ['flour', 'onion'],
    instructions: [],
    tags: [],
    prep_time: null,
    cook_time: null,
    servings: null,
    base_servings: null,
    source_url: null,
    is_favorite: false,
    ingredient_structure_version: null,
  });
  // Pre-define the target list's section order, same as plugins/lists' set_list_section_order —
  // duplicated here since this fake pool doesn't share state with that plugin's own tests.
  pool.lists.push({ list_id: 'sectioned-list', user_id: userId, name: 'Grocery List', section_order: ['veggies', 'baking'] });

  await db.withUserScope(userId, (session) =>
    registry.get('add_meal_plan_entry').handler({ meal_name: 'Sectioned Dish', planned_date: '2026-08-02' }, { userId, db: session }),
  );
  const result = await db.withUserScope(userId, (session) =>
    registry
      .get('generate_shopping_list_from_meal_plan')
      .handler({ start_date: '2026-08-02', end_date: '2026-08-02' }, { userId, db: session }),
  );

  assert(result.itemsAdded.length === 2, 'both ingredients were added to the pre-existing sectioned list');
  const classifyCalls = sectionLlm.calls.filter((c) => c.options.forceTool === 'classify_section');
  assert(classifyCalls.length === 2, 'each new ingredient triggered exactly one section classification call');
  assert(pool.listItems.find((i) => i.item_name === 'flour').section === 'baking', 'flour was classified into the baking section');
  assert(pool.listItems.find((i) => i.item_name === 'onion').section === 'veggies', 'onion was classified into the veggies section');
}

// --- delete_recipe: blocks when still planned or logged, succeeds otherwise, is user-scoped ---
{
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const notion = createFakeNotion();
  const tools = await registerTools({ llm: createFakeLlm(() => ({})), embeddings: null, cipher: null, notion });
  const registry = createToolRegistry(tools);
  const withUser = (fn) => db.withUserScope(userId, (session) => fn({ userId, db: session }));
  const seedRecipe = (recipeId, mealName) =>
    pool.recipesMeals.push({
      recipe_id: recipeId,
      user_id: userId,
      meal_name: mealName,
      ingredients: [],
      instructions: [],
      tags: [],
      prep_time: null,
      cook_time: null,
      servings: null,
      source_url: null,
      is_favorite: false,
      ingredient_structure_version: null,
    });

  seedRecipe('planned-recipe', 'Planned Dish');
  pool.mealPlanEntries.push({ plan_entry_id: 'plan-x', user_id: userId, recipe_id: 'planned-recipe', planned_date: '2026-08-05', meal_label: null });

  let plannedError;
  try {
    await withUser((ctx) => registry.get('delete_recipe').handler({ recipe_id: 'planned-recipe' }, ctx));
  } catch (err) {
    plannedError = err;
  }
  assert(plannedError instanceof Error && /meal plan/i.test(plannedError.message), 'delete_recipe throws a descriptive error when the recipe is still planned');
  assert(pool.recipesMeals.some((r) => r.recipe_id === 'planned-recipe'), 'the recipe still exists after a blocked delete');

  seedRecipe('logged-recipe', 'Logged Dish');
  pool.shoppingLogs.push({ log_id: 'log-1', user_id: userId, recipe_id: 'logged-recipe', item_name: 'broth', is_staple: false });

  let loggedError;
  try {
    await withUser((ctx) => registry.get('delete_recipe').handler({ recipe_id: 'logged-recipe' }, ctx));
  } catch (err) {
    loggedError = err;
  }
  assert(loggedError instanceof Error && /shopping log/i.test(loggedError.message), 'delete_recipe throws a descriptive error when the recipe is still referenced by a shopping log entry');
  assert(pool.recipesMeals.some((r) => r.recipe_id === 'logged-recipe'), 'the recipe still exists after being blocked by a shopping log reference');

  seedRecipe('free-recipe', 'Free Dish');
  const deleted = await withUser((ctx) => registry.get('delete_recipe').handler({ recipe_id: 'free-recipe' }, ctx));
  assert(deleted.deleted === true && deleted.mealName === 'Free Dish', 'delete_recipe succeeds for a recipe with no meal-plan or shopping-log references');
  assert(!pool.recipesMeals.some((r) => r.recipe_id === 'free-recipe'), 'the deleted recipe is gone from recipes_meals');

  const missing = await withUser((ctx) => registry.get('delete_recipe').handler({ recipe_id: 'no-such-recipe' }, ctx));
  assert(missing.deleted === false, 'delete_recipe on a nonexistent id returns deleted: false rather than throwing');

  seedRecipe('someone-elses-recipe', 'Someone Elses Dish');
  const otherUserId = '99999999-9999-9999-9999-999999999999';
  const wrongUserResult = await db.withUserScope(otherUserId, (session) =>
    registry.get('delete_recipe').handler({ recipe_id: 'someone-elses-recipe' }, { userId: otherUserId, db: session }),
  );
  assert(wrongUserResult.deleted === false, 'delete_recipe is user-scoped: another user cannot delete this recipe');
  assert(pool.recipesMeals.some((r) => r.recipe_id === 'someone-elses-recipe'), 'the recipe survives a wrong-user delete attempt');
}

if (process.exitCode) {
  console.error('\nrecipes verification FAILED');
  process.exit(1);
}
console.log('\nrecipes verification passed');
