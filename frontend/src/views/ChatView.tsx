import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import {
  ApiError,
  adminGetActiveProfile,
  adminListModelsForProfile,
  archiveChat,
  callTool,
  chatCompletion,
  createChat,
  deleteMessage,
  forkChat,
  getChat,
  getChatTurnStatus,
  listFolders,
  listToolNames,
  truncateMessagesFrom,
  updateChat,
  uploadAttachment,
} from '../api/client';
import { formatPricePerMillion } from '../api/pricing';
import type { ChatMessage, ChatParams, ChatSessionRow, Folder, ProfileModelsResult, PromptPreset } from '../api/types';
import CanvasPanel from '../components/canvas/CanvasPanel';
import StagingBar, { type StagedFile } from '../components/attachments/StagingBar';
import ImageStagingBar, { type StagedImageFile } from '../components/attachments/ImageStagingBar';
import PinnedNotesDrawer from '../components/PinnedNotesDrawer';
import type { SummonableType } from '../hooks/useTabs';
import './ChatView.css';

// The "come here to do a task" specialist views. Settings is reachable via TabStrip's gear icon
// instead (always available, not just from this empty-chat landing state), so it isn't one of
// these.
const VIEW_SWITCH_OPTIONS: { type: SummonableType; label: string; icon: string }[] = [
  { type: 'notes', label: 'Notes', icon: '📝' },
  { type: 'documents', label: 'Documents', icon: '📄' },
];

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
  /** Opt-in escape hatch out of the chat-first default (principle 5): converts this still-empty
   *  draft tab into a specialist view. Only offered before anything's been sent — see the
   *  chat-empty-landing branch below. */
  onSwitchView?: (type: SummonableType) => void;
  /** Focuses (or opens) a chat tab by id — used by the "Fork from here" action to jump straight
   *  to the new branch once it's created (useTabs.ts's openChat). */
  onOpenChat?: (chatId: string, title?: string) => void;
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

