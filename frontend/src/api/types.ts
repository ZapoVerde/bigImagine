/* @stamp 2026-08-10 */
/**
 * Hand-written response shapes for bigBrain's tool-call and chat endpoints.
 *
 * There is no machine-readable response contract to generate these from. Each interface below is
 * copied by hand from the corresponding plugin tool handler's `return` statement (file noted per
 * type). If a handler's return shape changes, this file has to be updated by hand too — nothing
 * else will catch the drift.
 */

// plugins/temporal/src/{setTimerTool,listTemporalStateTool}.ts's return shape
export type TimerStatus = 'running' | 'completed' | 'cancelled';

export interface ActiveTimer {
  timerId: string;
  label: string;
  durationSeconds: number;
  endAt: string;
  status: TimerStatus;
}

// plugins/temporal/src/scheduleRoutineTool.ts's return shape
export type ScheduledJobStatus = 'active' | 'completed' | 'cancelled';

export interface ScheduledAlarm {
  jobId: string;
  title: string;
  scheduleKind: 'once' | 'daily';
  timeOfDay: string | null;
  timezone: string;
  status: ScheduledJobStatus;
  nextRunAt: string;
  lastRunAt: string | null;
}

// plugins/temporal/src/listTemporalStateTool.ts's grouped return shape
export interface TemporalState {
  running: ActiveTimer[];
  completed: ActiveTimer[];
  cancelled: ActiveTimer[];
  upcomingAlarms: ScheduledAlarm[];
  recentlyFiredAlarms: ScheduledAlarm[];
}

// orchestrator/src/server/adminServer.ts getNotificationSettings()
export interface NotificationSettings {
  serverUrl: string | null;
  enabled: boolean;
}

// orchestrator/src/server/adminServer.ts getScreenLockSettings() — password === '' means the
// idle-lock overlay is disabled.
export interface ScreenLockSettings {
  password: string;
  timeoutMinutes: number;
}

// orchestrator/src/server/adminServer.ts getPersonaSettings() — '' means never set.
export interface PersonaSettings {
  name: string;
  description: string;
}

// orchestrator/src/server/openai.ts buildChatCompletion()
export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: { index: number; message: { role: string; content: string }; finish_reason: string }[];
}

// The streaming abort/error terminal frame (docs/plans/completed/rp-streaming-plan.md Contracts): one extra
// `data: ...` line sent before [DONE], only when the in-flight stream is aborted (Stop button /
// dropped client) or fails after the SSE headers already committed (so an HTTP status change is
// no longer possible). Never present on a successful stream — an OpenAI-compatible client that has
// never heard of this field simply never sees it. The stream does not end at this frame; [DONE]
// still follows, so the caller resolves on [DONE] either way and decides what to show.
export interface StreamingTerminalFrame {
  bigimagine_error: true;
  aborted: boolean;
  message: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

// orchestrator/src/server/handleUploadAttachment.ts's extractAttachmentUpload() response shape.
// Held only in the composer's local state until sent — never persisted server-side (see
// orchestrator/src/util/attachmentContext.ts's own preamble).
export interface StagedAttachment {
  filename: string;
  mimeType: string;
  markdown: string;
  truncated: boolean;
  meta: { totalChars: number; totalLines: number };
}

// A staged image, client-encoded — never goes through POST /v1/attachments/extract (there's
// nothing to extract; see orchestrator/src/io/attachments/dispatchExtraction.ts's own preamble).
// mimeType/base64 are the wire shape orchestrator/src/server/openai.ts's IncomingImage expects;
// previewUrl (an object URL, revoked on removal) is purely local, never sent to the server.
export interface StagedImage {
  filename: string;
  mimeType: string;
  base64: string;
  previewUrl: string;
}

// orchestrator/src/io/providerCredentials.ts CredentialSummary
export interface CredentialSummary {
  name: string;
  configured: boolean;
  updatedAt: string | null;
}

// orchestrator/src/io/llmConnections.ts LlmConnectionRow — the Connections tab's list/detail shape.
// No apiKey field at all (write-only by construction, same as CredentialSummary above) — a
// connection always has one set (required at creation), so there's no "configured" state to track.
export interface LlmConnectionSummary {
  id: string;
  name: string;
  kind: 'anthropic' | 'openai-compatible';
  model: string;
  baseUrl: string | null;
  supportsVision: boolean;
  providerOrder: string[] | null;
  allowFallbacks: boolean;
  quantizations: string[] | null;
  /** USD per 1M tokens (Prompt Inspector cost receipt) — undefined = not configured, so the
   *  inspector shows token counts only, never a fabricated $0.00. */
  priceInputPerMillion?: number;
  priceOutputPerMillion?: number;
  priceCacheHitPerMillion?: number;
  isActive: boolean;
  updatedAt: string;
}

// orchestrator/src/server/adminServer.ts parseCreateConnectionBody's expected shape (LlmConnectionInit)
// — exactly one of apiKey/copyApiKeyFrom must be sent: a fresh key, or reuse an existing
// connection's (by id) instead of re-pasting the same key into every connection that shares one
// underlying provider.
export interface CreateConnectionInput {
  name: string;
  kind: 'anthropic' | 'openai-compatible';
  model: string;
  apiKey?: string;
  copyApiKeyFrom?: string;
  baseUrl?: string;
  supportsVision?: boolean;
  providerOrder?: string[];
  allowFallbacks?: boolean;
  quantizations?: string[];
  /** USD per 1M tokens (Prompt Inspector cost receipt) — omit to leave unconfigured. */
  priceInputPerMillion?: number;
  priceOutputPerMillion?: number;
  priceCacheHitPerMillion?: number;
}

// orchestrator/src/server/adminServer.ts parseUpdateConnectionBody's expected shape
// (LlmConnectionPatch) — every field optional (a PATCH); baseUrl/providerOrder/quantizations
// additionally accept null to explicitly clear a previously-set value.
export interface UpdateConnectionInput {
  name?: string;
  model?: string;
  /** Omit to leave the stored key untouched — only send when actually rotating it. Mutually exclusive with copyApiKeyFrom. */
  apiKey?: string;
  /** Rotate by copying another connection's key instead of typing one. Mutually exclusive with apiKey. */
  copyApiKeyFrom?: string;
  baseUrl?: string | null;
  supportsVision?: boolean;
  providerOrder?: string[] | null;
  allowFallbacks?: boolean;
  quantizations?: string[] | null;
  /** USD per 1M tokens — omit to leave the stored price untouched, null to explicitly clear it
   *  (same three-state convention baseUrl uses). */
  priceInputPerMillion?: number | null;
  priceOutputPerMillion?: number | null;
  priceCacheHitPerMillion?: number | null;
}

// orchestrator/src/server/adminServer.ts ProfileModelsResult
export interface ProfileModelsResult {
  models: { id: string; pricing?: { prompt: string; completion: string } }[];
  defaultModel: string;
}

// orchestrator/src/server/adminServer.ts ModelProvidersResult — OpenRouter-only routing table
export interface ModelProvidersResult {
  providers: { name: string; tag: string; pricing?: { prompt: string; completion: string } }[];
}

// orchestrator/src/server/adminServer.ts ConnectionTestResult — a real, capped-tokens round trip
// through one saved connection. ok: false means the call reached the route fine but the provider
// call itself failed (bad key/model/baseUrl) — not a thrown error, since that's the point of the
// button.
export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  reply?: string;
  error?: string;
}

