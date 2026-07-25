import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import {
  ApiError,
  adminGetActiveProfile,
  adminListModelsForProfile,
  callTool,
  chatCompletion,
  createChat,
  deleteMessage,
  getChat,
  listFolders,
  listToolNames,
  truncateMessagesFrom,
  updateChat,
} from '../api/client';
import { formatPricePerMillion } from '../api/pricing';
import type { ChatMessage, ChatParams, ChatSessionRow, Folder, ProfileModelsResult, PromptPreset } from '../api/types';
import './ChatView.css';

interface ChatViewProps {
  apiKey: string | null;
  /** undefined = a fresh, not-yet-created chat (today's "New chat" state). Once set by a parent
   *  tab (either up front, from History, or via onChatCreated below), it never changes again for
   *  the lifetime of this component — tabs are single-purpose and never swap which chat they show. */
  chatId?: string;
  /** Fires the moment a fresh chat gets a real id — the lazy createChat() on first send. Lets the
   *  owning tab learn the id (and initial title) so it can persist/label itself. */
  onChatCreated?: (chatId: string, title: string) => void;
  /** Fires whenever this chat's title changes (e.g. the server's first-message auto-title) so the
   *  owning tab's label stays in sync. */
  onTitleChange?: (title: string) => void;
}

// messageId is set only once a message round-trips through the server and comes back from
// getChat — undefined for the brief optimistic window between sending and that refetch landing.
// Copy/edit/rerun/delete all need a real id (they're per-message API calls), so they're simply
// not offered on a message that doesn't have one yet.
interface DisplayMessage {
  messageId?: string;
  role: 'user' | 'assistant';
  content: string;
}

function toWireMessages(messages: DisplayMessage[]): ChatMessage[] {
  return messages.map(({ role, content }) => ({ role, content }));
}

