import { useEffect, useState } from 'react';
import './theme/tokens.css';
import './App.css';
import { API_KEY_STORAGE_KEY } from './api/authStorage';
import { whoami } from './api/client';
import BackupWarningModal from './components/BackupWarningModal';
import Sidebar from './components/sidebar/Sidebar';
import TabStrip from './components/TabStrip';
import TimerStrip from './components/temporal/TimerStrip';
import TypePicker from './components/TypePicker';
import UnlockGate from './components/UnlockGate';
import { useTabs } from './hooks/useTabs';
import { useTheme } from './hooks/useTheme';
import CanonQueueView from './views/CanonQueueView';
import ChatView from './views/ChatView';
import DocumentsView from './views/DocumentsView';
import NotesView from './views/NotesView';
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
  const { tabs, activeTabId, openBlank, summon, openChat, updateTab, close, focus } = useTabs();
  const { theme, toggle: toggleTheme } = useTheme();

  // Lifted out of Sidebar so TabStrip's mobile menu button (the "summoning arrow" that replaces
  // the always-on rail on narrow screens) can toggle the same state the rail's own header button
  // does — they're siblings under .app, not parent/child, same reason note selection is lifted
  // above.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth < 768);

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
    <div className="app">
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
        selectedNoteId={selectedNoteId}
        onSelectNote={setSelectedNoteId}
        onDeselectNote={() => setSelectedNoteId(null)}
        notesRefreshKey={notesRefreshKey}
      />
      <div className="app-main">
        <TabStrip
          tabs={tabs}
          activeId={activeTabId}
          onSelect={focus}
          onClose={close}
          onNew={openBlank}
          onOpenSettings={() => summon('settings')}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed((c) => !c)}
          onChangeKey={
            auth.mode === 'key'
              ? () => {
                  localStorage.removeItem(API_KEY_STORAGE_KEY);
                  setAuth({ mode: 'locked' });
                }
              : undefined
          }
        />
        <TimerStrip apiKey={apiKey} />
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
                onSwitchView={summon}
                onOpenChat={openChat}
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
            {tab.type === 'settings' && <SettingsView theme={theme} onToggleTheme={toggleTheme} />}
          </div>
        ))}
      </div>
    </div>
  );
}