// orchestrator/src/io/imageConnections.ts ImageConnectionRow — the Connections tab's image section
// list/detail shape. No apiKey field (write-only, same as LlmConnectionSummary); hasApiKey instead,
// since a local comfyui endpoint legitimately has none (every cloud provider requires one).
export interface ImageConnectionSummary {
  id: string;
  name: string;
  kind: 'runware' | 'fal-ai' | 'pollinations' | 'comfyui' | 'openai-images';
  model: string;
  hasApiKey: boolean;
  baseUrl: string | null;
  width: number;
  height: number;
  samplingSteps: number;
  cfgScale: number;
  samplerName: string | null;
  masterPositiveStylePrefix: string | null;
  masterNegativePrompt: string | null;
  workflowParameters: Record<string, unknown> | null;
  isActive: boolean;
  updatedAt: string;
  /** migration 0105: 'background' (the Vistalyze location renders) or 'portrait' (the Portrait
   *  Studio's candidate renders) — the active row is enforced per purpose, one each. */
  purpose: 'background' | 'portrait';
}

// orchestrator/src/server/adminServer.ts parseCreateImageConnectionBody's expected shape
// (ImageConnectionInit) — apiKey is optional: keyless providers need none (endpoint.md §2.1).
export interface CreateImageConnectionInput {
  name: string;
  kind: ImageConnectionSummary['kind'];
  model: string;
  apiKey?: string;
  baseUrl?: string;
  width?: number;
  height?: number;
  samplingSteps?: number;
  cfgScale?: number;
  samplerName?: string;
  masterPositiveStylePrefix?: string;
  masterNegativePrompt?: string;
  workflowParameters?: Record<string, unknown>;
  /** Defaults to 'background' when omitted. */
  purpose?: 'background' | 'portrait';
}

// orchestrator/src/server/adminServer.ts parseUpdateImageConnectionBody's expected shape
// (ImageConnectionPatch) — every field optional; string/jsonb fields accept null to explicitly
// clear a previously-set value.
export interface UpdateImageConnectionInput {
  name?: string;
  kind?: ImageConnectionSummary['kind'];
  model?: string;
  /** Omit to leave the stored key untouched — only send when actually rotating it. */
  apiKey?: string;
  baseUrl?: string | null;
  width?: number;
  height?: number;
  samplingSteps?: number;
  cfgScale?: number;
  samplerName?: string | null;
  masterPositiveStylePrefix?: string | null;
  masterNegativePrompt?: string | null;
  workflowParameters?: Record<string, unknown> | null;
  /** Omit to leave the connection's purpose unchanged. */
  purpose?: 'background' | 'portrait';
}

// orchestrator/src/server/adminServer.ts ImageConnectionTestResult — endpoint.md §3.3's diagnostic
// probe through one saved image connection.
export interface ImageConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  imageUrl?: string;
  /** The exact synthesized positive prompt sent to the provider — surfaced so the admin sees what
   *  the connection will actually render (parallax_fade_teststep.md §4.2, bi_principles §17). */
  prompt?: string;
  error?: string;
}

/** orchestrator/src/server/adminServer.ts ChatBackgroundSettings — parallax_fade_teststep.md §2.2
 *  + migration 0073: the ChatView location-background controls (parallax pan toggle, the dimming
 *  veil over the location image, and the bubble fill). Stored as text in orchestrator_settings;
 *  defaults when unset: parallax false, veil 0.5 '#000000', bubbles 0.7 '#4f46e5'/'#26272c' (the
 *  dark-theme colors). ChatView applies them as CSS custom properties at chat load. */
export interface ChatBackgroundSettings {
  parallaxEnabled: boolean;
  /** 0..1 — the veil's strength over the location background (default 0.5). */
  overlayOpacity: number;
  /** '#rrggbb' — the veil's color (default '#000000'). */
  overlayShade: string;
  /** 0..1 — bubble background alpha (default 0.7). */
  bubbleOpacity: number;
  /** '#rrggbb' — user bubble fill (default '#4f46e5'). */
  bubbleUserShade: string;
  /** '#rrggbb' — assistant bubble fill (default '#26272c'). */
  bubbleAssistantShade: string;
}

/** orchestrator/src/server/adminServer.ts ChatLegibilitySettings — migration 0074: the ChatView
 *  "Text legibility" toggles (opt-in text-rendering tricks for prose on translucent bubbles over
 *  the location background). Stored as text 'true'/'false'; default false when unset (opt-in, so
 *  an untouched install keeps the built-in look). Household-wide: one set applies to every chat.
 *  ChatView applies them as data-legibility tokens on the chat view root; the menu in the chat
 *  settings rail POSTs each toggle immediately (admin-gated), no Save button. */
export interface ChatLegibilitySettings {
  /** text-shadow halo ring around bubble prose (subtitle-renderer trick). */
  halo: boolean;
  /** 0..1 — the halo ring's intensity (migration 0075), default 0.6 when unset; the menu's
   *  slider under the Letter halo toggle. Applied as a color-mix percentage over the per-theme
   *  halo colors, so 0 = invisible ring, 1 = the full-force ring. */
  haloStrength: number;
  /** crisp 0.5px -webkit-text-stroke on quoted dialogue, headings, <summary>. */
  outline: boolean;
  /** solid near-black code chips + <pre> blocks with light text. */
  solidCode: boolean;
  /** font-weight 500 on em/i, blockquotes, and pending bubbles' muted text. */
  weightBump: boolean;
  /** hovering a bubble raises its fill opacity to 92% just for that message. */
  hoverFocus: boolean;
}

/** A partial update — every field optional, at least one present. */
export interface ChatLegibilitySettingsPatch {
  halo?: boolean;
  haloStrength?: number;
  outline?: boolean;
  solidCode?: boolean;
  weightBump?: boolean;
  hoverFocus?: boolean;
}

// orchestrator/src/server/adminServer.ts ImageSettings — the master image prompt template
// (endpoint.md §2.2), the location-describer prompt + history-pairs knob (describer.md, migration
// 0078); '' means "use the built-in default" (bi_principles.md §17).
export interface ImageSettings {
  template: string;
  templateIsDefault: boolean;
  describerPrompt: string;
  describerPromptIsDefault: boolean;
  describerHistoryPairs: string;
}

