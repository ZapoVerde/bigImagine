/* @stamp 2026-08-15 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  adminListConnections,
  abortTurn,
  callTool,
  chatCompletion,
  createChat,
  deleteChat,
  deleteMessage,
  editMessageContent,
  forkChat,
  getChat,
  getChatLocationImage,
  getChatBackgroundSettings,
  getChatLegibilitySettings,
  getChatTurnStatus,
  getChatSyncStatus,
  listFolders,
  listToolNames,
  reportBrokenLocationImage,
  swipeMessage,
  truncateMessagesFrom,
  updateChat,
  uploadAttachment,
  whoami,
} from '../api/client';
import type { SwipeResult } from '../api/client';
import { attachBackgroundParallax } from '../components/chat/backgroundParallax';
import { ADMIN_API_KEY_STORAGE_KEY } from '../api/authStorage';
import { TurnTimeline, type TimelineOutcome } from '../lib/turnTimeline';
import type { TurnSnapshot } from '../lib/turnTimelineReport';
import type {
  ChatBackgroundSettings,
  ChatDetail,
  ChatLegibilitySettings,
  ChatMessage,
  ChatParams,
  ChatSessionRow,
  ChatSyncHealth,
  CleanupPatchFrame,
  CleanupStatusFrame,
  ContextStackPreset,
  Folder,
  LlmConnectionSummary,
  PromptPreset,
  ReasoningFrame,
} from '../api/types';
import CanvasPanel from '../components/canvas/CanvasPanel';
import LorebookPanel from '../components/lorebook/LorebookPanel';
import BranchMapPanel from '../components/branchMap/BranchMapPanel';
import ChatSyncStatusPanel from '../components/chatSyncStatus/ChatSyncStatusPanel';
import CleanupStatusPill, { type CleanupLivePillState } from '../components/cleanup/CleanupStatusPill';
import StagingBar, { type StagedFile } from '../components/attachments/StagingBar';
import ImageStagingBar, { type StagedImageFile } from '../components/attachments/ImageStagingBar';
import LegibilityMenu from '../components/chat/LegibilityMenu';
import PinnedNotesDrawer from '../components/PinnedNotesDrawer';
import ChatMessageRow from '../components/chat/ChatMessageRow';
import ChatComposer, { type ChatComposerHandle } from '../components/chat/ChatComposer';
import { useEdgeSwipe } from '../hooks/useEdgeSwipe';
import SpriteStage from '../components/chat/SpriteStage';
import CastSection from '../components/sidebar/CastSection';
import CharacterVisualStateToggle from '../components/sidebar/CharacterVisualStateToggle';
import './ChatView.css';

// GitHub's git-branch octicon (Primer) — the branch-map toggle icon. Inline SVG so it inherits
// currentColor and scales with the surrounding text (1em) instead of relying on an emoji glyph.
export function GitBranchIcon() {
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
  /** The owning tab's stable id (useTabs.ts's TabInstance.id, persisted in bb_tabs across
   *  reloads) — used to key the composer draft in localStorage (robust-chat-turns-plan.md), so
   *  typed-but-unsent text survives an involuntary remount (a mobile browser reloading a
   *  backgrounded tab, a relogin). */
  tabId: string;
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
  /** Focuses (or opens) a chat tab by id — used by the "Fork from here" action to jump straight
   *  to the new branch once it's created (useTabs.ts's openChat). */
  onOpenChat?: (chatId: string, title?: string) => void;
  /** Opens/switches to a fresh RP chat tab — used by the ⋯ menu's "Restart chat" so the
   *  restarted session opens without navigating away (useTabs.ts's openRp). */
  onOpenRp?: (chatId: string, title?: string) => void;
  /** Fires when this chat was hard-deleted server-side, so App can close its tab and drop it
   *  from the history browsers (same contract CharactersView's onChatsDeleted uses). */
  onChatsDeleted?: (chatIds: string[]) => void;
  /** The Lorebook panel's mode-off one-liner link target (App wires it to summon the Lorebooks
   *  tab, where the §3d settings live). */
  onOpenLorebooks?: () => void;
  /** Mobile-only: whether the app-level top bars (TabStrip + TimerStrip + this chat's header) are
   *  currently collapsed away — owned by App.tsx, which applies .app.top-bars-hidden. ChatView
   *  both drives it (scroll-down on the history collapses, scroll-up / pull-down-at-top restores)
   *  and reads it (to gate the pull gesture on the bars actually being hidden). */
  topBarsHidden: boolean;
  /** Ask the app to collapse (true) or restore (false) the top bars. */
  onTopBarsHiddenChange: (hidden: boolean) => void;
  /** Whether this tab is the one currently displayed — hidden tabs stay mounted (App.tsx toggles
   *  them with a CSS class), so the mobile edge-swipe listener below is attached only for the
   *  visible chat, and no hidden tab opens a drawer on a stray swipe. */
  active: boolean;
  /** RP chats only: fired once per completed turn (when this chat's message count changes) so the
   *  app can bump its promptRefreshToken — the Prompt Inspector now lives in the left sidebar
   *  drawer, and this is how it keeps the once-per-turn live-read it had as an in-chat panel. */
  onPromptRefresh?: () => void;
  /** RP chats only: fired after each turn's timing recorder finalizes (send and swipe paths
   *  both), with the client-captured timing fields — App holds the last one for the drawer's
   *  Timing section (docs/plans/turn-timeline-graph-plan.md). Tagged with the chat id so a
   *  switched tab never shows one chat's chart under another chat's cost line. */
  onTurnSnapshot?: (snapshot: TurnSnapshot) => void;
  /** RP chats only: fired whenever the loaded session's sceneId changes (a chat load, or a turn
   *  that landed a header — the scraper stamps chat_sessions.scene_id post-turn). App holds the
   *  active chat's sceneId for the sidebar's Cast section
   *  (rp-cast-infrastructure-plan.md Part C) — the one piece of genuinely new plumbing in that
   *  plan, sourced here because ChatView is the only component that fetches the session. */
  onSceneIdChange?: (sceneId: string | null) => void;
}

