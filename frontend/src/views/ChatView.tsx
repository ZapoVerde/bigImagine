import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkQuotes from '../lib/remarkQuotes';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import {
  ApiError,
  adminListConnectionModels,
  adminListConnections,
  archiveChat,
  callTool,
  chatCompletion,
  createChat,
  deleteMessage,
  editMessageContent,
  forkChat,
  getChat,
  getChatLocationImage,
  getChatBackgroundSettings,
  getChatLegibilitySettings,
  getChatTurnStatus,
  listFolders,
  listToolNames,
  reportBrokenLocationImage,
  swipeMessage,
  truncateMessagesFrom,
  updateChat,
  uploadAttachment,
} from '../api/client';
import { attachBackgroundParallax } from '../components/chat/backgroundParallax';
import { formatPricePerMillion } from '../api/pricing';
import { ADMIN_API_KEY_STORAGE_KEY } from '../api/authStorage';
import type {
  ApplyPromptStackToChatResult,
  ChatBackgroundSettings,
  ChatLegibilitySettings,
  ChatMessage,
  ChatParams,
  ChatSessionRow,
  ContextStackPreset,
  Folder,
  LlmConnectionSummary,
  ProfileModelsResult,
  PromptPreset,
} from '../api/types';
import CanvasPanel from '../components/canvas/CanvasPanel';
import PromptInspectorPanel from '../components/promptInspector/PromptInspectorPanel';
import BranchMapPanel from '../components/branchMap/BranchMapPanel';
import ChatSyncStatusPanel from '../components/chatSyncStatus/ChatSyncStatusPanel';
import CleanupStatusPill from '../components/cleanup/CleanupStatusPill';
import StagingBar, { type StagedFile } from '../components/attachments/StagingBar';
import ImageStagingBar, { type StagedImageFile } from '../components/attachments/ImageStagingBar';
import LegibilityMenu from '../components/chat/LegibilityMenu';
import PinnedNotesDrawer from '../components/PinnedNotesDrawer';
import type { SummonableType } from '../hooks/useTabs';
import './ChatView.css';

// The "come here to do a task" specialist views. Settings is reachable via TabStrip's gear icon
// instead (always available, not just from this empty-chat landing state), so it isn't one of
// these.
const VIEW_SWITCH_OPTIONS: { type: SummonableType; label: string; icon: string }[] = [
  { type: 'notes', label: 'Notes', icon: '📝' },
  { type: 'documents', label: 'Documents', icon: '📄' },
  { type: 'characters', label: 'Characters', icon: '🎭' },
  { type: 'browse-chub', label: 'Browse Chub', icon: '🔍' },
  { type: 'rag', label: 'RAG', icon: '🧠' },
  { type: 'promptstacks', label: 'Prompt Stacks', icon: '🧩' },
  { type: 'connections', label: 'Connections', icon: '🔌' },
  { type: 'cleanup', label: 'Cleanup', icon: '🧹' },
];

// GitHub's git-branch octicon (Primer) — the branch-map toggle icon. Inline SVG so it inherits
// currentColor and scales with the surrounding text (1em) instead of relying on an emoji glyph.
function GitBranchIcon() {
  return (
    <svg
      className="git-branch-icon"
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
    </svg>
  );
}

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
  /** Mobile-only: whether the app-level top bars (TabStrip + TimerStrip + this chat's header) are
   *  currently collapsed away — owned by App.tsx, which applies .app.top-bars-hidden. ChatView
   *  both drives it (scroll-down on the history collapses, scroll-up / pull-down-at-top restores)
   *  and reads it (to gate the pull gesture on the bars actually being hidden). */
  topBarsHidden: boolean;
  /** Ask the app to collapse (true) or restore (false) the top bars. */
  onTopBarsHiddenChange: (hidden: boolean) => void;
}

