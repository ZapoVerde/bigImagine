/**
 * Hand-written response shapes for bigBrain's tool-call and chat endpoints.
 *
 * GET /v1/tools/openapi.json mechanically reports every tool's response schema as `{}`
 * (orchestrator/src/server/openApiToolServer.ts) — there is no machine-readable response contract
 * to generate these from. Each interface below is copied by hand from the corresponding plugin
 * tool handler's `return` statement (file noted per type). If a handler's return shape changes,
 * this file has to be updated by hand too — nothing else will catch the drift.
 */

export type ListItemPriority = 'P1' | 'P2' | 'P3';

// plugins/lists/src/getListItemsTool.ts
export interface ListItem {
  itemId: string;
  listName: string;
  section: string | null;
  itemName: string;
  status: 'pending' | 'done';
  priority: ListItemPriority | null;
  dueAt: string | null;
  createdAt: string;
  completedAt: string | null;
}

// plugins/lists/src/addListItemTool.ts
export interface AddListItemResult {
  itemId: string;
  listId: string;
  listName: string;
  itemName: string;
  priority: ListItemPriority | null;
  dueAt: string | null;
  listWasCreated: boolean;
}

// plugins/lists/src/updateListItemTool.ts
export type UpdateListItemResult =
  | { found: false; itemId: string }
  | { found: true; itemId: string; itemName: string; priority: ListItemPriority | null; dueAt: string | null };

// plugins/lists/src/completeListItemTool.ts
export type CompleteListItemResult =
  | { completed: true; itemId: string; listId: string; itemName: string }
  | { completed: false; reason: string };

// plugins/lists/src/createListTool.ts
export interface CreateListResult {
  listId: string;
  name: string;
  created: boolean;
}

// plugins/lists/src/deleteListItemTool.ts
export interface DeleteListItemResult {
  deleted: boolean;
}

// plugins/lists/src/deleteListTool.ts
export type DeleteListResult =
  | { deleted: false; reason: string }
  | { deleted: true; listId: string; name: string; itemsDeleted: number };

// plugins/lists/src/getListsTool.ts
export interface ListSummary {
  listId: string;
  name: string;
  tags: string[];
  showPriority: boolean;
  showDueDates: boolean;
}

// plugins/lists/src/updateListSettingsTool.ts
export interface UpdateListSettingsResult {
  listId: string;
  name: string;
  showPriority: boolean;
  showDueDates: boolean;
}

// plugins/recipes/src/recipeIngredientSchema.ts
export interface RecipeIngredient {
  raw: string;
  amount: number | null;
  unit: string | null;
  item: string;
  modifier: string | null;
  scalable: boolean;
}

// plugins/recipes/src/recipeIngredientSchema.ts / scaleIngredients.ts
export interface ScaledIngredient extends RecipeIngredient {
  amountDisplay: string | null;
}

// plugins/recipes/src/getRecipesTool.ts
export interface RecipeSummary {
  recipeId: string;
  mealName: string;
  tags: string[];
  prepTime: string | null;
  cookTime: string | null;
  // Free-text yield, e.g. "4-6" — NOT a number. (Previously mistyped as number | null here; the
  // real DB/tool value has always been the human-readable string.) baseServings is the numeric one.
  servings: string | null;
  baseServings: number | null;
  isFavorite: boolean;
}

// plugins/recipes/src/getRecipeTool.ts
export type RecipeDetailResult =
  | { found: false; mealName: string }
  | {
      found: true;
      recipeId: string;
      mealName: string;
      ingredients: RecipeIngredient[];
      instructions: (string | { section: string; steps: string[] })[];
      tags: string[];
      prepTime: string | null;
      cookTime: string | null;
      servings: string | null;
      baseServings: number | null;
      isFavorite: boolean;
    };

