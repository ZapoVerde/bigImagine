import { useEffect, useState } from 'react';
import { ApiError, callTool } from '../api/client';
import type { ImportRecipeResult, RecipeDetailResult } from '../api/types';
import './RecipesView.css';

interface RecipesViewProps {
  apiKey: string | null;
  /** Which recipe to show — picked in the sidebar's RecipesBrowser. */
  selectedRecipeName: string | null;
  /** Focuses a recipe — called after a successful import, so the new recipe shows immediately. */
  onSelectRecipe: (mealName: string) => void;
  /** Tells the sidebar to re-fetch the recipe list after an import. */
  onChanged: () => void;
}

// Detail/import half of the recipes master-detail split — browsing and tag filtering live in the
// sidebar's RecipesBrowser now.
export default function RecipesView({ apiKey, selectedRecipeName, onSelectRecipe, onChanged }: RecipesViewProps) {
  const [detail, setDetail] = useState<RecipeDetailResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importUrl, setImportUrl] = useState('');
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!selectedRecipeName) {
      setDetail(null);
      return;
    }
    setError(null);
    callTool<RecipeDetailResult>('get_recipe', { meal_name: selectedRecipeName }, apiKey)
      .then(setDetail)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'failed to load recipe'));
  }, [selectedRecipeName, apiKey]);

  async function importFromUrl() {
    if (!importUrl.trim() || importing) return;
    setImporting(true);
    setError(null);
    try {
      const result = await callTool<ImportRecipeResult>('import_recipe', { url: importUrl.trim() }, apiKey);
      setImportUrl('');
      onChanged();
      onSelectRecipe(result.mealName);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to import recipe');
    } finally {
      setImporting(false);
    }
  }

  const importForm = (
    <form
      className="import-form"
      onSubmit={(e) => {
        e.preventDefault();
        importFromUrl();
      }}
    >
      <input value={importUrl} onChange={(e) => setImportUrl(e.target.value)} placeholder="Recipe URL to import" />
      <button type="submit" disabled={importing || !importUrl.trim()}>
        Import
      </button>
    </form>
  );

  if (!selectedRecipeName) {
    return (
      <div className="recipes-view">
        {error && <div className="error-banner">{error}</div>}
        <div className="empty-state">Pick a recipe from the sidebar, or import one below.</div>
        {importForm}
      </div>
    );
  }

  return (
    <div className="recipes-view">
      {error && <div className="error-banner">{error}</div>}
      {detail && (detail.found ? (
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
      ))}
    </div>
  );
}
