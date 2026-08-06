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
  isActive: boolean;
  updatedAt: string;
}

// orchestrator/src/server/adminServer.ts parseCreateConnectionBody's expected shape (LlmConnectionInit)
export interface CreateConnectionInput {
  name: string;
  kind: 'anthropic' | 'openai-compatible';
  model: string;
  apiKey: string;
  baseUrl?: string;
  supportsVision?: boolean;
  providerOrder?: string[];
  allowFallbacks?: boolean;
  quantizations?: string[];
}

// orchestrator/src/server/adminServer.ts parseUpdateConnectionBody's expected shape
// (LlmConnectionPatch) — every field optional (a PATCH); baseUrl/providerOrder/quantizations
// additionally accept null to explicitly clear a previously-set value.
export interface UpdateConnectionInput {
  name?: string;
  model?: string;
  /** Omit to leave the stored key untouched — only send when actually rotating it. */
  apiKey?: string;
  baseUrl?: string | null;
  supportsVision?: boolean;
  providerOrder?: string[] | null;
  allowFallbacks?: boolean;
  quantizations?: string[] | null;
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
   *  read/write and starts with empty toolNames — see orchestrator/src/io/chatSessions.ts. */
  kind: 'chat' | 'rp';
  /** Which character this chat is playing, if any — set by apply_character_to_chat. */
  characterId: string | null;
  /** The last context_stack_presets row applied via apply_prompt_stack_to_chat, if any. */
  promptStackPresetId: string | null;
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
  chunkSummaryPrompt: string;
  chunkSummaryPromptIsDefault: boolean;
  distillPrompt: string;
  distillPromptIsDefault: boolean;
  householdMemoryPrompt: string;
  householdMemoryPromptIsDefault: boolean;
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

export interface StoredChatMessage {
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  /** Present only once this message has been regenerated at least once (swipe capability on the
   *  last LLM response). index is its current position among stored variants (0-based); count is
   *  how many exist. Undefined means never swiped — content is the only version. */
  swipes?: { index: number; count: number };
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
// the exact, itemized prompt an 'rp' chat's next turn would send, for the Prompt Inspector panel.
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

export interface PromptPreview {
  systemStack: PromptPreviewItem[];
  messages: PromptPreviewItem[];
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
  /** Optional display name (migration 0060) — cosmetic only. */
  label?: string;
}

// plugins/context-stack-presets/src/getContextStackPresetsTool.ts
export interface ContextStackPreset {
  presetId: string;
  name: string;
  isBuiltin: boolean;
  /** This user's chosen default (migration 0061) — auto-applied to every new RP chat by
   *  CharactersView.tsx's startRp(), right after apply_character_to_chat. At most one true. */
  isDefault: boolean;
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
