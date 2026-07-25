import { useEffect, useRef, useState } from 'react';
import { ApiError, createFolder, deleteChat, deleteFolder, listChats, listFolders } from '../api/client';
import type { ChatSummary, Folder } from '../api/types';
import './ChatHistoryView.css';

interface ChatHistoryViewProps {
  apiKey: string | null;
  /** Opens (or focuses, if already open in another tab) a chat — wired to useTabs' openChat. */
  onOpenChat: (chatId: string, title?: string) => void;
}

// The bigBrain-wide "browse and reopen a past chat" surface — everything ChatView's own sidebar
// used to do before chats became one-per-tab. Summoned via the (+) picker like any other tab type.
export default function ChatHistoryView({ apiKey, onOpenChat }: ChatHistoryViewProps) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const searchTimer = useRef<number | null>(null);

  async function refresh(searchText?: string) {
    try {
      const [chatList, folderList] = await Promise.all([
        listChats(apiKey, searchText || undefined),
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
      <div key={chat.chatId} className="history-row" onClick={() => onOpenChat(chat.chatId, chat.title)}>
        <span className="history-row-title">{chat.title}</span>
        <button
          className="history-row-delete"
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
    <div className="chat-history-view">
      {error && <div className="error-banner">{error}</div>}
      <div className="history-actions">
        <input
          className="history-search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search chats…"
        />
        <button className="new-folder-btn" title="New folder" onClick={addFolder}>
          + Folder
        </button>
      </div>
      <div className="history-list">
        {folders.map((folder) => (
          <div key={folder.folderId} className="folder-group">
            <div className="folder-name">
              <span>{folder.name}</span>
              <button
                className="history-row-delete"
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
        {chats.length === 0 && <div className="empty-state">No chats yet.</div>}
      </div>
    </div>
  );
}
