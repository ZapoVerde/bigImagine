import { useEffect, useState } from 'react';

export type TabType =
  | 'blank'
  | 'chat'
  | 'rp'
  | 'notes'
  | 'documents'
  | 'settings'
  | 'connections'
  | 'canon'
  | 'rag'
  | 'reviewpanel'
  | 'promptstacks'
  | 'characters'
  | 'browse-chub'
  | 'cleanup'
  | 'backgrounds'
  | 'locations';
// 'rp' behaves like 'chat' (many instances, each keyed by chatId), not like a singleton summoned
// view — it's excluded here for that reason, not because it's a specialist view (see openRp below).
export type SummonableType = Exclude<TabType, 'blank' | 'chat' | 'rp'>;

export interface TabInstance {
  id: string;
  type: TabType;
  /** Only meaningful for type 'chat' or 'rp'. Undefined for a fresh 'chat' not yet created
   *  server-side — never undefined for 'rp', which always opens with a real chatId already
   *  (see openRp below). */
  chatId?: string;
  title: string;
}

const STORAGE_KEY = 'bb_tabs';

const SUMMON_LABELS: Record<SummonableType, string> = {
  notes: 'Notes',
  documents: 'Documents',
  settings: 'Settings',
  connections: 'Connections',
  canon: 'Canon',
  rag: 'RAG',
  reviewpanel: 'Review Panel',
  promptstacks: 'Prompt Stacks',
  characters: 'Characters',
  'browse-chub': 'Browse Chub',
  cleanup: 'Cleanup',
  backgrounds: 'Backgrounds',
  locations: 'Locations',
};

function newChatTab(): TabInstance {
  return { id: crypto.randomUUID(), type: 'chat', title: 'New chat' };
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
    // malformed/missing storage — fall through to a fresh chat tab
  }
  const tab = newChatTab();
  return { tabs: [tab], activeTabId: tab.id };
}

// A tab still open on its landing state — a legacy 'blank' tab (pre-chat-first-default, kept so
// tabs persisted before this change keep working), or a 'chat' tab nobody has typed into yet
// (no chatId). Either is fair game for summon()/openChat() to claim in place; anything else is
// real content and, per the tab-strip design, never changes type again once created.
function isClaimable(tab: TabInstance | undefined): boolean {
  return tab?.type === 'blank' || (tab?.type === 'chat' && !tab.chatId);
}

// Owns the browser-style tab strip: which tabs are open, in what order, and which is active.
// Persisted to localStorage so a reload doesn't scatter open conversations.
export function useTabs() {
  const [state, setState] = useState<TabsState>(loadInitial);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  function focus(id: string) {
    setState((s) => (s.tabs.some((t) => t.id === id) ? { ...s, activeTabId: id } : s));
  }

  // Chat-first default (principle 5): a new tab drops straight into an empty chat, no picker in
  // the way. Specialist views are still one click away via summon() below.
  function openBlank() {
    const tab = newChatTab();
    setState((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
  }

  /** Singleton view types: focuses the existing tab if one's already open, else claims the active
   *  landing tab (blank, or an empty chat draft) in place, else opens a brand new one. */
  function summon(type: SummonableType) {
    setState((s) => {
      const existing = s.tabs.find((t) => t.type === type);
      if (existing) return { ...s, activeTabId: existing.id };
      const active = s.tabs.find((t) => t.id === s.activeTabId);
      const title = SUMMON_LABELS[type];
      if (isClaimable(active)) {
        return { tabs: s.tabs.map((t) => (t.id === active!.id ? { ...t, type, title } : t)), activeTabId: active!.id };
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
      if (isClaimable(active)) {
        return {
          tabs: s.tabs.map((t) => (t.id === active!.id ? { ...t, type: 'chat', chatId, title: label } : t)),
          activeTabId: active!.id,
        };
      }
      const tab: TabInstance = { id: crypto.randomUUID(), type: 'chat', chatId, title: label };
      return { tabs: [...s.tabs, tab], activeTabId: tab.id };
    });
  }

  /** Opens an RP tab for a chatId that already exists server-side (a character must be picked
   *  first — CharactersView's "Start RP" creates the chat, then calls this). RP chat is a single
   *  slot by design: the strip never carries more than one RP tab, so opening another RP chat
   *  (new or from history) replaces the existing one in place rather than stacking stale tabs.
   *  The replacement keeps the existing tab's position in the strip and becomes active. */
  function openRp(chatId: string, title?: string) {
    setState((s) => {
      const existing = s.tabs.find((t) => t.type === 'rp' && t.chatId === chatId);
      if (existing) return { ...s, activeTabId: existing.id };
      const label = title ?? 'RP';
      const keep =
        s.tabs.find((t) => t.id === s.activeTabId && t.type === 'rp') ?? s.tabs.find((t) => t.type === 'rp');
      if (keep) {
        return {
          tabs: s.tabs
            .filter((t) => t.type !== 'rp' || t.id === keep.id)
            .map((t) => (t.id === keep.id ? { ...t, chatId, title: label } : t)),
          activeTabId: keep.id,
        };
      }
      const tab: TabInstance = { id: crypto.randomUUID(), type: 'rp', chatId, title: label };
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

  /** Closes every chat/RP tab whose chatId is in the given set — used when a character is
   *  deleted and its chats are purged server-side, so they vanish from the strip too. If the
   *  active tab is among the closed ones, the neighbor that would follow it becomes active
   *  (same selection rule as close()). No-op for an empty set. */
  function closeChats(chatIds: string[]) {
    if (chatIds.length === 0) return;
    const doomed = new Set(chatIds);
    setState((s) => {
      const closedIdx = s.tabs.findIndex((t) => (t.type === 'chat' || t.type === 'rp') && t.chatId && doomed.has(t.chatId));
      if (closedIdx === -1) return s;
      const tabs = s.tabs.filter((t) => !((t.type === 'chat' || t.type === 'rp') && t.chatId && doomed.has(t.chatId)));
      if (tabs.length === s.tabs.length) return s;
      if (s.activeTabId && s.tabs.some((t) => t.id === s.activeTabId && ((t.type === 'chat' || t.type === 'rp') && t.chatId && doomed.has(t.chatId)))) {
        const neighbor = tabs[closedIdx] ?? tabs[closedIdx - 1] ?? null;
        return { tabs, activeTabId: neighbor?.id ?? null };
      }
      return { tabs, activeTabId: s.activeTabId };
    });
  }

  return { tabs: state.tabs, activeTabId: state.activeTabId, openBlank, summon, openChat, openRp, updateTab, close, focus, closeChats };
}
