import { useEffect, useState } from 'react';
import { ApiError, callTool } from '../../api/client';
import type { DeleteRecipeResult, RecipeSummary, UpdateRecipeResult } from '../../api/types';

interface RecipesBrowserProps {
  apiKey: string | null;
  selectedRecipeName: string | null;
  onSelect: (mealName: string) => void;
  onDeselect: () => void;
  /** Bumped by RecipesView after an import. */
  refreshKey: number;
}

export default function RecipesBrowser({ apiKey, selectedRecipeName, onSelect, onDeselect, refreshKey }: RecipesBrowserProps) {
  const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      setRecipes(await callTool<RecipeSummary[]>('get_recipes', {}, apiKey));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to load recipes');
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, refreshKey]);

  async function toggleFavorite(recipe: RecipeSummary) {
    setError(null);
    try {
      await callTool<UpdateRecipeResult>(
        'update_recipe',
        { recipe_id: recipe.recipeId, isFavorite: !recipe.isFavorite },
        apiKey,
      );
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to update recipe');
    }
  }

  async function removeRecipe(recipe: RecipeSummary) {
    if (!window.confirm(`Delete "${recipe.mealName}"? This cannot be undone.`)) return;
    setError(null);
    try {
      await callTool<DeleteRecipeResult>('delete_recipe', { recipe_id: recipe.recipeId }, apiKey);
      if (recipe.mealName === selectedRecipeName) onDeselect();
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to delete recipe');
    }
  }

  const allTags = [...new Set(recipes.flatMap((r) => r.tags))].sort();
  const visibleRecipes = selectedTag ? recipes.filter((r) => r.tags.includes(selectedTag)) : recipes;

  return (
    <div className="sidebar-browser">
      {error && <div className="error-banner">{error}</div>}
      {allTags.length > 0 && (
        <div className="sidebar-tag-pills">
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
      <div className="sidebar-list">
        {visibleRecipes.map((recipe) => (
          <div
            key={recipe.recipeId}
            className={`sidebar-row${recipe.mealName === selectedRecipeName ? ' active' : ''}`}
            onClick={() => onSelect(recipe.mealName)}
          >
            <button
              className={`sidebar-row-favorite${recipe.isFavorite ? ' active' : ''}`}
              title={recipe.isFavorite ? 'Unfavorite' : 'Favorite'}
              onClick={(e) => {
                e.stopPropagation();
                toggleFavorite(recipe);
              }}
            >
              {recipe.isFavorite ? '★' : '☆'}
            </button>
            <span className="sidebar-row-title">{recipe.mealName}</span>
            <button
              className="sidebar-row-delete"
              title="Delete recipe"
              onClick={(e) => {
                e.stopPropagation();
                removeRecipe(recipe);
              }}
            >
              &times;
            </button>
          </div>
        ))}
        {visibleRecipes.length === 0 && <div className="empty-state small">No recipes yet.</div>}
      </div>
    </div>
  );
}
