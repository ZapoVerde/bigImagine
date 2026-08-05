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

// orchestrator/src/server/adminServer.ts ActiveProfileSetting
export interface ActiveProfileSetting {
  activeProfile: string;
  activeModel: string;
  profileNames: string[];
  visionCapableProfiles: string[];
}

// orchestrator/src/server/adminServer.ts ProfileModelsResult
export interface ProfileModelsResult {
  models: { id: string; pricing?: { prompt: string; completion: string } }[];
  defaultModel: string;
}

// orchestrator/src/io/chatSessions.ts — persisted chat sessions
export interface ChatParams {
  system?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  model?: string;
  /** Which BIGBRAIN_LLM_PROFILES connection this chat uses, overriding the household's active
   *  one. Unset means "use whichever connection is active". */
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
// (which attaches profileNames from deps.llmProfiles, same split as ActiveProfileSetting).
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

export interface StoredChatMessage {
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface ChatDetail {
  session: ChatSessionRow;
  messages: StoredChatMessage[];
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
}

// plugins/context-stack-presets/src/getContextStackPresetsTool.ts
export interface ContextStackPreset {
  presetId: string;
  name: string;
  isBuiltin: boolean;
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