// GET /v1/admin/location-settings — the Locations page's unified tracker settings (location.md
// §6.3): the split/injection toggles, the known-locations block prompt, and the room describer's
// prompt/history-pairs (moved here from the Backgrounds page, migration 0083; the image-settings
// endpoint still accepts the describer_* patch keys for back-compat).
export interface LocationSettings {
  splitEnabled: boolean;
  injectionEnabled: boolean;
  injectionPrompt: string;
  injectionPromptIsDefault: boolean;
  describerPrompt: string;
  describerPromptIsDefault: boolean;
  describerHistoryPairs: string;
}

// GET /v1/admin/character-settings — the Settings tab's Character-describer settings
// (rp-cast-infrastructure-plan.md A4): the character-describer LLM pass's prompt/history-pairs,
// mirroring LocationSettings' describer pair. describerPrompt is always the effective prompt —
// the built-in default when the stored value is empty (bi_principles.md §17) — with
// describerPromptIsDefault flagging which one it is; describerHistoryPairs is the stored raw
// string ('' = default), integer-as-text, default '1'.
export interface CharacterSettings {
  describerPrompt: string;
  describerPromptIsDefault: boolean;
  describerHistoryPairs: string;
}

// GET /v1/admin/locations — one row of the Locations page's read-only known-locations browser
// (location.md §6.2.4): the location with its parent place (via parent_location_id) and its
// lifecycle status.
export interface LocationAdminRow {
  locationId: string;
  userId: string;
  name: string;
  parentName: string | null;
  status: string | null;
  imageUrl: string | null;
  updatedAt: string;
  // db/migrations/0096's location_chat_links — the chat(s) this row is currently linked to. Always
  // [] for a user-authored row (status null); an auto-registered row disappears from this list
  // entirely (the cleanup trigger deletes it) once its last chat link is gone.
  chatTitles: string[];
}

// orchestrator/src/io/chatSessions.ts — persisted chat sessions
export interface ChatParams {
  system?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  model?: string;
  /** Which admin-managed connection (LlmConnectionSummary.name) this chat uses, overriding the
   *  household's active one. Unset means "use whichever connection is active". */
  profile?: string;
}

export interface ChatSummary {
  chatId: string;
  title: string;
  folderId: string | null;
  updatedAt: string;
}

