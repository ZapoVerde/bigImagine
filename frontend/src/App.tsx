import { useEffect, useState } from 'react';
import './App.css';
import { whoami } from './api/client';
import TabStrip from './components/TabStrip';
import TypePicker from './components/TypePicker';
import UnlockGate from './components/UnlockGate';
import { useTabs } from './hooks/useTabs';
import ChatHistoryView from './views/ChatHistoryView';
import ChatView from './views/ChatView';
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

  return (
    <div className="app">
      <TabStrip
        tabs={tabs}
        activeId={activeTabId}
        onSelect={focus}
        onClose={close}
        onNew={openBlank}
        onChangeKey={
          auth.mode === 'key'
            ? () => {
                localStorage.removeItem(API_KEY_STORAGE_KEY);
                setAuth({ mode: 'locked' });
              }
            : undefined
        }
      />
      {tabs.map((tab) => (
        <div key={tab.id} className={`view-container${tab.id === activeTabId ? '' : ' hidden'}`}>
          {tab.type === 'blank' && (
            <TypePicker onPick={(type) => (type === 'chat' ? openChat() : summon(type))} />
          )}
          {tab.type === 'chat' && (
            <ChatView
              apiKey={apiKey}
              chatId={tab.chatId}
              onChatCreated={(chatId, title) => updateTab(tab.id, { chatId, title })}
              onTitleChange={(title) => updateTab(tab.id, { title })}
            />
          )}
          {tab.type === 'history' && <ChatHistoryView apiKey={apiKey} onOpenChat={openChat} />}
          {tab.type === 'lists' && <ListsView apiKey={apiKey} />}
          {tab.type === 'recipes' && <RecipesView apiKey={apiKey} />}
          {tab.type === 'mealplan' && <MealPlanView apiKey={apiKey} />}
          {tab.type === 'notes' && <NotesView apiKey={apiKey} />}
          {tab.type === 'settings' && <SettingsView />}
        </div>
      ))}
    </div>
  );
}
