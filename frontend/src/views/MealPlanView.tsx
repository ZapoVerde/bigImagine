import { useEffect, useState } from 'react';
import { ApiError, callTool } from '../api/client';
import type { AddMealPlanEntryResult, GenerateShoppingListResult, MealPlanEntry } from '../api/types';
import './MealPlanView.css';

interface MealPlanViewProps {
  apiKey: string | null;
}

function groupByDate(entries: MealPlanEntry[]): Map<string, MealPlanEntry[]> {
  const byDate = new Map<string, MealPlanEntry[]>();
  for (const entry of entries) {
    if (!byDate.has(entry.plannedDate)) byDate.set(entry.plannedDate, []);
    byDate.get(entry.plannedDate)!.push(entry);
  }
  return new Map([...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export default function MealPlanView({ apiKey }: MealPlanViewProps) {
  const [entries, setEntries] = useState<MealPlanEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shoppingResult, setShoppingResult] = useState<GenerateShoppingListResult | null>(null);
  const [generating, setGenerating] = useState(false);

  const [plannedDate, setPlannedDate] = useState('');
  const [mealLabel, setMealLabel] = useState('');
  const [mealName, setMealName] = useState('');

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      setEntries(await callTool<MealPlanEntry[]>('get_meal_plan', {}, apiKey));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to load meal plan');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function addEntry() {
    if (!plannedDate || !mealName.trim()) return;
    setError(null);
    try {
      const result = await callTool<AddMealPlanEntryResult>(
        'add_meal_plan_entry',
        { meal_name: mealName.trim(), planned_date: plannedDate, meal_label: mealLabel.trim() || undefined },
        apiKey,
      );
      if (!result.planned) {
        setError(result.reason);
        return;
      }
      setMealName('');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to add meal plan entry');
    }
  }

  async function generateShoppingList() {
    setGenerating(true);
    setError(null);
    setShoppingResult(null);
    try {
      setShoppingResult(await callTool<GenerateShoppingListResult>('generate_shopping_list_from_meal_plan', {}, apiKey));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to generate shopping list');
    } finally {
      setGenerating(false);
    }
  }

  const grouped = groupByDate(entries);

  return (
    <div className="mealplan-view">
      {error && <div className="error-banner">{error}</div>}

      <div className="mealplan-toolbar">
        <button onClick={generateShoppingList} disabled={generating}>
          Generate shopping list from this week
        </button>
        {shoppingResult && (
          <span className="shopping-result">
            added {shoppingResult.itemsAdded.length} item(s) to “{shoppingResult.listName}”
            {shoppingResult.itemsSkipped.length > 0 && `, skipped ${shoppingResult.itemsSkipped.length} already pending`}
          </span>
        )}
      </div>

      {loading && entries.length === 0 && <div className="empty-state">Loading…</div>}
      {!loading && entries.length === 0 && <div className="empty-state">No meals planned this week.</div>}

      {[...grouped.entries()].map(([date, dayEntries]) => (
        <section key={date} className="day-group">
          <h2>{date}</h2>
          <ul>
            {dayEntries.map((entry, i) => (
              <li key={i}>
                {entry.mealLabel && <span className="meal-label">{entry.mealLabel}: </span>}
                {entry.mealName}
              </li>
            ))}
          </ul>
        </section>
      ))}

      <form
        className="add-entry-form"
        onSubmit={(e) => {
          e.preventDefault();
          addEntry();
        }}
      >
        <input type="date" value={plannedDate} onChange={(e) => setPlannedDate(e.target.value)} required />
        <input
          value={mealLabel}
          onChange={(e) => setMealLabel(e.target.value)}
          placeholder="Label (e.g. dinner)"
        />
        <input value={mealName} onChange={(e) => setMealName(e.target.value)} placeholder="Recipe / meal name" />
        <button type="submit">Add</button>
      </form>
    </div>
  );
}