// Mirrors orchestrator/src/server/openai.ts's own MAX_IMAGES_PER_TURN/MAX_IMAGE_BYTES/
// ALLOWED_IMAGE_MIME_TYPES — client-side so an oversized/unsupported image is rejected before a
// round trip, not duplicated logic the server relies on (the server's own check is still
// authoritative; this is a fail-fast convenience, same relationship as other client-side caps in
// this codebase, e.g. handleUploadAttachment.ts's MAX_UPLOAD_BYTES isn't imported by the frontend
// either).
const MAX_STAGED_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function readImageAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the "data:<mime>;base64," prefix readAsDataURL adds — the wire shape
      // (orchestrator/src/server/openai.ts's IncomingImage) wants raw base64 only.
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error(`failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

// Not real token streaming: runTurn resolves the full reply server-side before anything is sent
// back (httpServer.ts), so there's nothing to stream client-side either — just wait for the
// full response.
export default function ChatView({ apiKey, chatId, onChatCreated, onTitleChange, onSwitchView, onOpenChat }: ChatViewProps) {
  // Active conversation state
  const [activeChat, setActiveChat] = useState<ChatSessionRow | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  // What runTurn's currently running tool is doing, polled from GET /v1/chat/status while
  // `sending` is true (client.ts's getChatTurnStatus) — null renders as the old plain "…" bubble.
  const [turnStatus, setTurnStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Staged file attachments: held only in this tab's own state, never persisted — cleared once
  // the message carrying them is sent (see orchestrator/src/util/attachmentContext.ts).
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  // Staged images: never go through uploadAttachment/POST /v1/attachments/extract at all — read
  // client-side as base64 (see orchestrator/src/io/attachments/dispatchExtraction.ts's own
  // preamble on why there's nothing to extract). Same ephemeral, cleared-on-send lifecycle.
  const [stagedImages, setStagedImages] = useState<StagedImageFile[]>([]);
  const [attaching, setAttaching] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Per-message edit/copy UI state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Settings rail state — collapsed by default, but (unlike the old gear-icon toggle) available
  // even before a chat exists, so a system prompt/model/tools can be set up before the first
  // message. pendingSettings holds a save made before activeChat exists; send() applies it right
  // after the lazy createChat() so the very first message already sees it.
  const [settingsCollapsed, setSettingsCollapsed] = useState(true);
  const [pendingSettings, setPendingSettings] = useState<{
    params?: ChatParams;
    tool_names?: string[] | null;
    folder_id?: string | null;
    title?: string;
  } | null>(null);
  const [allToolNames, setAllToolNames] = useState<string[]>([]);
  // Mobile-only: chat and Canvas are full flex-1 panes side by side (ChatView.css), which is fine
  // on desktop but leaves neither one readable on a phone-width screen. Below the breakpoint, only
  // one of the two is shown at a time — this tracks which. Irrelevant on desktop, where both
  // panes are always visible and this toggle is hidden.
  const [mobileShowCanvas, setMobileShowCanvas] = useState(false);
  // Read-only here — just for the settings pane's folder-assignment dropdown. Creating/deleting
  // folders is the sidebar's ChatBrowser's job now.
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
      setSettingsCollapsed(true);
      setMobileShowCanvas(false);
      setError(null);
      setEditingId(null);
      return;
    }
    if (activeChat?.chatId === chatId) return;
    setMobileShowCanvas(false);
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

  // Re-fetches the active chat from the server — the source of truth for real messageIds, called
  // after every mutation (send/rerun/edit) rather than hand-constructing local state, so
  // copy/edit/rerun/delete always have a real id to act on. Also refreshes activeChat itself
  // (not just messages) so Canvas's canvasNoteId — which a turn may have just set server-side via
  // a tool's focusHint — shows up without a separate request.
  async function refreshActiveMessages(chatId: string) {
    const detail = await getChat(chatId, apiKey);
    setMessages(detail.messages.map((m) => ({ messageId: m.messageId, role: m.role, content: m.content })));
    setActiveChat(detail.session);
  }

  async function closeCanvas() {
    if (!activeChat) return;
    try {
      const updated = await updateChat(activeChat.chatId, { canvas_note_id: null }, apiKey);
      setActiveChat(updated);
      setMobileShowCanvas(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to close canvas');
    }
  }

  async function attachFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setError(null);

    // Images never go through uploadAttachment/POST /v1/attachments/extract — there's nothing to
    // extract (bb_principles.md §2 — interpreting an image is the LLM's job). Split by MIME type
    // so a single file-picker selection can mix ordinary attachments and images.
    const files = Array.from(fileList);
    const imageFiles = files.filter((f) => ALLOWED_IMAGE_MIME_TYPES.has(f.type));
    const otherFiles = files.filter((f) => !ALLOWED_IMAGE_MIME_TYPES.has(f.type));

    if (imageFiles.length > 0) {
      if (stagedImages.length + imageFiles.length > MAX_STAGED_IMAGES) {
        setError(`up to ${MAX_STAGED_IMAGES} images per message`);
      } else {
        const oversized = imageFiles.find((f) => f.size > MAX_IMAGE_BYTES);
        if (oversized) {
          setError(`${oversized.name} exceeds the ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))}MB image limit`);
        } else {
          try {
            const encoded = await Promise.all(
              imageFiles.map(async (file) => ({
                filename: file.name,
                mimeType: file.type,
                base64: await readImageAsBase64(file),
                previewUrl: URL.createObjectURL(file),
                id: crypto.randomUUID(),
              })),
            );
            setStagedImages((prev) => [...prev, ...encoded]);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'failed to read image');
          }
        }
      }
    }

    if (otherFiles.length > 0) {
      setAttaching(true);
      try {
        const uploaded = await Promise.all(otherFiles.map((file) => uploadAttachment(file, apiKey)));
        const withIds: StagedFile[] = uploaded.map((file) => ({ ...file, id: crypto.randomUUID() }));
        setStagedFiles((prev) => [...prev, ...withIds]);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'failed to attach file');
      } finally {
        setAttaching(false);
      }
    }
  }

  function removeStagedFile(id: string) {
    setStagedFiles((prev) => prev.filter((f) => f.id !== id));
  }

  function removeStagedImage(id: string) {
    setStagedImages((prev) => {
      const removed = prev.find((img) => img.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((img) => img.id !== id);
    });
  }

  async function send() {
    const text = draft.trim();
    if ((!text && stagedFiles.length === 0 && stagedImages.length === 0) || sending) return;

    // A file/image-only send (no typed text) still needs non-empty, readable content for the
    // message that actually gets persisted — neither a file's extracted text nor an image's bytes
    // are ever stored (see attachFiles/StagedAttachment/StagedImage), so history would otherwise
    // show a blank bubble forever.
    const stagedCount = stagedFiles.length + stagedImages.length;
    const displayText =
      text ||
      (stagedFiles.length === 1 && stagedImages.length === 0
        ? `Sent ${stagedFiles[0]!.filename}`
        : `Sent ${stagedCount} file${stagedCount === 1 ? '' : 's'}`);

    setError(null);
    setSending(true);
    const nextMessages: DisplayMessage[] = [...messages, { role: 'user', content: displayText }];
    setMessages(nextMessages);
    setDraft('');
    // Strip the client-only id (StagingBar's key/promotion-tracking field) before it goes over
    // the wire — the server's IncomingAttachment shape doesn't know about it.
    const attachments = stagedFiles.map(({ id: _id, ...rest }) => rest);
    // Only {mimeType, base64} travels over the wire — the server's IncomingImage shape has no
    // filename/previewUrl field (see client.ts's chatCompletion).
    const images = stagedImages.map(({ mimeType, base64 }) => ({ mimeType, base64 }));
    setStagedFiles([]);
    stagedImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    setStagedImages([]);
    try {
      let session = activeChat;
      if (!session) {
        session = await createChat(apiKey);
        if (pendingSettings) {
          session = await updateChat(session.chatId, pendingSettings, apiKey);
          setPendingSettings(null);
        }
        setActiveChat(session);
      }
      const chatId = session.chatId;
      const statusTimer = window.setInterval(async () => {
        setTurnStatus(await getChatTurnStatus(chatId, apiKey));
      }, 1000);
      try {
        await chatCompletion(toWireMessages(nextMessages), apiKey, chatId, attachments, images);
      } finally {
        window.clearInterval(statusTimer);
        setTurnStatus(null);
      }
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

  /** Branches a new chat from this one at messageId (inclusive) and jumps straight to it —
   *  docs/chat-memory.md. Leaves the current chat completely untouched. */
  async function forkFrom(messageId: string) {
    if (!activeChat) return;
    try {
      const forked = await forkChat(activeChat.chatId, messageId, apiKey);
      onOpenChat?.(forked.chatId, forked.title);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to fork chat');
    }
  }

  /** Marks this chat done — the explicit signal (docs/bb_principles.md §3) that triggers its
   *  end-of-chat long-term-memory extraction server-side. Once archived, a chat stops rolling
   *  into ongoing sync (chatMemorySync.ts), though it's still fully readable/searchable. */
  async function archiveCurrentChat() {
    if (!activeChat || activeChat.archivedAt) return;
    try {
      const archived = await archiveChat(activeChat.chatId, apiKey);
      setActiveChat(archived);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to archive chat');
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
    if (!activeChat) {
      // No chat exists yet — stash the draft, send() applies it right after createChat().
      setPendingSettings(patch);
      return;
    }
    try {
      const updated = await updateChat(activeChat.chatId, patch, apiKey);
      setActiveChat(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to save settings');
    }
  }

  return (
    <div className={`chat-view${mobileShowCanvas ? ' mobile-canvas' : ''}`}>
      <div className="chat-main">
        {error && <div className="error-banner">{error}</div>}

        <div className="chat-header">
          <span className="chat-title">{activeChat?.title ?? 'New chat'}</span>
          {activeChat && !activeChat.archivedAt && (
            <button type="button" className="chat-archive-button" title="Mark this chat done — extracts anything worth remembering long-term" onClick={archiveCurrentChat}>
              Archive
            </button>
          )}
          {activeChat?.archivedAt && <span className="chat-archived-badge" title={activeChat.archivedAt}>Archived</span>}
          {activeChat?.canvasNoteId && (
            <button
              type="button"
              className="chat-canvas-switch mobile-only"
              onClick={() => setMobileShowCanvas((v) => !v)}
            >
              {mobileShowCanvas ? '💬 Chat' : '📄 Canvas'}
            </button>
          )}
          <button
            type="button"
            className="chat-settings-summon mobile-only"
            title={settingsCollapsed ? 'Show chat settings' : 'Hide chat settings'}
            onClick={() => setSettingsCollapsed((c) => !c)}
          >
            ⚙
          </button>
        </div>

        <div className="chat-history" ref={historyRef}>
          {messages.length === 0 && chatId && <div className="empty-state">Ask bigBrain something.</div>}
          {messages.length === 0 && !chatId && (
            <div className="chat-empty-landing">
              {onSwitchView && (
                <div className="view-switch-pills">
                  {VIEW_SWITCH_OPTIONS.map((opt) => (
                    <button key={opt.type} type="button" onClick={() => onSwitchView(opt.type)}>
                      <span className="pill-icon">{opt.icon}</span>
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
              <PinnedNotesDrawer apiKey={apiKey} />
            </div>
          )}
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
                        <button onClick={() => forkFrom(m.messageId!)} title="Branch a new chat from this point, leaving this one untouched">
                          Fork from here
                        </button>
                        <button onClick={() => removeMessage(m.messageId!)}>Delete</button>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
          {sending && <div className="chat-bubble assistant pending">{turnStatus ?? '…'}</div>}
        </div>

        <StagingBar attachments={stagedFiles} apiKey={apiKey} onRemove={removeStagedFile} />
        <ImageStagingBar images={stagedImages} onRemove={removeStagedImage} />

        <form
          className="chat-input"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              attachFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            className="chat-attach-button"
            title="Attach a file or image"
            disabled={attaching}
            onClick={() => fileInputRef.current?.click()}
          >
            📎
          </button>
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
            autoFocus
          />
          <button
            type="submit"
            className="chat-send-button"
            disabled={sending || (!draft.trim() && stagedFiles.length === 0 && stagedImages.length === 0)}
          >
            <span className="chat-send-label">Send</span>
            <span className="chat-send-icon" aria-hidden="true">➤</span>
          </button>
        </form>
      </div>

      {activeChat?.canvasNoteId && (
        <CanvasPanel
          apiKey={apiKey}
          noteId={activeChat.canvasNoteId}
          refreshToken={messages.length}
          onClose={closeCanvas}
        />
      )}

      <div className={`chat-settings-rail${settingsCollapsed ? ' collapsed' : ''}`}>
        <div className="chat-settings-rail-header">
          <button
            className="chat-settings-toggle"
            title={settingsCollapsed ? 'Show chat settings' : 'Hide chat settings'}
            onClick={() => setSettingsCollapsed((c) => !c)}
          >
            {settingsCollapsed ? '«' : '»'}
          </button>
        </div>
        {!settingsCollapsed && (
          <div className="chat-settings-rail-content">
            <ChatSettings apiKey={apiKey} session={activeChat} folders={folders} allToolNames={allToolNames} onSave={saveSettings} />
          </div>
        )}
      </div>
    </div>
  );
}

interface ChatSettingsProps {
  apiKey: string | null;
  session: ChatSessionRow | null;
  folders: Folder[];
  allToolNames: string[];
  onSave: (patch: {
    params?: ChatParams;
    tool_names?: string[] | null;
    folder_id?: string | null;
    title?: string;
  }) => Promise<void>;
}

// session is null until the chat's first message is sent (it's created lazily) — every field
// below just falls back to an empty/default draft in that case. Saving while null hands the
// draft patch back up to ChatView, which applies it right after the chat is actually created.
function ChatSettings({ apiKey, session, folders, allToolNames, onSave }: ChatSettingsProps) {
  const [title, setTitle] = useState(session?.title ?? 'New chat');
  const [system, setSystem] = useState(session?.params.system ?? '');
  const [temperature, setTemperature] = useState(session?.params.temperature?.toString() ?? '');
  const [maxTokens, setMaxTokens] = useState(session?.params.max_tokens?.toString() ?? '');
  const [model, setModel] = useState(session?.params.model ?? '');
  const [folderId, setFolderId] = useState(session?.folderId ?? '');
  // null toolNames = all tools allowed
  const [selectedTools, setSelectedTools] = useState<Set<string>>(
    new Set(session?.toolNames ?? allToolNames),
  );
  const [saved, setSaved] = useState(false);

  // The household's active connection (Settings tab) is still the default every chat starts
  // from, but both the connection and the model within it can now be overridden per chat —
  // io/orchestratorSettings.ts's active_llm_profile stays what a brand-new chat uses, this is
  // just an escape hatch. Reuses the same admin endpoints SettingsView's own picker uses;
  // harmless to call under Cloudflare Access (isAdminAuthorized trusts the Access identity the
  // same way the rest of the app already does), see client.ts's doc comments. Unlike the
  // Settings-tab connection switch, picking a different one here needs no restart — httpServer.ts
  // builds a throwaway provider for this chat's turns instead of the boot-time one.
  const [activeProfile, setActiveProfile] = useState('');
  const [profileNames, setProfileNames] = useState<string[]>([]);
  const [profile, setProfile] = useState(session?.params.profile ?? '');
  const [modelOptions, setModelOptions] = useState<ProfileModelsResult['models']>([]);
  const [modelsError, setModelsError] = useState('');

  useEffect(() => {
    adminGetActiveProfile(null)
      .then((connection) => {
        setActiveProfile(connection.activeProfile);
        setProfileNames(connection.profileNames);
      })
      .catch((err) => setModelsError(err instanceof ApiError ? err.message : 'failed to load connections'));
  }, []);

  // Refetches the model catalog whenever a different connection is picked (or the household
  // default resolves), so the model dropdown always reflects whichever connection this chat would
  // actually use — same dependent-select shape as SettingsView's own connection/model pair.
  useEffect(() => {
    const effectiveProfile = profile || activeProfile;
    if (!effectiveProfile) return;
    let cancelled = false;
    adminListModelsForProfile(effectiveProfile, null)
      .then((result) => {
        if (!cancelled) setModelOptions(result.models);
      })
      .catch((err) => {
        if (!cancelled) setModelsError(err instanceof ApiError ? err.message : 'failed to load models');
      });
    return () => {
      cancelled = true;
    };
  }, [profile, activeProfile]);

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
    if (profile.trim()) params.profile = profile.trim();
    const allSelected = allToolNames.length > 0 && allToolNames.every((t) => selectedTools.has(t));
    await onSave({
      title: title.trim() || session?.title || 'New chat',
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
        Connection
        <select value={profile} onChange={(e) => setProfile(e.target.value)}>
          <option value="">
            (household default{activeProfile ? ` — ${activeProfile}` : ''})
          </option>
          {profileNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <span className="model-connection-note">Household default set in Settings; this only affects this chat.</span>
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
