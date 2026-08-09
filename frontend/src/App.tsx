import { useEffect, useState } from 'react';
import './theme/tokens.css';
import './App.css';
import { API_KEY_STORAGE_KEY } from './api/authStorage';
import { whoami } from './api/client';
import BackupWarningModal from './components/BackupWarningModal';
import AppNavDrawer from './components/appNav/AppNavDrawer';
import ScreenLockOverlay from './components/ScreenLockOverlay';
import Sidebar from './components/sidebar/Sidebar';
import TabStrip from './components/TabStrip';
import TimerStrip from './components/temporal/TimerStrip';
import TypePicker from './components/TypePicker';
import UnlockGate from './components/UnlockGate';
import { useTabs } from './hooks/useTabs';
import { useTheme } from './hooks/useTheme';
import BrowseChubView from './views/BrowseChubView';
import BackgroundsView from './views/BackgroundsView';
import CanonQueueView from './views/CanonQueueView';
import CharactersView from './views/CharactersView';
import ChatView from './views/ChatView';
import CleanupView from './views/CleanupView';
import ConnectionsView from './views/ConnectionsView';
import DocumentsView from './views/DocumentsView';
import NotesView from './views/NotesView';
import PromptStacksView from './views/PromptStacksView';
import ReviewPanelView from './views/ReviewPanelView';
import RagView from './views/RagView';
import SettingsView from './views/SettingsView';

const BACKUP_WARNING_DISMISSED_KEY = 'bb_backup_warning_dismissed';

type AuthState =
  | { mode: 'checking' }
  | { mode: 'sso' }
  | { mode: 'key'; apiKey: string }
  | { mode: 'locked' };

