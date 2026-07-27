import type { TabType } from '../../hooks/useTabs';
import ChatBrowser from './ChatBrowser';
import ListsBrowser from './ListsBrowser';
import NotesBrowser from './NotesBrowser';
import RecipesBrowser from './RecipesBrowser';
import './Sidebar.css';

interface SidebarProps {
  apiKey: string | null;
  activeType: TabType | undefined;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenChat: (chatId: string, title?: string) => void;

  selectedListName: string | null;
  onSelectList: (name: string) => void;
  onDeselectList: () => void;
  listsRefreshKey: number;

  selectedNoteId: string | null;
  onSelectNote: (id: string) => void;
  onDeselectNote: () => void;
  notesRefreshKey: number;

  selectedRecipeName: string | null;
  onSelectRecipe: (mealName: string) => void;
  onDeselectRecipe: () => void;
  recipesRefreshKey: number;
}

const TITLES: Partial<Record<TabType, string>> = {
  chat: 'History',
  lists: 'Lists',
  notes: 'Notes',
  recipes: 'Recipes',
};

// App-wide left rail. Its content is contextual to the active tab's type — a folder/history
// browser for chat, a name picker for lists/notes/recipes — and empty for view types that are
// already a single browsable structure (calendar, settings, meal plans, the blank picker).
export default function Sidebar({ collapsed, onToggleCollapsed, ...props }: SidebarProps) {
  const title = props.activeType && TITLES[props.activeType];

  return (
    <div className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="sidebar-header">
        {!collapsed && <span className="sidebar-title">{title ?? ''}</span>}
        <button
          className="sidebar-toggle"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={onToggleCollapsed}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>
      {!collapsed && title && (
        <div className="sidebar-content">
          {props.activeType === 'chat' && <ChatBrowser apiKey={props.apiKey} onOpenChat={props.onOpenChat} />}
          {props.activeType === 'lists' && (
            <ListsBrowser
              apiKey={props.apiKey}
              selectedListName={props.selectedListName}
              onSelect={props.onSelectList}
              onDeselect={props.onDeselectList}
              refreshKey={props.listsRefreshKey}
            />
          )}
          {props.activeType === 'notes' && (
            <NotesBrowser
              apiKey={props.apiKey}
              selectedNoteId={props.selectedNoteId}
              onSelect={props.onSelectNote}
              onDeselect={props.onDeselectNote}
              refreshKey={props.notesRefreshKey}
            />
          )}
          {props.activeType === 'recipes' && (
            <RecipesBrowser
              apiKey={props.apiKey}
              selectedRecipeName={props.selectedRecipeName}
              onSelect={props.onSelectRecipe}
              onDeselect={props.onDeselectRecipe}
              refreshKey={props.recipesRefreshKey}
            />
          )}
        </div>
      )}
    </div>
  );
}
