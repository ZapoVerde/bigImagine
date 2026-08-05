import { useEffect, useRef, useState } from 'react';
import { ApiError, createFolder, deleteChat, deleteFolder, listChats, listFolders } from '../../api/client';
import type { ChatSummary, Folder } from '../../api/types';

interface ChatBrowserProps {
  apiKey: string | null;
  /** Which sidebar section this instance renders — 'chat' (general) or 'rp' (roleplay). Folder
   *  grouping, search, and delete are shared; only the listChats filter and copy differ. */
  kind: 'chat' | 'rp';
  /** Opens (or focuses, if already open in another tab) a chat/RP tab — wired to useTabs'
   *  openChat/openRp. */
  onOpenChat: (chatId: string, title?: string) => void;
}

// The sidebar's chat/RP browser: folders + past sessions of one kind, click to open/focus a tab.
export default function ChatBrowser({ apiKey, kind, onOpenChat }: ChatBrowserProps) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const searchTimer = useRef<number | null>(null);

  async function refresh(searchText?: string) {
    try {
      const [chatList, folderList] = await Promise.all([
        listChats(apiKey, searchText || undefined, kind),
        listFolders(apiKey),
      ]);
      setChats(chatList);
      setFolders(folderList);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to load chats');
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSearchChange(text: string) {
    setSearch(text);
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => refresh(text), 300);
  }

  async function removeChat(chatId: string) {
    try {
      await deleteChat(chatId, apiKey);
      await refresh(search);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to delete chat');
    }
  }

  async function addFolder() {
    const name = window.prompt('Folder name');
    if (!name?.trim()) return;
    try {
      await createFolder(name.trim(), apiKey);
      await refresh(search);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to create folder');
    }
  }

  async function removeFolder(folderId: string) {
    try {
      await deleteFolder(folderId, apiKey);
      await refresh(search);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to delete folder');
    }
  }

  const chatsByFolder = new Map<string | null, ChatSummary[]>();
  for (const chat of chats) {
    const key = chat.folderId;
    if (!chatsByFolder.has(key)) chatsByFolder.set(key, []);
    chatsByFolder.get(key)!.push(chat);
  }

  function renderChatRow(chat: ChatSummary) {
    return (
      <div key={chat.chatId} className="sidebar-row" onClick={() => onOpenChat(chat.chatId, chat.title)}>
        <span className="sidebar-row-title">{chat.title}</span>
        <button
          className="sidebar-row-delete"
          title="Delete chat"
          onClick={(e) => {
            e.stopPropagation();
            removeChat(chat.chatId);
          }}
        >
          &times;
        </button>
      </div>
    );
  }

  return (
    <div className="sidebar-browser">
      {error && <div className="error-banner">{error}</div>}
      <div className="sidebar-actions">
        <input
          className="sidebar-search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={kind === 'rp' ? 'Search RP…' : 'Search chats…'}
        />
        <button className="sidebar-add-btn" title="New folder" onClick={addFolder}>
          + Folder
        </button>
      </div>
      <div className="sidebar-list">
        {folders.map((folder) => (
          <div key={folder.folderId} className="sidebar-group">
            <div className="sidebar-group-name">
              <span>{folder.name}</span>
              <button
                className="sidebar-row-delete"
                title="Delete folder (chats are kept)"
                onClick={() => removeFolder(folder.folderId)}
              >
                &times;
              </button>
            </div>
            {(chatsByFolder.get(folder.folderId) ?? []).map(renderChatRow)}
          </div>
        ))}
        {(chatsByFolder.get(null) ?? []).map(renderChatRow)}
        {chats.length === 0 && <div className="empty-state small">{kind === 'rp' ? 'No RP chats yet.' : 'No chats yet.'}</div>}
      </div>
    </div>
  );
}
