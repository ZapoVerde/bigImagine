import type { SummonableType } from '../hooks/useTabs';
import './TypePicker.css';

type PickableType = 'chat' | SummonableType;

interface TypePickerProps {
  onPick: (type: PickableType) => void;
}

const OPTIONS: { type: PickableType; label: string }[] = [
  { type: 'chat', label: 'New Chat' },
  { type: 'lists', label: 'Lists' },
  { type: 'recipes', label: 'Recipes' },
  { type: 'mealplan', label: 'Meal Plans' },
  { type: 'notes', label: 'Notes' },
  { type: 'calendar', label: 'Calendar' },
  { type: 'documents', label: 'Documents' },
  { type: 'settings', label: 'Settings' },
];

// What a legacy 'blank' tab shows until the user picks what it's for. The tab strip's (+) button
// no longer creates these (new tabs drop straight into chat — see useTabs' openBlank), but a tab
// left in this state from before that change still needs somewhere to land. Purely user-driven —
// no auto-selection, no intent detection. Once picked, a tab never changes type again.
export default function TypePicker({ onPick }: TypePickerProps) {
  return (
    <div className="type-picker">
      <h2>What do you want to do here?</h2>
      <div className="type-picker-grid">
        {OPTIONS.map((opt) => (
          <button key={opt.type} className="type-picker-btn" onClick={() => onPick(opt.type)}>
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