export interface ChatSessionRow {
  chatId: string;
  title: string;
  folderId: string | null;
  params: ChatParams;
  toolNames: string[] | null;
  /** Canvas: the note this chat's document panel is focused on, if any. */
  canvasNoteId: string | null;
  /** Set only on a forked chat — the chat it branched from. */
  parentChatId: string | null;
  /** Set only on a forked chat — the parent's message id it branched from. */
  forkMessageId: string | null;
  /** Set once, explicitly, via the Archive action — null means still ongoing. */
  archivedAt: string | null;
  /** Set once at creation, never changed afterward. An 'rp' chat gets no household_memory
   *  read/write and runs with no tools at all (DEFAULT_RP_TOOLS = [], 2026-08-10 — the RP
   *  model just executes its prompt stack) — see orchestrator/src/io/chatSessions.ts; the
   *  server re-enforces zero tools per rp turn regardless of this column. */
  kind: 'chat' | 'rp';
  /** Which character this chat is playing, if any — set by apply_character_to_chat. */
  characterId: string | null;
  /** The scene_id cache pointer (segway.md §2.2) — which scene this chat's story currently
   *  stands in, stamped by the post-turn scraper. Backend has always sent it (chatSessions.ts's
   *  toSessionRow); the frontend type just never surfaced it — the RP sidebar's Cast section
   *  (rp-cast-infrastructure-plan.md Part C) matches get_scenes' returned scene rows against it
   *  to read the active scene's presence. Null when no turn has landed a header yet. */
  sceneId: string | null;
  /** The last context_stack_presets row applied via apply_prompt_stack_to_chat, if any. */
  promptStackPresetId: string | null;
  /** The retired preset-based cleanup pass's per-chat preset id — the inline runCleanupPass is
   *  gone (migration 0072, orchestrator/cleanupLoop.ts); the async heuristic subloop is opted in
   *  via cleanupEnabledAt below instead. Column deliberately left in place, unread.
   *  @deprecated superseded by cleanupEnabledAt; nothing new reads this. */
  cleanupPresetId: string | null;
  /** When this chat opted into the async heuristic cleanup subloop (migration 0072): the RP-only
   *  background pass that strips antislop and repairs the header/footer regex shapes after a
   *  reply lands. A timestamp, not a bool — the subloop only processes messages created after
   *  this stamp, so enabling never re-processes old history. Null = cleanup off. */
  cleanupEnabledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// orchestrator/src/server/adminServer.ts getChatMemorySettings() + httpServer.ts's route handler
// (which attaches profileNames from deps.llmConnections.list()).
export interface ChatMemorySettings {
  profile: string | null;
  profileNames: string[];
  liveWindowPairs: number | null;
  syncEveryPairs: number | null;
  digestHorizonPairs: number | null;
  // Chunk size in turn-pairs (migration 0099, docs/plans/completed/chunk-size-resize-plan.md) — read live
  // by the sync tick, the eager path, the recall decay SQL, and the admin-triggered re-chunk
  // backfill (orchestrator/chatChunkResize.ts). null = unset (built-in default of 2 pairs = the
  // classic 4-message chunk); a saved value only affects NEW chunks — existing archives keep
  // their old size until the resize backfill re-chunks them.
  chunkPairs: number | null;
  chunkSummaryPrompt: string;
  chunkSummaryPromptIsDefault: boolean;
  distillPrompt: string;
  distillPromptIsDefault: boolean;
  householdMemoryPrompt: string;
  householdMemoryPromptIsDefault: boolean;
  bridgePrompt: string;
  bridgePromptIsDefault: boolean;
  worldCuratorPrompt: string;
  worldCuratorPromptIsDefault: boolean;
  peopleCuratorPrompt: string;
  peopleCuratorPromptIsDefault: boolean;
  injectBridgePrompt: string;
  injectBridgePromptIsDefault: boolean;
  injectPlotPrompt: string;
  injectPlotPromptIsDefault: boolean;
  injectAutoRecallPrompt: string;
  injectAutoRecallPromptIsDefault: boolean;
  injectRecentHistoryPrompt: string;
  injectRecentHistoryPromptIsDefault: boolean;
  autoRecallChunkPrompt: string;
  autoRecallChunkPromptIsDefault: boolean;
  // Lead-in window (migration 0100, docs/plans/chunk-lead-in-context-plan.md) — how many
  // preceding chunks' summaries ride along with each recalled chunk (recallForPrompt.ts merges
  // them before injection; 0 disables; null = unset, built-in default 2, capped at 3), plus the
  // per-entry template those summaries render under in the narrator stack (empty = the built-in
  // '[Just before: {{text}}]').
  autoRecallLeadInChunks: number | null;
  autoRecallLeadInPrompt: string;
  autoRecallLeadInPromptIsDefault: boolean;
  // Sync-summaries component (migration 0104, docs/plans/completed/sync-summaries-plan.md) — the
  // unconditional open-sync-point section between bridge and recent_history: the outer wrapper
  // (mirrors injectAutoRecallPrompt's shape) and the per-entry bare-summary template (its own
  // setting — lead-ins stay reserved for auto_recall's deep-archive picks). Empty = the
  // built-in default, same contract as the other prompt fields.
  injectSyncSummariesPrompt: string;
  injectSyncSummariesPromptIsDefault: boolean;
  syncSummaryEntryPrompt: string;
  syncSummaryEntryPromptIsDefault: boolean;
  autoRecallEnabled: boolean;
  autoRecallPairs: number | null;
  autoRecallChunkTopK: number | null;
  // RAG dynamic-cutoff knobs (migration 0091, orchestrator io/chatMemory/recallCutoff.ts) —
  // autoRecallChunkTopK above is the Max ceiling; these are the Min floor, the Pool Multiple P,
  // and the strictness mode in raw-distance space where lower is better.
  autoRecallMin: number | null;
  autoRecallPoolMultiple: number | null;
  autoRecallCutoffMode: 'mean' | 'mean+1sd' | 'mean+2sd' | null;
  // Ranked plot-arc lane knobs (migration 0097, orchestrator io/chatMemory/recallPlotLane.ts) —
  // plotRecallTopK is the Max ceiling for per-arc cards (default 6), plotRecallMin the Min floor
  // (default 1), plotRecallFloorSyncs the recency floor (default 2: an arc touched in the chat's
  // last N sync ticks stays visible regardless of score).
  plotRecallTopK: number | null;
  plotRecallMin: number | null;
  plotRecallFloorSyncs: number | null;
}

// orchestrator/src/server/adminServer.ts getCanonSettings() — the Canonize feature's knobs:
// recallTopK (how many canon facts the recall_canon_facts tool / the RP auto-recall inject, read
// live on every recall call, no restart) and extractionPrompt (the background extraction pass's
// template — "default + bespoke" override per bi_principles.md §17, empty clears to built-in).
// Since migration 0092 (rag-dynamic-cutoff-plan.md Stage 2) recallTopK doubles as the fact
// lane's per-channel Max for the dynamic cutoff, with recallMin (canon_recall_min, default 2)
// as its Min floor; both are read live by buildAutoRecallParts.
export interface CanonSettings {
  recallTopK: number;
  recallMin: number | null;
  extractionPrompt: string;
  extractionPromptIsDefault: boolean;
}

// orchestrator/src/server/adminServer.ts getLorebookSettings() — the Lorebook plan's §3d knobs
// (docs/lorebook-plan.md). lorebookTokenBudget null = unlimited; lorebookMode default off (§2);
// lorebookRecursionEnabled's row exists but is deliberately unread (§9). resolveLorebook reads
// these live every turn, so saves take effect immediately.
export interface LorebookSettings {
  lorebookMode: 'on' | 'off';
  lorebookModeIsDefault: boolean;
  lorebookTokenBudget: number | null;
  lorebookTokenBudgetIsDefault: boolean;
  lorebookRecallTopK: number;
  lorebookRecallTopKIsDefault: boolean;
  lorebookRecursionEnabled: boolean;
  lorebookRecursionEnabledIsDefault: boolean;
}

// orchestrator/src/server/adminServer.ts getLorebooksAdmin() — the Lorebooks page's library rows.
// Books are user-scoped; the admin list is cross-user (each row carries its owning userId, which
// the write endpoints echo back so the update/delete runs under that user's RLS scope).
export interface LorebookEntryAdminRow {
  entryId: string;
  uid: number;
  key: string[];
  comment: string;
  content: string;
  constant: boolean;
  disable: boolean;
  orderValue: number;
  probability: number;
  useProbability: boolean;
  groupName: string;
  groupWeight: number;
  groupOverride: boolean;
  sticky: number;
  cooldown: number;
  delay: number;
  updatedAt: string;
}

export interface LorebookAdminRow {
  lorebookId: string;
  userId: string;
  name: string;
  globalScope: boolean;
  createdAt: string;
  updatedAt: string;
  characterIds: string[];
  chatOverrideCount: number;
  entries: LorebookEntryAdminRow[];
}

// orchestrator/src/io/lorebook/panelData.ts — the chat-sidebar Lorebook panel (plan §8b),
// user-scoped. Books in scope for the chat (§3b: global_scope, character links, or an enabled
// chat override; an explicit enabled=false override beats every path), each with all its
// entries — not the top-K recall set, the panel browses whole books. entryOverrideEnabled null =
// no per-entry chat override. activatedInLatestTurn = present in lorebook_activation_log for the
// chat's latest assistant message (§8b's live activation badge). mode is the resolved global
// §3d setting (modeIsDefault = unset) — the panel swaps to its mode-off one-liner when off.
export interface LorebookPanelEntry {
  entryId: string;
  uid: number;
  key: string[];
  comment: string;
  content: string;
  constant: boolean;
  disable: boolean;
  orderValue: number;
  probability: number;
  useProbability: boolean;
  groupName: string;
  groupWeight: number;
  groupOverride: boolean;
  sticky: number;
  cooldown: number;
  delay: number;
  entryOverrideEnabled: boolean | null;
  activatedInLatestTurn: boolean;
}

export interface LorebookPanelBook {
  lorebookId: string;
  name: string;
  globalScope: boolean;
  characterLinked: boolean;
  chatOverrideEnabled: boolean | null;
  entries: LorebookPanelEntry[];
}

export interface LorebookPanelData {
  mode: 'on' | 'off';
  modeIsDefault: boolean;
  books: LorebookPanelBook[];
}

// orchestrator/src/server/adminServer.ts getChatMemorySyncStatus() — one row per chat, the
// review panel's confirmation that the background sync loop (chunk/embed/distill) actually ran,
// not an editing surface (that's CanonQueueView, for canon facts specifically).
export interface ChatMemorySyncStatusRow {
  chatId: string;
  chatTitle: string;
  lastAttemptAt: string;
  lastStatus: 'ok' | 'skipped' | 'error';
  lastStep: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  lastChunksAdded: number | null;
  lastEntriesUpdated: number | null;
  consecutiveErrors: number;
  canonProposedCount: number;
  canonApprovedCount: number;
  canonLastProposedAt: string | null;
}

// orchestrator/src/orchestrator/chatChunkResize.ts getChatChunkResizeStatus() — the singleton
// progress row of the admin-triggered chunk-size backfill (docs/plans/completed/chunk-size-resize-plan.md).
// status: 'idle' before any pass / 'running' while one is live (chatsDone/chatsTotal advance per
// chat) / 'done' or 'error' when it finished; error carries the failure message when status is
// 'error'. GET /v1/admin/chat-memory-resize-status wraps it as { resize: ChunkResizeStatus }.
export interface ChunkResizeStatus {
  status: 'idle' | 'running' | 'done' | 'error';
  chatsTotal: number;
  chatsDone: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

/** GET /v1/admin/location-render-status — the Backgrounds tab's proof-it-ran table
 *  (orchestrator/src/server/adminServer.ts getLocationRenderStatus): one row per
 *  recently-touched location with which bg-gen pipeline stages actually completed. The row's
 *  booleans map directly to the pipeline (endpoint.md §5): described = visual_description
 *  non-empty (the describer / name seed), defined = definition non-empty (describer's Definition
 *  half, migration 0078), rendered = image_url present (generateLocationImage.ts wrote one),
 *  hasRenderHash = the cache-validation key (migration 0076) is present. status is the segway
 *  status (migration 0067: transient / permanent / inactive). */
export interface LocationRenderStatusRow {
  locationId: string;
  name: string;
  status: string | null;
  described: boolean;
  defined: boolean;
  rendered: boolean;
  hasRenderHash: boolean;
  imageGeneratedAt: string | null;
  updatedAt: string;
}

// GET /v1/chats/:id/sync-status — one chat's slice of the rolling sync loop's status record
// (orchestrator/src/io/chatSessions.ts getChatSyncStatus), the RP chat header menu's "Sync
// status" panel. Same field set as the admin Review Panel's row minus the chat-identifying
// columns, plus the unsynced-vs-due message counts so the panel can say when the next tick will
// actually do something. lastStatus is null until the chat has had its first sync attempt.
export interface ChatSyncSummary {
  syncId: string;
  ordinal: number;
  createdAt: string;
  entryCount: number;
  factCount: number;
}

export interface ChatSyncInspection {
  syncId: string;
  ordinal: number;
  createdAt: string;
  lastMessageId: string;
  bridgePrompt: string | null;
  entries: { topicKey: string; content: string; updatedAt: string }[];
  canonFacts: {
    factId: string;
    category: string;
    arcTag: string | null;
    entityKey: string | null;
    summary: string;
    detail: string;
    status: string;
  }[];
}

export interface ChatSyncStatus {
  lastAttemptAt: string | null;
  lastStatus: 'ok' | 'skipped' | 'error' | null;
  lastStep: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  lastChunksAdded: number | null;
  lastEntriesUpdated: number | null;
  consecutiveErrors: number;
  canonProposedCount: number;
  canonApprovedCount: number;
  canonLastProposedAt: string | null;
  unsyncedMessages: number;
  dueAfterMessages: number;
  /** Every sync point this chat has produced, newest first — the "click a sync and play it
   *  back" list. Summary-only; the per-sync detail is fetched on demand (getChatSyncInspection). */
  syncs: ChatSyncSummary[];
}

// GET /v1/cleanup/status — the async cleanup subloop's per-chat read surface (cleanupLoop.ts's
// CleanupStatus), polled by the floating chat status pills. Per-region pill states on the newest
// eligible message (in-stream-cleanup-plan.md): each region is not-called (nothing needed fixing),
// in-flux (a repair is in flight — the loop is working, or the live path is streaming), deployed
// (a repair actually changed the text), or flagged (a repair was needed but produced nothing /
// errored). enabled:false means the chat is not opted in (or not RP / archived) — the pills
// render nothing, not fake 'not-called' states.
export type CleanupRegionState = 'not-called' | 'in-flux' | 'deployed' | 'flagged';
export interface CleanupStatus {
  enabled: boolean;
  pending: number;
  latest: {
    messageId: string;
    regions: {
      header: { state: CleanupRegionState };
      body: { state: CleanupRegionState };
      footer: { state: CleanupRegionState };
    };
  } | null;
}

// The live in-stream cleanup SSE frames (in-stream-cleanup-plan.md Contracts), interleaved with
// the content-delta chunks and never a normal content chunk nor [DONE] — an OpenAI-compatible
// client that has never heard of these fields simply never sees them (the same additive contract
// bigimagine_error established). A status frame reports one region's pill state; a patch frame
// carries a content splice — start/end are character offsets into the text accumulated via onDelta
// so far (raw deltas plus every patch already applied, in the same order both sides applied them).
export interface CleanupStatusFrame {
  bigimagine_cleanup: true;
  region: 'header' | 'body' | 'footer';
  state: CleanupRegionState;
}
export interface CleanupPatchFrame {
  bigimagine_patch: true;
  region: 'header' | 'body' | 'footer';
  start: number;
  end: number;
  replacement: string;
}

// The live reasoning-block SSE frame (docs/plans/reasoning-blocks-plan.md Contracts), interleaved
// with the content-delta chunks exactly like the cleanup frames and never a normal content chunk
// nor [DONE] — same additive contract (a client that has never heard of the field never sees it).
// A reasoning frame carries one slice of the model's accumulated reasoning span (the text between
// the configured open/close tag pair), relayed in arrival order; `delta` is append-only — the
// client's reasoning buffer for the turn is the concatenation of every delta so far, and the
// finished span is also returned via the persisted message's `reasoning` field (present only when
// the turn produced a span).
export interface ReasoningFrame {
  bigimagine_reasoning: true;
  delta: string;
}

// GET /v1/cleanup/jobs — one chat's recent cleanup activity (cleanupLoop.ts's CleanupJobInfo),
// the Cleanup page's "recently cleaned / flagged" list. status is the job's fail-open outcome;
// notes carries what changed / why it was flagged; preview is the first ~120 chars of the
// message content.
export interface CleanupJob {
  jobId: string;
  messageId: string;
  status: 'done' | 'flagged' | 'error';
  changed: boolean;
  notes: string | null;
  createdAt: string;
  finishedAt: string | null;
  preview: string;
}

// GET/POST /v1/admin/cleanup-settings — the Cleanup page's setup block (adminServer.ts's
// CleanupSettings): the header/footer trigger regex + repair prompt ("the format expressed as a
// prompt") plus the full slop-rules table. POST sends the whole edited set; slop rules are a
// full-set replace.
export type SlopAction = 'remove' | 'replace-paragraph' | 'llm';
export interface SlopRule {
  ruleId: string;
  setName: string;
  position: number;
  pattern: string;
  flags: string;
  action: SlopAction;
  replacement: string | null;
  llmPrompt: string | null;
  enabled: boolean;
}
export interface CleanupSettings {
  headerRegex: string;
  headerPrompt: string;
  footerRegex: string;
  footerPrompt: string;
  slopRules: SlopRule[];
  /** The reasoning-block tag pair (docs/plans/reasoning-blocks-plan.md): the open/close markers
   *  whose wrapped span a reply is classified as reasoning (defaults '<think>' / '</think>',
   *  which liveReasoning.ts falls back to when a key is unset). Either one blank = detection
   *  disabled — the same empty-override meaning the header regex carries. Read live at the
   *  start of every RP streaming turn, so a save takes effect on the very next turn. */
  reasoningOpenTag: string;
  reasoningCloseTag: string;
}

export interface StoredChatMessage {
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  /** Display-only macro-resolved copy of `content` (docs/plans/prompt-macros.md's Stage 1) — attached
   *  server-side for 'rp' chats whose stored text contains {{...}} tokens (chiefly a character's
   *  seeded greeting). Render this when present; always re-send `content` (verbatim) so the
   *  per-turn resolution pass keeps resolving against the live persona. */
  resolvedContent?: string;
  /** Present only once this message has been regenerated at least once (swipe capability on the
   *  last LLM response). index is its current position among stored variants (0-based); count is
   *  how many exist. Undefined means never swiped — content is the only version. */
  swipes?: { index: number; count: number };
  /** The turn's reasoning block (docs/plans/reasoning-blocks-plan.md): the de-tagged span between
   *  the configured open/close tag pair, persisted by the server when the turn produced one.
   *  Present only then (absent = no span, never an empty string) — the message never renders the
   *  tags themselves. Follows its message: each swipe variant carries its own reasoning, and an
   *  edit to `content` clears it (the de-tagged span no longer corresponds to the edited text). */
  reasoning?: string;
}

export interface ChatDetail {
  session: ChatSessionRow;
  messages: StoredChatMessage[];
}

// GET /v1/chats/:id/lineage's node shape — the Branch Map panel's data source. Deliberately
// narrower than ChatSessionRow (no params/toolNames/etc.) since the panel only ever renders
// title/status/relationships, never a chat's actual settings.
export interface ChatLineageNode {
  chatId: string;
  title: string;
  folderId: string | null;
  parentChatId: string | null;
  forkMessageId: string | null;
  archivedAt: string | null;
  kind: 'chat' | 'rp';
  createdAt: string;
  updatedAt: string;
}

export interface Folder {
  folderId: string;
  name: string;
  parentId: string | null;
}

export type NoteState = 'active' | 'pinned' | 'archived';

// plugins/notes/src/getNotesTool.ts
export interface NoteSummary {
  noteId: string;
  title: string;
  state: NoteState;
  updatedAt: string;
}

// plugins/notes/src/getNoteTool.ts, updateNoteTool.ts
export type NoteDetailResult =
  | { found: false; noteId: string }
  | {
      found: true;
      noteId: string;
      title: string;
      content: string;
      tags: string[];
      state: NoteState;
      reminderAt: string | null;
      createdAt?: string;
      updatedAt: string;
    };

// plugins/notes/src/createNoteTool.ts
export interface CreateNoteResult {
  noteId: string;
  title: string;
  content: string;
  reminderAt: string | null;
}

// plugins/notes/src/deleteNoteTool.ts
export interface DeleteNoteResult {
  deleted: boolean;
}

// plugins/documents/src/saveDocumentTool.ts
export interface SaveDocumentResult {
  docId: string;
  title: string;
  filePath: string;
  summaryShort: string;
  commitSha: string;
}

// plugins/documents/src/listDocumentsTool.ts
export interface DocumentSummary {
  docId: string;
  title: string | null;
  summaryShort: string | null;
  status: string;
  updatedAt: string;
}

// plugins/documents/src/getDocumentTool.ts
export type DocumentDetailResult =
  | { found: false; docId: string }
  | {
      found: true;
      docId: string;
      title: string;
      content: string;
      summaryShort: string | null;
      status: string;
      updatedAt: string;
      sourceUrl: string | null;
      siteName: string | null;
      author: string | null;
      publishedAt: string | null;
    };

// plugins/prompt-presets/src/getPromptPresetsTool.ts — a reusable named system-prompt snippet
// ("instruction set"), applied by copying .content into a chat's own params.system.
export interface PromptPreset {
  presetId: string;
  name: string;
  content: string;
  updatedAt: string;
}

// orchestrator/src/server/httpServer.ts's buildPromptPreview (GET /v1/chats/:id/prompt-preview) —
// the exact, itemized prompts an 'rp' chat fires, for the Prompt Inspector panel.
export interface PromptPreviewItem {
  /** Raw MarkerKey (assemblePromptStack.ts) when this item came from a preset's marker slot —
   *  undefined for a custom slot, the date-context line, or a conversation message. Map to a
   *  friendly name via markerLabels.ts's markerLabel(). */
  markerKey?: string;
  /** A custom slot's own cosmetic label (migration 0060), when set. */
  label?: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  chars: number;
  /** ~4 chars/token estimate — not a real per-provider tokenizer (bi_principles.md §6). */
  estimatedTokens: number;
}

/** One prompt this chat fires: the main turn prompt (captured at send time — the exact text the
 *  last turn sent; only a live next-turn reconstruction when no capture exists yet) or a captured
 *  background prompt (cleanup pass, title generation, … — io/promptTrace.ts records the exact
 *  text at send time, since those aren't reconstructable from persisted state afterwards). */
export interface PromptPreviewGroup {
  /** Stable kind tag: 'main', 'cleanup', 'title', … */
  kind: string;
  /** Human heading, e.g. 'Main Prompt' / 'Cleanup Prompt'. */
  title: string;
  /** True = actual text fired during a turn; false = live reconstruction of the next turn. */
  captured: boolean;
  /** Items in send order — header/system items first, then conversation messages. */
  items: PromptPreviewItem[];
  /** The model's reply to this prompt, when the trace captured one (cleanup repair outputs —
   *  the cleaned text replaces the raw reply in the message, so this is its only home). Rendered
   *  as its own collapsible block; kept out of `items` so the group's totals stay prompt-side. */
  reply?: PromptPreviewItem;
  /** Cache-coverage report for the Main Prompt tag tree (docs/plans/completed/prompt-inspector-tag-tree.md §3.2):
   *  when this is a 'main' group with ≥2 recorded turns, the length in chars (UTF-16 code units,
   *  the same unit as the tag-tree's section offsets) of the longest prefix this turn's joined
   *  items text shares with the previous turn's — the run the provider's prefix cache would
   *  replay. A tag-tree section is cache-covered iff section.end <= this. Absent when fewer than
   *  two 'main' calls are on record — the panel then shows no cache badges at all. */
  stablePrefixChars?: number;
  /** When stablePrefixChars is set: epoch ms of the previous 'main' call the diff is against. */
  previousCallAt?: number;
  /** Per-subsection identity stability over the last x calls on record
   *  (docs/plans/completed/prompt-inspector-tag-tree.md §3.3): the server replays the trace's main entries as
   *  consecutive pairs; each section (keyed by canonical tag name + occurrence index) counts one
   *  observation per call it existed in, identical when its full span is byte-identical to the
   *  previous call's same section. The percentage shown per section is identical / seen. Absent
   *  when fewer than two 'main' calls are on record — same omission rule as stablePrefixChars. */
  stability?: {
    /** Consecutive pairs analyzed = mains on record − 1. */
    comparisons: number;
    sections: Array<{
      /** Canonical tag name, plus #occ when the name repeats within a call (document order). */
      key: string;
      name: string;
      seen: number;
      identical: number;
    }>;
  };
  /** The last turn's vendor-reported token accounting, when a turn has fired and resolved
   *  successfully (mirrors orchestrator LlmUsage). Powers the receipt row under the title;
   *  undefined on the live-reconstruction fallback or a failed turn. cacheReadTokens is undefined
   *  (not 0) when the provider reported no cache accounting. */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
  };
  /** The acting connection's USD-per-1M-token rates at that turn's send time — undefined end to
   *  end when no price was configured (tokens only, never a fabricated $0.00); a partially-set
   *  price omits the $ figure rather than pricing a tier at another tier's rate. */
  price?: {
    inputPerMillion?: number;
    outputPerMillion?: number;
    cacheHitPerMillion?: number;
  };
}

export interface PromptPreview {
  /** Every prompt the chat fires, in order: Main Prompt first, then captured background prompts. */
  groups: PromptPreviewGroup[];
  totalChars: number;
  totalEstimatedTokens: number;
}

// plugins/context-stack-presets/src/slotRows.ts's SlotInput — the wire shape a preset's ordered
// slots array takes both ways (get/create/update all return this same shape). Not yet assignable
// to any scene/character (docs/spec.md §7.4 "Deferred (not yet wired)") — this is a standalone
// preset library today.
export interface ContextStackSlot {
  slotType: 'marker' | 'custom';
  markerKey?: string;
  enabled?: boolean;
  customRole?: 'system' | 'user' | 'assistant';
  customContent?: string;
  /** Optional display name (migration 0060) — cosmetic only, except it names the wrapper tag
   *  when tagEnabled (0085) is on. */
  label?: string;
  /** Migration 0085: wrap this slot's assembled content in <Friendly Name>…</Friendly Name>
   *  HTML-style tags — a hint to the LLM, not real HTML. Default off. */
  tagEnabled?: boolean;
  /** Migration 0086: this slot is a member of a group. Every member of a contiguous run carries
   *  the same groupName (the opener's name); the first member of a run is the opener (its name
   *  box appears there), the last is the closer (</Name> chip). Default unset. */
  groupName?: string | null;
}

// plugins/context-stack-presets/src/getContextStackPresetsTool.ts
export interface ContextStackPreset {
  presetId: string;
  name: string;
  isBuiltin: boolean;
  /** This user's chosen prompt-stack default (migration 0061) — auto-applied to every new RP chat
   *  by CharactersView.tsx's startRp(), right after apply_character_to_chat. At most one true. */
  isDefault: boolean;
  /** This user's chosen cleanup default (migration 0071) — auto-applied to every new RP chat's
   *  cleanup_preset_id by startRp(), alongside the prompt-stack default. Independent of
   *  isDefault: one preset can be both, or two presets can each own one. At most one true. */
  isCleanupDefault: boolean;
  slots: ContextStackSlot[];
  updatedAt: string;
}

// plugins/characters/src/getCharactersTool.ts — the Character Roster's list-pane row shape.
export interface CharacterSummary {
  characterId: string;
  name: string;
}

// plugins/characters/src/getCharacterTool.ts
export type CharacterDetail =
  | { found: false; characterId: string }
  | {
      found: true;
      characterId: string;
      name: string;
      persona: string;
      scenario: string;
      systemPrompt: string;
      exampleDialogue: string;
      greetings: string[];
      specVersion: 'v2' | 'v3';
      hasAvatar: boolean;
      hasSourceJson: boolean;
      createdAt: string;
      updatedAt: string;
    };

// POST /v1/characters/import's response shape (handleCharacterImport.ts, relaying
// plugins/characters/src/importCharacterCardTool.ts's return value).
export interface ImportedCharacter {
  characterId: string;
  name: string;
  specVersion: 'v2' | 'v3';
  hasAvatar: boolean;
  /** Number of lorebook entries imported from the card's embedded `character_book` (0 when none). */
  lorebookEntriesImported: number;
}

// plugins/characters/src/searchChubCharactersTool.ts
export interface ChubCharacterSummary {
  fullPath: string;
  name: string;
  tagline: string;
  avatarUrl: string;
  starCount: number;
  rating: number;
  ratingCount: number;
  nChats: number;
  nMessages: number;
  nFavorites: number;
  nTokens: number;
  forksCount: number;
  topics: string[];
  createdAt: string;
  lastActivityAt: string;
  verified: boolean;
  recommended: boolean;
  hasGallery: boolean;
}

export interface ChubSearchResult {
  count: number;
  page: number;
  results: ChubCharacterSummary[];
}

// orchestrator/src/server/handleChubCardDetail.ts — what GET /v1/characters/chub-detail returns:
// the search summary plus everything chub's search API doesn't carry (full description, the
// bespoke `definition` object, and maxResUrl — the card PNG the Download button fetches).
export interface ChubCardDetail {
  fullPath: string;
  name: string;
  tagline: string;
  description: string;
  avatarUrl: string;
  maxResUrl: string;
  definition: Record<string, unknown>;
  topics: string[];
  starCount: number;
  rating: number;
  ratingCount: number;
  nChats: number;
  nMessages: number;
  nFavorites: number;
  nTokens: number;
  forksCount: number;
  createdAt: string;
  lastActivityAt: string;
  verified: boolean;
  recommended: boolean;
  hasGallery: boolean;
}

// import_character_card_from_url's return value — same shape as ImportedCharacter
// (importCharacterCardFromUrlTool.ts calls the same insertCharacterFromCard.ts helper).
export type ImportedChubCharacter = ImportedCharacter;

// plugins/characters/src/applyCharacterToChatTool.ts
export type ApplyCharacterToChatResult =
  | { applied: false; reason: string }
  | { applied: true; systemText: string; greetingInserted: boolean };

// plugins/context-stack-presets/src/applyPromptStackToChatTool.ts
export type ApplyPromptStackToChatResult =
  | { applied: false; reason: string }
  | { applied: true; systemText: string; greetingInserted: boolean };

// docs/plans/llm-stats-page-plan.md — the Stats view's wire shapes (hand-mirrored from
// orchestrator/src/server/adminServer.ts's row mappers, same file-noted-by-hand convention as
// the rest of this file).

export type LlmCallKind = 'chat' | 'agent_routine' | 'system';
export type LlmCallOutcome = 'ok' | 'refused' | 'error';
export type TurnDisplayOutcome = 'ok' | 'aborted' | 'error';

/** GET /v1/admin/llm-stats row — adminServer.ts listLlmStats's map result. providerKind/model are
 *  '(pre-tracking)' for rows written before migration 0101; every numeric column is null for
 *  those rows, and the Stats view excludes nulls from sums/averages rather than treating them as
 *  zero. costUsd is already Number()-cast server-side (node-postgres returns numerics as text).
 *  callLabel (migration 0103) is the finer one-level-deeper label for 'system'-kind calls
 *  (docs/plans/llm-call-label-breakdown-plan.md): null for kind 'chat'/'agent_routine' rows,
 *  pre-0103 rows, and any unlabeled system call — passed through untouched, never substituted. */
export interface LlmCallStatRow {
  callId: string;
  createdAt: string; // ISO
  userId: string;
  kind: LlmCallKind;
  taskId: string;
  jobId: string | null;
  outcome: LlmCallOutcome;
  providerKind: string;
  model: string;
  callLabel: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  attempt: number;
}

/** GET /v1/admin/turn-display-stats row — camelCase mirror of migration 0102's columns, one per
 *  RP turn. Every *_ms field is elapsed milliseconds since dispatch_at, measured client-side. */
export interface TurnDisplayMetricRow {
  turnDisplayMetricId: string;
  userId: string;
  chatId: string;
  messageId: string;
  dispatchAt: string; // ISO
  firstTokenMs: number | null;
  lastTokenMs: number | null;
  displayLandMs: number | null;
  displaySettleMs: number | null;
  headerStartMs: number | null;
  headerStopMs: number | null;
  bodyStartMs: number | null;
  bodyStopMs: number | null;
  footerStartMs: number | null;
  footerStopMs: number | null;
  outcome: TurnDisplayOutcome;
  terminatedAtMs: number | null;
  createdAt: string; // ISO
}

/** POST /v1/turn-display-metrics body — the optional *_ms fields are omitted entirely when never
 *  reached (an abort mid-turn), never sent as zeros. */
export interface TurnDisplayMetricsInput {
  chatId: string;
  messageId: string;
  dispatchAt: string; // ISO
  firstTokenMs?: number;
  lastTokenMs?: number;
  displayLandMs?: number;
  displaySettleMs?: number;
  headerStartMs?: number;
  headerStopMs?: number;
  bodyStartMs?: number;
  bodyStopMs?: number;
  footerStartMs?: number;
  footerStopMs?: number;
  outcome: TurnDisplayOutcome;
  terminatedAtMs?: number;
}

/** Client-only: the window CustomEvent detail turnTimeline.ts dispatches at each milestone
 *  ('bigimagine:turn-event') — listenable in devtools, same spirit as Loggeryze's
 *  window.loggeryze.time(). messageId is null until the first delta lands. */
export interface TurnTimelineEventDetail {
  messageId: string | null;
  event:
    | 'dispatch'
    | 'stop'
    | 'first-token'
    | 'last-token'
    | 'cleanup-start'
    | 'cleanup-stop'
    | 'display-land'
    | 'display-settle';
  region?: 'header' | 'body' | 'footer';
  tsMs: number;
}

// ============================================================================
// Portrait Studio (docs/plans/completed/portrait-studio-plan.md) — the user-scoped visual_* tables'
// wire shapes, mirroring orchestrator/src/server/portraitRoutes.ts exactly.
// ============================================================================

/** One layer of the active layer manifest — promptable layers carry chromosome slots; the
 *  `subject` layer is mandatory (Manage Layers never offers to remove it). */
export interface PortraitLayerDefinition {
  id: string;
  label: string;
  promptable: boolean;
  boundary: string;
}

/** The stored visual_layer_stack manifest: the layer list + the composed-prompt template
 *  ({{slot}} / {{<layerId>_overflow}} tokens). */
export interface PortraitLayerManifest {
  layers: PortraitLayerDefinition[];
  template: string;
}

/** One visual_entities row as the Studio sees it — full, nothing redacted. */
export interface PortraitEntityRow {
  entity_id: string;
  layer_id: string;
  character_id: string | null;
  name: string;
  slots: Record<string, string>;
  standing_instructions: string;
  template: string | null;
  last_image_url: string | null;
  current_best_candidate_id: string | null;
  created_at: string;
  updated_at: string;
}

/** POST /v1/portraits/entities body — characterId is required for the subject layer (one
 *  subject per character, validated server-side). */
export interface CreatePortraitEntityInput {
  layerId: string;
  characterId?: string | null;
  name: string;
  slots?: Record<string, string>;
  standingInstructions?: string;
  template?: string | null;
}

/** PATCH /v1/portraits/entities/:id body — every field optional; null clears
 *  standingInstructions/template/characterId (not name/slots — an entity always has a name). */
export interface UpdatePortraitEntityInput {
  name?: string;
  characterId?: string | null;
  slots?: Record<string, string>;
  standingInstructions?: string;
  template?: string | null;
}

/** One wiki subscription — entity-specific when layerEntityId is set, whole-layer-type when
 *  null (reaches every entity of that layer type). */
export interface PortraitWikiSubscription {
  layerType: string;
  layerEntityId: string | null;
}

/** One visual_wiki_entries row shaped for the Studio's Wiki panel. */
export interface PortraitWikiEntry {
  entry_id: string;
  title: string;
  body: string;
  tags: string[];
  subscriptions: PortraitWikiSubscription[];
  origin_episode_id: string | null;
  created_at: string;
  updated_at: string;
}

/** PATCH /v1/portraits/wiki/:id body — subscriptions replaces, not merges. */
export interface UpdatePortraitWikiInput {
  title?: string;
  body?: string;
  tags?: string[];
  subscriptions?: PortraitWikiSubscription[];
}

/** One candidate from a generation round — the grid's card shape. imageUrl null = the render
 *  failed (row still written; card omitted from the grid). */
export interface PortraitCandidate {
  candidateId: string;
  chromosome: {
    slots: Record<string, Record<string, string>>;
    negative_prompt?: string;
  };
  composedPrompt: string;
  imageUrl: string | null;
  failed?: string;
}

/** POST /v1/portraits/generate body — entityIds is the round's { [layerId]: entityId } map. */
export interface PortraitGenerateInput {
  entityIds: Record<string, string>;
  goal: string;
  pendingFeedback?: string;
}

/** POST /v1/portraits/feedback body — ratings are 1-5 integers (server 400s otherwise). */
export interface PortraitFeedbackInput {
  entityIds: Record<string, string>;
  goal: string;
  candidateIds: string[];
  winnerId: string;
  ratings?: Record<string, number>;
  notes?: Record<string, string>;
  rationale?: string;
}

/** The Reflection Investigation outcome returned with the feedback response. */
export interface PortraitReflectionOutcome {
  action: 'created' | 'amended' | 'failed';
  entryId?: string;
  reason?: string;
}

/** POST /v1/portraits/feedback response. */
export interface PortraitFeedbackResult {
  episodeId: string;
  reflection: PortraitReflectionOutcome;
}
