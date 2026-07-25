import { useEffect, useState } from 'react';

export type TabType = 'blank' | 'chat' | 'lists' | 'recipes' | 'mealplan' | 'notes' | 'settings' | 'history';
export type SummonableType = Exclude<TabType, 'blank' | 'chat'>;

export interface TabInstance {
  id: string;
  type: TabType;
  /** Only meaningful for type 'chat'. Undefined = a fresh chat not yet created server-side. */
  chatId?: string;
  title: string;
}

const STORAGE_KEY = 'bb_tabs';

const SUMMON_LABELS: Record<SummonableType, string> = {
  lists: 'Lists',
  recipes: 'Recipes',
  mealplan: 'Meal Plans',
  notes: 'Notes',
  settings: 'Settings',
  history: 'History',
};

function newBlankTab(): TabInstance {
  return { id: crypto.randomUUID(), type: 'blank', title: 'New tab' };
}

interface TabsState {
  tabs: TabInstance[];
  activeTabId: string | null;
}

function loadInitial(): TabsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<TabsState>;
      if (Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
        const activeTabId = parsed.tabs.some((t) => t.id === parsed.activeTabId)
          ? (parsed.activeTabId as string)
          : parsed.tabs[0]!.id;
        return { tabs: parsed.tabs, activeTabId };
      }
    }
  } catch {
    // malformed/missing storage — fall through to a fresh blank tab
  }
  const blank = newBlankTab();
  return { tabs: [blank], activeTabId: blank.id };
}

// Owns the browser-style tab strip: which tabs are open, in what order, and which is active.
// Persisted to localStorage so a reload doesn't scatter open conversations. Tabs are single-
// purpose and never change type after creation (see the design decisions in the tab-strip plan) —
// summon()/openChat() below only ever convert a still-*blank* tab, or open a brand new one.
export function useTabs() {
  const [state, setState] = useState<TabsState>(loadInitial);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  function focus(id: string) {
    setState((s) => (s.tabs.some((t) => t.id === id) ? { ...s, activeTabId: id } : s));
  }

  function openBlank() {
    const tab = newBlankTab();
    setState((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
  }

  /** Singleton view types: focuses the existing tab if one's already open, else claims the active
   *  blank tab (from the (+) picker) in place, else opens a brand new one. */
  function summon(type: SummonableType) {
    setState((s) => {
      const existing = s.tabs.find((t) => t.type === type);
      if (existing) return { ...s, activeTabId: existing.id };
      const active = s.tabs.find((t) => t.id === s.activeTabId);
      const title = SUMMON_LABELS[type];
      if (active?.type === 'blank') {
        return { tabs: s.tabs.map((t) => (t.id === active.id ? { ...t, type, title } : t)), activeTabId: active.id };
      }
      const tab: TabInstance = { id: crypto.randomUUID(), type, title };
      return { tabs: [...s.tabs, tab], activeTabId: tab.id };
    });
  }

  /** Opens a chat tab. With no chatId, always starts a fresh (not-yet-created) chat. With a
   *  chatId, focuses that chat's tab if already open, else opens/claims one for it. */
  function openChat(chatId?: string, title?: string) {
    setState((s) => {
      if (chatId) {
        const existing = s.tabs.find((t) => t.type === 'chat' && t.chatId === chatId);
        if (existing) return { ...s, activeTabId: existing.id };
      }
      const active = s.tabs.find((t) => t.id === s.activeTabId);
      const label = title ?? 'New chat';
      if (active?.type === 'blank') {
        return {
          tabs: s.tabs.map((t) => (t.id === active.id ? { ...t, type: 'chat', chatId, title: label } : t)),
          activeTabId: active.id,
        };
      }
      const tab: TabInstance = { id: crypto.randomUUID(), type: 'chat', chatId, title: label };
      return { tabs: [...s.tabs, tab], activeTabId: tab.id };
    });
  }

  /** Learns a chat tab's real id/title once a fresh chat is lazily created, or a title changes. */
  function updateTab(id: string, patch: Partial<Pick<TabInstance, 'chatId' | 'title'>>) {
    setState((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  }

  function close(id: string) {
    setState((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      if (s.activeTabId !== id) return { tabs, activeTabId: s.activeTabId };
      const neighbor = tabs[idx - 1] ?? tabs[idx] ?? null;
      return { tabs, activeTabId: neighbor?.id ?? null };
    });
  }

  return { tabs: state.tabs, activeTabId: state.activeTabId, openBlank, summon, openChat, updateTab, close, focus };
}
