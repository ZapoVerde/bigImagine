import { useEffect, useState } from 'react';
import { ApiError, callTool } from '../../api/client';
import type { RecipeSummary } from '../../api/types';

interface RecipesBrowserProps {
  apiKey: string | null;
  selectedRecipeName: string | null;
  onSelect: (mealName: string) => void;
  /** Bumped by RecipesView after an import. */
  refreshKey: number;
}

export default function RecipesBrowser({ apiKey, selectedRecipeName, onSelect, refreshKey }: RecipesBrowserProps) {
  const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    callTool<RecipeSummary[]>('get_recipes', {}, apiKey)
      .then(setRecipes)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'failed to load recipes'));
  }, [apiKey, refreshKey]);

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
            <span className="sidebar-row-title">{recipe.mealName}</span>
          </div>
        ))}
        {visibleRecipes.length === 0 && <div className="empty-state small">No recipes yet.</div>}
      </div>
    </div>
  );
}
