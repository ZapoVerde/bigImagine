/**
 * Hand-written response shapes for bigBrain's tool-call and chat endpoints.
 *
 * GET /v1/tools/openapi.json mechanically reports every tool's response schema as `{}`
 * (orchestrator/src/server/openApiToolServer.ts) — there is no machine-readable response contract
 * to generate these from. Each interface below is copied by hand from the corresponding plugin
 * tool handler's `return` statement (file noted per type). If a handler's return shape changes,
 * this file has to be updated by hand too — nothing else will catch the drift.
 */

// plugins/lists/src/getListItemsTool.ts
export interface ListItem {
  itemId: string;
  listName: string;
  section: string | null;
  itemName: string;
  status: 'pending' | 'done';
  createdAt: string;
  completedAt: string | null;
}

// plugins/lists/src/addListItemTool.ts
export interface AddListItemResult {
  itemId: string;
  listId: string;
  listName: string;
  itemName: string;
  listWasCreated: boolean;
}

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

// plugins/recipes/src/getRecipesTool.ts
export interface RecipeSummary {
  recipeId: string;
  mealName: string;
  tags: string[];
  prepTime: string | null;
  cookTime: string | null;
  servings: number | null;
}

// plugins/recipes/src/getRecipeTool.ts
export type RecipeDetailResult =
  | { found: false; mealName: string }
  | {
      found: true;
      recipeId: string;
      mealName: string;
      ingredients: string[];
      instructions: (string | { section: string; steps: string[] })[];
      tags: string[];
      prepTime: string | null;
      cookTime: string | null;
      servings: number | null;
    };

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
}

// plugins/recipes/src/addMealPlanEntryTool.ts
export type AddMealPlanEntryResult =
  | { planned: false; reason: string }
  | { planned: true; mealName: string; plannedDate: string; mealLabel: string | null; replaced: boolean };

// plugins/recipes/src/shoppingListFromMealPlanTool.ts
export interface GenerateShoppingListResult {
  listName: string;
  itemsAdded: string[];
  itemsSkipped: string[];
  mealsConsidered: number;
}

// plugins/calendar/src/getCalendarScheduleTool.ts / createCalendarEventTool.ts
export type CalendarSource = 'cozi' | 'outlook' | 'google' | 'native';

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
}

// orchestrator/src/server/adminServer.ts getCalendarSettings()
export interface CalendarSettings {
  ownerUserId: string | null;
  maskWorkCalendar: boolean;
}

// orchestrator/src/server/adminServer.ts getNotionSettings()
export interface NotionSettings {
  ownerUserId: string | null;
  listsDataSourceId: string | null;
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
  createdAt: string;
  updatedAt: string;
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

// plugins/notes/src/getNotesTool.ts
export interface NoteSummary {
  noteId: string;
  title: string;
  updatedAt: string;
}

// plugins/notes/src/getNoteTool.ts, updateNoteTool.ts
export type NoteDetailResult =
  | { found: false; noteId: string }
  | { found: true; noteId: string; title: string; content: string; tags: string[]; createdAt?: string; updatedAt: string };

// plugins/notes/src/createNoteTool.ts
export interface CreateNoteResult {
  noteId: string;
  title: string;
  content: string;
}

// plugins/notes/src/deleteNoteTool.ts
export interface DeleteNoteResult {
  deleted: boolean;
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
    };

// plugins/prompt-presets/src/getPromptPresetsTool.ts — a reusable named system-prompt snippet
// ("instruction set"), applied by copying .content into a chat's own params.system.
export interface PromptPreset {
  presetId: string;
  name: string;
  content: string;
  updatedAt: string;
}
