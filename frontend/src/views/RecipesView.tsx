import { useEffect, useState } from 'react';
import { ApiError, callTool } from '../api/client';
import type { ImportRecipeResult, RecipeDetailResult, RecipeSummary } from '../api/types';
import './RecipesView.css';

interface RecipesViewProps {
  apiKey: string | null;
}

export default function RecipesView({ apiKey }: RecipesViewProps) {
  const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [detail, setDetail] = useState<RecipeDetailResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importUrl, setImportUrl] = useState('');
  const [importing, setImporting] = useState(false);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      setRecipes(await callTool<RecipeSummary[]>('get_recipes', {}, apiKey));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to load recipes');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openRecipe(mealName: string) {
    setError(null);
    try {
      setDetail(await callTool<RecipeDetailResult>('get_recipe', { meal_name: mealName }, apiKey));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to load recipe');
    }
  }

  async function importFromUrl() {
    if (!importUrl.trim() || importing) return;
    setImporting(true);
    setError(null);
    try {
      await callTool<ImportRecipeResult>('import_recipe', { url: importUrl.trim() }, apiKey);
      setImportUrl('');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to import recipe');
    } finally {
      setImporting(false);
    }
  }

  const allTags = [...new Set(recipes.flatMap((r) => r.tags))].sort();
  const visibleRecipes = selectedTag ? recipes.filter((r) => r.tags.includes(selectedTag)) : recipes;

  if (detail) {
    return (
      <div className="recipes-view">
        <button className="back-link" onClick={() => setDetail(null)}>
          &larr; all recipes
        </button>
        {error && <div className="error-banner">{error}</div>}
        {detail.found ? (
          <article className="recipe-detail">
            <h2>{detail.mealName}</h2>
            <p className="recipe-meta">
              {[detail.prepTime && `prep ${detail.prepTime}`, detail.cookTime && `cook ${detail.cookTime}`, detail.servings && `${detail.servings} servings`]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <div className="recipe-tags">
              {detail.tags.map((t) => (
                <span key={t} className="pill">
                  {t}
                </span>
              ))}
            </div>
            <h3>Ingredients</h3>
            <ul>
              {detail.ingredients.map((ing, i) => (
                <li key={i}>{ing}</li>
              ))}
            </ul>
            <h3>Instructions</h3>
            {detail.instructions.map((step, i) =>
              typeof step === 'string' ? (
                <p key={i}>{step}</p>
              ) : (
                <div key={i}>
                  <h4>{step.section}</h4>
                  <ol>
                    {step.steps.map((s, j) => (
                      <li key={j}>{s}</li>
                    ))}
                  </ol>
                </div>
              ),
            )}
          </article>
        ) : (
          <div className="empty-state">Recipe not found.</div>
        )}
      </div>
    );
  }

  return (
    <div className="recipes-view">
      {error && <div className="error-banner">{error}</div>}

      {allTags.length > 0 && (
        <div className="tag-pills">
          <button className={`pill${selectedTag === null ? ' active' : ''}`} onClick={() => setSelectedTag(null)}>
            all
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              className={`pill${selectedTag === tag ? ' active' : ''}`}
              onClick={() => setSelectedTag(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {loading && recipes.length === 0 && <div className="empty-state">Loading…</div>}
      {!loading && visibleRecipes.length === 0 && <div className="empty-state">No recipes yet.</div>}

      <div className="recipe-grid">
        {visibleRecipes.map((recipe) => (
          <button key={recipe.recipeId} className="recipe-card" onClick={() => openRecipe(recipe.mealName)}>
            <h3>{recipe.mealName}</h3>
            <p className="recipe-meta">
              {[recipe.prepTime && `prep ${recipe.prepTime}`, recipe.cookTime && `cook ${recipe.cookTime}`]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </button>
        ))}
      </div>

      <form
        className="import-form"
        onSubmit={(e) => {
          e.preventDefault();
          importFromUrl();
        }}
      >
        <input
          value={importUrl}
          onChange={(e) => setImportUrl(e.target.value)}
          placeholder="Recipe URL to import"
        />
        <button type="submit" disabled={importing || !importUrl.trim()}>
          Import
        </button>
      </form>
    </div>
  );
}
