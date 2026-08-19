import type { ReactNode } from 'react';
import type { TabType } from '../../hooks/useTabs';
import type { TurnSnapshot } from '../../lib/turnTimelineReport';
import ChatBrowser from './ChatBrowser';
import NotesBrowser from './NotesBrowser';
import CastSection from './CastSection';
import CharacterVisualStateToggle from './CharacterVisualStateToggle';
import PortraitConnectionPanel from './PortraitConnectionPanel';
import PortraitPromptsPanel from './PortraitPromptsPanel';
import PromptInspectorPanel from '../promptInspector/PromptInspectorPanel';
import TurnDrawerSection from '../timeline/TurnDrawerSection';
import PortraitTelemetryPanel from '../portraits/PortraitTelemetryPanel';
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
  /** The active RP chat's scene_id cache pointer (rp-cast-infrastructure-plan.md Part C) —
   *  App holds it (ChatView up-reports it) and CastSection matches get_scenes' rows against it
   *  to read the active scene's presence. undefined when no RP chat is open. */
  activeSceneId?: string | null;
  /** Bumped once per completed turn of the active RP chat (App.tsx, via ChatView) so the
   *  inspector re-fetches — same live-read-per-turn behavior it had as an in-chat panel. */
  promptRefreshToken: number;
  /** Bumped (App.tsx) when the chat set changes out from under the browsers (a deleted
   *  character's chats were purged) so the history lists re-fetch. */
  chatsRefreshKey: number;
  /** The last completed turn's timing fields, tagged with the chat it happened in
   *  (docs/plans/turn-timeline-graph-plan.md) — feeds the RP drawer's Timing section. */
  turnSnapshot?: TurnSnapshot;

  selectedNoteId: string | null;
  onSelectNote: (id: string) => void;
  onDeselectNote: () => void;
  notesRefreshKey: number;
  portraitRoundId: string | null;
  portraitTelemetryRefreshToken: number;
}

const TITLES: Partial<Record<TabType, string>> = {
  chat: 'History',
  // The character page's drawer holds the RP chat history (the RP chat drawer itself is the
  // prompt inspector now, so it carries no title of its own — the inspector has its own header).
  characters: 'History',
  notes: 'Notes',
  portraits: 'Connection',
};

// App-wide left rail. Content is contextual to the active tab's type: a folder/history browser
// for chat, the RP chat history for the character page (resume an ongoing RP from where you pick
// characters), the Prompt Inspector for RP chats (permanent — the drawer IS the inspector), a
// name picker for notes, Portrait Studio's own connection subscription panel for portraits — and
// empty for view types that are already a single browsable structure (settings, the blank
// picker).
export default function Sidebar({ collapsed, onToggleCollapsed, ...props }: SidebarProps) {
  const title = props.activeType && TITLES[props.activeType];

  let content: ReactNode = null;
  switch (props.activeType) {
    case 'chat':
      content = <ChatBrowser apiKey={props.apiKey} kind="chat" onOpenChat={props.onOpenChat} refreshKey={props.chatsRefreshKey} />;
      break;
    case 'rp':
      content = props.activeChatId ? (
        <div className="sidebar-rp-sections">
          {/* character-visual-state-plan.md's kill switch, default off — placed first so it's
              always visible without opening a section, regardless of which chat is active. */}
          <CharacterVisualStateToggle />
          {/* rp-cast-infrastructure-plan.md Part C: the chat's known cast with live presence —
              the actual feature of this plan, so it defaults expanded (unlike Timing below). */}
          <CastSection apiKey={props.apiKey} chatId={props.activeChatId} sceneId={props.activeSceneId ?? null} />
          <PromptInspectorPanel apiKey={props.apiKey} chatId={props.activeChatId} refreshToken={props.promptRefreshToken} />
          {/* The snapshot is only shown when it belongs to THIS chat — a switched tab must never
              render one chat's chart under another chat's cost line. */}
          <TurnDrawerSection
            apiKey={props.apiKey}
            chatId={props.activeChatId}
            snapshot={props.turnSnapshot?.chatId === props.activeChatId ? props.turnSnapshot.fields : undefined}
          />
        </div>
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
    case 'portraits':
      content = (
        <div className="sidebar-portraits-sections">
          <PortraitConnectionPanel />
          <PortraitPromptsPanel />
          <PortraitTelemetryPanel apiKey={props.apiKey} roundId={props.portraitRoundId} refreshToken={props.portraitTelemetryRefreshToken} />
        </div>
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