// Not real token streaming: runTurn resolves the full reply server-side before anything is sent
// back (httpServer.ts), so there's nothing to stream client-side either — just wait for the
// full response.
export default function ChatView({ apiKey, chatId, onChatCreated, onTitleChange }: ChatViewProps) {
  // Active conversation state
  const [activeChat, setActiveChat] = useState<ChatSessionRow | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-message edit/copy UI state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Settings pane state
  const [showSettings, setShowSettings] = useState(false);
  const [allToolNames, setAllToolNames] = useState<string[]>([]);
  // Read-only here — just for the settings pane's folder-assignment dropdown. Creating/deleting
  // folders is a chat-history concern now (see ChatHistoryView).
  const [folders, setFolders] = useState<Folder[]>([]);

  const historyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listFolders(apiKey).then(setFolders).catch(() => {});
    listToolNames(apiKey).then(setAllToolNames).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Loads the chat this tab was opened for. Guarded so the round trip through onChatCreated below
  // (parent hands the new id back as a prop) doesn't trigger a redundant refetch.
  useEffect(() => {
    if (!chatId) {
      setActiveChat(null);
      setMessages([]);
      setShowSettings(false);
      setError(null);
      setEditingId(null);
      return;
    }
    if (activeChat?.chatId === chatId) return;
    getChat(chatId, apiKey)
      .then((detail) => {
        setActiveChat(detail.session);
        setMessages(detail.messages.map((m) => ({ messageId: m.messageId, role: m.role, content: m.content })));
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'failed to load chat'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  // Tells the owning tab about this chat's identity/title — once when a fresh chat first gets a
  // real id, and again any time the title changes afterward (e.g. the server's auto-title).
  useEffect(() => {
    if (!activeChat) return;
    if (activeChat.chatId !== chatId) {
      onChatCreated?.(activeChat.chatId, activeChat.title);
    } else {
      onTitleChange?.(activeChat.title);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChat]);

  useEffect(() => {
    historyRef.current?.scrollTo({ top: historyRef.current.scrollHeight });
  }, [messages, sending]);

  // Re-fetches the active chat's messages from the server — the source of truth for real
  // messageIds, called after every mutation (send/rerun/edit) rather than hand-constructing
  // local state, so copy/edit/rerun/delete always have a real id to act on.
  async function refreshActiveMessages(chatId: string) {
    const detail = await getChat(chatId, apiKey);
    setMessages(detail.messages.map((m) => ({ messageId: m.messageId, role: m.role, content: m.content })));
  }

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;

    setError(null);
    setSending(true);
    const nextMessages: DisplayMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(nextMessages);
    setDraft('');
    try {
      let session = activeChat;
      if (!session) {
        session = await createChat(apiKey);
        setActiveChat(session);
      }
      await chatCompletion(toWireMessages(nextMessages), apiKey, session.chatId);
      await refreshActiveMessages(session.chatId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to reach bigBrain');
    } finally {
      setSending(false);
    }
  }

  /** Regenerates one assistant reply: truncates it (and anything after it, though there normally
   *  isn't anything — rerun is only offered on the last reply) server-side, then resends the
   *  now-shorter history unchanged. handleChatCompletions recognizes a same-length resend and
   *  appends only the new reply, not a duplicate of the user message that prompted it. */
  async function rerun(messageId: string) {
    if (!activeChat || sending) return;
    setError(null);
    setSending(true);
    try {
      await truncateMessagesFrom(activeChat.chatId, messageId, apiKey);
      const idx = messages.findIndex((m) => m.messageId === messageId);
      const kept = idx === -1 ? messages : messages.slice(0, idx);
      setMessages(kept);
      await chatCompletion(toWireMessages(kept), apiKey, activeChat.chatId);
      await refreshActiveMessages(activeChat.chatId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to rerun');
    } finally {
      setSending(false);
    }
  }

  function startEdit(messageId: string, content: string) {
    setEditingId(messageId);
    setEditDraft(content);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft('');
  }

  /** Edits a user message: truncates it (and everything after — the conversation branches from
   *  here) server-side, then resends the kept history plus the edited content as a new turn.
   *  One message longer than what's now persisted, so handleChatCompletions treats it as
   *  genuinely new and appends both the edited message and its fresh reply. */
  async function submitEdit() {
    const messageId = editingId;
    const content = editDraft.trim();
    if (!activeChat || !messageId || !content || sending) return;
    setError(null);
    setEditingId(null);
    setSending(true);
    try {
      await truncateMessagesFrom(activeChat.chatId, messageId, apiKey);
      const idx = messages.findIndex((m) => m.messageId === messageId);
      const kept = idx === -1 ? messages : messages.slice(0, idx);
      const withEdit: DisplayMessage[] = [...kept, { role: 'user', content }];
      setMessages(withEdit);
      await chatCompletion(toWireMessages(withEdit), apiKey, activeChat.chatId);
      await refreshActiveMessages(activeChat.chatId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to save edit');
    } finally {
      setSending(false);
    }
  }

  /** Standalone delete — just that one message, no resend, everything else in the conversation
   *  (including anything after it) is left exactly as is. */
  async function removeMessage(messageId: string) {
    if (!activeChat) return;
    try {
      await deleteMessage(activeChat.chatId, messageId, apiKey);
      setMessages((prev) => prev.filter((m) => m.messageId !== messageId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to delete message');
    }
  }

  async function copyMessage(content: string, messageId?: string) {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      return; // clipboard permission denied/unavailable — not worth an error banner
    }
    if (messageId) {
      setCopiedId(messageId);
      window.setTimeout(() => setCopiedId((id) => (id === messageId ? null : id)), 1500);
    }
  }

  async function saveSettings(patch: {
    params?: ChatParams;
    tool_names?: string[] | null;
    folder_id?: string | null;
    title?: string;
  }) {
    if (!activeChat) return;
    try {
      const updated = await updateChat(activeChat.chatId, patch, apiKey);
      setActiveChat(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to save settings');
    }
  }

  return (
    <div className="chat-view">
      <div className="chat-main">
        {error && <div className="error-banner">{error}</div>}

        <div className="chat-header">
          <span className="chat-title">{activeChat?.title ?? 'New chat'}</span>
          {activeChat && (
            <button className="settings-btn" title="Chat settings" onClick={() => setShowSettings(!showSettings)}>
              &#9881;
            </button>
          )}
        </div>

        <div className="chat-history" ref={historyRef}>
          {messages.length === 0 && <div className="empty-state">Ask bigBrain something.</div>}
          {messages.map((m, i) => {
            const isLastAssistant = m.role === 'assistant' && !messages.slice(i + 1).some((x) => x.role === 'assistant');
            return (
              <div key={m.messageId ?? `pending-${i}`} className={`chat-bubble ${m.role}`}>
                {editingId === m.messageId ? (
                  <div className="message-edit">
                    <textarea value={editDraft} onChange={(e) => setEditDraft(e.target.value)} rows={3} autoFocus />
                    <div className="message-edit-actions">
                      <button onClick={submitEdit} disabled={!editDraft.trim() || sending}>
                        Save &amp; resend
                      </button>
                      <button onClick={cancelEdit}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="markdown-content">
                      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{m.content}</ReactMarkdown>
                    </div>
                    {m.messageId && (
                      <div className="message-actions">
                        <button onClick={() => copyMessage(m.content, m.messageId)}>
                          {copiedId === m.messageId ? 'Copied' : 'Copy'}
                        </button>
                        {m.role === 'user' && <button onClick={() => startEdit(m.messageId!, m.content)}>Edit</button>}
                        {m.role === 'assistant' && isLastAssistant && (
                          <button onClick={() => rerun(m.messageId!)} disabled={sending}>
                            Rerun
                          </button>
                        )}
                        <button onClick={() => removeMessage(m.messageId!)}>Delete</button>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
          {sending && <div className="chat-bubble assistant pending">…</div>}
        </div>

        <form
          className="chat-input"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Message bigBrain…"
            rows={2}
          />
          <button type="submit" disabled={sending || !draft.trim()}>
            Send
          </button>
        </form>
      </div>

      {showSettings && activeChat && (
        <aside className="chat-settings-pane">
          <ChatSettings apiKey={apiKey} session={activeChat} folders={folders} allToolNames={allToolNames} onSave={saveSettings} />
        </aside>
      )}
    </div>
  );
}

interface ChatSettingsProps {
  apiKey: string | null;
  session: ChatSessionRow;
  folders: Folder[];
  allToolNames: string[];
  onSave: (patch: {
    params?: ChatParams;
    tool_names?: string[] | null;
    folder_id?: string | null;
    title?: string;
  }) => Promise<void>;
}

function ChatSettings({ apiKey, session, folders, allToolNames, onSave }: ChatSettingsProps) {
  const [title, setTitle] = useState(session.title);
  const [system, setSystem] = useState(session.params.system ?? '');
  const [temperature, setTemperature] = useState(session.params.temperature?.toString() ?? '');
  const [maxTokens, setMaxTokens] = useState(session.params.max_tokens?.toString() ?? '');
  const [model, setModel] = useState(session.params.model ?? '');
  const [folderId, setFolderId] = useState(session.folderId ?? '');
  // null toolNames = all tools allowed
  const [selectedTools, setSelectedTools] = useState<Set<string>>(
    new Set(session.toolNames ?? allToolNames),
  );
  const [saved, setSaved] = useState(false);

  // The connection (provider/API key) stays a global, household-wide choice (Settings tab) — only
  // the model is a per-chat override. Reuses the same admin endpoints SettingsView's own model
  // picker uses; harmless to call under Cloudflare Access (isAdminAuthorized trusts the Access
  // identity the same way the rest of the app already does), see client.ts's doc comments.
  const [activeProfile, setActiveProfile] = useState('');
  const [modelOptions, setModelOptions] = useState<ProfileModelsResult['models']>([]);
  const [modelsError, setModelsError] = useState('');

  useEffect(() => {
    adminGetActiveProfile(null)
      .then((connection) => {
        setActiveProfile(connection.activeProfile);
        return adminListModelsForProfile(connection.activeProfile, null);
      })
      .then((result) => setModelOptions(result.models))
      .catch((err) => setModelsError(err instanceof ApiError ? err.message : 'failed to load models'));
  }, []);

  // Instruction sets: a personal library of reusable named system-prompt snippets. Picking one
  // only copies its content into the textarea below — still freely hand-editable, and not saved
  // until the usual "Save settings" button below is clicked.
  const [presets, setPresets] = useState<PromptPreset[]>([]);

  async function reloadPresets() {
    try {
      setPresets(await callTool<PromptPreset[]>('get_prompt_presets', {}, apiKey));
    } catch {
      // instruction sets are a convenience, not load-bearing — fail quietly, keep the previous list
    }
  }

  useEffect(() => {
    reloadPresets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveCurrentAsPreset() {
    const name = window.prompt('Name this instruction set');
    if (!name?.trim()) return;
    try {
      await callTool('create_prompt_preset', { name: name.trim(), content: system }, apiKey);
      await reloadPresets();
    } catch (err) {
      setModelsError(err instanceof ApiError ? err.message : 'failed to save instruction set');
    }
  }

  async function removePreset(presetId: string) {
    try {
      await callTool('delete_prompt_preset', { preset_id: presetId }, apiKey);
      await reloadPresets();
    } catch {
      // best-effort — the row simply won't disappear if this fails, no need for a banner
    }
  }

  function toggleTool(name: string) {
    const next = new Set(selectedTools);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelectedTools(next);
  }

  async function save() {
    const params: ChatParams = {};
    if (system.trim()) params.system = system.trim();
    if (temperature.trim() && !Number.isNaN(Number(temperature))) params.temperature = Number(temperature);
    if (maxTokens.trim() && !Number.isNaN(Number(maxTokens))) params.max_tokens = Number(maxTokens);
    if (model.trim()) params.model = model.trim();
    const allSelected = allToolNames.length > 0 && allToolNames.every((t) => selectedTools.has(t));
    await onSave({
      title: title.trim() || session.title,
      params,
      tool_names: allSelected ? null : [...selectedTools],
      folder_id: folderId || null,
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="chat-settings">
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>

      <fieldset className="preset-list">
        <legend>Instruction sets</legend>
        {presets.length === 0 && <div className="empty-state small">No saved instruction sets yet.</div>}
        {presets.map((preset) => (
          <div key={preset.presetId} className="preset-row" onClick={() => setSystem(preset.content)}>
            <span className="preset-row-name">{preset.name}</span>
            <button
              className="preset-row-delete"
              title="Delete instruction set"
              onClick={(e) => {
                e.stopPropagation();
                removePreset(preset.presetId);
              }}
            >
              &times;
            </button>
          </div>
        ))}
        <button type="button" className="save-preset-btn" onClick={saveCurrentAsPreset}>
          + Save current as preset
        </button>
      </fieldset>

      <label>
        System prompt
        <textarea value={system} onChange={(e) => setSystem(e.target.value)} rows={5} placeholder="(none)" />
      </label>

      <label>
        Model
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">(connection default)</option>
          {[model, ...modelOptions.map((m) => m.id)]
            .filter(Boolean)
            .filter((id, i, ids) => ids.indexOf(id) === i)
            .map((id) => {
              const opt = modelOptions.find((m) => m.id === id);
              return (
                <option key={id} value={id}>
                  {id}
                  {opt?.pricing
                    ? ` — ${formatPricePerMillion(opt.pricing.prompt)} in / ${formatPricePerMillion(opt.pricing.completion)} out per 1M tok`
                    : ''}
                </option>
              );
            })}
        </select>
        {activeProfile && <span className="model-connection-note">Connection: {activeProfile} (change in Settings)</span>}
        {modelsError && <div className="error-banner">{modelsError}</div>}
      </label>

      <div className="settings-row">
        <label>
          Temperature
          <input value={temperature} onChange={(e) => setTemperature(e.target.value)} placeholder="default" />
        </label>
        <label>
          Max tokens
          <input value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="default" />
        </label>
      </div>

      <label>
        Folder
        <select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
          <option value="">(none)</option>
          {folders.map((f) => (
            <option key={f.folderId} value={f.folderId}>
              {f.name}
            </option>
          ))}
        </select>
      </label>

      {allToolNames.length > 0 && (
        <fieldset className="tool-checklist">
          <legend>Tools available in this chat</legend>
          {allToolNames.map((name) => (
            <label key={name} className="tool-item">
              <input type="checkbox" checked={selectedTools.has(name)} onChange={() => toggleTool(name)} />
              {name}
            </label>
          ))}
        </fieldset>
      )}

      <div className="settings-actions">
        <button onClick={save}>Save settings</button>
        {saved && <span className="saved-note">Saved.</span>}
      </div>
    </div>
  );
}