// Every open tab stays mounted (toggled with a CSS class rather than conditional rendering) for
// as long as it's open, so switching tabs never loses an in-progress chat, a scrolled list, or a
// half-filled form. Closing a tab does unmount it — any local-only draft is gone, same as closing
// a browser tab — but nothing it was showing is deleted server-side.
export default function App() {
  const [auth, setAuth] = useState<AuthState>({ mode: 'checking' });
  // sessionStorage (not localStorage) so this reappears next session rather than being
  // permanently silenced by one click — see BackupWarningModal's own note on why.
  const [showBackupWarning, setShowBackupWarning] = useState(false);
  const { tabs, activeTabId, openBlank, summon, openChat, openRp, updateTab, close, focus, closeChats } = useTabs();
  const { theme, toggle: toggleTheme } = useTheme();

  // Lifted out of Sidebar so TabStrip's mobile menu button (the "summoning arrow" that replaces
  // the always-on rail on narrow screens) can toggle the same state the rail's own header button
  // does — they're siblings under .app, not parent/child, same reason note selection is lifted
  // above. Starts closed everywhere (the user's call: chat history lives on the character page
  // drawer and the RP drawer is the prompt inspector now — both are summoned on demand, and the
  // chat gets maximal room by default).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);

  // Bumped once per completed turn of the active RP chat (ChatView reports its message-count
  // changes up via onPromptRefresh) and forwarded to Sidebar's Prompt Inspector, so the drawer
  // version keeps the same live-read-once-per-turn behavior the in-chat panel had.
  const [promptRefreshToken, setPromptRefreshToken] = useState(0);

  // Bumped when a character is deleted and its chats were purged server-side, so the sidebar's
  // history browsers (which list those chats) re-fetch and drop them.
  const [chatsRefreshKey, setChatsRefreshKey] = useState(0);

  // Mobile chat only: the top bars (TabStrip + TimerStrip + the chat header) collapse up when the
  // user scrolls down the chat history and come back on scroll-up or a pull-down at the top —
  // ChatView drives this via onTopBarsHiddenChange; the class below is what actually collapses
  // them (App.css, .app.top-bars-hidden). Lifted here because the bars straddle the App/ChatView
  // boundary (TabStrip is App's, the chat header is ChatView's), and reset on any tab switch so
  // non-chat views never inherit a collapsed bar they have no bottom control to bring back.
  const [topBarsHidden, setTopBarsHidden] = useState(false);

  // App-wide navigation drawer behind the tab-bar hamburger (AppNavDrawer) — owns the specialist
  // views that used to be the empty-chat landing pills.
  const [navOpen, setNavOpen] = useState(false);

  // A character was deleted — its RP chats are gone server-side (delete_character returns the
  // ids). Close any open tabs for them and bump chatsRefreshKey so the history browsers drop
  // them too.
  function handleChatsDeleted(chatIds: string[]) {
    if (chatIds.length === 0) return;
    closeChats(chatIds);
    setChatsRefreshKey((k) => k + 1);
  }

  useEffect(() => {
    setTopBarsHidden(false);
  }, [activeTabId]);

  // Sidebar/view picker state for the singleton notes tab — lifted here because the sidebar's
  // browser and the tab's detail view are siblings, not parent/child. The "changed" callback
  // bumps the refresh key so the sidebar's browser (which owns its own fetch) knows to re-fetch
  // after a mutation the detail view made.
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [notesRefreshKey, setNotesRefreshKey] = useState(0);

  useEffect(() => {
    const maybeWarnAboutBackup = (result: { backupConfigured: boolean } | null) => {
      if (result && !result.backupConfigured && !sessionStorage.getItem(BACKUP_WARNING_DISMISSED_KEY)) {
        setShowBackupWarning(true);
      }
    };

    // Probe first: a Cloudflare Access identity (io/accessIdentity.ts) needs no key at all — only
    // fall back to a stored/manual key if Access doesn't cover this request.
    whoami()
      .then((result) => {
        if (result) {
          setAuth({ mode: 'sso' });
          maybeWarnAboutBackup(result);
          return;
        }
        const stored = localStorage.getItem(API_KEY_STORAGE_KEY);
        if (!stored) {
          setAuth({ mode: 'locked' });
          return;
        }
        setAuth({ mode: 'key', apiKey: stored });
        // The unauthenticated probe above only resolves the SSO path — fetch again with the
        // stored key so the 'key' auth path also gets a backupConfigured reading.
        whoami(stored)
          .then(maybeWarnAboutBackup)
          .catch(() => {});
      })
      .catch(() => setAuth({ mode: 'locked' }));
  }, []);

  if (auth.mode === 'checking') return null;

  if (auth.mode === 'locked') {
    return (
      <UnlockGate
        onUnlock={(key) => {
          localStorage.setItem(API_KEY_STORAGE_KEY, key);
          setAuth({ mode: 'key', apiKey: key });
          whoami(key)
            .then((result) => {
              if (result && !result.backupConfigured) setShowBackupWarning(true);
            })
            .catch(() => {});
        }}
      />
    );
  }

  const apiKey = auth.mode === 'key' ? auth.apiKey : null;
  const activeTab = tabs.find((t) => t.id === activeTabId);

  return (
    <div className={topBarsHidden ? 'app top-bars-hidden' : 'app'}>
      <ScreenLockOverlay apiKey={apiKey} />
      {showBackupWarning && (
        <BackupWarningModal
          onDismiss={() => {
            sessionStorage.setItem(BACKUP_WARNING_DISMISSED_KEY, 'true');
            setShowBackupWarning(false);
          }}
        />
      )}
      <Sidebar
        apiKey={apiKey}
        activeType={activeTab?.type}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((c) => !c)}
        onOpenChat={openChat}
        onOpenRp={openRp}
        selectedNoteId={selectedNoteId}
        onSelectNote={setSelectedNoteId}
        onDeselectNote={() => setSelectedNoteId(null)}
        notesRefreshKey={notesRefreshKey}
        activeChatId={activeTab?.type === 'rp' ? activeTab.chatId : undefined}
        promptRefreshToken={promptRefreshToken}
        chatsRefreshKey={chatsRefreshKey}
      />
      {/* Mobile-only floating toggle for the left rail (the desktop rail's own header arrow is
          the control wide-screen). A fixed-position FAB rather than a slot in TabStrip — the top
          bars collapse on scroll, and the arrow has to survive that (App.css, .side-fab). */}
      <button
        type="button"
        className="side-fab side-fab-left mobile-only"
        title={sidebarCollapsed ? 'Open sidebar' : 'Close sidebar'}
        aria-label={sidebarCollapsed ? 'Open sidebar' : 'Close sidebar'}
        onClick={() => setSidebarCollapsed((c) => !c)}
      >
        {sidebarCollapsed ? '»' : '«'}
      </button>
      <div className="app-main">
        {/* .app-top-bars is a collapsing single-row grid (App.css); the inner column shim keeps
            TabStrip and TimerStrip stacked vertically so the grid always has exactly one child
            to collapse. */}
        <div className="app-top-bars">
          <div className="app-top-bars-inner">
            <TabStrip
              tabs={tabs}
              activeId={activeTabId}
              onSelect={focus}
              onClose={close}
              onNew={openBlank}
              onOpenSettings={() => summon('settings')}
              onChangeKey={
                auth.mode === 'key'
                  ? () => {
                      localStorage.removeItem(API_KEY_STORAGE_KEY);
                      setAuth({ mode: 'locked' });
                    }
                  : undefined
              }
              navOpen={navOpen}
              onToggleNav={() => setNavOpen((v) => !v)}
            />
            <TimerStrip apiKey={apiKey} />
          </div>
        </div>
        {tabs.map((tab) => (
          <div key={tab.id} className={`view-container${tab.id === activeTabId ? '' : ' hidden'}`}>
            {tab.type === 'blank' && (
              <div className="blank-tab">
                <TypePicker onPick={(type) => (type === 'chat' ? openChat() : summon(type))} />
              </div>
            )}
            {tab.type === 'chat' && (
              <ChatView
                apiKey={apiKey}
                chatId={tab.chatId}
                onChatCreated={(chatId, title) => updateTab(tab.id, { chatId, title })}
                onTitleChange={(title) => updateTab(tab.id, { title })}
                onOpenChat={openChat}
                topBarsHidden={topBarsHidden}
                onTopBarsHiddenChange={setTopBarsHidden}
              />
            )}
            {tab.type === 'rp' && (
              <ChatView
                apiKey={apiKey}
                chatId={tab.chatId}
                onChatCreated={(chatId, title) => updateTab(tab.id, { chatId, title })}
                onTitleChange={(title) => updateTab(tab.id, { title })}
                onOpenChat={openChat}
                topBarsHidden={topBarsHidden}
                onTopBarsHiddenChange={setTopBarsHidden}
                onPromptRefresh={tab.id === activeTabId ? () => setPromptRefreshToken((t) => t + 1) : undefined}
              />
            )}
            {tab.type === 'notes' && (
              <NotesView
                apiKey={apiKey}
                selectedNoteId={selectedNoteId}
                onChanged={() => setNotesRefreshKey((k) => k + 1)}
              />
            )}
            {tab.type === 'documents' && <DocumentsView apiKey={apiKey} />}
            {tab.type === 'canon' && <CanonQueueView apiKey={apiKey} />}
            {tab.type === 'reviewpanel' && <ReviewPanelView />}
            {tab.type === 'rag' && <RagView />}
            {tab.type === 'promptstacks' && <PromptStacksView apiKey={apiKey} />}
            {tab.type === 'characters' && <CharactersView apiKey={apiKey} onOpenRp={openRp} onChatsDeleted={handleChatsDeleted} />}
            {tab.type === 'browse-chub' && <BrowseChubView apiKey={apiKey} />}
            {tab.type === 'settings' && <SettingsView theme={theme} onToggleTheme={toggleTheme} />}
            {tab.type === 'connections' && <ConnectionsView />}
            {tab.type === 'cleanup' && <CleanupView apiKey={apiKey} />}
            {tab.type === 'backgrounds' && <BackgroundsView />}
          </div>
        ))}
      </div>
      <AppNavDrawer open={navOpen} onClose={() => setNavOpen(false)} onNavigate={summon} />
    </div>
  );
}
