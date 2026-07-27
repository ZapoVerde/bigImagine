import { useEffect, useState } from 'react';
import './theme/tokens.css';
import './App.css';
import { whoami } from './api/client';
import Sidebar from './components/sidebar/Sidebar';
import TabStrip from './components/TabStrip';
import TimerStrip from './components/temporal/TimerStrip';
import TodayAgenda from './components/TodayAgenda';
import TypePicker from './components/TypePicker';
import UnlockGate from './components/UnlockGate';
import { useTabs } from './hooks/useTabs';
import { useTheme } from './hooks/useTheme';
import CalendarView from './views/CalendarView';
import ChatView from './views/ChatView';
import DocumentsView from './views/DocumentsView';
import ListsView from './views/ListsView';
import MealPlanView from './views/MealPlanView';
import NotesView from './views/NotesView';
import RecipesView from './views/RecipesView';
import SettingsView from './views/SettingsView';

const API_KEY_STORAGE_KEY = 'bb_api_key';

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
  const { tabs, activeTabId, openBlank, summon, openChat, updateTab, close, focus } = useTabs();
  const { theme, toggle: toggleTheme } = useTheme();

  // Lifted out of Sidebar so TabStrip's mobile menu button (the "summoning arrow" that replaces
  // the always-on rail on narrow screens) can toggle the same state the rail's own header button
  // does — they're siblings under .app, not parent/child, same reason list/note/recipe selection
  // is lifted above.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth < 768);

  // Sidebar/view picker state for the singleton lists/notes/recipes tabs — lifted here because
  // the sidebar's browser and the tab's detail view are siblings, not parent/child. Each "X
  // changed" callback bumps the matching refresh key so the sidebar's browser (which owns its own
  // fetch) knows to re-fetch after a mutation the detail view made.
  const [selectedListName, setSelectedListName] = useState<string | null>(null);
  const [listsRefreshKey, setListsRefreshKey] = useState(0);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [notesRefreshKey, setNotesRefreshKey] = useState(0);
  const [selectedRecipeName, setSelectedRecipeName] = useState<string | null>(null);
  const [recipesRefreshKey, setRecipesRefreshKey] = useState(0);

  useEffect(() => {
    // Probe first: a Cloudflare Access identity (io/accessIdentity.ts) needs no key at all — only
    // fall back to a stored/manual key if Access doesn't cover this request.
    whoami()
      .then((userId) => {
        if (userId) {
          setAuth({ mode: 'sso' });
          return;
        }
        const stored = localStorage.getItem(API_KEY_STORAGE_KEY);
        setAuth(stored ? { mode: 'key', apiKey: stored } : { mode: 'locked' });
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
        }}
      />
    );
  }

  const apiKey = auth.mode === 'key' ? auth.apiKey : null;
  const activeTab = tabs.find((t) => t.id === activeTabId);

  return (
    <div className="app">
      <Sidebar
        apiKey={apiKey}
        activeType={activeTab?.type}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((c) => !c)}
        onOpenChat={openChat}
        selectedListName={selectedListName}
        onSelectList={setSelectedListName}
        onDeselectList={() => setSelectedListName(null)}
        listsRefreshKey={listsRefreshKey}
        selectedNoteId={selectedNoteId}
        onSelectNote={setSelectedNoteId}
        onDeselectNote={() => setSelectedNoteId(null)}
        notesRefreshKey={notesRefreshKey}
        selectedRecipeName={selectedRecipeName}
        onSelectRecipe={setSelectedRecipeName}
        onDeselectRecipe={() => setSelectedRecipeName(null)}
        recipesRefreshKey={recipesRefreshKey}
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
                <TodayAgenda apiKey={apiKey} />
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
              />
            )}
            {tab.type === 'lists' && (
              <ListsView
                apiKey={apiKey}
                selectedListName={selectedListName}
                onSelectList={setSelectedListName}
                onChanged={() => setListsRefreshKey((k) => k + 1)}
              />
            )}
            {tab.type === 'recipes' && (
              <RecipesView
                apiKey={apiKey}
                selectedRecipeName={selectedRecipeName}
                onSelectRecipe={setSelectedRecipeName}
                onChanged={() => setRecipesRefreshKey((k) => k + 1)}
              />
            )}
            {tab.type === 'mealplan' && <MealPlanView apiKey={apiKey} />}
            {tab.type === 'notes' && (
              <NotesView
                apiKey={apiKey}
                selectedNoteId={selectedNoteId}
                onChanged={() => setNotesRefreshKey((k) => k + 1)}
              />
            )}
            {tab.type === 'calendar' && <CalendarView apiKey={apiKey} />}
            {tab.type === 'documents' && <DocumentsView apiKey={apiKey} />}
            {tab.type === 'settings' && <SettingsView theme={theme} onToggleTheme={toggleTheme} />}
          </div>
        ))}
      </div>
    </div>
  );
}
