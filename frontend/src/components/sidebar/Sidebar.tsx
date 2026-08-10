import type { ReactNode } from 'react';
import type { TabType } from '../../hooks/useTabs';
import ChatBrowser from './ChatBrowser';
import NotesBrowser from './NotesBrowser';
import PromptInspectorPanel from '../promptInspector/PromptInspectorPanel';
import './Sidebar.css';

interface SidebarProps {
  apiKey: string | null;
  activeType: TabType | undefined;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenChat: (chatId: string, title?: string) => void;
  onOpenRp: (chatId: string, title?: string) => void;

  /** The active RP chat's id — the drawer's Prompt Inspector shows this chat's turns. */
  activeChatId?: string;
  /** Bumped once per completed turn of the active RP chat (App.tsx, via ChatView) so the
   *  inspector re-fetches — same live-read-per-turn behavior it had as an in-chat panel. */
  promptRefreshToken: number;
  /** Bumped (App.tsx) when the chat set changes out from under the browsers (a deleted
   *  character's chats were purged) so the history lists re-fetch. */
  chatsRefreshKey: number;

  selectedNoteId: string | null;
  onSelectNote: (id: string) => void;
  onDeselectNote: () => void;
  notesRefreshKey: number;
}

const TITLES: Partial<Record<TabType, string>> = {
  chat: 'History',
  // The character page's drawer holds the RP chat history (the RP chat drawer itself is the
  // prompt inspector now, so it carries no title of its own — the inspector has its own header).
  characters: 'History',
  notes: 'Notes',
};

// App-wide left rail. Content is contextual to the active tab's type: a folder/history browser
// for chat, the RP chat history for the character page (resume an ongoing RP from where you pick
// characters), the Prompt Inspector for RP chats (permanent — the drawer IS the inspector), a
// name picker for notes — and empty for view types that are already a single browsable structure
// (settings, the blank picker).
export default function Sidebar({ collapsed, onToggleCollapsed, ...props }: SidebarProps) {
  const title = props.activeType && TITLES[props.activeType];

  let content: ReactNode = null;
  switch (props.activeType) {
    case 'chat':
      content = <ChatBrowser apiKey={props.apiKey} kind="chat" onOpenChat={props.onOpenChat} refreshKey={props.chatsRefreshKey} />;
      break;
    case 'rp':
      content = props.activeChatId ? (
        <PromptInspectorPanel apiKey={props.apiKey} chatId={props.activeChatId} refreshToken={props.promptRefreshToken} />
      ) : (
        <div className="empty-state small">Open an RP chat to inspect its prompt.</div>
      );
      break;
    case 'characters':
      content = <ChatBrowser apiKey={props.apiKey} kind="rp" onOpenChat={props.onOpenRp} refreshKey={props.chatsRefreshKey} />;
      break;
    case 'notes':
      content = (
        <NotesBrowser
          apiKey={props.apiKey}
          selectedNoteId={props.selectedNoteId}
          onSelect={props.onSelectNote}
          onDeselect={props.onDeselectNote}
          refreshKey={props.notesRefreshKey}
        />
      );
      break;
  }

  return (
    <div className={`sidebar${collapsed ? ' collapsed' : ''}${props.activeType === 'rp' ? ' sidebar-inspector' : ''}`}>
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
      {!collapsed && content && <div className="sidebar-content">{content}</div>}
    </div>
  );
}