// messageId is set only once a message round-trips through the server and comes back from
// getChat — undefined for the brief optimistic window between sending and that refetch landing.
// Copy/edit/swipe/delete all need a real id (they're per-message API calls), so they're simply
// not offered on a message that doesn't have one yet.
interface DisplayMessage {
  messageId?: string;
  role: 'user' | 'assistant';
  content: string;
  /** Display-only macro-resolved copy of `content` (docs/prompt-macros.md's Stage 1) — served by
   *  GET /v1/chats/:id as resolvedContent for 'rp' chats whose stored text contains {{...}} tokens
   *  (chiefly a character's seeded greeting). Render this when present; `content` stays verbatim
   *  and is what gets re-sent, so the server's per-turn resolution stays fresh against the live
   *  persona. */
  resolvedContent?: string;
  /** Swipe capability on the last LLM response — present only once this message has been
   *  regenerated at least once. See api/types.ts's StoredChatMessage for the shape. */
  swipes?: { index: number; count: number };
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

// endpoint.md §5.1.8's "notify UI" gap: the post-turn bg pass runs decoupled from the reply, so
// after a turn that moved to a new location the rendered image lands a beat (or more) later. When
// a refresh finds an eligible location with no image yet, poll briefly — the displayed background
// stays up until its replacement is ready, then fades to it (refreshLocationImage below).
const BG_POLL_INTERVAL_MS = 2000;
const BG_POLL_MAX_TRIES = 30; // 60s cap — a provider round trip can sit in a queue for a while.

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
export default function ChatView({ apiKey, chatId, onChatCreated, onTitleChange, onSwitchView, onOpenChat, topBarsHidden, onTopBarsHiddenChange }: ChatViewProps) {
  // Active conversation state
  const [activeChat, setActiveChat] = useState<ChatSessionRow | null>(null);
  // endpoint.md §6.4: the active location's rendered background image for this chat (resolved via
  // the scene_id cache pointer, §2.6-filtered). nulls = no eligible location at all — a location
  // whose image hasn't rendered yet does NOT null this out: the previous background stays up until
  // the pending render is ready to replace it (refreshLocationImage below, endpoint.md §5.1.8).
  const [locationImage, setLocationImage] = useState<{ locationId: string; name: string; imageUrl: string } | null>(null);

  // Background fade state machine (parallax_fade_teststep.md §3): when locationImage's URL
  // changes, the old layer fades out (0.3s), then the src swaps and the new layer fades in (0.6s)
  // — SillyTavern-Vistalyze's single-layer class-toggle rhythm (style.css fade-out/fade-in), not a
  // two-image crossfade. bgUrl is the URL actually displayed (it lags locationImage during a fade);
  // bgFadeClass is the active transition class. The img is deliberately NOT keyed by URL — the key
  // used to remount it, which made every location change an instant cut.
  const [bgUrl, setBgUrl] = useState<string | null>(null);
  const [bgFadeClass, setBgFadeClass] = useState('');
  const bgFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The bg-replacement poll (see the BG_POLL_* constants): while a location's render is still in
  // flight, refreshLocationImage re-checks every BG_POLL_INTERVAL_MS so the new background swaps in
  // the moment it's ready. Cleared on image arrival, on chat switch, and on unmount.
  const bgPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bgPollTriesRef = useRef(0);
  // Staleness/disposal guards for the poll and the in-flight refreshes it drives. bgChatIdRef is
  // the chat this bg work belongs to, kept in sync with the chatId prop; bgDisposedRef flips on
  // unmount. An async resolve or a poll tick for a stale chat — or after unmount — must neither
  // clobber the on-screen chat's background nor re-arm an orphaned interval.
  const bgChatIdRef = useRef(chatId);
  const bgDisposedRef = useRef(false);
  // endpoint.md §5.1.8's last-turn location state on the client side: the endpoint's `previous`
  // from the last refresh (the revert target a regen swipe shows while the new turn settles), the
  // last settled current locationId (to compute freshness — "did the swiped turn establish the
  // current background"), and whether that location was freshly established by the last settle.
  // All three reset on chat switch; freshness starts false on load (a chat's historical
  // background is established, never "fresh").
  const bgPreviousRef = useRef<{ locationId: string; name: string; imageUrl: string } | null>(null);
  const bgLastLocationIdRef = useRef<string | null>(null);
  const bgFreshRef = useRef(false);

  // Chat background settings (parallax_fade_teststep.md §2.2 + migration 0073): the whole set —
  // parallax toggle, overlay veil opacity/shade, bubble opacity/shades — read live from the
  // orchestrator at chat load (the household-key user gate, same shape as /v1/timezone). The
  // parallax attach effect below only engages when it's on AND a background image is present;
  // the other fields become CSS custom properties on the view root (chatBgStyle below), which
  // the overlay/bubble rules in ChatView.css consume. null until the fetch resolves = the CSS
  // fallbacks (theme tokens + built-in 0.5/70% defaults) apply.
  const [bgSettings, setBgSettings] = useState<ChatBackgroundSettings | null>(null);
  const chatMainRef = useRef<HTMLDivElement | null>(null);
  const bgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    getChatBackgroundSettings(apiKey)
      .then(setBgSettings)
      .catch(() => setBgSettings(null));
  }, [apiKey]);

  // The "Text legibility" toggles (migration 0074): five opt-in text-rendering tricks for prose
  // on the translucent bubbles (components/chat/LegibilityMenu.tsx, collapsible menu at the top
  // of the chat settings rail). Read live at chat load like bgSettings — household-wide, so one
  // set applies to every chat. null until the fetch resolves = all toggles off (the built-in
  // look); the active flags become space-separated data-legibility tokens on the view root, and
  // the rule sets of the same names in ChatView.css key off [data-legibility~=…].
  const [legSettings, setLegSettings] = useState<ChatLegibilitySettings | null>(null);

  useEffect(() => {
    getChatLegibilitySettings(apiKey)
      .then(setLegSettings)
      .catch(() => setLegSettings(null));
  }, [apiKey]);

  const legibilityFlags = legSettings
    ? [
        legSettings.halo && 'halo',
        legSettings.outline && 'outline',
        legSettings.solidCode && 'solid-code',
        legSettings.weightBump && 'weight',
        legSettings.hoverFocus && 'hover-focus',
      ]
        .filter((f): f is string => typeof f === 'string')
        .join(' ')
    : '';

  // The halo ring's intensity (migration 0075) as a CSS custom property: ChatView.css mixes the
  // per-theme halo colors at this percentage, so 0% = invisible ring, 100% = full force. Read
  // from the same settings object the toggles live in — the menu's slider writes it household-
  // wide, applied live with no restart.
  const legStyle = legSettings
    ? ({ '--halo-strength': `${Math.round(legSettings.haloStrength * 100)}%` } as React.CSSProperties)
    : undefined;

  // The settings, as CSS custom properties for ChatView.css: the overlay veil (opacity is a
  // plain 0..1 number — the CSS `opacity` property accepts it directly) and the bubble fill
  // (opacity as a percentage — color-mix needs one). Unitless/percentage strings so the rules
  // below can just var() them.
  const chatBgStyle = bgSettings
    ? ({
        '--chat-bg-overlay-opacity': String(bgSettings.overlayOpacity),
        '--chat-bg-overlay-shade': bgSettings.overlayShade,
        '--chat-bubble-opacity': `${Math.round(bgSettings.bubbleOpacity * 100)}%`,
        '--chat-bubble-user-shade': bgSettings.bubbleUserShade,
        '--chat-bubble-assistant-shade': bgSettings.bubbleAssistantShade,
      } as React.CSSProperties)
    : undefined;

  // Attach/dispose the parallax pan (parallax_fade_teststep.md §2.3): the img element persists
  // across URL fades (it is not keyed), so this effect keys on whether an image is present at
  // all + the toggle, not on the URL itself. Disposing is mandatory on unmount/disable/chat
  // switch so no rAF loop outlives this view.
  useEffect(() => {
    if (!bgSettings?.parallaxEnabled || !bgUrl) return;
    const container = chatMainRef.current;
    const img = bgRef.current;
    if (!container || !img) return;
    const handle = attachBackgroundParallax(container, img);
    return () => handle.dispose();
  }, [bgSettings?.parallaxEnabled, bgUrl !== null]);

  useEffect(() => {
    const next = locationImage?.imageUrl ?? null;
    // Any pending swap is superseded by this change — even when next equals bgUrl again (the
    // image bounced back to the current URL mid-fade), the old timer must not fire and swap to a
    // stale URL.
    if (bgFadeTimerRef.current) clearTimeout(bgFadeTimerRef.current);
    if (next === bgUrl) {
      // Bounced back to the currently displayed URL mid-fade: the pending swap is cancelled
      // above, and the layer must return to its resting state too — otherwise the fade-out
      // class (opacity 0) sticks until the next URL change leaves the background invisible.
      setBgFadeClass('');
      return;
    }
    if (bgUrl === null) {
      // First paint (or recovery from a broken link): show immediately — no fade-out of nothing.
      setBgUrl(next);
      setBgFadeClass(next ? 'vistalyze-fade-in' : '');
      return;
    }
    // URL changed: fade the old layer out, then swap src and fade the new one in.
    setBgFadeClass('vistalyze-fade-out');
    bgFadeTimerRef.current = setTimeout(() => {
      bgFadeTimerRef.current = null;
      setBgUrl(next);
      setBgFadeClass(next ? 'vistalyze-fade-in' : '');
    }, 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationImage?.imageUrl]);

  // Reset the disposal flag in the setup body: StrictMode's dev double-mount unmounts then
  // remounts with the SAME ref objects (initializers don't re-run), so the unmount cleanup
  // below must not leave the flag set on a live second mount — that would permanently disable
  // the bg refresh/poll in dev.
  useEffect(() => {
    bgDisposedRef.current = false;
    return () => {
      if (bgFadeTimerRef.current) clearTimeout(bgFadeTimerRef.current);
      bgDisposedRef.current = true;
      stopBgPoll();
    };
  }, []);
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
  // Mobile: which message's action row is revealed by tapping its bubble — hidden by default
  // below the mobile breakpoint (ChatView.css). One at a time: tapping another message moves the
  // reveal, tapping the same message again closes it. Desktop is unaffected — the CSS rules that
  // read this class live inside the mobile media query.
  const [actionsVisibleId, setActionsVisibleId] = useState<string | null>(null);
  // Which message a swipe (prev/next/regenerate) is in flight for, if any — deliberately not the
  // same flag `sending` uses, since a swipe replaces one message's content in place and shouldn't
  // render the "new turn incoming" pending bubble the way send/rerun's own full turns do.
  const [swipingId, setSwipingId] = useState<string | null>(null);
  // Mobile: browse an already-stored swipe (e.g. a card's alternate greetings) with a left/right
  // finger drag on the bubble itself, same direction convention st-source/RossAscends-mods.js uses
  // (finger-left -> next, finger-right -> prev) so it feels familiar to anyone coming from ST. A
  // plain ref, not state — the gesture only reads position at touchend, no re-render needed mid-drag.
  const touchSwipeStartRef = useRef<{ x: number; y: number } | null>(null);

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
    cleanup_preset_id?: string | null;
  } | null>(null);
  const [allToolNames, setAllToolNames] = useState<string[]>([]);
  // Mobile-only: chat and Canvas are full flex-1 panes side by side (ChatView.css), which is fine
  // on desktop but leaves neither one readable on a phone-width screen. Below the breakpoint, only
  // one of the two is shown at a time — this tracks which. Irrelevant on desktop, where both
  // panes are always visible and this toggle is hidden.
  const [mobileShowCanvas, setMobileShowCanvas] = useState(false);
  // Prompt Inspector: opt-in per bi_principles.md §5 (specialist views are layered on top, never
  // required) — a household member reviewing exactly what an 'rp' chat's next turn would send.
  // Only offered for 'rp' chats (the header button below is gated on activeChat?.kind === 'rp');
  // mounted only while open, same conditional-render shape as CanvasPanel.
  const [promptInspectorOpen, setPromptInspectorOpen] = useState(false);
  // Branch Map: read-only tree of this chat's fork family (docs/chat-memory.md) — opt-in per
  // bi_principles.md §5, same as Canvas/Prompt Inspector. Offered for any chat, not just 'rp'.
  const [branchMapOpen, setBranchMapOpen] = useState(false);
  // RP-chat header hamburger menu — folds the prompt-inspector and branch-map toggles plus
  // file/image attach under one control (see the header below). Non-RP chats keep their single
  // branch-map button and the input-row paper clip instead.
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  // Sync Status panel (RP chat ☰ menu → "Sync status"): this chat's slice of the rolling memory
  // sync loop's status record — when the last attempt/success landed, what it did, and when the
  // next one is due. Mounted only while open, same conditional-render shape as the other panels.
  const [syncStatusOpen, setSyncStatusOpen] = useState(false);
  // Selection-mode bulk delete (hamburger → "Delete messages"): a tickbox on every message, and
  // ticking any entry selects everything below it, so the selected set is always a trailing
  // suffix — exactly what the server's truncateMessagesFrom removes in one call. RP-chat only,
  // like the menu itself.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectionStart, setSelectionStart] = useState<number | null>(null);
  // Read-only here — just for the settings pane's folder-assignment dropdown. Creating/deleting
  // folders is the sidebar's ChatBrowser's job now.
  const [folders, setFolders] = useState<Folder[]>([]);

  const historyRef = useRef<HTMLDivElement | null>(null);
  const chatMenuRef = useRef<HTMLDivElement | null>(null);
  // Second mount of the ☰ chat menu, in the mobile input row opposite Send (the desktop copy
  // lives in the chat header). Only one is visible at a time — CSS hides the header one on
  // mobile and the row one on desktop — but both need to participate in outside-click closing.
  const chatMenuMobileRef = useRef<HTMLDivElement | null>(null);

  // Mobile collapsing top bars (App.css's .app.top-bars-hidden): scroll-down on the history
  // collapses the TabStrip/TimerStrip/chat-header, scroll-up restores them, and pulling down at
  // the top is the finger-driven version of the same reveal. Mirrored in a ref so the scroll and
  // touch handlers can read the latest value without re-subscribing.
  const topBarsHiddenRef = useRef(topBarsHidden);
  const lastHistoryScrollTopRef = useRef(0);
  // Pull-down gesture state: where the drag started, and how far the bars have been pulled (the
  // touchend snap threshold reads it). Plain refs — mid-drag the bars follow via direct DOM
  // writes (applyTopBarPull), no re-render needed.
  const pullStartRef = useRef<{ x: number; y: number } | null>(null);
  const pullRef = useRef(0);

  useEffect(() => {
    topBarsHiddenRef.current = topBarsHidden;
  }, [topBarsHidden]);

  useEffect(() => {
    listFolders(apiKey).then(setFolders).catch(() => {});
    listToolNames(apiKey).then(setAllToolNames).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Loads the chat this tab was opened for. Guarded so the round trip through onChatCreated below
  // (parent hands the new id back as a prop) doesn't trigger a redundant refetch.
  useEffect(() => {
    bgChatIdRef.current = chatId;
    bgPreviousRef.current = null;
    bgLastLocationIdRef.current = null;
    bgFreshRef.current = false;
    lastHistoryScrollTopRef.current = 0;
    if (!chatId) {
      setActiveChat(null);
      setMessages([]);
      setSettingsCollapsed(true);
      setMobileShowCanvas(false);
      setPromptInspectorOpen(false);
      setBranchMapOpen(false);
      setChatMenuOpen(false);
      setSyncStatusOpen(false);
      setSelectionMode(false);
      setSelectionStart(null);
      setError(null);
      setEditingId(null);
      stopBgPoll();
      return;
    }
    if (activeChat?.chatId === chatId) return;
    setMobileShowCanvas(false);
    setPromptInspectorOpen(false);
    setBranchMapOpen(false);
    setChatMenuOpen(false);
    setSyncStatusOpen(false);
    setSelectionMode(false);
    setSelectionStart(null);
    stopBgPoll();
    getChat(chatId, apiKey)
      .then((detail) => {
        setActiveChat(detail.session);
        setMessages(detail.messages.map((m) => ({ messageId: m.messageId, role: m.role, content: m.content, resolvedContent: m.resolvedContent, swipes: m.swipes })));
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'failed to load chat'));
    refreshLocationImage(chatId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  // Close the ☰ chat menu (either mount — header or mobile input row) on outside click or
  // Escape. Only mounted while the menu is open, so the listeners cost nothing when it isn't.
  useEffect(() => {
    if (!chatMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideHeader = chatMenuRef.current?.contains(target);
      const insideRow = chatMenuMobileRef.current?.contains(target);
      if (!insideHeader && !insideRow) {
        setChatMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setChatMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [chatMenuOpen]);

  // --- Mobile collapsing top bars (App.css's .app.top-bars-hidden) ---
  // Scrolling down the history collapses the TabStrip/TimerStrip/chat-header; scrolling up (or
  // pulling down at the top, below) restores them. Everything here is gated on the 768px
  // breakpoint — desktop keeps the bars permanently, and only the active, scrolling chat drives
  // the state (inactive tabs are display:none, so they never scroll).
  const updateTopBars = (hidden: boolean) => {
    if (topBarsHiddenRef.current === hidden) return;
    onTopBarsHiddenChange(hidden);
  };

  const handleHistoryScroll = () => {
    const el = historyRef.current;
    if (!el || window.innerWidth >= 768) return;
    const delta = el.scrollTop - lastHistoryScrollTopRef.current;
    lastHistoryScrollTopRef.current = el.scrollTop;
    // Small scroll-up at the top shouldn't collapse: require a real downward scroll and some
    // distance from the top before hiding, but restore on any upward scroll.
    if (delta > 6 && el.scrollTop > 60) updateTopBars(true);
    else if (delta < -6) updateTopBars(false);
  };

  // Direct manipulation during the pull: both collapsing wrappers (.app-top-bars, .chat-top-bar)
  // follow the finger via an inline px row height, with transitions disabled (the app-level
  // .top-bars-dragging class) so they don't fight the drag. On release the inline styles are
  // cleared and the class-driven 0fr/1fr transition animates the snap.
  const applyTopBarPull = (px: number) => {
    const appEl = chatMainRef.current?.closest('.app');
    if (!(appEl instanceof HTMLElement)) return;
    appEl.classList.add('top-bars-dragging');
    appEl.querySelectorAll<HTMLElement>('.app-top-bars, .chat-top-bar').forEach((el) => {
      el.style.gridTemplateRows = `${px}px`;
    });
  };
  const clearTopBarPull = () => {
    const appEl = chatMainRef.current?.closest('.app');
    if (!(appEl instanceof HTMLElement)) return;
    appEl.classList.remove('top-bars-dragging');
    appEl.querySelectorAll<HTMLElement>('.app-top-bars, .chat-top-bar').forEach((el) => {
      el.style.gridTemplateRows = '';
    });
  };

  const handleHistoryTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (window.innerWidth >= 768 || !topBarsHiddenRef.current) return;
    const t = e.touches[0];
    if (t) pullStartRef.current = { x: t.clientX, y: t.clientY };
  };
  // touchcancel lands here too (React's onTouchCancel): a dropped gesture (system alert,
  // edge swipe, etc.) must still clear the drag or the bars would stick at partial height.
  const handleHistoryTouchEnd = () => {
    const start = pullStartRef.current;
    pullStartRef.current = null;
    if (!start || window.innerWidth >= 768) return;
    clearTopBarPull();
    // Snap: pulled past ~40 of the 72px cap -> reveal, otherwise collapse back.
    updateTopBars(pullRef.current < 40);
    pullRef.current = 0;
  };

  // The touchmove listener must be native and non-passive so preventDefault actually stops the
  // browser's own overscroll/pull-to-refresh while the user drags the bars down from the top
  // (React's synthetic touchmove is registered passive and can't preventDefault).
  useEffect(() => {
    const el = historyRef.current;
    if (!el) return;
    const onTouchMove = (e: TouchEvent) => {
      if (window.innerWidth >= 768 || !topBarsHiddenRef.current) return;
      const start = pullStartRef.current;
      if (!start) return;
      // Pull-to-reveal only makes sense at the very top — anywhere else a downward drag is
      // ordinary scrolling toward older messages and must not be hijacked (a hijacked one
      // would also preventDefault, which would block that scroll entirely).
      if ((historyRef.current?.scrollTop ?? 0) !== 0) return;
      const touch = e.touches[0];
      if (!touch) return;
      const dy = touch.clientY - start.y;
      const dx = Math.abs(touch.clientX - start.x);
      // Dominant downward drag only — never hijack the horizontal swipe gesture on bubbles.
      if (dy <= 12 || dy < dx) return;
      e.preventDefault();
      const pull = Math.min(dy, 72);
      pullRef.current = pull;
      applyTopBarPull(pull);
    };
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      el.removeEventListener('touchmove', onTouchMove);
      // Unmount mid-drag must not leave the App-level wrappers stuck at a partial height.
      clearTopBarPull();
      pullRef.current = 0;
      pullStartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape exits selection mode too, same as it closes the hamburger menu.
  useEffect(() => {
    if (!selectionMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectionMode(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selectionMode]);

  // Stops the bg-replacement poll (BG_POLL_* above) and resets its try counter. Called on image
  // arrival, on "no eligible location", on chat switch, and on unmount.
  function stopBgPoll() {
    if (bgPollTimerRef.current !== null) {
      clearInterval(bgPollTimerRef.current);
      bgPollTimerRef.current = null;
    }
    bgPollTriesRef.current = 0;
  }

  // endpoint.md §6.4: refresh the chat's active-location background image. Best-effort — a
  // failure just leaves the previous image (or none), never surfaces an error banner for what is
  // decorative state. Display rule (endpoint.md §5.1.8): the current location's image when it has
  // one; while it's pending (imageUrl null — the post-turn bg pass fires only after the reply is
  // sent, endpoint.md §5) or the chat has no eligible location at all, the last settled location's
  // image stays up instead of blanking the layer — "some background is better than no background
  // even if stale". Only a chat that never had a location shows nothing. A pending render keeps a
  // bounded poll running (BG_POLL_*) until the replacement lands.
  async function refreshLocationImage(chatId: string) {
    let payload: Awaited<ReturnType<typeof getChatLocationImage>>;
    try {
      payload = await getChatLocationImage(chatId, apiKey);
    } catch {
      // Best-effort fetch — a transient failure leaves whatever background is currently showing.
      return;
    }
    // Stale-response guard: the chat on screen may have changed (or this ChatView unmounted)
    // while the request was in flight — don't clobber the new chat's background, and don't let a
    // stale null re-arm a poll against an old chatId.
    if (bgDisposedRef.current || bgChatIdRef.current !== chatId) return;
    const { current, previous } = payload;
    bgPreviousRef.current = previous?.imageUrl ? { locationId: previous.locationId, name: previous.name, imageUrl: previous.imageUrl } : null;
    if (current?.imageUrl) {
      // A rendered current — show it; the fade state machine swaps it in. Freshness: the
      // location changed on this settle (a swipe of that turn should revert to the previous
      // location). Any pending poll for the old render is moot now.
      bgFreshRef.current = bgLastLocationIdRef.current !== null && current.locationId !== bgLastLocationIdRef.current;
      bgLastLocationIdRef.current = current.locationId;
      setLocationImage({ locationId: current.locationId, name: current.name, imageUrl: current.imageUrl });
      stopBgPoll();
      return;
    }
    // No rendered current: the render is still pending, or the chat has no eligible location.
    // Keep the last settled location up rather than blanking; only a never-located chat shows
    // nothing. The settle (whenever it lands) updates freshness via the branch above.
    if (bgPreviousRef.current && bgPreviousRef.current.imageUrl !== locationImage?.imageUrl) {
      setLocationImage(bgPreviousRef.current);
    } else if (!bgPreviousRef.current) {
      setLocationImage(null);
    }
    if (current && !current.imageUrl) {
      // Pending render — poll until it lands (bounded — see BG_POLL_MAX_TRIES).
      if (bgPollTimerRef.current === null) {
        bgPollTriesRef.current = 0;
        bgPollTimerRef.current = setInterval(() => {
          // Belt-and-suspenders on top of stopBgPoll's chat-switch/unmount teardown: never let a
          // tick outlive its chat or its ChatView (a stale tick would fetch a wrong chat's image).
          if (bgDisposedRef.current || bgChatIdRef.current !== chatId) {
            stopBgPoll();
            return;
          }
          bgPollTriesRef.current += 1;
          if (bgPollTriesRef.current > BG_POLL_MAX_TRIES) {
            stopBgPoll();
            return;
          }
          void refreshLocationImage(chatId);
        }, BG_POLL_INTERVAL_MS);
      }
    } else {
      stopBgPoll();
    }
  }

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

  // Every messages/sending change funnels through here — send, resend, swipe-regenerate,
  // edit-resend, and the reply landing. Position the view at the TOP of the new turn (the
  // newest user message — the start of the turn, so a fresh reply reads from its beginning)
  // instead of the bottom of the new content. Fallbacks: a greeting-only chat has no user
  // message, so its turn starts at the first message; an empty history just settles at the
  // bottom (a no-op). Instant jump, same as the old bottom-scroll — never smooth, so a landing
  // reply can't animate a scroll race with the user.
  useEffect(() => {
    const el = historyRef.current;
    if (!el) return;
    let turnStart = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') {
        turnStart = i;
        break;
      }
    }
    const target = el.querySelectorAll<HTMLElement>('.chat-message')[turnStart];
    if (!target) {
      el.scrollTo({ top: el.scrollHeight });
      return;
    }
    // Viewport-relative distance from the container's top edge to the target's top edge —
    // independent of the container's current scrollTop and of where the positioned ancestors
    // sit, so aligning scrollTop to it puts the turn's start flush at the top of the view.
    el.scrollTo({ top: target.getBoundingClientRect().top - el.getBoundingClientRect().top });
  }, [messages, sending]);

  // Re-fetches the active chat from the server — the source of truth for real messageIds, called
  // after every mutation (send/rerun/edit) rather than hand-constructing local state, so
  // copy/edit/rerun/delete always have a real id to act on. Also refreshes activeChat itself
  // (not just messages) so Canvas's canvasNoteId — which a turn may have just set server-side via
  // a tool's focusHint — shows up without a separate request.
  async function refreshActiveMessages(chatId: string) {
    const detail = await getChat(chatId, apiKey);
    setMessages(detail.messages.map((m) => ({ messageId: m.messageId, role: m.role, content: m.content, resolvedContent: m.resolvedContent, swipes: m.swipes })));
    setActiveChat(detail.session);
    refreshLocationImage(chatId);
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

  /** Resend mode: the chat's last message is the user's own (its AI reply was deleted or never
   *  arrived) and there's nothing new typed or staged — the Send button lights up and pressing it
   *  re-runs that turn instead of sending a new message. The history is sent as-is, no user
   *  message appended, which httpServer.ts's isNewTurn check reads as "no new turn": the user
   *  message is not duplicated and the fresh assistant reply lands under it. */
  function resendMode(): boolean {
    const lastMsg = messages[messages.length - 1];
    return (
      !sending &&
      !selectionMode &&
      lastMsg?.role === 'user' &&
      !draft.trim() &&
      stagedFiles.length === 0 &&
      stagedImages.length === 0
    );
  }

  async function send() {
    const text = draft.trim();
    const resendLast = resendMode();
    if (sending) return;
    if (!resendLast && !text && stagedFiles.length === 0 && stagedImages.length === 0) return;

    // A file/image-only send (no typed text) still needs non-empty, readable content for the
    // message that actually gets persisted — neither a file's extracted text nor an image's bytes
    // are ever stored (see attachFiles/StagedAttachment/StagedImage), so history would otherwise
    // show a blank bubble forever.
    const stagedCount = stagedFiles.length + stagedImages.length;
    const displayText = resendLast
      ? messages[messages.length - 1]!.content
      : text ||
        (stagedFiles.length === 1 && stagedImages.length === 0
          ? `Sent ${stagedFiles[0]!.filename}`
          : `Sent ${stagedCount} file${stagedCount === 1 ? '' : 's'}`);

    setError(null);
    setSending(true);
    // Resend re-runs the existing history as-is; a normal send appends this turn's user message.
    const nextMessages: DisplayMessage[] = resendLast
      ? messages
      : [...messages, { role: 'user', content: displayText }];
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
      setError(err instanceof ApiError ? err.message : 'failed to reach BigImagine');
    } finally {
      setSending(false);
    }
  }

  /** Swipe capability on the last LLM response: 'prev'/'next' mostly just swap messageId's active
   *  content to an already-generated variant, in place — no resend, nothing else in the
   *  conversation changes. 'next' past the newest stored variant instead triggers a fresh
   *  regeneration server-side (still in place, via recordSwipe) — this is also what "Rerun" is
   *  now, so the Rerun button below just calls swipe(id, 'next'). Only ever offered on the
   *  chat's current last assistant reply (isLastAssistant below); the server enforces this too.
   *
   *  endpoint.md §5.1.8's revert rule: regenerating the last turn invalidates its background when
   *  that turn *established* it (the location changed on the last settle — a freshly generated
   *  image). The display reverts to the last settled location immediately and keeps it while the
   *  new turn settles (its location + render), then the refresh swaps in the replacement;
   *  a failure restores the swiped-from background. Plain prev/next cycling between stored
   *  variants never reverts — the location state doesn't change. */
  async function swipe(messageId: string, direction: 'prev' | 'next') {
    if (!activeChat || sending || swipingId) return;
    setError(null);
    setSwipingId(messageId);
    const msg = messages.find((m) => m.messageId === messageId);
    const hasMoreSwipesAhead = !!msg?.swipes && msg.swipes.index < msg.swipes.count - 1;
    const willRegenerate = direction === 'next' && !hasMoreSwipesAhead;
    const swipedFrom = locationImage;
    const prevImage = bgPreviousRef.current;
    const reverted =
      willRegenerate &&
      bgFreshRef.current &&
      !!prevImage?.imageUrl &&
      prevImage.imageUrl !== locationImage?.imageUrl;
    if (reverted) {
      // The swiped turn's freshly generated image belongs to content being replaced — show the
      // last settled location until the regenerated turn settles.
      setLocationImage({ locationId: prevImage.locationId, name: prevImage.name, imageUrl: prevImage.imageUrl });
    }
    try {
      const result = await swipeMessage(activeChat.chatId, messageId, direction, apiKey);
      if ('message' in result) {
        setMessages((prev) =>
          prev.map((m) => (m.messageId === messageId ? { ...m, content: result.message.content, resolvedContent: result.message.resolvedContent, swipes: result.message.swipes } : m)),
        );
        // A switch happened (regeneration or variant cycle) — the active swipe changed, so the
        // location state may have too: re-read it. For a regen the new location is pending until
        // its render lands, so the reverted previous background stays up and the poll swaps in
        // the replacement the moment it's ready; for a cycle the server's own trigger
        // (ensureActiveLocationImage) restarts a dropped render and this read picks it up.
        void refreshLocationImage(activeChat.chatId);
      }
      // 'no_earlier_swipe': nothing to do — the prev button is already disabled at index 0.
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to swipe');
      // The swipe failed — the turn is unchanged, so restore the swiped-from background.
      if (reverted) setLocationImage(swipedFrom);
    } finally {
      setSwipingId(null);
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

  /** Edits a message. Two distinct semantics by role:
   *  - user message: truncates it (and everything after — the conversation branches from here)
   *    server-side, then resends the kept history plus the edited content as a new turn. One
   *    message longer than what's now persisted, so handleChatCompletions treats it as genuinely
   *    new and appends both the edited message and its fresh reply.
   *  - assistant message (the "edit an LLM reply" action): the text is rewritten in place — same
   *    message id, everything after untouched, the pre-edit text preserved as a swipe — and the
   *    conversation simply continues from the edited reply. No truncation, no branch. */
  async function submitEdit() {
    const messageId = editingId;
    const content = editDraft.trim();
    if (!activeChat || !messageId || !content || sending) return;
    const target = messages.find((m) => m.messageId === messageId);
    if (!target) return;
    setError(null);
    setEditingId(null);
    setSending(true);
    try {
      if (target.role === 'assistant') {
        if (content === target.content) return; // nothing changed — no junk swipe server-side
        await editMessageContent(activeChat.chatId, messageId, content, apiKey);
      } else {
        await truncateMessagesFrom(activeChat.chatId, messageId, apiKey);
        const idx = messages.findIndex((m) => m.messageId === messageId);
        const kept = idx === -1 ? messages : messages.slice(0, idx);
        const withEdit: DisplayMessage[] = [...kept, { role: 'user', content }];
        setMessages(withEdit);
        await chatCompletion(toWireMessages(withEdit), apiKey, activeChat.chatId);
      }
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

  // --- Selection-mode bulk delete (hamburger → "Delete messages") ---
  // Ticking a message selects everything below it too, so the selection is always a trailing
  // suffix of the conversation; un-ticking works symmetrically (clears that message and all
  // below it). Deleting = one truncateMessagesFrom call at the first selected message.
  function toggleSelect(index: number) {
    if (messages[index] && !messages[index].messageId) return; // pending message — not selectable
    setSelectionStart((s) => {
      if (s !== null && index >= s) return index === s ? null : s; // uncheck: clears index..end
      return index;
    });
  }

  function cancelSelectionMode() {
    setSelectionMode(false);
    setSelectionStart(null);
  }

  async function confirmSelectionDelete() {
    if (!activeChat || selectionStart === null) return;
    const firstId = messages[selectionStart]?.messageId;
    if (!firstId) return;
    setError(null);
    try {
      await truncateMessagesFrom(activeChat.chatId, firstId, apiKey);
      await refreshActiveMessages(activeChat.chatId);
      cancelSelectionMode();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to delete messages');
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

  /** Mobile tap-to-reveal for a message's action row: tapping the bubble toggles which message's
   *  row is visible (one at a time). Action-button clicks stopPropagation inside the row, so
   *  using the buttons doesn't collapse the row mid-use. */
  function toggleMessageActions(messageId: string | undefined) {
    if (!messageId) return;
    setActionsVisibleId((cur) => (cur === messageId ? null : messageId));
  }

  async function saveSettings(patch: {
    params?: ChatParams;
    tool_names?: string[] | null;
    folder_id?: string | null;
    title?: string;
    cleanup_preset_id?: string | null;
    cleanup_enabled_at?: string | null;
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

  // Shared between the desktop header ☰ and the mobile input-row ☰ — the same five items, two
  // mounts (ChatView.css hides the header copy on mobile and the row copy on desktop). One
  // chatMenuOpen state serves both.
  const chatMenuItems = (
    <>
      <button
        type="button"
        role="menuitem"
        title={promptInspectorOpen ? 'Hide prompt inspector' : 'Inspect the exact prompt sent to the model'}
        onClick={() => {
          setPromptInspectorOpen((v) => !v);
          setChatMenuOpen(false);
        }}
      >
        🧾 {promptInspectorOpen ? 'Hide prompt inspector' : 'Inspect prompt'}
      </button>
      <button
        type="button"
        role="menuitem"
        title={branchMapOpen ? 'Hide branch map' : "Show this chat's fork family"}
        onClick={() => {
          setBranchMapOpen((v) => !v);
          setChatMenuOpen(false);
        }}
      >
        <GitBranchIcon /> {branchMapOpen ? 'Hide branch map' : 'Branch map'}
      </button>
      <button
        type="button"
        role="menuitem"
        title={
          syncStatusOpen
            ? 'Hide sync status'
            : 'When the background memory sync last ran for this chat, and when the next one is due'
        }
        onClick={() => {
          setSyncStatusOpen((v) => !v);
          setChatMenuOpen(false);
        }}
      >
        🔄 {syncStatusOpen ? 'Hide sync status' : 'Sync status'}
      </button>
      <button
        type="button"
        role="menuitem"
        title="Attach a file or image"
        disabled={attaching}
        onClick={() => {
          fileInputRef.current?.click();
          setChatMenuOpen(false);
        }}
      >
        📎 Attach file or image
      </button>
      <button
        type="button"
        role="menuitem"
        title="Select messages to delete"
        disabled={messages.length === 0 || sending}
        onClick={() => {
          setSelectionMode(true);
          setSelectionStart(null);
          setChatMenuOpen(false);
        }}
      >
        🗑 Delete messages
      </button>
    </>
  );

  return (
    <div className={`chat-view${mobileShowCanvas ? ' mobile-canvas' : ''}`} style={{ ...chatBgStyle, ...legStyle }} data-legibility={legibilityFlags}>
      {promptInspectorOpen && activeChat?.kind === 'rp' && (
        <PromptInspectorPanel
          apiKey={apiKey}
          chatId={activeChat.chatId}
          refreshToken={messages.length}
          onClose={() => setPromptInspectorOpen(false)}
        />
      )}

      <div className="chat-main" ref={chatMainRef}>
        {error && <div className="error-banner">{error}</div>}

        {bgUrl && (
          // endpoint.md §6.4: the active location's rendered image as the chat background layer,
          // faded between URLs by the state machine above (parallax_fade_teststep.md §3).
          // onError = §5.2's broken-link expiry recovery — notify the server to clear the stale
          // URL (next visit re-renders), then drop the layer rather than showing a broken image.
          // The sibling .chat-location-overlay div is the dimming veil: the image itself renders
          // at full opacity and the veil (settings-controlled opacity + shade, migration 0073)
          // darkens it, so the background stays visible between bubbles and the content above
          // stays legible.
          <>
            <img
              ref={bgRef}
              className={`chat-location-background ${bgFadeClass}`.trim()}
              src={bgUrl}
              alt=""
              aria-hidden="true"
              onError={() => {
                reportBrokenLocationImage(locationImage?.locationId ?? '', apiKey).catch(() => {});
                setLocationImage(null);
              }}
            />
            <div className="chat-location-overlay" aria-hidden="true" />
          </>
        )}

        <div className="chat-top-bar">
          <div className="chat-header">
            <span className="chat-title">{activeChat?.title ?? 'New chat'}</span>
            {activeChat?.kind === 'rp' && activeChat.cleanupEnabledAt && (
              <CleanupStatusPill apiKey={apiKey} chatId={activeChat.chatId} />
            )}
            {activeChat && activeChat.kind !== 'rp' && !activeChat.archivedAt && (
              <button type="button" className="chat-archive-button" title="Mark this chat done — extracts anything worth remembering long-term" onClick={archiveCurrentChat}>
                Archive
              </button>
            )}
            {activeChat?.archivedAt && <span className="chat-archived-badge" title={activeChat.archivedAt}>Archived</span>}
            {activeChat?.kind === 'rp' ? (
              <div className="chat-menu-wrap" ref={chatMenuRef}>
                <button
                  type="button"
                  className="chat-menu-button"
                  title="Chat menu"
                  aria-haspopup="menu"
                  aria-expanded={chatMenuOpen}
                  onClick={() => setChatMenuOpen((v) => !v)}
                >
                  ☰
                </button>
                {chatMenuOpen && (
                  <div className="chat-menu" role="menu">
                    {chatMenuItems}
                  </div>
                )}
              </div>
            ) : (
              activeChat && (
                <button
                  type="button"
                  className="chat-branch-map-summon"
                  title={branchMapOpen ? 'Hide branch map' : "Show this chat's fork family"}
                  onClick={() => setBranchMapOpen((v) => !v)}
                >
                  <GitBranchIcon />
                </button>
              )
            )}
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
        </div>

        <div className="chat-history" ref={historyRef} onScroll={handleHistoryScroll} onTouchStart={handleHistoryTouchStart} onTouchEnd={handleHistoryTouchEnd} onTouchCancel={handleHistoryTouchEnd}>
          {messages.length === 0 && chatId && <div className="empty-state">Ask BigImagine something.</div>}
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
            // The chat's very first message being an assistant message only ever happens via
            // apply_character_to_chat's greeting seed (applyCharacterToChatTool.ts) — there's no
            // other path that produces an assistant reply with no user message before it. Its
            // "swipes" are a card's pre-written alternate_greetings, not earlier LLM turns, so
            // running past the last one must stop there rather than fall into Rerun's regenerate
            // path (server/httpServer.ts's swipe route enforces the same rule; this just keeps the
            // button/gesture from offering an action the server would reject anyway).
            const isOpeningGreeting = i === 0 && m.role === 'assistant';
            const hasMoreSwipesAhead = m.swipes ? m.swipes.index < m.swipes.count - 1 : false;
            const swipeNextDisabled = sending || swipingId === m.messageId || (isOpeningGreeting && !hasMoreSwipesAhead);
            const swipePrevDisabled = sending || swipingId === m.messageId || !m.swipes || m.swipes.index === 0;
            // The last reply's bottom action bar (below) is always visible on desktop, unlike the
            // per-message hover row — arrow shown only when a swipe exists in that direction, Rerun
            // standing in for the next-arrow when there's nothing ahead to swipe to. Mobile hides
            // it until the message is tapped (actionsVisibleId / .actions-visible).
            const busy = sending || swipingId === m.messageId;
            const hasPrevSwipe = !!m.swipes && m.swipes.index > 0;
            const hasNextSwipe = !!m.swipes && hasMoreSwipesAhead;
            const showCounter = !!m.swipes && m.swipes.count > 1;
            const showRerun = !isOpeningGreeting && !hasMoreSwipesAhead;
            // Mobile: a left/right drag on the bubble browses swipes the same way the ‹/› buttons
            // do (see touchSwipeStartRef above) — only wired up when there's actually more than one
            // stored variant to browse between.
            const swipeGestureEnabled = isLastAssistant && m.messageId && m.swipes && m.swipes.count > 1 && !selectionMode;
            const handleSwipeTouchStart = swipeGestureEnabled
              ? (e: React.TouchEvent<HTMLDivElement>) => {
                  const t = e.touches[0];
                  if (t) touchSwipeStartRef.current = { x: t.clientX, y: t.clientY };
                }
              : undefined;
            const handleSwipeTouchEnd = swipeGestureEnabled
              ? (e: React.TouchEvent<HTMLDivElement>) => {
                  const start = touchSwipeStartRef.current;
                  touchSwipeStartRef.current = null;
                  const end = e.changedTouches[0];
                  if (!start || !end) return;
                  const dx = end.clientX - start.x;
                  const dy = end.clientY - start.y;
                  // Mostly-horizontal drags only, past a minimum distance — otherwise a normal
                  // vertical scroll of the chat history would keep getting misread as a swipe.
                  if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
                  if (dx < 0) {
                    if (!swipeNextDisabled) swipe(m.messageId!, 'next');
                  } else if (!swipePrevDisabled) {
                    swipe(m.messageId!, 'prev');
                  }
                }
              : undefined;
            return (
              <div key={m.messageId ?? `pending-${i}`} className={`chat-message ${m.role}`}>
                {selectionMode && (
                  <label className="chat-select-box" title={m.role === 'user' ? 'Select this message and everything below it' : 'Select this reply and everything below it'}>
                    <input
                      type="checkbox"
                      checked={selectionStart !== null && i >= selectionStart}
                      disabled={!m.messageId}
                      onChange={() => toggleSelect(i)}
                    />
                  </label>
                )}
                <div
                  className={`chat-bubble ${m.role}${actionsVisibleId === m.messageId ? ' actions-visible' : ''}`}
                  onClick={() => toggleMessageActions(m.messageId)}
                  onTouchStart={handleSwipeTouchStart}
                  onTouchEnd={handleSwipeTouchEnd}
                >
                {editingId === m.messageId ? (
                  <div className="message-edit">
                    <textarea value={editDraft} onChange={(e) => setEditDraft(e.target.value)} rows={3} autoFocus />
                    <div className="message-edit-actions">
                      <button onClick={submitEdit} disabled={!editDraft.trim() || sending}>
                        {m.role === 'assistant' ? 'Save' : 'Save &amp; resend'}
                      </button>
                      <button onClick={cancelEdit}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="markdown-content">
                      {/* allowDangerousHtml + rehypeRaw let literal HTML the LLM writes inline (chiefly
                          <details>/<summary> spoiler blocks, SillyTavern-style "hidden text") parse into
                          real elements instead of rendering as escaped text. rehypeSanitize runs right
                          after with hast-util-sanitize's default (GitHub) schema, which strips anything
                          not on its allowlist — script tags, event-handler attributes, iframes, etc. —
                          so this never becomes a path for injected HTML/JS from message content (including
                          tool/RAG output that ends up quoted back into a message) to execute. */}
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkBreaks, remarkQuotes]}
                        remarkRehypeOptions={{ allowDangerousHtml: true }}
                        rehypePlugins={[rehypeRaw, [rehypeSanitize, defaultSchema]]}
                      >
                        {/* resolvedContent is the display copy of a macro-bearing message (the
                            seeded greeting's {{user}} etc., resolved against the live persona on
                            the server); content stays verbatim and is what re-sends, so the
                            per-turn resolution stays fresh. */}
                        {m.resolvedContent ?? m.content}
                      </ReactMarkdown>
                    </div>
                    {m.messageId && !selectionMode &&
                      (isLastAssistant && m.role === 'assistant' ? (
                        <div className="last-chat-actions" onClick={(e) => e.stopPropagation()}>
                          {hasPrevSwipe && (
                            <button
                              type="button"
                              className="last-chat-arrow"
                              title="Previous reply"
                              disabled={busy}
                              onClick={() => swipe(m.messageId!, 'prev')}
                            >
                              ‹
                            </button>
                          )}
                          <button
                            type="button"
                            className="last-chat-icon"
                            title={copiedId === m.messageId ? 'Copied' : 'Copy'}
                            onClick={() => copyMessage(m.content, m.messageId)}
                          >
                            {copiedId === m.messageId ? '✓' : '📋'}
                          </button>
                          <button
                            type="button"
                            className="last-chat-icon"
                            title="Edit this reply — rewrite the text in place, the original stays one ‹ away"
                            disabled={busy}
                            onClick={() => startEdit(m.messageId!, m.content)}
                          >
                            ✏️
                          </button>
                          {showRerun && (
                            <button
                              type="button"
                              className="last-chat-icon"
                              title="Regenerate this reply"
                              disabled={busy}
                              onClick={() => swipe(m.messageId!, 'next')}
                            >
                              {swipingId === m.messageId ? '…' : '↻'}
                            </button>
                          )}
                          <button
                            type="button"
                            className="last-chat-icon"
                            title="Branch a new chat from this point, leaving this one untouched"
                            onClick={() => forkFrom(m.messageId!)}
                          >
                            🌿
                          </button>
                          <button type="button" className="last-chat-icon" title="Delete" onClick={() => removeMessage(m.messageId!)}>
                            🗑
                          </button>
                          {showCounter && (
                            <span className="last-chat-counter">
                              [{m.swipes!.index + 1}/{m.swipes!.count}]
                            </span>
                          )}
                          {hasNextSwipe && (
                            <button
                              type="button"
                              className="last-chat-arrow"
                              title="Next reply"
                              disabled={busy}
                              onClick={() => swipe(m.messageId!, 'next')}
                            >
                              ›
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="message-actions" onClick={(e) => e.stopPropagation()}>
                          <button onClick={() => copyMessage(m.content, m.messageId)}>
                            {copiedId === m.messageId ? 'Copied' : 'Copy'}
                          </button>
                          <button onClick={() => startEdit(m.messageId!, m.content)}>Edit</button>
                          <button onClick={() => forkFrom(m.messageId!)} title="Branch a new chat from this point, leaving this one untouched">
                            Fork from here
                          </button>
                          <button onClick={() => removeMessage(m.messageId!)}>Delete</button>
                        </div>
                      ))}
                  </>
                )}
                </div>
              </div>
            );
          })}
          {sending && <div className="chat-bubble assistant pending">{turnStatus ?? '…'}</div>}
        </div>

        <StagingBar attachments={stagedFiles} apiKey={apiKey} onRemove={removeStagedFile} />
        <ImageStagingBar images={stagedImages} onRemove={removeStagedImage} />

        {selectionMode && (
          <div className="chat-delete-bar">
            <span className="chat-delete-count">
              {selectionStart === null ? 0 : messages.length - selectionStart} selected
            </span>
            <button
              type="button"
              className="chat-delete-confirm"
              disabled={selectionStart === null}
              onClick={confirmSelectionDelete}
            >
              Delete
            </button>
            <button type="button" onClick={cancelSelectionMode}>
              Cancel
            </button>
          </div>
        )}

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
          {/* RP chats attach from the ☰ menu; on mobile that menu lives in this row (opposite
              Send) instead of the header, so the row carries its own copy here. Non-RP chats
              keep the paper clip. */}
          {activeChat?.kind === 'rp' && (
            <div className="chat-menu-wrap chat-menu-mobile" ref={chatMenuMobileRef}>
              <button
                type="button"
                className="chat-menu-button"
                title="Chat menu"
                aria-haspopup="menu"
                aria-expanded={chatMenuOpen}
                onClick={() => setChatMenuOpen((v) => !v)}
              >
                ☰
              </button>
              {chatMenuOpen && (
                <div className="chat-menu" role="menu">
                  {chatMenuItems}
                </div>
              )}
            </div>
          )}
          {/* RP chats attach from the header hamburger menu instead — the input row keeps just
              the textarea + Send, with the paper clip reserved for non-RP chats. */}
          {activeChat?.kind !== 'rp' && (
            <button
              type="button"
              className="chat-attach-button"
              title="Attach a file or image"
              disabled={attaching}
              onClick={() => fileInputRef.current?.click()}
            >
              📎
            </button>
          )}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && window.innerWidth >= 768) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Message BigImagine…"
            rows={2}
            autoFocus
          />
          <button
            type="submit"
            className={`chat-send-button${resendMode() ? ' chat-send-resend' : ''}`}
            disabled={
              sending ||
              selectionMode ||
              (!resendMode() && !draft.trim() && stagedFiles.length === 0 && stagedImages.length === 0)
            }
            title={resendMode() ? 'Resend your last message' : undefined}
          >
            <span className="chat-send-label">{resendMode() ? 'Resend' : 'Send'}</span>
            <span className="chat-send-icon" aria-hidden="true">{resendMode() ? '↻' : '➤'}</span>
          </button>
        </form>
      </div>

      {activeChat?.canvasNoteId && (
        <CanvasPanel
          apiKey={apiKey}
          noteId={activeChat.canvasNoteId}
          refreshToken={messages.length}
          locationImage={locationImage}
          onLocationImageChanged={() => refreshLocationImage(activeChat.chatId)}
          onClose={closeCanvas}
        />
      )}

      {branchMapOpen && activeChat && (
        <BranchMapPanel
          apiKey={apiKey}
          chatId={activeChat.chatId}
          onOpenChat={onOpenChat ?? (() => {})}
          onClose={() => setBranchMapOpen(false)}
        />
      )}

      {syncStatusOpen && activeChat?.kind === 'rp' && (
        <ChatSyncStatusPanel
          apiKey={apiKey}
          chatId={activeChat.chatId}
          archived={!!activeChat.archivedAt}
          onClose={() => setSyncStatusOpen(false)}
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
            <LegibilityMenu settings={legSettings} onChange={setLegSettings} />
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
    cleanup_preset_id?: string | null;
    cleanup_enabled_at?: string | null;
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

  // The household's active connection (Connections tab) is still the default every chat starts
  // from, but both the connection and the model within it can now be overridden per chat —
  // whichever llm_connections row has is_active stays what a brand-new chat uses, this is just an
  // escape hatch. Reuses the same admin endpoints ConnectionsView's own picker uses, so it needs
  // the same stored admin key ConnectionsView reads from ADMIN_API_KEY_STORAGE_KEY — without it
  // these calls have no Authorization header and isAdminAuthorized rejects them outright. Unlike
  // switching the household's active connection, picking a different one here needs no restart —
  // httpServer.ts builds a throwaway provider for this chat's turns instead of the boot-time one.
  const [connections, setConnections] = useState<LlmConnectionSummary[]>([]);
  const [profile, setProfile] = useState(session?.params.profile ?? '');
  const [modelOptions, setModelOptions] = useState<ProfileModelsResult['models']>([]);
  const [modelsError, setModelsError] = useState('');

  useEffect(() => {
    const adminKey = localStorage.getItem(ADMIN_API_KEY_STORAGE_KEY);
    adminListConnections(adminKey)
      .then(setConnections)
      .catch((err) => setModelsError(err instanceof ApiError ? err.message : 'failed to load connections'));
  }, []);

  const activeConnection = connections.find((c) => c.isActive);
  const effectiveConnection = connections.find((c) => c.name === profile) ?? activeConnection;

  // Refetches the model catalog whenever a different connection is picked (or the household
  // default resolves), so the model dropdown always reflects whichever connection this chat would
  // actually use — same dependent-select shape as ConnectionsView's own connection/model pair.
  useEffect(() => {
    if (!effectiveConnection) return;
    let cancelled = false;
    const adminKey = localStorage.getItem(ADMIN_API_KEY_STORAGE_KEY);
    adminListConnectionModels(effectiveConnection.id, adminKey)
      .then((result) => {
        if (!cancelled) setModelOptions(result.models);
      })
      .catch((err) => {
        if (!cancelled) setModelsError(err instanceof ApiError ? err.message : 'failed to load models');
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveConnection]);

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

  // Prompt-stack picker — the same get_context_stack_presets list backs the RP-only Prompt
  // stack selector below. (The old Cleanup Preset selector is gone — cleanup is now the async
  // heuristic subloop, toggled per chat below and configured on the Cleanup page.)
  const [stacks, setStacks] = useState<ContextStackPreset[]>([]);
  const [selectedStackId, setSelectedStackId] = useState(session?.promptStackPresetId ?? '');
  const [applyingStack, setApplyingStack] = useState(false);
  const [stackError, setStackError] = useState('');
  // The async heuristic cleanup subloop toggle. Enabled if either the new timestamp switch or a
  // legacy preset id is set (a pre-migration chat that had a cleanup preset is still being
  // cleaned by the inline pass until this is touched — saving the toggle migrates it: enabling
  // clears the legacy preset so the new subloop owns it, disabling turns everything off).
  const [cleanupEnabled, setCleanupEnabled] = useState(
    session?.cleanupEnabledAt != null || session?.cleanupPresetId != null,
  );

  useEffect(() => {
    if (!session) return;
    callTool<ContextStackPreset[]>('get_context_stack_presets', {}, apiKey)
      .then(setStacks)
      .catch((err) => setStackError(err instanceof ApiError ? err.message : 'failed to load prompt stacks'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.chatId]);

  // Only updates the local system-prompt textarea from the tool's response — the tool has already
  // persisted params.system (and prompt_stack_preset_id) server-side, same as
  // apply_character_to_chat does, so no extra onSave call is needed here.
  async function applyStack() {
    if (!session || !selectedStackId) return;
    setApplyingStack(true);
    setStackError('');
    try {
      const result = await callTool<ApplyPromptStackToChatResult>(
        'apply_prompt_stack_to_chat',
        { chatId: session.chatId, presetId: selectedStackId },
        apiKey,
      );
      if (result.applied) setSystem(result.systemText);
      else setStackError(result.reason);
    } catch (err) {
      setStackError(err instanceof ApiError ? err.message : 'failed to apply prompt stack');
    } finally {
      setApplyingStack(false);
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
      // The toggle is the only cleanup switch now: enabled stamps the loop's window at now()
      // (so only messages that land from here on are cleaned — never a retro pass over old
      // history); disabled clears it. The legacy preset id is always cleared alongside — the
      // preset-based inline pass is retired, so a saved toggle migrates the chat off it in
      // whichever direction.
      cleanup_enabled_at: cleanupEnabled ? new Date().toISOString() : null,
      cleanup_preset_id: null,
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
            (household default{activeConnection ? ` — ${activeConnection.name}` : ''})
          </option>
          {connections.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
        <span className="model-connection-note">Household default set in the Connections tab; this only affects this chat.</span>
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

      {session?.kind === 'rp' && (
        <label>
          Prompt stack
          <select value={selectedStackId} onChange={(e) => setSelectedStackId(e.target.value)}>
            <option value="">(none)</option>
            {stacks.map((s) => (
              <option key={s.presetId} value={s.presetId}>
                {s.name}
              </option>
            ))}
          </select>
          <div className="settings-actions">
            <button type="button" onClick={applyStack} disabled={!selectedStackId || applyingStack}>
              {applyingStack ? 'Applying…' : 'Apply'}
            </button>
          </div>
          {stackError && <div className="error-banner">{stackError}</div>}
        </label>
      )}

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={cleanupEnabled}
          onChange={(e) => setCleanupEnabled(e.target.checked)}
          disabled={session?.kind !== 'rp'}
        />
        Async cleanup pass
        {session?.kind !== 'rp' && <span className="model-connection-note"> RP chats only.</span>}
        <span className="model-connection-note">
          Strips antislop and repairs the header/footer shapes in the background after each reply
          lands — the original stays available as a swipe. Rules and prompts are configured on the
          Cleanup page.
        </span>
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