// messageId is set only once a message round-trips through the server and comes back from
// getChat — undefined for the brief optimistic window between sending and that refetch landing.
// Copy/edit/swipe/delete all need a real id (they're per-message API calls), so they're simply
// not offered on a message that doesn't have one yet.
export interface DisplayMessage {
  messageId?: string;
  role: 'user' | 'assistant';
  content: string;
  /** Display-only macro-resolved copy of `content` (docs/plans/prompt-macros.md's Stage 1) — served by
   *  GET /v1/chats/:id as resolvedContent for 'rp' chats whose stored text contains {{...}} tokens
   *  (chiefly a character's seeded greeting). Render this when present; `content` stays verbatim
   *  and is what gets re-sent, so the server's per-turn resolution stays fresh against the live
   *  persona. */
  resolvedContent?: string;
  /** Swipe capability on the last LLM response — present only once this message has been
   *  regenerated at least once. See api/types.ts's StoredChatMessage for the shape. */
  swipes?: { index: number; count: number };
  activeSwipeId?: string;
  /** The turn's reasoning block (docs/plans/reasoning-blocks-plan.md) — the de-tagged span the
   *  model produced between the configured tag pair; present only when the turn produced one,
   *  per swipe variant. See StoredChatMessage.reasoning. */
  reasoning?: string;
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
export default function ChatView({
  apiKey,
  tabId,
  chatId,
  onChatCreated,
  onTitleChange,
  onOpenChat,
  onOpenRp,
  onChatsDeleted,
  onOpenLorebooks,
  topBarsHidden,
  onTopBarsHiddenChange,
  onPromptRefresh,
  onTurnSnapshot,
  onSceneIdChange,
  active,
}: ChatViewProps) {
  // Turn-timing snapshot reporting (docs/plans/turn-timeline-graph-plan.md): capture the timing
  // recorder's fields the moment a turn finalizes and hand them up, tagged with the chat, so the
  // drawer's Timing section shows the turn that just happened here. getSnapshot() is undefined
  // only when the turn never dispatched — unreachable at these call sites, but skipping is the
  // safe reading either way.
  const reportTurnSnapshot = (timeline: TurnTimeline | undefined, chatId: string): void => {
    const fields = timeline?.getSnapshot();
    if (fields) onTurnSnapshot?.({ chatId, fields });
  };

  // Active conversation state
  const [activeChat, setActiveChat] = useState<ChatSessionRow | null>(null);
  // rp-cast-infrastructure-plan.md Part C: keep App's active-sceneId in sync with the loaded
  // session — a chat load, and any turn that lands a header (the scraper stamps
  // chat_sessions.scene_id post-turn), changes it. Also re-fires when the callback flips from
  // undefined (this tab hidden) to wired (this tab active), so returning to an already-loaded
  // RP chat re-reports its sceneId — App must never keep a different chat's sceneId under it.
  useEffect(() => {
    onSceneIdChange?.(activeChat?.sceneId ?? null);
  }, [activeChat?.sceneId, onSceneIdChange]);
  // endpoint.md §6.4: the active location's rendered background image for this chat (resolved via
  // the scene_id cache pointer, §2.6-filtered). nulls = no eligible location at all — a location
  // whose image hasn't rendered yet does NOT null this out: the previous background stays up until
  // the pending render is ready to replace it (refreshLocationImage below, endpoint.md §5.1.8).
  const [locationImage, setLocationImage] = useState<{ locationId: string; name: string; definition: string | null; imageUrl: string } | null>(null);

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
  // The chat currently on screen, kept current during render — so an async callback that
  // resolves after a chat switch (the cleanup pill's onSettled, which re-fetches messages) can
  // tell that its chat is gone and stand down instead of clobbering the new chat's message list.
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;
  // Latest sending flag, read from async callbacks: send() sets it synchronously (not just via
  // setSending), so a cleanup settle that lands mid-send sees it immediately, and a cleanup
  // settle deferred past the send can be re-run in send()'s finally without a stale check.
  const sendingRef = useRef(false);
  // The RP turn-timing recorder currently in flight (lib/turnTimeline.ts, llm-stats-page-plan.md)
  // — exactly one at a time (sending/swipingId guards), so the Stop button can mark `stop` the
  // instant it fires POST /v1/chat/abort rather than waiting for the terminal frame.
  const activeTimelineRef = useRef<TurnTimeline | null>(null);
  // A cleanup settle observed while a send was in flight — the send's own refresh may have
  // already read the DB before the cleanup write landed, so re-fetch once in send()'s finally.
  const deferredCleanupSettleRef = useRef<string | null>(null);
  // endpoint.md §5.1.8's last-turn location state on the client side: the endpoint's `previous`
  // from the last refresh (the revert target a regen swipe shows while the new turn settles), the
  // last settled current locationId (to compute freshness — "did the swiped turn establish the
  // current background"), and whether that location was freshly established by the last settle.
  // All three reset on chat switch; freshness starts false on load (a chat's historical
  // background is established, never "fresh").
  const bgPreviousRef = useRef<{ locationId: string; name: string; definition: string | null; imageUrl: string } | null>(null);
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
  // Sync boundary for the rollout display (docs/plans/rp-sync-boundary-rollout-plan.md): how many
  // of the newest *closed* sync points the user has revealed above the marker (0 = none, i.e. the
  // default bounded view). Reveal is always a newest-first contiguous prefix of the boundary's
  // `pages` (each scroll-to-the-marker reveals the next-older sync nearest it), so a count
  // suffices. Reset to 0 on send (the "next turn hides it again" guarantee); on a boundary
  // advance a re-derived clamp keeps revealed pages to those still present in the refreshed
  // `pages`.
  const [syncBoundary, setSyncBoundary] = useState<ChatDetail['syncBoundary']>(undefined);
  const [revealedSyncCount, setRevealedSyncCount] = useState(0);
  // Composer draft lives in ChatComposer (composer-render-isolation-plan.md) — typing must not
  // re-render ChatView, so the draft's state and its localStorage persistence moved there with
  // it. ChatView keeps only the one reactive signal it actually needs (the Send/Resend button's
  // label/styling/disabled state), as a boolean updated only when the trimmed-empty state flips.
  const composerRef = useRef<ChatComposerHandle>(null);
  // Seed from the same lazy localStorage read ChatComposer performs for its own initial draft, so
  // a chat reloaded with a persisted non-empty draft shows "Resend"/enabled on the very first
  // render (onEmptyChange only fires from an effect, after paint — an unseeded false would flash
  // "Send"/disabled for one frame). One-time read, not a shared source of truth.
  const draftKey = `bb_chat_draft:${tabId}`;
  const [composerHasText, setComposerHasText] = useState(
    () => (localStorage.getItem(draftKey) ?? '').trim().length > 0,
  );
  const onEmptyChange = useCallback((isEmpty: boolean) => setComposerHasText(!isEmpty), []);
  const [sending, setSending] = useState(false);
  // Robust-chat-turns plan: a turn is running server-side for this chat that this tab lost track
  // of (a backgrounded tab / reload mid-turn wiped the local `sending` state). Kept separate from
  // `sending` so it never disturbs send()'s own guards — send() is not running; we're catching up
  // to a turn the client can't see. Renders the pending bubble and disables the composer while the
  // server-side lock is held (reconcileTurnInFlight), then refreshes against canonical state.
  const [resumingTurn, setResumingTurn] = useState(false);
  // Re-entrancy guard for reconcileTurnInFlight (read from async callbacks, like sendingRef): the
  // load-effect check, a visibilitychange, and a send()-409 can all fire within a second of each
  // other — only one poll loop should ever run for this tab.
  const resumingTurnRef = useRef(false);
  // Re-entrancy guard for waitForReconnectThenReconcile, same shape as resumingTurnRef — only
  // one reconnect-poll loop should ever run for this tab.
  const reconnectingRef = useRef(false);
  // Flips true on unmount so a reconnect-poll loop started before a chat switch/tab close stops
  // polling instead of leaking — same StrictMode-safe reset-in-setup pattern as bgDisposedRef.
  const reconnectDisposedRef = useRef(false);
  useEffect(() => {
    reconnectDisposedRef.current = false;
    return () => {
      reconnectDisposedRef.current = true;
    };
  }, []);
  // What runTurn's currently running tool is doing, polled from GET /v1/chat/status while
  // `sending` is true (client.ts's getChatTurnStatus) — null renders as the old plain "…" bubble.
  const [turnStatus, setTurnStatus] = useState<string | null>(null);
  // An RP turn is streaming its reply live (rp-streaming-plan.md): the placeholder pushed by
  // send() is being filled by onDelta, so the static "…" pending bubble is suppressed while this
  // is true — the live text is the status.
  const [liveStreaming, setLiveStreaming] = useState(false);
  // The three cleanup pills' live per-region states while a turn with in-stream cleanup is
  // actively streaming (in-stream-cleanup-plan.md) — fed from the bigimagine_cleanup SSE frames
  // via send()/swipe()'s onCleanupStatus, and cleared when the stream resolves so the settled
  // poll becomes authoritative again. null = no live cleanup turn in flight.
  const [cleanupLive, setCleanupLive] = useState<CleanupLivePillState | null>(null);
  // Reasoning blocks (docs/plans/reasoning-blocks-plan.md): the in-flight turn's live reasoning
  // buffer, fed from the bigimagine_reasoning SSE frames via send()/swipe()'s onReasoningDelta.
  // null = no live reasoning yet this turn (the overwhelmingly common case — a model that never
  // uses the tags produces no frames and this stays null, so nothing extra renders). The buffer
  // is rendered on the streaming target — the tail placeholder during a send (the only
  // message without a messageId while a send streams) or the being-regenerated message during a
  // swipe (liveReasoningTargetId). liveReasoningDone flips when the stream resolves: the block
  // stays open while thinking and collapses once done, and the post-stream refresh swaps the
  // live buffer for the canonical row's persisted `reasoning` (the field wins once present).
  const [liveReasoning, setLiveReasoning] = useState<string | null>(null);
  const [liveReasoningDone, setLiveReasoningDone] = useState(false);
  const [liveReasoningTargetId, setLiveReasoningTargetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Rolling-memory sync health (orchestrator/chatMemorySync.ts's computeChatSyncHealth, read
  // through GET /v1/chats/:id/sync-status's syncHealth) — the RP chat screen's warning/blocked
  // banner and composer-disable. Polled only while an RP chat is open; null before the first
  // fetch resolves (no banner). The "View sync status" button on either banner opens the
  // standalone ChatSyncStatusPanel (the same panel the settings rail embeds).
  const [syncHealth, setSyncHealth] = useState<ChatSyncHealth | null>(null);
  const [syncStatusOpen, setSyncStatusOpen] = useState(false);

  // RP Sprite Stage persisted visibility + ratio (AC-02, AC-08) — presentation-only
  const [spriteStageVisible, setSpriteStageVisible] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem('rp_sprite_stage_visible');
      return v === null ? true : v === 'true';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('rp_sprite_stage_visible', String(spriteStageVisible));
    } catch {}
  }, [spriteStageVisible]);
  const [spriteStageRatio, setSpriteStageRatio] = useState<number>(() => {
    try {
      const v = localStorage.getItem('rp_sprite_stage_ratio');
      const n = v ? parseFloat(v) : NaN;
      if (Number.isFinite(n)) return Math.min(0.6, Math.max(0.2, n));
      return 0.33;
    } catch {
      return 0.33;
    }
  });
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);
  useEffect(() => {
    if (!active) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      const viewportH = vv.height;
      const windowH = window.innerHeight;
      const keyboardOpen = viewportH < windowH * 0.75;
      setIsKeyboardOpen(keyboardOpen);
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, [active]);
  const effectiveStageRatio = isKeyboardOpen ? Math.min(spriteStageRatio, 0.25) : spriteStageRatio;

  const isDraggingStageRef = useRef(false);
  const isKeyboardOpenRef = useRef(false);
  useEffect(() => {
    isKeyboardOpenRef.current = isKeyboardOpen;
  }, [isKeyboardOpen]);
  const handleStageDividerPointerDown = useCallback((e: React.PointerEvent) => {
    if (isKeyboardOpenRef.current) return;
    if (!chatMainRef.current) return;
    isDraggingStageRef.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = chatMainRef.current.querySelector<HTMLElement>('.rp-sprite-stage-container')?.offsetHeight ?? 220;
    const avail = chatMainRef.current.clientHeight;
    const onMove = (ev: PointerEvent) => {
      if (!isDraggingStageRef.current || !chatMainRef.current) return;
      const dy = ev.clientY - startY;
      const newHeight = Math.min(avail * 0.6, Math.max(avail * 0.2, startHeight + dy));
      const ratio = Math.min(0.6, Math.max(0.2, newHeight / avail));
      const el = chatMainRef.current.querySelector<HTMLElement>('.rp-sprite-stage-container');
      if (el) el.style.height = `${ratio * 100}%`;
      (chatMainRef.current as unknown as { _pendingRatio?: number })._pendingRatio = ratio;
    };
    const onUp = () => {
      isDraggingStageRef.current = false;
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      const pending = (chatMainRef.current as unknown as { _pendingRatio?: number })._pendingRatio;
      if (pending !== undefined) {
        const clamped = Math.min(0.6, Math.max(0.2, pending));
        setSpriteStageRatio(clamped);
        try {
          localStorage.setItem('rp_sprite_stage_ratio', String(clamped));
        } catch {}
      }
      const el = chatMainRef.current?.querySelector<HTMLElement>('.rp-sprite-stage-container');
      if (el) el.style.height = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, []);
  const [spriteRefreshToken, setSpriteRefreshToken] = useState(0);
  // Bump sprite refresh after completed turns (messages length changes) and after swipe actions
  useEffect(() => {
    if (activeChat?.kind === 'rp') setSpriteRefreshToken((n) => n + 1);
  }, [messages.length, activeChat?.kind]);
  // Cast Refresh Imagery: explicit invalidation from CastSection's refresh control (§Required Behaviour)
  useEffect(() => {
    const onSpriteRefresh = (e: Event) => {
      const detail = (e as CustomEvent<{ chatId?: string }>).detail;
      if (!activeChat || activeChat.kind !== 'rp') return;
      if (detail?.chatId && detail.chatId !== chatId) return;
      setSpriteRefreshToken((n) => n + 1);
    };
    window.addEventListener('bigimagine:sprite-refresh', onSpriteRefresh as EventListener);
    return () => window.removeEventListener('bigimagine:sprite-refresh', onSpriteRefresh as EventListener);
  }, [activeChat, chatId]);
  const selectedSpriteSwipe = useMemo(() => {
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    return {
      swipeId: lastAssistant?.activeSwipeId ?? null,
      messageId: lastAssistant?.messageId ?? null,
    };
  }, [messages]);
  // Also bump on swipe id change (same length, different variant)
  useEffect(() => {
    if (activeChat?.kind === 'rp' && (selectedSpriteSwipe.swipeId || selectedSpriteSwipe.messageId)) {
      setSpriteRefreshToken((n) => n + 1);
    }
  }, [selectedSpriteSwipe.swipeId, selectedSpriteSwipe.messageId, activeChat?.kind]);
  // Sprite refresh exposed via spriteRefreshToken bump (messages.length effect covers most cases)
  // The blocking truth as a plain boolean so send() and the composer's disabled prop read the
  // same value. true exactly when the server is refusing new turns with 409 CHAT_SYNC_STALLED.
  const syncBlocked = syncHealth?.blocking === true;
  // The banner shouldn't fire the instant sync merely falls due — that's the very start of the
  // warning window, with the full syncEveryPairs grace still ahead. It's held back until
  // turnsUntilBlock has counted down to half of syncEveryPairs (halfway through that grace),
  // so "running behind" only shows once the chat actually is. Blocked always shows immediately —
  // there's no grace left to wait out.
  const showSyncBanner =
    syncHealth?.state === 'blocked' ||
    (syncHealth?.state === 'warning' &&
      syncHealth.turnsUntilBlock !== null &&
      syncHealth.turnsUntilBlock <= syncHealth.syncEveryPairs / 2);

  // Poll cadence matches the panel's own (30s) and the orchestrator's POLL_INTERVAL_MS, so the
  // banner is at most one tick behind the loop's last attempt. Best-effort: a transient poll
  // failure keeps the last-known health (or no banner) rather than flashing an error. Non-RP
  // chats have no live-window arc to stall, so nothing polls.
  useEffect(() => {
    if (!chatId || activeChat?.kind !== 'rp') {
      setSyncHealth(null);
      return;
    }
    let disposed = false;
    const load = () => {
      getChatSyncStatus(chatId, apiKey)
        .then((status) => {
          if (!disposed) setSyncHealth(status.syncHealth);
        })
        .catch(() => {});
    };
    load();
    const interval = setInterval(load, 30_000);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [chatId, apiKey, activeChat?.kind]);

  // Staged file attachments: held only in this tab's own state, never persisted — cleared once
  // the message carrying them is sent (see orchestrator/src/util/attachmentContext.ts).
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  // Staged images: never go through uploadAttachment/POST /v1/attachments/extract at all — read
  // client-side as base64 (see orchestrator/src/io/attachments/dispatchExtraction.ts's own
  // preamble on why there's nothing to extract). Same ephemeral, cleared-on-send lifecycle.
  const [stagedImages, setStagedImages] = useState<StagedImageFile[]>([]);
  const [attaching, setAttaching] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ⋯ menu → "Restart chat": modal + "delete old chat" tick box. Unchecked by default — the
  // delete is destructive, so it needs the user's explicit tick (bi_principles.md §3).
  const [restartOpen, setRestartOpen] = useState(false);
  const [restartDeleteOld, setRestartDeleteOld] = useState(false);
  const [restarting, setRestarting] = useState(false);

  // Per-message edit UI state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  // Mobile: which message's action row is revealed by tapping its bubble — hidden by default
  // below the mobile breakpoint (ChatView.css). One at a time: tapping another message moves the
  // reveal, tapping the same message again closes it. Desktop is unaffected — the CSS rules that
  // read this class live inside the mobile media query.
  const [actionsVisibleId, setActionsVisibleId] = useState<string | null>(null);
  // Which message a swipe (prev/next/regenerate) is in flight for, if any — deliberately not the
  // same flag `sending` uses, since a swipe replaces one message's content in place and shouldn't
  // render the "new turn incoming" pending bubble the way send/rerun's own full turns do.
  const [swipingId, setSwipingId] = useState<string | null>(null);
  // Whether that in-flight swipe is a regeneration ('next' past the last stored variant) — the
  // only swipe kind the server registers as an abortable task (regenerateSwipe runs runTurn with
  // taskId = chatId), so this is what arms the Stop button. Plain prev/next cycling between stored
  // variants is a fast DB read with nothing to abort and must not arm it.
  const [swipeRegenerating, setSwipeRegenerating] = useState(false);

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
  // Branch Map: read-only tree of this chat's fork family (docs/chat-memory.md) — opt-in per
  // bi_principles.md §5, same as Canvas/Prompt Inspector. Offered for any chat, not just 'rp'.
  const [branchMapOpen, setBranchMapOpen] = useState(false);
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  // Selection-mode bulk delete (⋯ menu → "Delete messages"): a tickbox on every message, and
  // ticking any entry selects everything below it, so the selected set is always a trailing
  // suffix — exactly what the server's truncateMessagesFrom removes in one call. RP-chat only,
  // like the menu itself.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectionStart, setSelectionStart] = useState<number | null>(null);
  // Read-only here — just for the settings pane's folder-assignment dropdown. Creating/deleting
  // folders is the sidebar's ChatBrowser's job now.
  const [folders, setFolders] = useState<Folder[]>([]);

  useEdgeSwipe('right', () => setSettingsCollapsed(false), {
    enabled: active,
    canOpen: () => settingsCollapsed && !branchMapOpen && !mobileShowCanvas && !restartOpen && !syncStatusOpen && !chatMenuOpen,
  });

  const historyRef = useRef<HTMLDivElement | null>(null);
  // The rollout's boundary marker element (docs/plans/rp-sync-boundary-rollout-plan.md): observed
  // by the lazy-load effect below, so that when the reader scrolls up to it, the next-older
  // archived page is revealed. Non-interactive — it's a status strip, not a button.
  const boundaryMarkerRef = useRef<HTMLDivElement | null>(null);
  // Set true right after a chat's messages are (re)loaded from the server (opening a tab, or
  // switching this tab to a different chat) so the messages-effect below knows to jump to the
  // last turn exactly once. Left false the rest of the time so sending/editing/swiping — which
  // also change `messages` — never re-trigger it (see the "No auto-scroll" note below on why
  // scrolling on every messages change was tried and reverted).
  const pendingInitialScrollRef = useRef(false);
  // The bottom control stack (staging bars, delete bar, input row) floats over the conversation
  // as .chat-bottom-overlay — bubbles scroll under it. Its height is dynamic (staging/delete
  // bars appear and vanish, the textarea grows), so the history's matching bottom padding is
  // measured live (ResizeObserver below) instead of hardcoded.
  const bottomOverlayRef = useRef<HTMLDivElement | null>(null);
  const chatMenuRef = useRef<HTMLDivElement | null>(null);
  // Second mount of the ⋯ chat menu, in the mobile input row opposite Send (the desktop copy
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

  // Park the newest message just above the control stack: mirror the bottom overlay's measured
  // height (+ the history's base 1rem padding) as the history's bottom padding, so at full
  // scroll the last bubble rests fully visible above the stack while bubbles still slide under
  // it while scrolling. The same measurement drives --chat-fade-px (the alpha-mask fade span,
  // chat-fade-mask-plan.md), so the fade always spans exactly the stack's footprint. Mobile
  // keeps its mid-screen rest point: the 50vh history spacer already sits below the last
  // message there, so its height is subtracted (clamped at the base padding) to avoid stacking
  // dead scroll slack on top of it.
  useEffect(() => {
    const history = historyRef.current;
    const overlay = bottomOverlayRef.current;
    if (!history || !overlay) return;
    const sync = () => {
      const base = parseFloat(getComputedStyle(history).paddingTop) || 16;
      const spacer = history.querySelector<HTMLElement>('.chat-history-spacer');
      const spacerH = spacer?.offsetHeight ?? 0;
      history.style.paddingBottom = `${Math.max(base, overlay.offsetHeight + base - spacerH)}px`;
      // Alpha-mask fade span (chat-fade-mask-plan.md): the fade zone tracks the overlay's live
      // height so it always spans exactly the input stack's footprint, however tall it is.
      history.style.setProperty('--chat-fade-px', `${overlay.offsetHeight}px`);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(overlay);
    return () => ro.disconnect();
  }, []);

  // Report message-count changes up to the app (RP chats only) so Sidebar's Prompt Inspector
  // can re-fetch after each completed turn. No dep array — every render compares against the
  // last reported count, so only real changes bump; the App re-render this triggers can't loop
  // because it doesn't change messages.length.
  const lastReportedMessageCountRef = useRef(0);
  useEffect(() => {
    if (messages.length !== lastReportedMessageCountRef.current) {
      lastReportedMessageCountRef.current = messages.length;
      onPromptRefresh?.();
    }
  });

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
      setBranchMapOpen(false);
      setChatMenuOpen(false);
      setPendingSettings(null);
      setSelectionMode(false);
      setSelectionStart(null);
      setError(null);
      setEditingId(null);
      setSyncBoundary(undefined);
      setRevealedSyncCount(0);
      stopBgPoll();
      return;
    }
    if (activeChat?.chatId === chatId) return;
    setMobileShowCanvas(false);
    setBranchMapOpen(false);
    setChatMenuOpen(false);
    setPendingSettings(null);
    setSelectionMode(false);
    setSelectionStart(null);
    stopBgPoll();
    getChat(chatId, apiKey)
      .then((detail) => {
        setActiveChat(detail.session);
        setMessages(detail.messages.map((m) => ({ messageId: m.messageId, role: m.role, content: m.content, resolvedContent: m.resolvedContent, swipes: m.swipes, reasoning: m.reasoning, activeSwipeId: m.activeSwipeId })));
        setSyncBoundary(detail.syncBoundary);
        setRevealedSyncCount(0);
        pendingInitialScrollRef.current = true;
        // Robust-chat-turns plan: a remounted tab reopens while a turn is still running
        // server-side (the reload happened mid-turn and local `sending` was lost) — the local
        // view has no way to know. Ask the server once; if a turn is active, show the pending
        // bubble and refresh when it resolves (reconcileTurnInFlight).
        void reconcileTurnInFlight(chatId);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'failed to load chat'));
    refreshLocationImage(chatId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  // Robust-chat-turns plan: on regaining visibility, re-check server truth about whether a turn
  // is running for the chat currently open in this tab. This is what directly answers "I check
  // another tab and come back": the tab need not have been killed/reloaded for the local poll to
  // have gone stale — mobile browsers throttle/pause timers in backgrounded tabs — so every
  // return re-syncs against the server, not only on mount. Guarded to the visible, loaded chat
  // (the same activeChat/chatIdRef pattern send()'s post-turn refresh uses): hidden tabs stay
  // mounted and must not reconcile the chat they happen to hold.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible' || !active) return;
      const chatId = chatIdRef.current;
      if (!chatId || !activeChat || chatIdRef.current !== activeChat.chatId) return;
      void reconcileTurnInFlight(chatId);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, activeChat]);

  // Close the ⋯ chat menu (either mount — header or mobile input row) on outside click or
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

  // Escape exits selection mode too, same as it closes the ⋯ menu.
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
    bgPreviousRef.current = previous?.imageUrl ? { locationId: previous.locationId, name: previous.name, definition: previous.definition, imageUrl: previous.imageUrl } : null;
    if (current?.imageUrl) {
      // A rendered current — show it; the fade state machine swaps it in. Freshness: the
      // location changed on this settle (a swipe of that turn should revert to the previous
      // location). Any pending poll for the old render is moot now.
      bgFreshRef.current = bgLastLocationIdRef.current !== null && current.locationId !== bgLastLocationIdRef.current;
      bgLastLocationIdRef.current = current.locationId;
      setLocationImage({ locationId: current.locationId, name: current.name, definition: current.definition, imageUrl: current.imageUrl });
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

  // No auto-scroll on a running chat, on purpose: a new turn renders below the fold and the
  // reader scrolls down on their own. Auto-positioning on every messages/sending change kept
  // fighting the reader, so that was reverted (see git history) — the one case still worth
  // handling is the very first render of a (re)loaded chat, which otherwise just lands at
  // scrollTop 0, i.e. the start of the chat rather than where the reader left off. That one-shot
  // jump is gated on pendingInitialScrollRef, set only by the chat-load effect above, so it never
  // fires again while this tab keeps showing the same chat.
  useEffect(() => {
    if (!pendingInitialScrollRef.current) return;
    pendingInitialScrollRef.current = false;
    const target = historyRef.current?.querySelector<HTMLElement>('[data-last-user-msg="true"]');
    target?.scrollIntoView({ block: 'start' });
  }, [messages]);

  // Re-fetches the active chat from the server — the source of truth for real messageIds, called
  // after every mutation (send/rerun/edit) rather than hand-constructing local state, so
  // copy/edit/rerun/delete always have a real id to act on. Also refreshes activeChat itself
  // (not just messages) so Canvas's canvasNoteId — which a turn may have just set server-side via
  // a tool's focusHint — shows up without a separate request.
  async function refreshActiveMessages(chatId: string) {
    const detail = await getChat(chatId, apiKey);
    setMessages(detail.messages.map((m) => ({ messageId: m.messageId, role: m.role, content: m.content, resolvedContent: m.resolvedContent, swipes: m.swipes, reasoning: m.reasoning, activeSwipeId: m.activeSwipeId })));
    // Boundary advance (docs/plans/rp-sync-boundary-rollout-plan.md): a background sync may have
    // consolidated part of the live tail since the last render, so the refreshed boundary's
    // anchor moves up and the collapsed region grows. Revealed pages whose sync is no longer in
    // the refreshed `pages` (a now-consumed page, or a truncate that cascaded its sync point) are
    // dropped by capping the reveal count at the new pages length; the live tail re-anchors to
    // the new boundary on the next render.
    setSyncBoundary(detail.syncBoundary);
    // Page-drop observability (bi_principles.md §11 + docs/plans/rp-sync-boundary-rollout-plan.md):
    // a revealed page that vanished from the refreshed `pages` was consumed (or truncated), and
    // silently collapsing it would be an invisible display change. Log only the unusual case —
    // the reveal count needing to shrink — never the routine refresh.
    setRevealedSyncCount((prev) => {
      const next = detail.syncBoundary ? Math.min(prev, detail.syncBoundary.pages.length) : 0;
      if (next < prev) {
        console.warn('[chat] dropped a revealed archive page on boundary change', {
          chatId,
          previousRevealed: prev,
          remainingPages: detail.syncBoundary?.pages.length ?? 0,
        });
      }
      return next;
    });
    setActiveChat(detail.session);
    refreshLocationImage(chatId);
  }

  // Robust-chat-turns plan: reconcile this chat against server truth about whether a turn is
  // running. Entered from three places — the chat-load effect (a remounted tab reopens mid-turn),
  // document visibilitychange (mobile browsers throttle/pause timers in backgrounded tabs, so the
  // local 1s poll may have gone stale while away), and send()'s 409 branch (a turn this client
  // lost track of is already running). If the server's lock says a turn is active, show the
  // pending bubble, poll on the same 1s cadence runChatTurn's status poll uses, and once the lock
  // clears refresh the messages — the reply lands as the canonical row, exactly like the
  // post-turn refresh send() runs. No-op when the turn already finished (the active check races
  // the lock release), and a no-op on a chat the user has since switched away from (chatIdRef
  // guard, same pattern as send()'s post-turn refresh).
  async function reconcileTurnInFlight(chatId: string) {
    if (resumingTurnRef.current || chatIdRef.current !== chatId) return;
    const { active } = await getChatTurnStatus(chatId, apiKey).catch(() => ({ status: null, active: false }));
    if (!active) return;
    resumingTurnRef.current = true;
    setResumingTurn(true);
    try {
      // The turn that holds the lock will release it in its own finally — poll until it clears,
      // then refresh to show the persisted result (a resumed streaming turn has no live SSE
      // stream to reattach to, so this is the same degradation turn 1 already accepts today).
      while (resumingTurnRef.current && chatIdRef.current === chatId) {
        await new Promise((r) => window.setTimeout(r, 1000));
        if (chatIdRef.current !== chatId) return;
        const status = await getChatTurnStatus(chatId, apiKey).catch(() => ({ status: null, active: false }));
        if (!status.active) break;
      }
      if (chatIdRef.current === chatId) {
        await refreshActiveMessages(chatId).catch(() => {});
      }
    } finally {
      resumingTurnRef.current = false;
      setResumingTurn(false);
    }
  }

  // send()'s generic catch-all: the fetch itself threw (not an ApiError — no HTTP response was
  // ever received), most commonly a backgrounded mobile tab whose OS suspended the in-flight
  // connection rather than a real outage. Left alone, the error banner is a dead end — the turn
  // behind the failed request may have completed, or still be running, entirely unrelated to
  // whether *this* tab can currently reach the server. Poll a cheap reachability probe (whoami —
  // the same unauthenticated probe App.tsx uses at mount) until it succeeds, then reconcile
  // against server truth instead of leaving the banner (and the unconfirmed optimistic message)
  // stuck. Deliberately unconditional on reachability, unlike reconcileTurnInFlight's other
  // callers: this tab has a specific pending attempt of unknown outcome, so a reply that landed
  // while disconnected must show up even if the turn is no longer "active" by the time we ask.
  async function waitForReconnectThenReconcile(chatId: string | undefined) {
    if (reconnectingRef.current) return;
    reconnectingRef.current = true;
    try {
      while (!reconnectDisposedRef.current) {
        const reachable = await whoami(apiKey).then(
          () => true,
          () => false,
        );
        if (reachable) break;
        await new Promise((r) => window.setTimeout(r, 3000));
      }
    } finally {
      reconnectingRef.current = false;
    }
    if (reconnectDisposedRef.current) return;
    setError(null);
    if (!chatId || chatIdRef.current !== chatId) return;
    await refreshActiveMessages(chatId).catch(() => {});
    await reconcileTurnInFlight(chatId);
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
      !composerHasText &&
      stagedFiles.length === 0 &&
      stagedImages.length === 0
    );
  }

  /** The Stop button: tell the orchestrator to abort this chat's in-flight turn server-side
   *  (POST /v1/chat/abort) — the only way to actually stop generation, since the completion
   *  POST is a single blocking request (see client.ts's abortTurn doc comment for why killing
   *  the client fetch alone wouldn't stop the server). The still-pending chatCompletion then
   *  resolves with the server's 499 'turn aborted' response, which send()'s catch treats as
   *  the expected outcome. Best-effort: if the abort request itself fails, the turn simply
   *  continues and its reply lands — nothing worse happens, so no error banner either. */
  async function stopTurn() {
    if (!activeChat) return; // chat still being created — nothing in flight to abort yet
    // Mark `stop` the instant the abort is requested — the plan's "stop is marked when the
    // client calls POST /v1/chat/abort itself" case (the terminal frame re-marks it idempotently
    // when it lands a moment later).
    activeTimelineRef.current?.stop();
    try {
      await abortTurn(activeChat.chatId, apiKey);
    } catch {
      // Best-effort, see above.
    }
  }

  /** In-stream cleanup status frame (client.ts's CleanupStatusFrame): update the three pills'
   *  live states for this stream (the server-side live map, cleanupLiveStatus.ts, overlaid on the
   *  settled poll — in-stream-cleanup-plan.md's ambient-hint-then-canonical-record handoff). */
  const handleCleanupStatus = (frame: CleanupStatusFrame) => {
    setCleanupLive((prev) => ({
      ...(prev ?? { header: 'not-called', body: 'not-called', footer: 'not-called' }),
      [frame.region]: frame.state,
    }));
  };

  /** In-stream cleanup patch frame (client.ts's CleanupPatchFrame): the server spliced this span
   *  into its composed buffer — byte-identical to the text this client accumulated via onDelta
   *  (raw deltas plus every patch already applied, in the same order both sides applied them) —
   *  so the same splice at the same offsets keeps the visible text in sync. For a send the target
   *  is the in-progress placeholder (the tail); for a swipe it's the regenerating message. */
  const applyCleanupPatch = (frame: CleanupPatchFrame, messageId?: string) => {
    setMessages((prev) => {
      const idx = messageId ? prev.findIndex((m) => m.messageId === messageId) : prev.length - 1;
      const target = prev[idx];
      if (!target || target.role !== 'assistant') return prev;
      const next = [...prev];
      next[idx] = {
        ...target,
        content: target.content.slice(0, frame.start) + frame.replacement + target.content.slice(frame.end),
      };
      return next;
    });
  };

  /** Runs one turn's chatCompletion call against `chatId`, wiring up whatever "something to look
   *  at while the LLM is working" behavior fits `kind` — a live streaming placeholder (RP) or a
   *  status poll (buffered) — so no caller has to reinvent it. Shared by send() (a fresh turn)
   *  and submitEdit()'s resend branch (an edited-then-resent turn): both replace whatever reply
   *  used to sit here and need the same in-flight feedback while the new one arrives — without
   *  it, the old reply is just gone with nothing to look at until the whole turn resolves.
   *  Callers own setSending/setError/refreshActiveMessages; this owns everything turn-local. */
  async function runChatTurn(
    wireMessages: ChatMessage[],
    chatId: string,
    kind: ChatSessionRow['kind'] | undefined,
    attachments?: Parameters<typeof chatCompletion>[3],
    images?: Parameters<typeof chatCompletion>[4],
  ): Promise<void> {
    // RP chats stream their turns live (rp-streaming-plan.md): the status poll is not started
    // (the live text IS the status), an assistant placeholder is pushed and filled by onDelta.
    // chat-kind turns (tool-calling) keep the buffered path, polled via getChatTurnStatus.
    const streaming = kind === 'rp';
    let statusTimer: number | undefined;
    // The turn-timing recorder (docs/plans/llm-stats-page-plan.md): one per RP turn, created only
    // when the turn actually streams (a buffered chat-kind turn never fires onDelta/cleanup
    // frames, so there'd be nothing to time). Marked from the existing SSE callbacks below,
    // finalized once the awaited call resolves or throws. The Stop button reaches it through
    // activeTimelineRef while the turn is in flight.
    let timeline: TurnTimeline | undefined;
    if (!streaming) {
      statusTimer = window.setInterval(async () => {
        setTurnStatus((await getChatTurnStatus(chatId, apiKey)).status);
      }, 1000);
    }
    try {
      if (streaming) {
        setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);
        setLiveStreaming(true);
        // Reasoning blocks (reasoning-blocks-plan.md): a fresh turn starts with an empty live
        // buffer aimed at the tail placeholder (target null = "the last message, the only
        // id-less one while a turn streams"). Frames append to it; the block stays open while
        // the turn streams and collapses when liveReasoningDone flips in the finally below.
        setLiveReasoning(null);
        setLiveReasoningDone(false);
        setLiveReasoningTargetId(null);
        // Turn-timing recorder (docs/plans/llm-stats-page-plan.md): the RP turn is the unit of
        // measurement — created here and marked from the SSE callbacks below. The Stop button
        // reaches this instance through activeTimelineRef while the turn is in flight.
        timeline = new TurnTimeline({ chatId, apiKey });
        activeTimelineRef.current = timeline;
        // The terminal frame upgrades this from the default 'ok' — an abort or a genuine
        // upstream failure after streaming began both still end with [DONE] (so the await below
        // resolves either way), and finalize reads this rather than the resolved value.
        let streamOutcome: TimelineOutcome = 'ok';
        // t0 — the instant before the API call, before any await.
        timeline.dispatch();
        const resolved = await chatCompletion(
          wireMessages,
          apiKey,
          chatId,
          attachments,
          images,
          (delta) => {
            // Turn-timing recorder: every content delta marks the first/last-token window.
            timeline!.onDelta();
            // Append into the placeholder pushed above. It is always the last message while
            // this turn is in flight — sending/swipingId guards block anything else appending —
            // so a tail-append is safe; the caller's post-turn refresh reconciles it either way.
            setMessages((prev) => {
              const tail = prev[prev.length - 1];
              if (!tail || tail.role !== 'assistant') return prev;
              return [...prev.slice(0, -1), { ...tail, content: tail.content + delta }];
            });
          },
          (frame) => {
            // Abort/error terminal frame (client.ts's StreamingTerminalFrame). An abort is the
            // expected Stop outcome — the caller's refresh shows the true state. A genuine
            // upstream failure after streaming began surfaces as an error banner instead.
            if (frame.aborted) {
              streamOutcome = 'aborted';
              // The recorder's stop mark (plan Logic): the abort-flavored terminal frame is the
              // same abort signal as the Stop button — idempotent, first one wins.
              timeline!.stop();
            } else {
              streamOutcome = 'error';
              setError(frame.message);
            }
          },
          // In-stream cleanup (in-stream-cleanup-plan.md): the live pill states ride the same
          // SSE stream as the deltas, and the content patches splice into the placeholder in
          // onDelta-accumulated coordinates (the tail while this turn is in flight). Patches
          // never arrive for turn 1 — the server sends the composed text wholesale there, so
          // there is no already-streamed raw text to correct in place. The recorder also reads
          // every cleanup frame: a region's first in-flux opens its span, its first
          // deployed/flagged closes it (plan Logic).
          (frame) => {
            timeline!.cleanupState(frame.region, frame.state);
            handleCleanupStatus(frame);
          },
          (frame) => applyCleanupPatch(frame),
          // Reasoning blocks (reasoning-blocks-plan.md): accumulate each reasoning delta into
          // the live buffer — deliberately separate from the content accumulation, so the
          // rendered content stays de-tagged (the server persists the same split).
          (frame: ReasoningFrame) => setLiveReasoning((prev) => (prev ?? '') + frame.delta),
        );
        // Turn-timing recorder: the turn is final — emit last-token + display-settle and POST
        // the record fire-and-forget. The resolved `id` is the SSE completion id (chatcmpl-*):
        // the assistant message's real id is never carried on the stream (it's generated
        // server-side, separate from the chunk id), so this is the best id available at
        // finalize. It is unique per turn, which is all the unique-index dedupe needs; aborted/
        // errored streams resolve normally, so the terminal frame's outcome above decides.
        timeline.finalize(streamOutcome, resolved.id);
        reportTurnSnapshot(timeline, chatId);
      } else {
        await chatCompletion(wireMessages, apiKey, chatId, attachments, images);
      }
    } catch (err) {
      // Turn-timing recorder: the awaited call threw. 499 = Stop (the server aborted before
      // anything streamed — nothing was persisted, so the recorder's no-message-id guard drops
      // the record); anything else = genuine failure. Either way the elapsed-time record up to
      // the throw is what the plan's "aborted/errored turns are still recorded" wants — except
      // a pre-stream throw has no message id to attach, which is precisely the case the
      // recorder's persist() deliberately drops.
      timeline?.finalize(err instanceof ApiError && err.status === 499 ? 'aborted' : 'error');
      reportTurnSnapshot(timeline, chatId);
      // A streamed turn that failed without ever streaming (bad request, auth, upstream error
      // before the first chunk, or a Stop abort) left its empty placeholder behind — drop it so
      // the list reflects reality (nothing was persisted). It's the only assistant message
      // without a messageId, so a tail-check is unambiguous; buffered turns never pushed one.
      if (streaming) {
        setMessages((prev) => {
          const tail = prev[prev.length - 1];
          if (tail && tail.role === 'assistant' && !tail.messageId) return prev.slice(0, -1);
          return prev;
        });
      }
      throw err;
    } finally {
      if (statusTimer !== undefined) {
        window.clearInterval(statusTimer);
        setTurnStatus(null);
      }
      setLiveStreaming(false);
      // The stream is over — drop the live pill overrides so the settled poll becomes
      // authoritative again (cleanupLiveStatus.ts's ambient-hint-then-canonical-record handoff).
      setCleanupLive(null);
      // Reasoning: the live block collapses now (thinking → done); the caller's refresh swaps
      // the buffer for the canonical row's persisted `reasoning`.
      setLiveReasoningDone(true);
      // The turn is no longer in flight — the Stop button must not mark a stale recorder.
      activeTimelineRef.current = null;
    }
  }

  async function send() {
    const text = composerRef.current?.getValue().trim() ?? '';
    const resendLast = resendMode();
    if (sending || resumingTurn) return;
    if (syncBlocked) return; // the banner under the top bar explains; the server would 409 anyway
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
    sendingRef.current = true;
    // Resend re-runs the existing history as-is; a normal send appends this turn's user message.
    const nextMessages: DisplayMessage[] = resendLast
      ? messages
      : [...messages, { role: 'user', content: displayText }];
    setMessages(nextMessages);
    // Rollout re-collapse on send (rp-sync-boundary-rollout-plan.md): the "next turn hides it
    // again" guarantee is unconditional — any revealed pages drop back to the single marker, and
    // the post-turn refresh re-anchors the (possibly advanced) boundary.
    setRevealedSyncCount(0);
    // The sent draft must not resurrect from localStorage on a later remount — clear() resets
    // the state AND removes the key immediately (the debounced write-through effect would clear
    // it 250ms later anyway; doing it here makes the intent explicit and immediate).
    composerRef.current?.clear();
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
      // An RP chat whose turn-1 reply is header-repaired server-side arrives as a single chunk
      // (still SSE, still resolved the same way as any other streamed turn).
      await runChatTurn(toWireMessages(nextMessages), chatId, session.kind, attachments, images);
      // Reconcile: for a streamed turn the placeholder pushed by runChatTurn is replaced by the
      // server's canonical row (dropped entirely if the stream aborted and nothing was
      // persisted); for a buffered turn this is the same refetch as before. Guarded against a
      // chat switch mid-send (chatIdRef): the turn belongs to the chat that was open when it
      // started, and refreshing it now would stomp the transcript of whichever chat the user has
      // since opened.
      if (chatIdRef.current === session.chatId) {
        await refreshActiveMessages(session.chatId);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 499) {
        // The user hit Stop — the server aborted the turn (POST /v1/chat/abort), so this is
        // the expected outcome, not an error. Refresh to show the stopped state: the user
        // message stands with no reply, which resendMode() already presents as the Resend
        // button recovery path. (activeChat, not the try-scoped session/chatId: a 499 can
        // only come from a turn on the already-open active chat.) Same chat-switch guard as
        // the success path above — a Stop landed on a turn the user has since navigated away
        // from must not repopulate the view with the old chat.
        if (activeChat && chatIdRef.current === activeChat.chatId) {
          await refreshActiveMessages(activeChat.chatId).catch(() => {});
        }
      } else if (err instanceof ApiError && err.status === 409) {
        // Robust-chat-turns plan: the server refused this send because a turn is already running
        // for this chat — most likely one this same client lost track of (a backgrounded tab or
        // reload wiped the local `sending` state) rather than a genuinely foreign turn. Reconcile
        // against server truth instead of surfacing an error banner: show the pending bubble and
        // refresh once the in-flight turn resolves (reconcileTurnInFlight). The optimistic user
        // message this send pushed is not in the canonical record and disappears on that refresh,
        // exactly like the 499 stopped-turn path.
        if (activeChat && chatIdRef.current === activeChat.chatId) {
          void reconcileTurnInFlight(activeChat.chatId);
        } else {
          setError('a turn is already in progress for this chat');
        }
      } else if (err instanceof ApiError && err.status === 409 && err.message === 'CHAT_SYNC_STALLED') {
        // Rolling-memory sync stall (handleChatCompletions.ts): the server refused this NEW turn
        // because sync has fallen a full block behind. The poll can lag up to 30s behind the
        // server's view, so reflect the block immediately — the banner's blocked state shows now,
        // not on the next tick. The optimistic user message this send pushed was never persisted
        // and disappears on the refresh (same as the 499 path).
        setSyncHealth((prev) => ({
          state: 'blocked',
          blocking: true,
          lastStatus: null,
          lastStep: null,
          lastError: null,
          consecutiveErrors: 0,
          turnsUntilBlock: null,
          // Irrelevant while blocked (showSyncBanner always shows blocked state regardless of
          // this value) — carried over from the last poll purely to satisfy the type.
          syncEveryPairs: prev?.syncEveryPairs ?? 0,
        }));
        if (activeChat && chatIdRef.current === activeChat.chatId) {
          void refreshActiveMessages(activeChat.chatId).catch(() => {});
        }
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        // No HTTP response was ever received — most commonly a backgrounded mobile tab whose OS
        // suspended this request's connection, not a real outage. The banner self-clears once
        // the server is reachable again (waitForReconnectThenReconcile), which also picks up a
        // reply that landed while this tab was disconnected — same recovery as the 409 path
        // above, just triggered by a lower-level failure than a clean 409 response.
        setError('failed to reach BigImagine — reconnecting…');
        void waitForReconnectThenReconcile(activeChat?.chatId);
      }
    } finally {
      setSending(false);
      sendingRef.current = false;
      // A cleanup settle observed while the send was in flight: the send's own refresh above may
      // have read the DB before the cleanup write landed. Re-fetch once so the rewrite still
      // shows up straightaway — guarded against a chat switch mid-send (chatIdRef).
      const deferredId = deferredCleanupSettleRef.current;
      deferredCleanupSettleRef.current = null;
      if (deferredId && chatIdRef.current === deferredId) {
        void refreshActiveMessages(deferredId).catch(() => {
          // Best-effort — a failed settle refresh leaves the poll tick to handle the next one.
        });
      }
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
  async function swipe(messageId: string, direction: 'prev' | 'next' | 'regenerate') {
    if (!activeChat || sending || swipingId) return;
    setError(null);
    setSwipingId(messageId);
    const willRegenerate = direction === 'regenerate' || (() => {
      const msg = messages.find((m) => m.messageId === messageId);
      const hasMoreSwipesAhead = !!msg?.swipes && msg.swipes.index < msg.swipes.count - 1;
      return direction === 'next' && !hasMoreSwipesAhead;
    })();
    setSwipeRegenerating(willRegenerate);
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
      setLocationImage({ locationId: prevImage.locationId, name: prevImage.name, definition: prevImage.definition, imageUrl: prevImage.imageUrl });
    }
    // Turn-timing recorder (docs/plans/llm-stats-page-plan.md): one per regeneration, marked
    // from the same SSE callbacks as a send. Declared outside the try so the catch can finalize
    // it on a throw. Swipes and sends are mutually exclusive (UI + the sending/swipingId
    // guards), so activeTimelineRef can hold only one recorder at a time.
    let swipeTimeline: TurnTimeline | undefined;
    try {
      // RP chats stream a needs_regenerate swipe live (rp-streaming-plan.md): the request gains
      // stream: true and each delta appends into the regenerating message in place; prev/next
      // cycling (no LLM call) is untouched.
      const streamingSwipe = willRegenerate && activeChat.kind === 'rp';
      let abortedStream = false;
      let result: SwipeResult;
      if (streamingSwipe) {
        // Reasoning blocks (reasoning-blocks-plan.md): a regeneration streams its own live
        // buffer aimed at the being-regenerated message (liveReasoningTargetId = messageId);
        // frames append to it, the block stays open while streaming, and the final mapping below
        // swaps the buffer for the canonical row's persisted `reasoning` after the refresh.
        setLiveReasoning(null);
        setLiveReasoningDone(false);
        setLiveReasoningTargetId(messageId);
        // The message being regenerated still holds the swipe it's replacing — clear it before
        // the first delta arrives, same as send()'s pending bubble starting at ''. Otherwise every
        // delta (and any live-cleanup patch, whose start/end offsets are computed against a
        // zero-based buffer for this turn only) lands on top of/into the old swipe's text instead
        // of a clean one, visibly appending until the post-stream refresh overwrites it.
        setMessages((prev) => prev.map((m) => (m.messageId === messageId ? { ...m, content: '' } : m)));
        // Turn-timing recorder: created here and marked from the SSE callbacks below, same as a
        // send. The Stop button reaches this instance through activeTimelineRef.
        swipeTimeline = new TurnTimeline({ chatId: activeChat.chatId, apiKey });
        activeTimelineRef.current = swipeTimeline;
        // The terminal frame upgrades this from the default 'ok' — abort and mid-stream failure
        // both end with [DONE] (the await resolves either way), so finalize reads this.
        let streamOutcome: TimelineOutcome = 'ok';
        // t0 — the instant before the API call, before any await.
        swipeTimeline.dispatch();
        result = await swipeMessage(
          activeChat.chatId,
          messageId,
          direction === 'regenerate' ? 'regenerate' : 'next',
          apiKey,
          (delta) => {
            // Turn-timing recorder: every content delta marks the first/last-token window.
            swipeTimeline!.onDelta();
            setMessages((prev) =>
              prev.map((m) => (m.messageId === messageId ? { ...m, content: m.content + delta } : m)),
            );
          },
          (frame) => {
            // Abort is the expected Stop outcome (partial text was never recordSwipe'd — the
            // refresh below restores the true state); a genuine upstream failure shows a banner.
            if (frame.aborted) {
              abortedStream = true;
              streamOutcome = 'aborted';
              // The recorder's stop mark (plan Logic): the abort-flavored terminal frame is the
              // same abort signal as the Stop button — idempotent, first one wins.
              swipeTimeline!.stop();
            } else {
              streamOutcome = 'error';
              setError(frame.message);
            }
          },
          // In-stream cleanup (in-stream-cleanup-plan.md): same frames as a send, but a swipe
          // has no turn-1 special case — every delta (and patch) targets the regenerating
          // message in place, so patches splice into that message by id. The recorder also reads
          // every cleanup frame: a region's first in-flux opens its span, its first
          // deployed/flagged closes it (plan Logic).
          (frame) => {
            swipeTimeline!.cleanupState(frame.region, frame.state);
            handleCleanupStatus(frame);
          },
          (frame) => applyCleanupPatch(frame, messageId),
          // Reasoning blocks (reasoning-blocks-plan.md): accumulate each reasoning delta into
          // the live buffer, separate from the content accumulation (content stays de-tagged).
          (frame: ReasoningFrame) => setLiveReasoning((prev) => (prev ?? '') + frame.delta),
        );
        // Turn-timing recorder: the regeneration is final. Unlike the send path, the streamed
        // return carries the real message id (an in-place regeneration keeps the message's id),
        // so the record is joinable to the message. Note the unique index on message_id means a
        // message regenerated more than once keeps only its first record — the plan's dedupe
        // contract, an accepted coverage gap for repeated Reruns.
        if ('message' in result) {
          swipeTimeline.finalize(streamOutcome, result.message.messageId);
        } else {
          swipeTimeline.finalize(streamOutcome);
        }
        reportTurnSnapshot(swipeTimeline, activeChat.chatId);
      } else {
        const swipeDir = direction === 'regenerate' ? 'regenerate' : direction;
        result = await swipeMessage(activeChat.chatId, messageId, swipeDir as 'prev' | 'next' | 'regenerate', apiKey);
      }
      if ('message' in result) {
        if (abortedStream) {
          // Stopped mid-regeneration — nothing was written, so refresh to the true state and
          // restore the swiped-from background (same net effect as the 499 catch below).
          if (activeChat) await refreshActiveMessages(activeChat.chatId).catch(() => {});
          if (reverted) setLocationImage(swipedFrom);
        } else {
          setMessages((prev) =>
            prev.map((m) => (m.messageId === messageId ? { ...m, content: result.message.content, resolvedContent: result.message.resolvedContent, swipes: result.message.swipes, reasoning: result.message.reasoning } : m)),
          );
          if (streamingSwipe) {
            // The regenerated variant is recordSwipe'd server-side by the time [DONE] arrived —
            // refresh the canonical row so swipes metadata (index/count) and any display copy
            // match what's stored, rather than trusting the minimal streamed return.
            await refreshActiveMessages(activeChat.chatId).catch(() => {});
          }
          // A switch happened (regeneration or variant cycle) — the active swipe changed, so the
          // location state may have too: re-read it. For a regen the new location is pending until
          // its render lands, so the reverted previous background stays up and the poll swaps in
          // the replacement the moment it's ready; for a cycle the server's own trigger
          // (ensureActiveLocationImage) restarts a dropped render and this read picks it up.
          void refreshLocationImage(activeChat.chatId);
        }
      }
      // 'no_earlier_swipe': nothing to do — the prev button is already disabled at index 0.
    } catch (err) {
      // Turn-timing recorder: the regeneration call threw (streamingSwipe only — prev/next
      // cycling never creates a timeline). 499 = Stop before anything streamed; nothing was
      // written either way, so the recorder's no-message-id guard drops the record.
      swipeTimeline?.finalize(err instanceof ApiError && err.status === 499 ? 'aborted' : 'error');
      reportTurnSnapshot(swipeTimeline, activeChat.chatId);
      if (err instanceof ApiError && err.status === 499) {
        // The user hit Stop mid-regeneration — the server aborted the turn (POST
        // /v1/chat/abort) and the swipe route answers 499 for it, same contract as the main
        // turn's aborted response. Nothing was written (recordSwipe never ran), so the turn is
        // unchanged: refresh to its true state and restore the swiped-from background, since the
        // replacement never settled. No error banner — this is the expected outcome.
        if (activeChat) await refreshActiveMessages(activeChat.chatId).catch(() => {});
        if (reverted) setLocationImage(swipedFrom);
      } else {
        setError(err instanceof ApiError ? err.message : 'failed to swipe');
        // The swipe failed — the turn is unchanged, so restore the swiped-from background.
        if (reverted) setLocationImage(swipedFrom);
      }
    } finally {
      setSwipingId(null);
      setSwipeRegenerating(false);
      // The regeneration stream is over — drop the live pill overrides so the settled poll is
      // authoritative again (same handoff as a send's finally).
      setCleanupLive(null);
      // Reasoning (reasoning-blocks-plan.md): the live block collapses now; the refresh in the
      // success branch above swaps the buffer for the canonical row's persisted `reasoning`.
      setLiveReasoningDone(true);
      // The regeneration is no longer in flight — the Stop button must not mark a stale
      // recorder (safe: sends and swipes are mutually exclusive, so this can't clear a
      // send's live recorder).
      activeTimelineRef.current = null;
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
   *    Exception: the user's last message can be saved in place instead (inPlace=true) — same
   *    message id, everything after untouched, the pre-edit text preserved as a swipe — when they
   *    just want to fix their wording without burning a regeneration.
   *  - assistant message (the "edit an LLM reply" action): the text is rewritten in place — same
   *    message id, everything after untouched, the pre-edit text preserved as a swipe — and the
   *    conversation simply continues from the edited reply. No truncation, no branch. */
  async function submitEdit(inPlace = false) {
    const messageId = editingId;
    const content = editDraft.trim();
    if (!activeChat || !messageId || !content || sending) return;
    const target = messages.find((m) => m.messageId === messageId);
    if (!target) return;
    setError(null);
    setEditingId(null);
    setSending(true);
    try {
      if (target.role === 'assistant' || inPlace) {
        if (content === target.content) return; // nothing changed — no junk swipe server-side
        await editMessageContent(activeChat.chatId, messageId, content, apiKey);
      } else {
        await truncateMessagesFrom(activeChat.chatId, messageId, apiKey);
        const idx = messages.findIndex((m) => m.messageId === messageId);
        const kept = idx === -1 ? messages : messages.slice(0, idx);
        const withEdit: DisplayMessage[] = [...kept, { role: 'user', content }];
        setMessages(withEdit);
        await runChatTurn(toWireMessages(withEdit), activeChat.chatId, activeChat.kind);
      }
      await refreshActiveMessages(activeChat.chatId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 499) {
        // The user hit Stop on an edit-resend (the Stop button shows while `sending` is true,
        // which submitEdit sets) — expected outcome, same quiet handling as send(): refresh so
        // the truncated/edited user message stands alone with the Resend recovery path.
        await refreshActiveMessages(activeChat.chatId).catch(() => {});
      } else {
        setError(err instanceof ApiError ? err.message : 'failed to save edit');
      }
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

  async function truncateFrom(messageId: string) {
    if (!activeChat) return;
    if (!window.confirm('Delete this message and everything after it?')) return;
    try {
      await truncateMessagesFrom(activeChat.chatId, messageId, apiKey);
      await refreshActiveMessages(activeChat.chatId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to delete history');
    }
  }

  // --- Selection-mode bulk delete (⋯ menu → "Delete messages") ---
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
      if (activeChat.kind === 'rp') {
        onOpenRp?.(forked.chatId, forked.title);
      } else {
        onOpenChat?.(forked.chatId, forked.title);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to fork chat');
    }
  }

  /** Best-effort mirror of CharactersView.applyDefaultStack: a fresh RP chat opts into the async
   *  cleanup subloop (migration 0072) and gets the user's default prompt stack (0061) so it
   *  doesn't start stack-less. Either can fail independently without blocking the restart. */
  async function applyDefaultStack(chatId: string) {
    try {
      const stacks = await callTool<ContextStackPreset[]>('get_context_stack_presets', {}, apiKey);
      const defaultStack = stacks.find((s) => s.isDefault);
      if (defaultStack) {
        await callTool('apply_prompt_stack_to_chat', { chatId, presetId: defaultStack.presetId }, apiKey);
      }
      await updateChat(chatId, { cleanup_enabled_at: new Date().toISOString() }, apiKey);
    } catch {
      // best-effort
    }
  }

  /** ⋯ menu → "Restart chat": starts a brand-new RP chat with the same character — the exact
   *  Start RP flow (CharactersView.startRp) — and opens it in a new tab. "Delete old chat"
   *  ticked = hard-delete THIS chat server-side afterwards: its messages/swipes, memory sync
   *  points, canon facts (0058) and scenes (0067) all cascade with the row, and App closes its
   *  tab (onChatsDeleted). The new chat is created first, so a failed delete can never leave the
   *  user with nothing — worst case the old chat survives and an error is shown. */
   async function restartChat() {
    if (!activeChat?.cardId) return;
    setRestarting(true);
    setError(null);
    try {
      const chat = await createChat(apiKey, { title: activeChat.title, kind: 'rp', card_id: activeChat.cardId });
      await callTool('apply_card_to_chat', { cardId: activeChat.cardId, chatId: chat.chatId }, apiKey);
      await applyDefaultStack(chat.chatId);
      if (restartDeleteOld) {
        await deleteChat(activeChat.chatId, apiKey);
        onChatsDeleted?.([activeChat.chatId]);
      }
      setRestartOpen(false);
      setRestartDeleteOld(false);
      onOpenRp?.(chat.chatId, activeChat.title);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to restart chat');
    } finally {
      setRestarting(false);
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

  // Shared between the desktop header ⋯ and the mobile input-row ⋯ — the same items, two mounts
  // (ChatView.css hides the header copy on mobile and the row copy on desktop). One chatMenuOpen
  // state serves both.
  const chatMenuItems = (
    <>
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
        title={
          activeChat?.cardId
            ? 'Start a fresh chat with this card'
            : 'No card attached to this chat'
        }
        disabled={!activeChat?.cardId || sending || restarting}
        onClick={() => {
          setRestartDeleteOld(false);
          setRestartOpen(true);
          setChatMenuOpen(false);
        }}
      >
        🔁 Restart chat
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

  // Typing lag fix: the composer's draft used to live in ChatView's state, so every keystroke
  // re-rendered it — and cascaded into a full re-render, and a full ReactMarkdown reparse, of
  // every message in the history, worst on long RP chats where that's most of what's on screen.
  // Two layers now stop that: ChatComposer owns the draft, so typing never re-renders ChatView at
  // all (composer-render-isolation-plan.md) — and ChatMessageRow (React.memo) is the second line
  // of defense for ChatView's other re-renders (send progress, selection mode, active-chat
  // changes), skipping the reparse for messages whose own props didn't change. Memoization only
  // holds if those props are referentially stable across renders. `messages[i]` objects already
  // are (setMessages only replaces the entries that actually changed); the callbacks below are
  // the other half — swipe/startEdit/etc. are plain `function` declarations redeclared every
  // render, so passed directly they'd break the memo on every re-render too. Routing them
  // through a ref keeps the identity handed to each row permanently stable while every call still
  // reaches the current closure (avoids hand-deriving accurate useCallback dependency arrays for
  // functions this wide, e.g. swipe's).
  const swipeRef = useRef(swipe);
  swipeRef.current = swipe;
  const startEditRef = useRef(startEdit);
  startEditRef.current = startEdit;
  const cancelEditRef = useRef(cancelEdit);
  cancelEditRef.current = cancelEdit;
  const submitEditRef = useRef(submitEdit);
  submitEditRef.current = submitEdit;
  const removeMessageRef = useRef(removeMessage);
  removeMessageRef.current = removeMessage;
  const truncateFromRef = useRef(truncateFrom);
  truncateFromRef.current = truncateFrom;
  const toggleSelectRef = useRef(toggleSelect);
  toggleSelectRef.current = toggleSelect;
  const forkFromRef = useRef(forkFrom);
  forkFromRef.current = forkFrom;
  const toggleMessageActionsRef = useRef(toggleMessageActions);
  toggleMessageActionsRef.current = toggleMessageActions;

  const stableSwipe = useCallback((messageId: string, direction: 'prev' | 'next' | 'regenerate') => swipeRef.current(messageId, direction as 'prev' | 'next' | 'regenerate'), []);
  const stableStartEdit = useCallback((messageId: string, content: string) => startEditRef.current(messageId, content), []);
  const stableCancelEdit = useCallback(() => cancelEditRef.current(), []);
  const stableSubmitEdit = useCallback((inPlace: boolean) => submitEditRef.current(inPlace), []);
  const stableRemoveMessage = useCallback((messageId: string) => removeMessageRef.current(messageId), []);
  const stableTruncateFrom = useCallback((messageId: string) => truncateFromRef.current(messageId), []);
  const stableToggleSelect = useCallback((index: number) => toggleSelectRef.current(index), []);
  const stableForkFrom = useCallback((messageId: string) => forkFromRef.current(messageId), []);
  const stableToggleMessageActions = useCallback((messageId: string | undefined) => toggleMessageActionsRef.current(messageId), []);

  // Single O(n) pass so isLastAssistant/isLastUserMsg below don't cost an O(n) lookahead scan
  // per message (an O(n^2) cost that itself grows with the same long RP histories this fix targets).
  const { lastAssistantIndex, lastUserIndex } = useMemo(() => {
    let lastAssistant = -1;
    let lastUser = -1;
    messages.forEach((m, idx) => {
      if (m.role === 'assistant') lastAssistant = idx;
      else if (m.role === 'user') lastUser = idx;
    });
    return { lastAssistantIndex: lastAssistant, lastUserIndex: lastUser };
  }, [messages]);

  const settledBoundaryIndex = useMemo(
    () => (syncBoundary ? messages.findIndex((m) => m.messageId === syncBoundary.lastMessageId) : -1),
    [syncBoundary, messages],
  );

  // The rollout display (docs/plans/rp-sync-boundary-rollout-plan.md): split the full message
  // array into the consumed (rolled-out) region, the revealed archive pages the reader has scrolled
  // to reveal above the boundary marker, and the live un-synced tail. Everything indexes into the
  // full `messages` array so lastAssistantIndex/lastUserIndex, selection, and the streaming
  // placeholder keep their meaning — this is purely which indices the render loop emits.
  const rollout = useMemo(() => {
    if (!syncBoundary) {
      return { boundaryIndex: -1, revealedBlocks: [] as { start: number; end: number }[], totalPages: 0 };
    }
    // The last closed sync point's anchor — everything at or before it is consumed.
    const boundaryIndex = messages.findIndex((m) => m.messageId === syncBoundary.lastMessageId);
    // A stale/cached boundary whose newest anchor can't be located (a truncate cascaded its sync
    // point) falls back to rendering the whole transcript rather than a bogus collapse.
    if (boundaryIndex < 0) return { boundaryIndex: -1, revealedBlocks: [], totalPages: 0 };
    // Survivors newest-first: drop any page whose anchor no longer exists in the message array
    // (docs/plans/rp-sync-boundary-rollout-plan.md Edge Cases — truncate-away anchors). The page
    // spans are always re-derived from the current array, so a dropped page re-bounds its
    // neighbors onto the next surviving anchor.
    const survivors = syncBoundary.pages.filter((p) => messages.some((m) => m.messageId === p.lastMessageId));
    // Compute every page's message-index span against ALL survivors (not just the revealed ones),
    // oldest-first (DOM order top-to-bottom): a page's inclusive upper bound is its own anchor;
    // its lower bound is the next-older surviving page's anchor (exclusive), or index 0 for the
    // oldest page. Never compares messageId values directly — only array index position (message
    // ids are random UUIDs, so only the ordered array is a valid ordering signal).
    const survivorsOldestFirst = [...survivors].reverse();
    const allSpans: { start: number; end: number }[] = [];
    for (let j = 0; j < survivorsOldestFirst.length; j++) {
      const anchorIndex = messages.findIndex((m) => m.messageId === survivorsOldestFirst[j].lastMessageId);
      // anchorIndex is >= 0: the page "survived" the filter above precisely because its anchor
      // still exists in the message array.
      const start = j === 0 ? 0 : messages.findIndex((m) => m.messageId === survivorsOldestFirst[j - 1].lastMessageId) + 1;
      allSpans.push({ start, end: anchorIndex });
    }
    // The revealed region is the newest `revealedSyncCount` pages (each push reveals the next
    // older sync nearest the marker), which are the LAST `revealedSyncCount` spans of the
    // oldest-first list — rendered in order so the newest sits directly above the marker.
    const revealedCount = Math.min(revealedSyncCount, allSpans.length);
    const revealedBlocks = revealedCount === 0 ? [] : allSpans.slice(allSpans.length - revealedCount);
    return { boundaryIndex, revealedBlocks, totalPages: survivors.length };
  }, [syncBoundary, messages, revealedSyncCount]);

  // Lazy-load reveal (docs/plans/rp-sync-boundary-rollout-plan.md): the boundary marker is the
  // trigger. When the reader scrolls up so the marker enters the scrollable history container,
  // reveal the next-older archived page. IntersectionObserver fires only on viewport-entry
  // transitions, so each scroll-approach of the marker reveals exactly one page, never a cascade;
  // the newly inserted page (above the marker) pushes the marker back out of view, and the user
  // must scroll up again to reveal the next one. Reading the live tail at the bottom never
  // reveals anything. Re-arm is implicit: the observer keeps watching the (moved) marker.
  useEffect(() => {
    const root = historyRef.current;
    const marker = boundaryMarkerRef.current;
    if (!rollout.totalPages || !root || !marker) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        // Reveal one more page only while older content remains; the end-cap hint (when all pages
        // are revealed) is purely presentational — reveal is governed here, not by the marker.
        setRevealedSyncCount((c) => Math.min(c + 1, rollout.totalPages));
      },
      { root, rootMargin: '0px 0px -20% 0px' },
    );
    observer.observe(marker);
    return () => observer.disconnect();
    // Rebind when the number of revealable pages changes (boundary advance / fresh chat); the
    // marker element identity is stable for a given chat, so `marker` need not be a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rollout.totalPages]);

  // One ChatMessageRow with its real full-array index — the rollout skips indices rather than
  // renumbering, so every index-based consumer (lastAssistant/lastUser/selection/tail placeholder)
  // sees an unchanged array. Extracted from the inline map below so the no-boundary case and the
  // boundary case (revealed archive pages + live tail) share one row definition.
  const renderMessageRow = (m: DisplayMessage, i: number) => {
    const isLastAssistant = m.role === 'assistant' && i === lastAssistantIndex;
    // The user's last message can be saved in place (no resend) — editing it with the
    // resend path would burn a regeneration just to fix the wording. Earlier user messages
    // keep the branch-and-resend semantic (an in-place save mid-conversation would silently
    // orphan the exchange that followed).
    const isLastUserMsg = m.role === 'user' && i === lastUserIndex;
    const isOpeningGreeting = i === 0 && m.role === 'assistant';
    const settled = settledBoundaryIndex >= 0 && i <= settledBoundaryIndex;
    const isLiveReasoningTarget =
      liveReasoning !== null &&
      (m.messageId ? m.messageId === liveReasoningTargetId : i === messages.length - 1);
    const shownReasoning =
      m.role === 'assistant' ? (isLiveReasoningTarget ? liveReasoning! : m.reasoning) : undefined;
    const reasoningLiveOpen = isLiveReasoningTarget && !liveReasoningDone;
    return (
      <ChatMessageRow
        key={m.messageId ?? `pending-${i}`}
        message={m}
        index={i}
        isLastAssistant={isLastAssistant}
        isLastUserMsg={isLastUserMsg}
        isOpeningGreeting={isOpeningGreeting}
        canSwipe={activeChat?.kind !== 'rp' || i === messages.length - 1}
        selectionMode={selectionMode}
        selected={selectionStart !== null && i >= selectionStart}
        editing={editingId === m.messageId}
        editDraft={editDraft}
        onEditDraftChange={setEditDraft}
        onSubmitEdit={stableSubmitEdit}
        onCancelEdit={stableCancelEdit}
        sending={sending}
        swipingId={swipingId}
        actionsVisible={actionsVisibleId === m.messageId}
        onToggleActions={stableToggleMessageActions}
        onToggleSelect={stableToggleSelect}
        onSwipe={stableSwipe}
        onStartEdit={stableStartEdit}
        onForkFrom={stableForkFrom}
         onRemoveMessage={stableRemoveMessage}
         onTruncateFrom={stableTruncateFrom}
         settled={settled}
        shownReasoning={shownReasoning}
        reasoningLiveOpen={reasoningLiveOpen}
      />
    );
  };

  return (
    <div
      className={`chat-view${mobileShowCanvas ? ' mobile-canvas' : ''}`}
      style={{ ...chatBgStyle, ...legStyle }}
      data-legibility={legibilityFlags}
    >
      <div className={`chat-main${activeChat?.kind === 'rp' ? ' rp' : ''}`} ref={chatMainRef}>
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
                reportBrokenLocationImage(locationImage?.locationId ?? '', apiKey, locationImage?.imageUrl).catch(() => {});
                setLocationImage(null);
              }}
            />
            <div className="chat-location-overlay" aria-hidden="true" />
          </>
        )}

        {activeChat?.kind !== 'rp' && (
          <div className="chat-top-bar">
            <div className="chat-header">
              <span className="chat-title">{activeChat?.title ?? 'New chat'}</span>
              {false ? (
                <div className="chat-menu-wrap" ref={chatMenuRef}>
                  <button
                    type="button"
                    className="chat-menu-button"
                    title="Chat menu"
                    aria-haspopup="menu"
                    aria-expanded={chatMenuOpen}
                    onClick={() => setChatMenuOpen((v) => !v)}
                  >
                    ⋯
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
          </div>
        </div>
        )}

        {/* Rolling-memory sync warning/block banner (RP chats only): sits directly under the top
            bar so a sync problem is the first thing visible, not buried below the composer.
            Warning = still advancing, N turns of grace remain; blocked = the server refuses new
            turns (409 CHAT_SYNC_STALLED) and the composer is disabled. The warning half is held
            back until turnsUntilBlock has counted down to half of syncEveryPairs — the banner
            shouldn't fire the moment sync merely falls due, only once it's meaningfully behind.
            "View sync status" opens the standalone ChatSyncStatusPanel overlay. */}
        {activeChat?.kind === 'rp' && activeChat.cleanupEnabledAt && (
          <div className="rp-floating-pill">
            <CleanupStatusPill
              apiKey={apiKey}
              chatId={activeChat.chatId}
              liveStatus={cleanupLive}
              onSettled={() => {
                const id = activeChat.chatId;
                if (chatIdRef.current !== id) return;
                if (sendingRef.current) {
                  deferredCleanupSettleRef.current = id;
                  return;
                }
                void refreshActiveMessages(id).catch(() => {});
              }}
            />
          </div>
        )}
        {activeChat?.kind === 'rp' && syncHealth && showSyncBanner && (
          <div
            className={`chat-sync-banner chat-sync-banner-${syncHealth.state}`}
            role={syncHealth.state === 'blocked' ? 'alert' : undefined}
          >
            <span className="chat-sync-banner-text">
              {syncHealth.state === 'blocked' ? (
                <>Memory sync has failed and new messages are paused until it catches up.</>
              ) : (
                <>
                  Memory sync is running behind —{' '}
                  {syncHealth.turnsUntilBlock === null
                    ? 'new messages may be paused soon.'
                    : `${syncHealth.turnsUntilBlock} more turn${syncHealth.turnsUntilBlock === 1 ? '' : 's'} until new messages are paused.`}
                </>
              )}
              {/* The compact underlying error, when the last attempt actually failed (a stall
                  reached by turn count alone, with no failed attempt yet, has neither) — so the
                  user sees what's broken without opening the detail panel. */}
              {syncHealth.lastError && (
                <span className="chat-sync-banner-detail">
                  {' '}
                  ({syncHealth.lastStep ?? 'unknown step'}: {syncHealth.lastError})
                </span>
              )}
            </span>
            <button
              type="button"
              className="chat-sync-banner-link"
              onClick={() => setSyncStatusOpen(true)}
            >
              View sync status
            </button>
          </div>
        )}

        {activeChat?.kind === 'rp' && spriteStageVisible && chatId && (
          <>
            <div className="rp-sprite-stage-container" style={{ height: `${effectiveStageRatio * 100}%` }}>
              <SpriteStage
                apiKey={apiKey}
                chatId={chatId}
                refreshToken={spriteRefreshToken}
                active={active}
                selectedSwipeId={selectedSpriteSwipe.swipeId}
                selectedMessageId={selectedSpriteSwipe.messageId}
              />
            </div>
            <div
              className="sprite-stage-divider"
              role="separator"
              aria-orientation="horizontal"
              onPointerDown={handleStageDividerPointerDown}
              title="Drag to resize sprites"
            />
          </>
        )}

        <div className="chat-history" ref={historyRef} onScroll={handleHistoryScroll} onTouchStart={handleHistoryTouchStart} onTouchEnd={handleHistoryTouchEnd} onTouchCancel={handleHistoryTouchEnd}>
          {messages.length === 0 && chatId && <div className="empty-state">Ask BigImagine something.</div>}
          {messages.length === 0 && !chatId && (
            <div className="chat-empty-landing">
              <PinnedNotesDrawer apiKey={apiKey} />
            </div>
          )}
          {rollout.boundaryIndex >= 0 ? (
            <>
              {/* Revealed archive pages, oldest at the top, newest just above the marker
                  (rp-sync-boundary-rollout-plan.md). Each page is a block of verbatim rows; the
                  marker then sits directly above the live tail. */}
              {rollout.revealedBlocks.map(({ start, end }) =>
                messages.slice(start, end + 1).map((m, k) => renderMessageRow(m, start + k)),
              )}
              <div className="sync-boundary-marker" ref={boundaryMarkerRef}>
                <span className="marker-text">
                  Earlier in this story is archived{' '}
                  <span className="marker-rolled">(rolled into memory)</span>
                </span>
                {revealedSyncCount < rollout.totalPages ? (
                  <span className="marker-hint" aria-hidden="true">
                    scroll up to keep showing previous turns
                  </span>
                ) : (
                  <span className="marker-at-start">— you&apos;re at the start of the story —</span>
                )}
              </div>
              {messages.slice(rollout.boundaryIndex + 1).map((m, k) =>
                renderMessageRow(m, rollout.boundaryIndex + 1 + k),
              )}
            </>
          ) : (
            messages.map((m, i) => renderMessageRow(m, i))
          )}
          {(sending || resumingTurn) && !liveStreaming && (
            <div className="chat-bubble assistant pending">{resumingTurn ? 'still generating…' : (turnStatus ?? '…')}</div>
          )}
          {/* Mobile bottom slack (ChatView.css): the scrollable content otherwise ends at the
              last entry, which pins its bottom to the top of the input row — the expandable
              rerun/edit bar could never be pulled up to mid-screen. This spacer extends the
              scroll range past the last message instead. Omitted on an empty chat (the landing/
              empty-state already fills the pane with flex:1 — a spacer would just add scroll). */}
          {messages.length > 0 && <div className="chat-history-spacer" aria-hidden="true" />}
        </div>

        {/* The whole bottom control stack floats over the conversation (ChatView.css): bubbles
            scroll under it instead of stopping at a divider line, and its footprint swallows
            pointer/touch events so a bubble that has scrolled underneath can't be tapped or
            swiped. The alpha mask on .chat-history (chat-fade-mask-plan.md) fades bubbles to
            transparent through this stack's footprint; its span tracks this stack's live height
            via --chat-fade-px (bottomOverlayRef's ResizeObserver), the same measurement that
            parks the newest message just above the stack at full scroll. The overlay itself is
            transparent — no tint, no edge — so the background behind the controls stays
            untouched. */}
        <div className="chat-bottom-overlay" ref={bottomOverlayRef}>
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
            <div className="chat-composer-shell">
              {/* Robust-chat-turns plan: the composer is disabled while catching up to a turn this
                  tab lost track of (resumingTurn) — typing into a conversation whose transcript is
                  about to change under you is worse than waiting for the refresh. Also disabled
                  while rolling-memory sync is blocking new turns (syncBlocked — the banner under
                  the top bar explains; the server would 409 CHAT_SYNC_STALLED anyway). */}
              <ChatComposer
                ref={composerRef}
                tabId={tabId}
                disabled={resumingTurn || syncBlocked}
                onSend={send}
                onEmptyChange={onEmptyChange}
              />
              <div className="chat-composer-actions">
                <div className="chat-composer-actions-left">
                  {activeChat?.kind === 'rp' && (
                    <button
                      type="button"
                      className="chat-composer-secondary chat-composer-sprite-toggle"
                      title={spriteStageVisible ? 'Hide character sprites' : 'Show character sprites'}
                      aria-label={spriteStageVisible ? 'Hide character sprites' : 'Show character sprites'}
                      aria-pressed={spriteStageVisible}
                      onClick={() => setSpriteStageVisible((v) => !v)}
                    >
                      <span aria-hidden="true">◐</span>
                    </button>
                  )}
                  {activeChat?.kind !== 'rp' && (
                    <button
                      type="button"
                      className="chat-composer-secondary chat-attach-button"
                      title="Attach a file or image"
                      aria-label="Attach a file or image"
                      disabled={attaching}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <span aria-hidden="true">📎</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="chat-composer-secondary chat-jump-bottom"
                    title="Jump to bottom"
                    aria-label="Jump to bottom"
                    onClick={() => historyRef.current?.scrollTo({ top: historyRef.current.scrollHeight, behavior: 'smooth' })}
                  >
                    <span aria-hidden="true">↓</span>
                  </button>
                </div>
                <div className="chat-composer-actions-right">
                  {activeChat?.kind === 'rp' && (
                    <div className="chat-menu-wrap chat-composer-menu-wrap" ref={chatMenuMobileRef}>
                      <button
                        type="button"
                        className="chat-menu-button chat-composer-secondary"
                        title="Chat menu"
                        aria-label="Chat menu"
                        aria-haspopup="menu"
                        aria-expanded={chatMenuOpen}
                        onClick={() => setChatMenuOpen((v) => !v)}
                      >
                        ⋯
                      </button>
                      {chatMenuOpen && (
                        <div className="chat-menu" role="menu">
                          {chatMenuItems}
                        </div>
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    className={`chat-composer-send chat-send-button${sending || swipeRegenerating ? ' chat-send-stop' : ''}${resendMode() ? ' chat-send-resend' : ''}`}
                    disabled={
                      !sending &&
                      !swipeRegenerating &&
                      !resumingTurn &&
                      !syncBlocked &&
                      (selectionMode ||
                        (!resendMode() && !composerHasText && stagedFiles.length === 0 && stagedImages.length === 0))
                    }
                    title={sending || swipeRegenerating ? 'Stop generating' : resendMode() ? 'Resend your last message' : undefined}
                    aria-label={sending || swipeRegenerating ? 'Stop generating' : resendMode() ? 'Resend your last message' : 'Send message'}
                    onClick={() => (sending || swipeRegenerating ? void stopTurn() : void send())}
                  >
                    <span aria-hidden="true">{sending || swipeRegenerating ? '■' : resendMode() ? '↻' : '↑'}</span>
                  </button>
                </div>
              </div>
            </div>
          </form>
        </div>
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

      {/* The standalone Sync status panel opened from the warning/blocked banner — the same
          ChatSyncStatusPanel the settings rail embeds, remounted as a floating panel with its own
          header (title, refresh, close). Clicking the scrim closes it. */}
      {syncStatusOpen && activeChat && (
        <div
          className="chat-sync-status-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Sync status"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSyncStatusOpen(false);
          }}
        >
          <ChatSyncStatusPanel
            apiKey={apiKey}
            chatId={activeChat.chatId}
            onClose={() => setSyncStatusOpen(false)}
          />
        </div>
      )}

      {restartOpen && activeChat?.cardId && (
        <div
          className="chat-restart-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Restart chat"
          onClick={(e) => {
            // Click on the scrim (not the panel) cancels; the busy flag blocks it mid-restart.
            if (e.target === e.currentTarget && !restarting) setRestartOpen(false);
          }}
        >
          <div className="chat-restart-dialog-panel">
            <div className="chat-restart-dialog-title">Restart this chat?</div>
            <p className="chat-restart-dialog-desc">
              Starts a fresh RP chat with <strong>{activeChat.title}</strong> and opens it. The old
              chat stays in the sidebar unless you delete it below.
            </p>
            <label className="chat-restart-delete-option">
              <input
                type="checkbox"
                checked={restartDeleteOld}
                onChange={(e) => setRestartDeleteOld(e.target.checked)}
                disabled={restarting}
              />
              Delete the old chat
            </label>
            {restartDeleteOld && (
              <p className="chat-restart-warning">
                This permanently deletes the old chat's messages, memory, canon facts and scenes.
              </p>
            )}
            <div className="chat-restart-dialog-actions">
              <button type="button" onClick={() => setRestartOpen(false)} disabled={restarting}>
                Cancel
              </button>
              <button
                type="button"
                className="chat-restart-confirm"
                onClick={restartChat}
                disabled={restarting}
              >
                {restarting ? 'Restarting…' : 'Restart chat'}
              </button>
            </div>
          </div>
        </div>
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
            <ChatSettings
              key={activeChat?.chatId}
              apiKey={apiKey}
              session={activeChat}
              folders={folders}
              allToolNames={allToolNames}
              onOpenLorebooks={onOpenLorebooks}
              refreshToken={messages.length}
              onSave={saveSettings}
              legSettings={legSettings}
              onLegChange={setLegSettings}
            />
          </div>
        )}
      </div>

      {/* Mobile edge-grip fallback for the settings rail. The edge swipe is the primary opener. */}
      <button
        type="button"
        className="edge-grip edge-grip-right mobile-only"
        title="Show chat settings"
        aria-label="Show chat settings"
        onClick={() => setSettingsCollapsed((c) => !c)}
      />
    </div>
  );
}

interface ChatSettingsProps {
  apiKey: string | null;
  session: ChatSessionRow | null;
  folders: Folder[];
  allToolNames: string[];
  /** The lorebook panel's mode-off one-liner link target (App wires this to the Lorebooks tab). */
  onOpenLorebooks?: () => void;
  /** Bumped once per completed chat turn (ChatView's messages.length) — refreshes the lorebook
   *  panel's live activation badges while its set is open. */
  refreshToken: number;
  onSave: (patch: {
    params?: ChatParams;
    tool_names?: string[] | null;
    folder_id?: string | null;
    title?: string;
    cleanup_preset_id?: string | null;
    cleanup_enabled_at?: string | null;
  }) => Promise<void>;
  legSettings: ChatLegibilitySettings | null;
  onLegChange: (next: ChatLegibilitySettings) => void;
}

// session is null until the chat's first message is sent (it's created lazily) — every field
// below just falls back to an empty/default draft in that case. Saving while null hands the
// draft patch back up to ChatView, which applies it right after the chat is actually created.
function ChatSettings({ apiKey, session, folders, allToolNames, onOpenLorebooks, refreshToken, onSave, legSettings, onLegChange }: ChatSettingsProps) {
  const [title, setTitle] = useState(session?.title ?? 'New chat');
  const [system, setSystem] = useState(session?.params.system ?? '');
  const [temperature, setTemperature] = useState(session?.params.temperature?.toString() ?? '');
  const [maxTokens, setMaxTokens] = useState(session?.params.max_tokens?.toString() ?? '');
  const [folderId, setFolderId] = useState(session?.folderId ?? '');
  // null toolNames = all tools allowed (chat-kind only: the RP lane never carries tools — the
  // checklist below is hidden for rp chats and save() omits tool_names for them)
  const [selectedTools, setSelectedTools] = useState<Set<string>>(
    new Set(session?.kind === 'rp' ? [] : (session?.toolNames ?? allToolNames)),
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
  const [modelsError, setModelsError] = useState('');

  useEffect(() => {
    const adminKey = localStorage.getItem(ADMIN_API_KEY_STORAGE_KEY);
    adminListConnections(adminKey)
      .then(setConnections)
      .catch((err) => setModelsError(err instanceof ApiError ? err.message : 'failed to load connections'));
  }, []);

  const activeConnection = connections.find((c) => c.isActive);
  const effectiveConnection = connections.find((c) => c.name === profile) ?? activeConnection;

  // Instruction sets: a personal library of reusable named system-prompt snippets. Picking one
  // copies its content into the System prompt field (chat-kind chats — RP chats have no field, the
  // prompt stack owns the system prompt) — still freely hand-editable there, and not saved until
  // the usual "Save settings" button below is clicked.
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

  // The async heuristic cleanup subloop toggle. Enabled if either the new timestamp switch or a
  // legacy preset id is set (a pre-migration chat that had a cleanup preset is still being
  // cleaned by the inline pass until this is touched — saving the toggle migrates it: enabling
  // clears the legacy preset so the new subloop owns it, disabling turns everything off).
  const [cleanupEnabled, setCleanupEnabled] = useState(
    session?.cleanupEnabledAt != null || session?.cleanupPresetId != null,
  );

  function toggleTool(name: string) {
    const next = new Set(selectedTools);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelectedTools(next);
  }

  async function save() {
    const params: ChatParams = {};
    // RP chats: the prompt stack owns the system prompt (apply_prompt_stack_to_chat persists it
    // server-side) — the drawer never writes params.system for them, same invariant as tool_names
    // below. Chat-kind chats still carry their hand-edited system prompt.
    if (session?.kind !== 'rp' && system.trim()) params.system = system.trim();
    if (temperature.trim() && !Number.isNaN(Number(temperature))) params.temperature = Number(temperature);
    if (maxTokens.trim() && !Number.isNaN(Number(maxTokens))) params.max_tokens = Number(maxTokens);
    if (profile.trim()) params.profile = profile.trim();
    const allSelected = allToolNames.length > 0 && allToolNames.every((t) => selectedTools.has(t));
    await onSave({
      title: title.trim() || session?.title || 'New chat',
      params,
      // RP chats run with no tools at all (server-enforced per turn) — never send a manifest.
      ...(session?.kind === 'rp' ? {} : { tool_names: allSelected ? null : [...selectedTools] }),
      folder_id: folderId || null,
      // The toggle is the only cleanup switch now (RP lane only — the loop scans kind='rp',
      // cleanupLoop.ts): enabled stamps the loop's window at now() (so only messages that land
      // from here on are cleaned — never a retro pass over old history); disabled clears it. The
      // legacy preset id is always cleared alongside — the preset-based inline pass is retired,
      // so a saved toggle migrates the chat off it in whichever direction. Never sent for
      // chat-kind chats — the toggle is disabled there and a Save must not stamp or clear the
      // fields behind its back.
      ...(session?.kind === 'rp'
        ? {
            cleanup_enabled_at: cleanupEnabled ? new Date().toISOString() : null,
            cleanup_preset_id: null,
          }
        : {}),
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="chat-settings">
      <details className="chat-settings-set" open>
        <summary className="chat-settings-set-summary">Title</summary>
        <div className="chat-settings-set-body">
          <input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
      </details>

      {session?.kind === 'rp' && (
        <details className="chat-settings-set" open>
          <summary className="chat-settings-set-summary">Characters</summary>
          <div className="chat-settings-set-body">
            {session && <CastSection apiKey={apiKey} chatId={session.chatId} sceneId={session.sceneId} />}
            <CharacterVisualStateToggle />
          </div>
        </details>
      )}

      <LegibilityMenu settings={legSettings} onChange={onLegChange} />

      <details className="chat-settings-set" open>
        <summary className="chat-settings-set-summary">Connection</summary>
        <div className="chat-settings-set-body">
          <select aria-label="Connection" value={profile} onChange={(e) => setProfile(e.target.value)}>
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
          <span className="model-connection-note">
            {effectiveConnection
              ? `This connection runs on ${effectiveConnection.model} — change it in the Connections tab.`
              : 'No connections configured yet.'}
          </span>
          {modelsError && <div className="error-banner">{modelsError}</div>}
        </div>
      </details>

      {session && (
        <LorebookSet
          apiKey={apiKey}
          session={session}
          refreshToken={refreshToken}
          onOpenLorebooks={onOpenLorebooks}
        />
      )}

      {session?.kind !== 'rp' && (
        <details className="chat-settings-set">
          <summary className="chat-settings-set-summary">Instruction sets</summary>
          <div className="chat-settings-set-body">
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
          </div>
        </details>
      )}

      {session?.kind !== 'rp' && (
        <details className="chat-settings-set" open>
          <summary className="chat-settings-set-summary">System prompt</summary>
          <div className="chat-settings-set-body">
            <textarea aria-label="System prompt" value={system} onChange={(e) => setSystem(e.target.value)} rows={5} placeholder="(none)" />
          </div>
        </details>
      )}

      <details className="chat-settings-set">
        <summary className="chat-settings-set-summary">Async cleanup pass</summary>
        <div className="chat-settings-set-body">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={cleanupEnabled}
              onChange={(e) => setCleanupEnabled(e.target.checked)}
              disabled={session?.kind !== 'rp'}
            />
            <span>Enabled{session?.kind !== 'rp' ? ' (RP chats only)' : ''}</span>
          </label>
          <span className="model-connection-note">
            Strips antislop and repairs the header/footer shapes in the background after each reply
            lands — the original stays available as a swipe. Rules and prompts are configured on the
            Cleanup page.
          </span>
        </div>
      </details>

      <details className="chat-settings-set">
        <summary className="chat-settings-set-summary">Advanced</summary>
        <div className="chat-settings-set-body">
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
        </div>
      </details>

      {session?.kind !== 'rp' && allToolNames.length > 0 && (
        <details className="chat-settings-set">
          <summary className="chat-settings-set-summary">Tools available in this chat</summary>
          <div className="chat-settings-set-body">
            {allToolNames.map((name) => (
              <label key={name} className="tool-item">
                <input type="checkbox" checked={selectedTools.has(name)} onChange={() => toggleTool(name)} />
                {name}
              </label>
            ))}
          </div>
        </details>
      )}

      {session?.kind === 'rp' && (
        <p className="model-connection-note">
          RP chats run with no tools — the model just executes the prompt stack (server-enforced
          per turn). Auto-recall still injects into the stack server-side.
        </p>
      )}

      <div className="settings-actions">
        <button onClick={save}>Save settings</button>
        {saved && <span className="saved-note">Saved.</span>}
      </div>
    </div>
  );
}

// The drawer's collapsible lorebook panel (docs/lorebook-plan.md §8b) — the chat-header 📖
// shortcut used to toggle a standalone sidebar; now the panel is a set in the chat settings
// rail, offered on any chat, not just 'rp'. The panel body is mounted lazily, only while the
// set is open, so a collapsed set never fetches panel data.
function LorebookSet({
  apiKey,
  session,
  refreshToken,
  onOpenLorebooks,
}: {
  apiKey: string | null;
  session: ChatSessionRow;
  refreshToken: number;
  onOpenLorebooks?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="chat-settings-set"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="chat-settings-set-summary">Lorebook</summary>
      {open && (
        <div className="chat-settings-set-body">
          <LorebookPanel
            apiKey={apiKey}
            chatId={session.chatId}
            refreshToken={refreshToken}
            onOpenLorebooks={onOpenLorebooks}
            onClose={() => setOpen(false)}
            embedded
          />
        </div>
      )}
    </details>
  );
}
