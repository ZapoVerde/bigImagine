import { useEffect, useState } from 'react';
import { ApiError, callTool } from '../api/client';
import type { ImportRecipeResult, RecipeDetailResult, RecipeIngredient, ScaleRecipeResult, ScaledIngredient } from '../api/types';
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

// A line's amount/unit, formatted for the "amount | ingredient" default display. scale_recipe's
// ScaledIngredient carries amountDisplay — a complete string with its own (possibly promoted, e.g.
// g -> kg or tbsp -> cup) unit already baked in by formatIngredientAmount.ts server-side, so it's
// returned as-is rather than having a unit appended again here. get_recipe's plain RecipeIngredient
// (shown only while scale_recipe hasn't resolved yet) has no amountDisplay at all, so that case
// still glues the raw amount + unit together itself.
function displayAmount(ing: RecipeIngredient | ScaledIngredient): string | null {
  if (ing.amount === null) return null;
  if ('amountDisplay' in ing && ing.amountDisplay !== null) return ing.amountDisplay;
  return ing.unit ? `${ing.amount} ${ing.unit}` : String(ing.amount);
}

// modifier is a prep instruction ("peeled and smashed") separated from item ("garlic") server-side
// (structureIngredientsWithLlm.ts) — recombined here only for display, comma-joined the way a
// recipe would actually read it.
function displayItem(ing: RecipeIngredient | ScaledIngredient): string {
  return ing.modifier ? `${ing.item}, ${ing.modifier}` : ing.item;
}

// Detail/import half of the recipes master-detail split — browsing and tag filtering live in the
// sidebar's RecipesBrowser now.
export default function RecipesView({ apiKey, selectedRecipeName, onSelectRecipe, onChanged }: RecipesViewProps) {
  const [detail, setDetail] = useState<RecipeDetailResult | null>(null);
  const [scaled, setScaled] = useState<ScaleRecipeResult | null>(null);
  const [targetServingsInput, setTargetServingsInput] = useState('');
  const [scaling, setScaling] = useState(false);
  // One toggle for the whole ingredients list, next to the "Ingredients" heading — not a button
  // per row.
  const [showOriginal, setShowOriginal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importUrl, setImportUrl] = useState('');
  const [importing, setImporting] = useState(false);
  // Tracks a just-imported/created recipe so its ingredient list opens with raw text visible —
  // the validation moment for the LLM's structuring pass. Cleared after the first load.
  const [justCreatedName, setJustCreatedName] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedRecipeName) {
      setDetail(null);
      setScaled(null);
      setShowOriginal(false);
      return;
    }
    setError(null);

    callTool<RecipeDetailResult>('get_recipe', { meal_name: selectedRecipeName }, apiKey)
      .then((d) => {
        setDetail(d);
        if (d.found && selectedRecipeName === justCreatedName) {
          setShowOriginal(true);
          setJustCreatedName(null);
        } else {
          setShowOriginal(false);
        }
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'failed to load recipe'));

    // Best-effort: the household default (or the recipe's own base) scaled view. If this fails,
    // the unscaled structured ingredients from get_recipe above still render.
    setScaled(null);
    callTool<ScaleRecipeResult>('scale_recipe', { meal_name: selectedRecipeName }, apiKey)
      .then((s) => {
        setScaled(s);
        if (s.found && s.scaled) setTargetServingsInput(String(s.targetServings));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRecipeName, apiKey]);

  async function importFromUrl() {
    if (!importUrl.trim() || importing) return;
    setImporting(true);
    setError(null);
    try {
      const result = await callTool<ImportRecipeResult>('import_recipe', { url: importUrl.trim() }, apiKey);
      setImportUrl('');
      onChanged();
      setJustCreatedName(result.mealName);
      onSelectRecipe(result.mealName);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to import recipe');
    } finally {
      setImporting(false);
    }
  }

  async function scaleTo(target: number) {
    if (!selectedRecipeName) return;
    setScaling(true);
    setError(null);
    try {
      const result = await callTool<ScaleRecipeResult>(
        'scale_recipe',
        { meal_name: selectedRecipeName, target_servings: target },
        apiKey,
      );
      setScaled(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to scale recipe');
    } finally {
      setScaling(false);
    }
  }

  // Scaling is a cheap call — no "Scale" button, it just happens as the input settles. Debounced
  // so typing "12" doesn't fire a call for "1" and then "12".
  useEffect(() => {
    const target = Number(targetServingsInput);
    if (!Number.isFinite(target) || target <= 0) return;
    if (scaled?.found && scaled.scaled && scaled.targetServings === target) return;
    const timeout = setTimeout(() => scaleTo(target), 400);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetServingsInput]);

  function resetScale() {
    if (!detail?.found || detail.baseServings === null) return;
    setTargetServingsInput(String(detail.baseServings));
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

  const ingredients: (RecipeIngredient | ScaledIngredient)[] =
    scaled?.found && scaled.scaled ? scaled.ingredients : detail?.found ? detail.ingredients : [];

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

          {detail.baseServings !== null && (
            <div className="recipe-scale">
              <label>
                Scale to
                <input
                  type="number"
                  min="1"
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  value={targetServingsInput}
                  onChange={(e) => setTargetServingsInput(e.target.value)}
                />
                servings
              </label>
              {scaling && <span className="status-text">scaling…</span>}
              {scaled?.found && scaled.scaled && scaled.targetServings !== scaled.baseServings && (
                <button onClick={resetScale} disabled={scaling}>
                  Reset to original ({detail.baseServings})
                </button>
              )}
            </div>
          )}

          <div className="ingredients-heading">
            <h3>Ingredients</h3>
            <button type="button" className="raw-toggle" onClick={() => setShowOriginal((v) => !v)}>
              {showOriginal ? 'hide original' : 'show original'}
            </button>
          </div>
          <ul>
            {ingredients.map((ing, i) => {
              const amount = displayAmount(ing);
              return (
                <li key={i}>
                  {amount ? (
                    <>
                      <span className="ingredient-amount">{amount}</span> | <span className="ingredient-item">{displayItem(ing)}</span>
                    </>
                  ) : (
                    <span className="ingredient-item">{displayItem(ing)}</span>
                  )}
                  {showOriginal && <div className="ingredient-raw">{ing.raw}</div>}
                </li>
              );
            })}
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
