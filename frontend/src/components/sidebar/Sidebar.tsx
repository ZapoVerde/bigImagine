import type { TabType } from '../../hooks/useTabs';
import ChatBrowser from './ChatBrowser';
import NotesBrowser from './NotesBrowser';
import './Sidebar.css';

interface SidebarProps {
  apiKey: string | null;
  activeType: TabType | undefined;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenChat: (chatId: string, title?: string) => void;

  selectedNoteId: string | null;
  onSelectNote: (id: string) => void;
  onDeselectNote: () => void;
  notesRefreshKey: number;
}

const TITLES: Partial<Record<TabType, string>> = {
  chat: 'History',
  notes: 'Notes',
};

// App-wide left rail. Its content is contextual to the active tab's type — a folder/history
// browser for chat, a name picker for notes — and empty for view types that are already a single
// browsable structure (settings, the blank picker).
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
          {props.activeType === 'notes' && (
            <NotesBrowser
              apiKey={props.apiKey}
              selectedNoteId={props.selectedNoteId}
              onSelect={props.onSelectNote}
              onDeselect={props.onDeselectNote}
              refreshKey={props.notesRefreshKey}
            />
          )}
        </div>
      )}
    </div>
  );
}