// plugins/recipes/src/updateRecipeTool.ts
export type UpdateRecipeResult =
  | { found: false; recipeId: string }
  | {
      found: true;
      recipeId: string;
      mealName: string;
      ingredients: RecipeIngredient[];
      instructions: (string | { section: string; steps: string[] })[];
      tags: string[];
      baseServings: number | null;
      prepTime: string | null;
      cookTime: string | null;
      servings: string | null;
      isFavorite: boolean;
    };

// plugins/recipes/src/scaleRecipeTool.ts
export type ScaleRecipeResult =
  | { found: false; mealName: string }
  | { found: true; scaled: false; reason: string; recipeId: string; mealName: string }
  | {
      found: true;
      scaled: true;
      recipeId: string;
      mealName: string;
      baseServings: number;
      targetServings: number;
      ingredients: ScaledIngredient[];
    };

// plugins/recipes/src/deleteRecipeTool.ts
export interface DeleteRecipeResult {
  deleted: boolean;
  mealName?: string;
}

// plugins/recipes/src/importRecipeTool.ts
export interface ImportRecipeResult {
  recipeId: string;
  mealName: string;
  ingredientCount: number;
  tags: string[];
}

// plugins/recipes/src/getMealPlanTool.ts
export interface MealPlanEntry {
  plannedDate: string;
  mealLabel: string | null;
  mealName: string;
  recipeId: string | null;
  targetServings: number | null;
}

// plugins/recipes/src/addMealPlanEntryTool.ts
export type AddMealPlanEntryResult =
  | { planned: false; reason: string }
  | {
      planned: true;
      mealName: string;
      plannedDate: string;
      mealLabel: string | null;
      targetServings: number | null;
      replaced: boolean;
    };

// plugins/recipes/src/shoppingListFromMealPlanTool.ts
export interface GenerateShoppingListResult {
  listName: string;
  itemsAdded: string[];
  itemsSkipped: string[];
  mealsConsidered: number;
  mealsWithErrors: string[];
}

// plugins/calendar/src/getCalendarScheduleTool.ts / createCalendarEventTool.ts
export type CalendarSource = 'cozi' | 'outlook' | 'google' | 'native';

// db/migrations/0025_calendar_links_visibility.sql — 'private' skips the outbound Google push,
// 'shared' pushes as before; linkedListItemId/linkedNoteId point back to a promoted list item/note
// and are set once at creation, never kept in sync afterward.
export type CalendarVisibility = 'private' | 'shared';

export interface CalendarEvent {
  eventId: string;
  source: CalendarSource;
  colorCode: string;
  isReadOnly: boolean;
  label: string;
  title: string;
  description: string | null;
  location: string | null;
  startTime: string;
  endTime: string;
  allDay: boolean;
  assignedMembers: string[];
  visibility: CalendarVisibility;
  linkedListItemId: string | null;
  linkedNoteId: string | null;
}

// plugins/calendar/src/createCalendarEventTool.ts's return shape — created:false when a
// linked_list_item_id/linked_note_id create request found an existing linked event and reused it
// instead of making a duplicate.
export interface CreateCalendarEventResult {
  eventId: string;
  source: CalendarSource;
  colorCode: string;
  isReadOnly: boolean;
  label: string;
  title: string;
  startTime: string;
  endTime: string;
  visibility: CalendarVisibility;
  linkedListItemId: string | null;
  linkedNoteId: string | null;
  created: boolean;
}

// orchestrator/src/server/adminServer.ts getCalendarSettings()
export interface CalendarSettings {
  ownerUserId: string | null;
  maskWorkCalendar: boolean;
}

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

// orchestrator/src/server/adminServer.ts getNotionSettings()
export interface NotionSettings {
  ownerUserId: string | null;
  listsDataSourceId: string | null;
}

// orchestrator/src/server/adminServer.ts getNotificationSettings()
export interface NotificationSettings {
  serverUrl: string | null;
  enabled: boolean;
}

// orchestrator/src/server/adminServer.ts getGoogleCalendarSettings()
export interface GoogleCalendarSettings {
  clientId: string | null;
  ownerUserId: string | null;
  calendarId: string;
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
