import type {
  ChatCompletionResponse,
  StreamingTerminalFrame,
  ChatDetail,
  ChatLineageNode,
  ChatMemorySettings,
  ChatMemorySyncStatusRow,
  ChunkResizeStatus,
  LocationRenderStatusRow,
  LocationSettings,
  LocationAdminRow,
  CanonSettings,
  LorebookAdminRow,
  LorebookEntryAdminRow,
  LorebookSettings,
  LorebookPanelData,
  ChatMessage,
  ChatParams,
  ChatSessionRow,
  ChatSummary,
  ChatSyncInspection,
  ChatSyncStatus,
  ChubCardDetail,
  CleanupJob,
  CleanupPatchFrame,
  CleanupSettings,
  CleanupStatus,
  CleanupStatusFrame,
  ConnectionTestResult,
  CreateConnectionInput,
  CreateImageConnectionInput,
  CredentialSummary,
  Folder,
  ImageConnectionSummary,
  ImageConnectionTestResult,
  ImageSettings,
  ChatBackgroundSettings,
  ChatLegibilitySettings,
  ChatLegibilitySettingsPatch,
  ImportedCharacter,
  LlmCallStatRow,
  LlmConnectionSummary,
  ModelProvidersResult,
  NotificationSettings,
  PersonaSettings,
  PortraitCandidate,
  PortraitEntityRow,
  PortraitFeedbackInput,
  PortraitFeedbackResult,
  PortraitGenerateInput,
  PortraitLayerManifest,
  PortraitWikiEntry,
  CreatePortraitEntityInput,
  UpdatePortraitEntityInput,
  UpdatePortraitWikiInput,
  ProfileModelsResult,
  PromptPreview,
  ReasoningFrame,
  ScreenLockSettings,
  StagedAttachment,
  StoredChatMessage,
  TurnDisplayMetricRow,
  TurnDisplayMetricsInput,
  UpdateConnectionInput,
  UpdateImageConnectionInput,
} from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

function authHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

export interface WhoAmI {
  userId: string;
  /** docker-compose.yml's BIGBRAIN_BACKUP_CONFIGURED — false until the backup/ sidecar has real
   *  R2 credentials. Drives App.tsx's "offsite backup isn't configured" warning modal. */
  backupConfigured: boolean;
}

/** Am I already authenticated? With no `apiKey`, this is purely a Cloudflare Access probe
 *  (io/accessIdentity.ts) — Access attaches its header to every request reaching the origin
 *  through bigbrain.your-domain.example regardless of what this page sends, so no Authorization header is
 *  needed here for that path to succeed. Pass the stored key to resolve the 'key' auth path
 *  instead. Returns null on 401 (an expected outcome, not an error) rather than throwing. */
export async function whoami(apiKey?: string | null): Promise<WhoAmI | null> {
  const res = await fetch('/v1/whoami', { headers: authHeaders(apiKey ?? null) });
  if (res.status === 401) return null;
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return (await res.json()) as WhoAmI;
}

/** GET /v1/timezone — the household_timezone setting, same household-key auth as callTool/chat
 *  (not the admin-gated /v1/admin/timezone). Not a secret (bb_principles.md §12); lets the
 *  frontend compute "today" the same way the server does for the LLM's own date context, instead
 *  of guessing from the browser's local clock or UTC. */
export async function getTimezone(apiKey: string | null): Promise<string> {
  const res = await fetch('/v1/timezone', { headers: authHeaders(apiKey) });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  const body = (await res.json()) as { timezone: string };
  return body.timezone;
}

/** GET /v1/screen-lock-settings — same household-key/Access auth as getTimezone, not the admin
 *  key: ScreenLockOverlay.tsx polls this as a regular authenticated user. password === '' means
 *  the idle-lock overlay is disabled (bi_principles.md §12 — see adminServer.ts's own note on why
 *  this plaintext round-trip is fine). */
export async function getScreenLockSettings(apiKey: string | null): Promise<ScreenLockSettings> {
  const res = await fetch('/v1/screen-lock-settings', { headers: authHeaders(apiKey) });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return res.json() as Promise<ScreenLockSettings>;
}

/** Invokes one registered tool by name — POST /v1/tools/:name, same auth and RLS scoping as chat.
 *  apiKey is null under Cloudflare Access SSO (see whoami()) — the Authorization header is simply
 *  omitted in that case. Response shapes aren't discoverable from the server; callers supply the
 *  expected shape via the type parameter, backed by the hand-written interfaces in ./types.ts. */
export async function callTool<T>(name: string, args: unknown, apiKey: string | null): Promise<T> {
  const res = await fetch(`/v1/tools/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return res.json() as Promise<T>;
}

/** POST /v1/attachments/extract — turns a staged file into Markdown ahead of sending it in a chat
 *  turn. `content-type` is deliberately omitted: FormData needs the browser to set it itself
 *  (with the multipart boundary it generates), which only happens when this code never sets the
 *  header explicitly — every other request in this file sets 'content-type': 'application/json'
 *  and JSON.stringifies its body, but a file upload can't go through that same path. */
export async function uploadAttachment(file: File, apiKey: string | null): Promise<StagedAttachment> {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetch('/v1/attachments/extract', {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: form,
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return res.json() as Promise<StagedAttachment>;
}

/** POST /v1/chat/completions. Two modes:
 *
 *  Non-streaming (no onDelta — the default, every existing caller): runTurn resolves the full
 *  reply server-side before anything is sent back. chatId ties the turn to a persisted session
 *  (the server applies its params/tools and stores the exchange). RP chats in this mode behave
 *  exactly as they always have — the only change this plan makes to them is that they no longer
 *  need it.
 *
 *  Streaming (onDelta provided): sends `stream: true` and parses the SSE `data:` lines off
 *  res.body as they arrive, calling onDelta once per content chunk in arrival order, then
 *  resolves with the same ChatCompletionResponse shape once [DONE] arrives — the server writes
 *  [DONE] only after the message is persisted, so the caller can trust the streamed text is
 *  already saved. The abort/error terminal frame (bigimagine_error) is reported through
 *  onTerminalFrame (the caller decides what to show, per rp-streaming-plan.md Edge Cases); the
 *  stream still ends with [DONE] and resolves normally either way. Reasoning blocks
 *  (docs/plans/reasoning-blocks-plan.md) arrive as bigimagine_reasoning frames and are reported
 *  through onReasoningDelta — they never enter the content accumulation, so the resolved
 *  response's content stays de-tagged. Passing onDelta implies stream: true; the body is
 *  byte-identical to the non-streaming call otherwise.
 *
 *  Deliberately omits `model` from the body: httpServer.ts's handleChatCompletions treats
 *  body.model as a real per-request override (`options.model ?? config.model` in the LLM
 *  adapters) — it exists for Open WebUI's own model dropdown, which sends a real model id from
 *  GET /v1/models. This client used to hardcode the literal string "bigbrain" here, which was
 *  harmless before that override plumbing existed but became a hard failure once it did — every
 *  request told the real provider (DeepSeek/OpenRouter) to use a model literally named
 *  "bigbrain", which doesn't exist, and it rejected every single message. Omitting it here falls
 *  back to the chat session's own params.model if set, else the active connection's configured
 *  default — never a fake label.
 *
 *  images never goes through POST /v1/attachments/extract (there's nothing to extract) — the
 *  caller base64-encodes them client-side; only {mimeType, base64} travels over the wire, matching
 *  orchestrator/src/server/openai.ts's IncomingImage shape exactly (no filename/preview data,
 *  unlike attachments). A non-vision-capable active connection makes the whole request fail with a
 *  422 server-side (httpServer.ts) rather than silently dropping the image. */
export async function chatCompletion(
  messages: ChatMessage[],
  apiKey: string | null,
  chatId?: string,
  attachments?: StagedAttachment[],
  images?: { mimeType: string; base64: string }[],
  onDelta?: (textDelta: string) => void,
  onTerminalFrame?: (frame: StreamingTerminalFrame) => void,
  onCleanupStatus?: (frame: CleanupStatusFrame) => void,
  onCleanupPatch?: (frame: CleanupPatchFrame) => void,
  onReasoningDelta?: (frame: ReasoningFrame) => void,
): Promise<ChatCompletionResponse> {
  const streaming = !!onDelta;
  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'content-type': 'application/json' },
    body: JSON.stringify({
      messages,
      stream: streaming,
      ...(chatId ? { chat_id: chatId } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...(images?.length ? { images } : {}),
    }),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  if (!streaming) return res.json() as Promise<ChatCompletionResponse>;
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    // Defensive fallback for a proxy/server that buffered the whole reply instead of streaming
    // (principle §6's graceful degradation at the HTTP boundary): surface it as one whole-reply
    // delta so the caller's live-fill still shows the text, then resolve normally.
    const buffered = (await res.json()) as ChatCompletionResponse;
    const bufferedContent = buffered.choices?.[0]?.message?.content ?? '';
    if (bufferedContent) onDelta(bufferedContent);
    return buffered;
  }
  const { id, created, model, content } = await consumeSseCompletionStream(res, onDelta, onTerminalFrame, onCleanupStatus, onCleanupPatch, onReasoningDelta);
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  };
}

/** Reads a streaming SSE response to completion: relays every content delta to onDelta in arrival
 *  order, reports the abort/error terminal frame through onTerminalFrame (the stream does not end
 *  there — [DONE] still follows), forwards the in-stream cleanup frames through onCleanupStatus /
 *  onCleanupPatch, forwards the reasoning-block frames through onReasoningDelta, and resolves
 *  once [DONE] arrives. The wire format is the server's OpenAI-compatible framing:
 *  `data: {chunk json}` blocks separated by blank lines, `data: {bigimagine_error frame}` when
 *  the turn was aborted or failed mid-stream, interleaved `data: {bigimagine_cleanup frame}` /
 *  `data: {bigimagine_patch frame}` cleanup frames (in-stream-cleanup-plan.md) and
 *  `data: {bigimagine_reasoning frame}` reasoning frames (reasoning-blocks-plan.md — a consumer
 *  that has never heard of them ignores them), and a final `data: [DONE]` terminator. Chunk JSON
 *  carries id/created/model on every frame (captured here from the first one seen) and
 *  `choices[0].delta.content` per text piece; reasoning frames are deliberately NOT content, so
 *  they never enter the contentParts accumulation — the resolved content stays de-tagged;
 *  non-JSON or comment lines are ignored. */
async function consumeSseCompletionStream(
  res: Response,
  onDelta: (textDelta: string) => void,
  onTerminalFrame?: (frame: StreamingTerminalFrame) => void,
  onCleanupStatus?: (frame: CleanupStatusFrame) => void,
  onCleanupPatch?: (frame: CleanupPatchFrame) => void,
  onReasoningDelta?: (frame: ReasoningFrame) => void,
): Promise<{ id: string; created: number; model: string; content: string }> {
  const reader = res.body?.getReader();
  if (!reader) throw new ApiError(0, 'streaming response has no body');
  const decoder = new TextDecoder();
  let buffer = '';
  let id = '';
  let created = 0;
  let model = '';
  const contentParts: string[] = [];

  const handleDataPayload = (payload: string): boolean => {
    // Returns true once the stream is done ([DONE] seen); false to keep reading.
    const trimmed = payload.trim();
    if (trimmed === '[DONE]') return true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return false; // keep-alive or comment line — nothing to do
    }
    if (typeof parsed !== 'object' || parsed === null) return false;
    const chunk = parsed as {
      id?: string;
      created?: number;
      model?: string;
      bigimagine_error?: unknown;
      bigimagine_cleanup?: unknown;
      bigimagine_patch?: unknown;
      bigimagine_reasoning?: unknown;
      choices?: { delta?: { content?: unknown }; finish_reason?: string }[];
    };
    if (chunk.bigimagine_error === true) {
      // Abort/error terminal frame — report it and keep reading; [DONE] follows and ends the
      // stream normally so the caller's resolve-on-[DONE] shape holds either way.
      onTerminalFrame?.(parsed as StreamingTerminalFrame);
      return false;
    }
    if (chunk.bigimagine_cleanup === true) {
      // In-stream cleanup status frame — one region's pill state (live path); keep reading.
      onCleanupStatus?.(parsed as CleanupStatusFrame);
      return false;
    }
    if (chunk.bigimagine_patch === true) {
      // In-stream cleanup patch frame — a content splice in onDelta-accumulated coordinates; keep
      // reading. Applied here too (in frame order) so the resolved content is byte-identical to
      // the server's composed buffer — the swipe path persists that composed text, and
      // ChatView replaces the regenerated message with it; without the splice, live repairs
      // would visibly revert until the post-swipe DB refresh.
      const patch = parsed as CleanupPatchFrame;
      applyPatchToAccumulated(contentParts, patch);
      onCleanupPatch?.(patch);
      return false;
    }
    if (chunk.bigimagine_reasoning === true) {
      // Reasoning-block frame (reasoning-blocks-plan.md) — one slice of the model's accumulated
      // reasoning span, relayed in arrival order. Deliberately NOT content: it never enters the
      // contentParts accumulation (the resolved content stays de-tagged); keep reading.
      onReasoningDelta?.(parsed as ReasoningFrame);
      return false;
    }
    if (chunk.id) id = chunk.id;
    if (chunk.created) created = chunk.created;
    if (chunk.model) model = chunk.model;
    const deltaContent = chunk.choices?.[0]?.delta?.content;
    if (typeof deltaContent === 'string') {
      contentParts.push(deltaContent);
      onDelta(deltaContent);
    }
    return false;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.startsWith('data: ')) {
        if (handleDataPayload(line.slice('data: '.length))) {
          // [DONE] seen — stop reading the body entirely; the turn is persisted server-side.
          await reader.cancel().catch(() => {});
          return { id, created: created || Math.floor(Date.now() / 1000), model, content: contentParts.join('') };
        }
      }
    }
  }
  return { id, created: created || Math.floor(Date.now() / 1000), model, content: contentParts.join('') };
}

/** Splices a cleanup patch into the delta-accumulated parts, in frame order. The patch
 *  coordinates are in server-composed-buffer space, and the parts array mirrors that buffer
 *  (every delta pushed, every patch spliced, in arrival order), so the coordinates are valid
 *  against the joined text. The joined result becomes the single accumulated part — later
 *  patches and deltas still line up, because the buffer they were computed against moved with
 *  ours. String slicing clamps out-of-range arguments, so an unexpected coordinate can never
 *  throw here. */
function applyPatchToAccumulated(
  parts: string[],
  patch: { start: number; end: number; replacement: string },
): void {
  const joined = parts.join('');
  parts.length = 0;
  parts.push(joined.slice(0, patch.start) + patch.replacement + joined.slice(patch.end));
}

/** GET /v1/chat/status — polled by ChatView while `sending` is true, alongside the still-in-flight
 *  chatCompletion POST above (not a replacement for it — see that function's own note on why this
 *  is a separate call at all). Since robust-chat-turns-plan.md the response carries two fields:
 *  `status` (the "still thinking" hint — which tool runTurn is currently running, null when none
 *  is: not started yet, the turn already finished, or the reply needed no tools this round) and
 *  `active` (the real "is a turn running" answer from the server-side per-chat interactive-turn
 *  lock, true for the whole turn including the RP streaming lane). A failed poll degrades to
 *  "not active / no status" rather than throwing — best-effort, keep-last-known-state. */
export async function getChatTurnStatus(chatId: string, apiKey: string | null): Promise<{ status: string | null; active: boolean }> {
  const res = await fetch(`/v1/chat/status?chat_id=${encodeURIComponent(chatId)}`, { headers: authHeaders(apiKey) });
  if (!res.ok) return { status: null, active: false };
  const body = (await res.json()) as { status: string | null; active: boolean };
  return body;
}

/** POST /v1/chat/abort — the Stop button's client side: asks the orchestrator to abort the LLM
 *  turn (and any cleanup repair) currently in flight for this chat, server-side — the only way
 *  to actually stop generation, since /v1/chat/completions is one blocking non-streaming POST
 *  and killing the client's own fetch would just orphan the server-side turn (see
 *  orchestrator/turnAbort.ts). 404 = nothing was in flight (turn already finished or never
 *  started — a normal race, not an error) and the function returns false. */
export async function abortTurn(chatId: string, apiKey: string | null): Promise<boolean> {
  const res = await fetch('/v1/chat/abort', {
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId }),
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return true;
}

async function jsonRequest<T>(path: string, apiKey: string | null, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: { ...authHeaders(apiKey), ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return res.json() as Promise<T>;
}

export async function listChats(apiKey: string | null, search?: string, kind?: 'chat' | 'rp'): Promise<ChatSummary[]> {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (kind) params.set('kind', kind);
  const query = params.toString() ? `?${params.toString()}` : '';
  const body = await jsonRequest<{ chats: ChatSummary[] }>(`/v1/chats${query}`, apiKey);
  return body.chats;
}

export function createChat(
  apiKey: string | null,
  init?: { title?: string; folder_id?: string; kind?: 'chat' | 'rp' },
): Promise<ChatSessionRow> {
  return jsonRequest<ChatSessionRow>('/v1/chats', apiKey, { method: 'POST', body: init ?? {} });
}

export function getChat(chatId: string, apiKey: string | null): Promise<ChatDetail> {
  return jsonRequest<ChatDetail>(`/v1/chats/${encodeURIComponent(chatId)}`, apiKey);
}

/** One side of the chat-background layer (endpoint.md §6.4): a location + its rendered image
 *  URL. imageUrl null is only legal on `current` — the location exists but its image hasn't
 *  rendered yet (the post-turn bg pass is still in flight, endpoint.md §5). definition is the
 *  location's logical definition (the describer pass's "Definition:" half, describer.md) —
 *  null when never written. */
export interface ChatLocationImage {
  locationId: string;
  name: string;
  definition: string | null;
  imageUrl: string | null;
}

/** GET /v1/chats/:id/location-image — the chat-background layer (endpoint.md §6.4): the current
 *  eligible location (scene_id pointer with an active-swipe fallback) plus the last settled one
 *  (endpoint.md §5.1.8's last-turn location state — the revert target shown while the current
 *  render is pending or after a swipe). current.imageUrl null = the location exists but its
 *  image hasn't rendered yet — the Chat View keeps the previous background up until the pending
 *  render replaces it. previous is only non-null when it has an image to show ("some background
 *  is better than no background even if stale"). Both null = no location at all. */
export async function getChatLocationImage(
  chatId: string,
  apiKey: string | null,
): Promise<{ current: ChatLocationImage | null; previous: ChatLocationImage | null }> {
  return jsonRequest(`/v1/chats/${encodeURIComponent(chatId)}/location-image`, apiKey);
}

/** GET /v1/chat-background-settings — the ChatView location-background controls (parallax
 *  toggle + the overlay/bubble FX, parallax_fade_teststep.md §2.2 + migration 0073), same
 *  household-key/Access auth as getTimezone: ChatView reads them live at chat load, before
 *  anyone would have entered the separate admin key. Defaults when unset. */
export async function getChatBackgroundSettings(apiKey: string | null): Promise<ChatBackgroundSettings> {
  const res = await fetch('/v1/chat-background-settings', { headers: authHeaders(apiKey) });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return (await res.json()) as ChatBackgroundSettings;
}

/** GET /v1/chat-legibility-settings — the ChatView "Text legibility" toggle set (migration
 *  0074), same household-key/Access auth as getChatBackgroundSettings: ChatView reads it live at
 *  chat load. Defaults false when unset (opt-in look). */
export async function getChatLegibilitySettings(apiKey: string | null): Promise<ChatLegibilitySettings> {
  const res = await fetch('/v1/chat-legibility-settings', { headers: authHeaders(apiKey) });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return (await res.json()) as ChatLegibilitySettings;
}

/** POST /v1/locations/:id/image-broken (endpoint.md §5.2) — the Chat View's background <img>
 *  onError notifies the server that the CDN link 404'd/expired; the server clears image_url so the
 *  next visit's cache check sees a miss and re-renders a fresh URL. */
export async function reportBrokenLocationImage(locationId: string, apiKey: string | null): Promise<void> {
  await jsonRequest<{ cleared: boolean }>(`/v1/locations/${encodeURIComponent(locationId)}/image-broken`, apiKey, {
    method: 'POST',
    body: {},
  });
}

/** GET /v1/chats/:id/prompt-preview — the exact prompts an 'rp' chat's last turn fired: the main
 *  prompt captured at send time (falling back to a live next-turn preview when nothing has been
 *  captured yet) plus any background prompts (cleanup, title, …), itemized
 *  (httpServer.ts's buildPromptPreview), for the Prompt Inspector panel. 422s for a non-'rp' chat
 *  — the caller is expected to only offer this for RP. */
export function getPromptPreview(chatId: string, apiKey: string | null): Promise<PromptPreview> {
  return jsonRequest<PromptPreview>(`/v1/chats/${encodeURIComponent(chatId)}/prompt-preview`, apiKey);
}

/** GET /v1/chats/:id/lineage — the whole fork family this chat belongs to, root first. The Branch
 *  Map panel's data source; see ChatSessionStore.getLineage's own doc for exactly what "family"
 *  means. */
export async function getChatLineage(chatId: string, apiKey: string | null): Promise<ChatLineageNode[]> {
  const body = await jsonRequest<{ nodes: ChatLineageNode[] }>(`/v1/chats/${encodeURIComponent(chatId)}/lineage`, apiKey);
  return body.nodes;
}

/** GET /v1/chats/:id/sync-status — this chat's slice of the rolling sync loop's status record
 *  (io/chatSessions.ts getChatSyncStatus): the data behind the chat settings rail's collapsible
 *  Sync status set (ChatView.tsx's ChatSyncSet). Unlike the admin-gated
 *  /v1/admin/chat-memory-sync-status, this one is user-scoped — no admin key needed to look at
 *  your own chat's sync history. */
export async function getChatSyncStatus(chatId: string, apiKey: string | null): Promise<ChatSyncStatus> {
  const body = await jsonRequest<{ sync: ChatSyncStatus }>(`/v1/chats/${encodeURIComponent(chatId)}/sync-status`, apiKey);
  return body.sync;
}

/** GET /v1/chats/:id/syncs/:syncId — one sync point's full inspection record (io/chatSessions.ts
 *  getChatSyncInspection, 0079): the memory entries that sync created/changed, the canon-fact
 *  proposals it wrote, and the bridge prompt it sent. Fetched on demand when the Sync Status
 *  panel expands a sync row, so the 30s status poll stays summary-only. */
export async function getChatSyncInspection(
  chatId: string,
  syncId: string,
  apiKey: string | null,
): Promise<ChatSyncInspection> {
  const body = await jsonRequest<{ sync: ChatSyncInspection }>(
    `/v1/chats/${encodeURIComponent(chatId)}/syncs/${encodeURIComponent(syncId)}`,
    apiKey,
  );
  return body.sync;
}

export function updateChat(
  chatId: string,
  patch: {
    title?: string;
    folder_id?: string | null;
    params?: ChatParams;
    tool_names?: string[] | null;
    canvas_note_id?: string | null;
    /** The context_stack_presets row the turn-loop cleanup pass runs for this chat; null turns
     *  the pass off. Same preset selection shape as the Prompt stack picker.
     *  @deprecated retirement in progress — superseded by cleanup_enabled_at (the async
     *  heuristic subloop); kept only so the Chat Settings toggle can clear a legacy value. */
    cleanup_preset_id?: string | null;
    /** Toggle the async heuristic cleanup subloop: an ISO timestamp = enabled (the loop only
     *  processes messages created after it), null = off. RP chats only, by loop policy. */
    cleanup_enabled_at?: string | null;
  },
  apiKey: string | null,
): Promise<ChatSessionRow> {
  return jsonRequest<ChatSessionRow>(`/v1/chats/${encodeURIComponent(chatId)}`, apiKey, { method: 'POST', body: patch });
}

export function deleteChat(chatId: string, apiKey: string | null): Promise<{ deleted: boolean }> {
  return jsonRequest<{ deleted: boolean }>(`/v1/chats/${encodeURIComponent(chatId)}`, apiKey, { method: 'DELETE' });
}

/** Removes exactly one message, wherever it falls in the conversation — the Chat tab's standalone
 *  delete action. Everything else in the chat is untouched. */
export function deleteMessage(chatId: string, messageId: string, apiKey: string | null): Promise<{ deleted: boolean }> {
  return jsonRequest<{ deleted: boolean }>(
    `/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
    apiKey,
    { method: 'DELETE' },
  );
}

/** Removes the given message and everything chronologically after it — "edit"'s primitive
 *  (truncate the edited message, then resend with new content). Caller is responsible for the
 *  resend; this only clears room for it. */
export function truncateMessagesFrom(
  chatId: string,
  messageId: string,
  apiKey: string | null,
): Promise<{ truncated: boolean }> {
  return jsonRequest<{ truncated: boolean }>(
    `/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/truncate`,
    apiKey,
    { method: 'POST' },
  );
}

/** In-place content rewrite of an already-persisted message — the Chat tab's "edit an LLM reply"
 *  action. Unlike truncateMessagesFrom's user-edit flow, the message keeps its id, everything
 *  chronologically after it is untouched, and the pre-edit text is preserved as a swipe (the
 *  original reply stays one ‹ away when this is the last message). */
export function editMessageContent(
  chatId: string,
  messageId: string,
  content: string,
  apiKey: string | null,
): Promise<{ message: StoredChatMessage }> {
  return jsonRequest<{ message: StoredChatMessage }>(
    `/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/edit`,
    apiKey,
    { method: 'POST', body: { content } },
  );
}

export type SwipeResult = { message: StoredChatMessage } | { status: 'no_earlier_swipe' | 'no_further_swipe' };

/** Swipe capability on the last LLM response — messageId must be the chat's current last message.
 *  'prev'/'next' mostly just swap to an already-stored variant (no LLM call); 'next' past the
 *  newest stored variant triggers a fresh in-place regeneration instead — this is also what
 *  "Rerun" is now, so the Rerun button just calls this with direction: 'next'.
 *
 *  Streaming regeneration (onDelta provided): only meaningful for the direction 'next'
 *  needs_regenerate case, where the request body gains `stream: true` and the response is the
 *  same SSE chunk framing as chatCompletion's streaming mode (see consumeSseCompletionStream) —
 *  there is no SwipeResult JSON on the wire. The streamed text is recordSwipe'd server-side by
 *  the time [DONE] arrives, so the caller should refresh the canonical row afterward; the
 *  returned minimal message carries the accumulated content for immediate display. Reasoning
 *  blocks arrive as bigimagine_reasoning frames and are reported through onReasoningDelta (they
 *  never enter the content accumulation); the persisted reasoning is available on the refreshed
 *  row. prev/next cycling (no LLM call) is unaffected — passing onDelta there is a no-op on the
 *  response shape. */
export async function swipeMessage(
  chatId: string,
  messageId: string,
  direction: 'prev' | 'next',
  apiKey: string | null,
  onDelta?: (textDelta: string) => void,
  onTerminalFrame?: (frame: StreamingTerminalFrame) => void,
  onCleanupStatus?: (frame: CleanupStatusFrame) => void,
  onCleanupPatch?: (frame: CleanupPatchFrame) => void,
  onReasoningDelta?: (frame: ReasoningFrame) => void,
): Promise<SwipeResult> {
  const path = `/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/swipe`;
  if (!onDelta) {
    return jsonRequest<SwipeResult>(path, apiKey, { method: 'POST', body: { direction } });
  }
  const res = await fetch(path, {
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'content-type': 'application/json' },
    body: JSON.stringify({ direction, stream: true }),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    // Defensive fallback (principle §6 at the HTTP boundary): a buffered SwipeResult JSON — only
    // possible if a proxy or the server decided not to stream; surface it as one whole-reply
    // delta, matching chatCompletion's equivalent fallback.
    const buffered = (await res.json()) as SwipeResult;
    if ('message' in buffered && buffered.message?.content) onDelta(buffered.message.content);
    return buffered;
  }
  const { content } = await consumeSseCompletionStream(res, onDelta, onTerminalFrame, onCleanupStatus, onCleanupPatch, onReasoningDelta);
  return { message: { messageId, role: 'assistant', content, createdAt: new Date().toISOString() } };
}

/** Branches a new chat from this one at fromMessageId (inclusive) — docs/chat-memory.md. Returns
 *  the new chat's session row; the caller is responsible for switching a tab/view to it. */
export function forkChat(
  chatId: string,
  fromMessageId: string,
  apiKey: string | null,
  title?: string,
): Promise<ChatSessionRow> {
  return jsonRequest<ChatSessionRow>(`/v1/chats/${encodeURIComponent(chatId)}/fork`, apiKey, {
    method: 'POST',
    body: { from_message_id: fromMessageId, ...(title ? { title } : {}) },
  });
}

/** Marks a chat as done — the explicit signal that triggers its end-of-chat long-term-memory
 *  extraction (docs/chat-memory.md, docs/bb_principles.md §3). The extraction itself runs
 *  server-side after this returns; there's nothing further for the caller to await. */
export function archiveChat(chatId: string, apiKey: string | null): Promise<ChatSessionRow> {
  return jsonRequest<ChatSessionRow>(`/v1/chats/${encodeURIComponent(chatId)}/archive`, apiKey, { method: 'POST' });
}

export async function listFolders(apiKey: string | null): Promise<Folder[]> {
  const body = await jsonRequest<{ folders: Folder[] }>('/v1/folders', apiKey);
  return body.folders;
}

export function createFolder(name: string, apiKey: string | null): Promise<Folder> {
  return jsonRequest<Folder>('/v1/folders', apiKey, { method: 'POST', body: { name } });
}

export function deleteFolder(folderId: string, apiKey: string | null): Promise<{ deleted: boolean }> {
  return jsonRequest<{ deleted: boolean }>(`/v1/folders/${encodeURIComponent(folderId)}`, apiKey, { method: 'DELETE' });
}

/** Registered tool names — used by the per-chat tool checklist. */
export async function listToolNames(apiKey: string | null): Promise<string[]> {
  const body = await jsonRequest<{ names: string[] }>('/v1/tools', apiKey);
  return body.names;
}

/** adminKey is null under Cloudflare Access SSO — httpServer.ts's isAdminAuthorized trusts any
 *  Access identity that already cleared the hostname, same as the household routes, so no
 *  manually-typed admin key is needed there. Only deployments without Access configured (or
 *  non-browser callers) need to supply the static BIGBRAIN_ADMIN_API_KEY. */
export async function adminListCredentials(adminKey: string | null): Promise<CredentialSummary[]> {
  const res = await fetch('/v1/admin/credentials', { headers: authHeaders(adminKey) });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  const body = (await res.json()) as { credentials: CredentialSummary[] };
  return body.credentials;
}

/** Resolves once the save is accepted (202) — the orchestrator restarts a moment later
 *  (restart-on-save, see adminServer.ts) to pick up the new value at boot. */
export async function adminSetCredential(name: string, value: string, adminKey: string | null): Promise<void> {
  const res = await fetch('/v1/admin/credentials', {
    method: 'POST',
    headers: { ...authHeaders(adminKey), 'content-type': 'application/json' },
    body: JSON.stringify({ name, value }),
  });
  if (res.status !== 202) throw new ApiError(res.status, await parseErrorBody(res));
}

/** The Connections tab's full list — every admin-managed connection, redacted (no apiKey field at
 *  all; see LlmConnectionSummary). */
export async function adminListConnections(adminKey: string | null): Promise<LlmConnectionSummary[]> {
  const body = await jsonRequest<{ connections: LlmConnectionSummary[] }>('/v1/admin/connections', adminKey);
  return body.connections;
}

export function adminCreateConnection(input: CreateConnectionInput, adminKey: string | null): Promise<LlmConnectionSummary> {
  return jsonRequest<LlmConnectionSummary>('/v1/admin/connections', adminKey, { method: 'POST', body: input });
}

/** Only send the fields actually changing — apiKey omitted leaves the stored key untouched
 *  (write-only, never round-tripped back for editing). */
export function adminUpdateConnection(
  id: string,
  patch: UpdateConnectionInput,
  adminKey: string | null,
): Promise<LlmConnectionSummary> {
  return jsonRequest<LlmConnectionSummary>(`/v1/admin/connections/${encodeURIComponent(id)}`, adminKey, {
    method: 'PATCH',
    body: patch,
  });
}

/** 409s (thrown as ApiError) if `id` is the currently active connection — activate a different one
 *  first, same "explicit successor" shape the old Settings picker's restart-required switch implied. */
export async function adminDeleteConnection(id: string, adminKey: string | null): Promise<void> {
  await jsonRequest<{ deleted: boolean }>(`/v1/admin/connections/${encodeURIComponent(id)}`, adminKey, { method: 'DELETE' });
}

/** Resolves once the save is accepted (202) — the orchestrator restarts a moment later to boot
 *  against the newly active connection (deps.llm is a boot-time singleton, bi_principles.md §14),
 *  same restart-on-save shape as adminSetCredential. */
export async function adminActivateConnection(id: string, adminKey: string | null): Promise<void> {
  const res = await fetch(`/v1/admin/connections/${encodeURIComponent(id)}/activate`, {
    method: 'POST',
    headers: authHeaders(adminKey),
  });
  if (res.status !== 202) throw new ApiError(res.status, await parseErrorBody(res));
}

/** The model catalog for one saved connection — even one that isn't currently active — so the
 *  Connections tab can populate its model dropdown once a connection exists. defaultModel is that
 *  connection's own stored model, a sensible pre-selection. */
export async function adminListConnectionModels(id: string, adminKey: string | null): Promise<ProfileModelsResult> {
  return jsonRequest<ProfileModelsResult>(`/v1/admin/connections/${encodeURIComponent(id)}/models`, adminKey);
}

/** The upstream inference providers OpenRouter can route one named model to — undefined
 *  connections (anything not OpenRouter) 404, surfaced to the caller as a thrown ApiError rather
 *  than an empty list, so the UI can tell "no such provider catalog" apart from "this model has
 *  no providers" (which shouldn't happen for a model the catalog itself returned). */
export async function adminListConnectionProviders(
  id: string,
  modelId: string,
  adminKey: string | null,
): Promise<ModelProvidersResult> {
  return jsonRequest<ModelProvidersResult>(
    `/v1/admin/connections/${encodeURIComponent(id)}/providers?model=${encodeURIComponent(modelId)}`,
    adminKey,
  );
}

/** Fires one cheap, capped-tokens real call through this saved connection. Resolves with
 *  { ok: false, error } rather than throwing when the provider call itself fails (bad key/model/
 *  baseUrl) — that's exactly the failure this button exists to surface; only a genuine route error
 *  (id not found, network failure reaching the orchestrator) throws. */
export async function adminTestConnection(id: string, adminKey: string | null): Promise<ConnectionTestResult> {
  return jsonRequest<ConnectionTestResult>(`/v1/admin/connections/${encodeURIComponent(id)}/test`, adminKey, { method: 'POST' });
}

/** The Connections tab's image section full list (io/imageConnections.ts, endpoint.md §3) — every
 *  admin-managed image generation connection, redacted (no apiKey field; hasApiKey instead, since
 *  keyless providers legitimately have none). */
export async function adminListImageConnections(adminKey: string | null): Promise<ImageConnectionSummary[]> {
  const body = await jsonRequest<{ connections: ImageConnectionSummary[] }>('/v1/admin/image-connections', adminKey);
  return body.connections;
}

/** GET /v1/admin/llm-stats?days=N — the Stats view's Usage & Cost read (llm-stats-page-plan.md).
 *  days is a bounded lookback (server clamps to [1, 365]); the view defaults to 30 like the
 *  endpoint's own default. */
export async function adminListLlmStats(adminKey: string | null, days = 30): Promise<LlmCallStatRow[]> {
  const body = await jsonRequest<{ calls: LlmCallStatRow[] }>(`/v1/admin/llm-stats?days=${days}`, adminKey);
  return body.calls;
}

/** GET /v1/admin/turn-display-stats?days=N — the Stats view's Timing read; same days semantics. */
export async function adminListTurnDisplayStats(adminKey: string | null, days = 30): Promise<TurnDisplayMetricRow[]> {
  const body = await jsonRequest<{ turns: TurnDisplayMetricRow[] }>(`/v1/admin/turn-display-stats?days=${days}`, adminKey);
  return body.turns;
}

/** GET /v1/chats/:chatId/turn-display-metrics/latest — the chat drawer Timing section's durable
 *  "last turn" read (docs/plans/turn-timeline-graph-plan.md): the newest recorded turn for this
 *  chat from the table, or null when it has none. Regular chat auth (not admin) — a user's own
 *  chat's timing is no more sensitive than the chat itself. */
export async function getLatestTurnDisplayMetric(chatId: string, apiKey: string | null): Promise<TurnDisplayMetricRow | null> {
  const body = await jsonRequest<{ turn: TurnDisplayMetricRow | null }>(
    `/v1/chats/${encodeURIComponent(chatId)}/turn-display-metrics/latest`,
    apiKey,
  );
  return body.turn;
}

/** POST /v1/turn-display-metrics — fire-and-forget timing record, regular chat auth (not admin).
 *  A duplicate message_id resolves as { recorded: false } (idempotent no-op); both shapes mean
 *  "recorded or already known", never an error the recorder has to interpret. */
export async function postTurnDisplayMetrics(
  input: TurnDisplayMetricsInput,
  apiKey: string | null,
): Promise<{ recorded: boolean }> {
  return jsonRequest<{ recorded: boolean }>('/v1/turn-display-metrics', apiKey, { method: 'POST', body: input });
}

export function adminCreateImageConnection(
  input: CreateImageConnectionInput,
  adminKey: string | null,
): Promise<ImageConnectionSummary> {
  return jsonRequest<ImageConnectionSummary>('/v1/admin/image-connections', adminKey, { method: 'POST', body: input });
}

/** Only send the fields actually changing — apiKey omitted leaves the stored key untouched
 *  (write-only, never round-tripped back for editing). */
export function adminUpdateImageConnection(
  id: string,
  patch: UpdateImageConnectionInput,
  adminKey: string | null,
): Promise<ImageConnectionSummary> {
  return jsonRequest<ImageConnectionSummary>(`/v1/admin/image-connections/${encodeURIComponent(id)}`, adminKey, {
    method: 'PATCH',
    body: patch,
  });
}

/** 409s (thrown as ApiError) if `id` is the currently active image connection — activate a
 *  different one first. */
export async function adminDeleteImageConnection(id: string, adminKey: string | null): Promise<void> {
  await jsonRequest<{ deleted: boolean }>(`/v1/admin/image-connections/${encodeURIComponent(id)}`, adminKey, { method: 'DELETE' });
}

/** Resolves immediately (200, no restart): the active image connection is resolved live on every
 *  generation call (endpoint.md §5.1.3, bi_principles.md §13), so the switch takes effect on the
 *  next render — unlike LLM connections, which restart because deps.llm is a boot-time singleton. */
export async function adminActivateImageConnection(id: string, adminKey: string | null): Promise<void> {
  await jsonRequest<{ activated: boolean }>(`/v1/admin/image-connections/${encodeURIComponent(id)}/activate`, adminKey, {
    method: 'POST',
  });
}

/** Fires endpoint.md §3.3's diagnostic probe through this saved connection — resolves with
 *  { ok: false, error } rather than throwing when the provider call itself fails (bad key/model/
 *  baseUrl/unreachable endpoint); only a genuine route error (id not found) throws. */
export async function adminTestImageConnection(id: string, adminKey: string | null): Promise<ImageConnectionTestResult> {
  return jsonRequest<ImageConnectionTestResult>(`/v1/admin/image-connections/${encodeURIComponent(id)}/test`, adminKey, {
    method: 'POST',
  });
}

/** The master image prompt template (endpoint.md §2.2) — read live per generation; an empty
 *  template means "use the built-in default" (bi_principles.md §17). */
export async function adminGetImageSettings(adminKey: string | null): Promise<ImageSettings> {
  return jsonRequest<ImageSettings>('/v1/admin/image-settings', adminKey);
}

export function adminSetImageSettings(
  patch: { template?: string; describer_prompt?: string; describer_history_pairs?: string },
  adminKey: string | null,
): Promise<ImageSettings> {
  return jsonRequest<ImageSettings>('/v1/admin/image-settings', adminKey, { method: 'POST', body: patch });
}

/** GET /v1/admin/location-settings — the Locations page's unified tracker settings (location.md
 *  §6.3): split/injection toggles, the known-locations block prompt, and the room describer's
 *  prompt/history-pairs (moved here from the Backgrounds page, migration 0083; the image-settings
 *  endpoint still accepts the describer_* keys for back-compat). Admin-gated like every
 *  Settings-tab GET. */
export function adminGetLocationSettings(adminKey: string | null): Promise<LocationSettings> {
  return jsonRequest<LocationSettings>('/v1/admin/location-settings', adminKey);
}

/** POST /v1/admin/location-settings — partial patch (any subset of split_enabled,
 *  injection_enabled, injection_prompt, describer_prompt, describer_history_pairs); the server
 *  rejects a body with zero fields or wrong-typed values. Returns the full updated set. No
 *  restart: the scraper and the marker-slot renderer read the values live. */
export function adminSetLocationSettings(
  patch: {
    split_enabled?: boolean;
    injection_enabled?: boolean;
    injection_prompt?: string;
    describer_prompt?: string;
    describer_history_pairs?: string;
  },
  adminKey: string | null,
): Promise<LocationSettings> {
  return jsonRequest<LocationSettings>('/v1/admin/location-settings', adminKey, { method: 'POST', body: patch });
}

/** GET /v1/admin/locations — the Locations page's read-only known-locations browser (location.md
 *  §6.2.4), cross-user roster: every location with its parent place (parent_location_id) and
 *  lifecycle status. No POST counterpart — the tracker owns row creation. */
export async function adminGetLocationsAdmin(adminKey: string | null): Promise<LocationAdminRow[]> {
  const body = await jsonRequest<{ locations: LocationAdminRow[] }>('/v1/admin/locations', adminKey);
  return body.locations;
}

/** GET /v1/admin/chat-background-settings — the SettingsView "Chat Background" fieldset's saved
 *  values (parallax_fade_teststep.md §2.2 + migration 0073), admin-gated like every other
 *  Settings-tab GET. */
export function adminGetChatBackgroundSettings(adminKey: string | null): Promise<ChatBackgroundSettings> {
  return jsonRequest<ChatBackgroundSettings>('/v1/admin/chat-background-settings', adminKey);
}

/** POST /v1/admin/chat-background-settings — the SettingsView "Chat Background" fieldset
 *  (parallax_fade_teststep.md §2.2 + migration 0073). Sends the full settings object (the
 *  server treats it as a partial patch). No restart: ChatView re-reads the values live at chat
 *  load. */
export function adminSetChatBackgroundSettings(
  value: ChatBackgroundSettings,
  adminKey: string | null,
): Promise<ChatBackgroundSettings> {
  return jsonRequest<ChatBackgroundSettings>('/v1/admin/chat-background-settings', adminKey, {
    method: 'POST',
    body: value,
  });
}

/** POST /v1/admin/chat-legibility-settings — the ChatView "Text legibility" menu's write side
 *  (migration 0074): the collapsible menu in the chat settings rail POSTs each toggle
 *  immediately, no Save button. Partial patch (any subset of the five booleans); the server
 *  rejects a body with zero fields or non-boolean values. Returns the full updated set. */
export function adminSetChatLegibilitySettings(
  patch: ChatLegibilitySettingsPatch,
  adminKey: string | null,
): Promise<ChatLegibilitySettings> {
  return jsonRequest<ChatLegibilitySettings>('/v1/admin/chat-legibility-settings', adminKey, {
    method: 'POST',
    body: patch,
  });
}

/** The household's IANA timezone (defaults to "UTC" server-side until ever set) — used to tell
 *  the LLM the actual current date/time on every chat turn (orchestrator's util/dateContext.ts).
 *  Unlike the connection picker, changing this needs no restart. */
export async function adminGetTimezone(adminKey: string | null): Promise<string> {
  const res = await fetch('/v1/admin/timezone', { headers: authHeaders(adminKey) });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  const body = (await res.json()) as { timezone: string };
  return body.timezone;
}

/** Resolves once saved — no restart, no polling; the very next chat turn reads it live. */
export async function adminSetTimezone(timezone: string, adminKey: string | null): Promise<void> {
  const res = await fetch('/v1/admin/timezone', {
    method: 'POST',
    headers: { ...authHeaders(adminKey), 'content-type': 'application/json' },
    body: JSON.stringify({ value: timezone }),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
}

/** POST /v1/characters/import — imports a character from an uploaded card PNG or JSON file.
 *  `content-type` omitted for the same reason uploadAttachment omits it: FormData needs the
 *  browser to set its own multipart boundary. */
export async function importCharacterCard(file: File, apiKey: string | null): Promise<ImportedCharacter> {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetch('/v1/characters/import', {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: form,
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return res.json() as Promise<ImportedCharacter>;
}

/** GET /v1/characters/:id/export.{png,json} — triggers a browser download via a throwaway object
 *  URL. A plain `<a href>` can't carry the Authorization header a 'key'-mode session needs, same
 *  constraint uploadAttachment works around for the opposite (upload) direction; fetching the
 *  bytes ourselves and revoking the object URL right after the click is the same workaround. */
export async function exportCharacterCard(characterId: string, format: 'png' | 'json', apiKey: string | null): Promise<void> {
  const res = await fetch(`/v1/characters/${encodeURIComponent(characterId)}/export.${format}`, {
    headers: authHeaders(apiKey),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  const disposition = res.headers.get('content-disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `character.${format}`;
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(objectUrl);
}

/** GET /v1/characters/:id/avatar, as an object URL the caller must revoke when done with it —
 *  the Roster list's thumbnails and the editor pane's preview both need this rather than a plain
 *  `<img src>`, since a 'key'-mode session's Authorization header can't travel on an <img> tag.
 *  Null (not a throw) when the character has no avatar, since that's the common case, not an
 *  error. */
export async function fetchCharacterAvatarUrl(characterId: string, apiKey: string | null): Promise<string | null> {
  const res = await fetch(`/v1/characters/${encodeURIComponent(characterId)}/avatar`, {
    headers: authHeaders(apiKey),
  });
  if (!res.ok) return null;
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/** GET /v1/characters/chub-avatar?url= — same authenticated-blob-fetch shape as
 *  fetchCharacterAvatarUrl, for BrowseChubView.tsx's search-result grid: a chub.ai avatar_url
 *  can't go on a plain <img src> either (the household-key Authorization header wouldn't travel),
 *  and the server-side route enforces its own chub-CDN host allowlist regardless of what URL is
 *  passed here. Null (not a throw) on failure, same "common enough to not be an error" reasoning
 *  as a character with no avatar. */
export async function fetchChubAvatarUrl(chubAvatarUrl: string, apiKey: string | null): Promise<string | null> {
  const res = await fetch(`/v1/characters/chub-avatar?url=${encodeURIComponent(chubAvatarUrl)}`, {
    headers: authHeaders(apiKey),
  });
  if (!res.ok) return null;
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/** GET /v1/characters/chub-detail?fullPath= — the full card detail (description, bespoke
 *  `definition` object, maxResUrl) behind ChubCardModal.tsx's embiggened view. Unlike
 *  fetchChubAvatarUrl this throws on failure: a card the user explicitly clicked deserves a
 *  visible error, not a silent null. */
export async function fetchChubCardDetail(fullPath: string, apiKey: string | null): Promise<ChubCardDetail> {
  const res = await fetch(`/v1/characters/chub-detail?fullPath=${encodeURIComponent(fullPath)}`, {
    headers: authHeaders(apiKey),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return (await res.json()) as ChubCardDetail;
}

/** GET /v1/characters/chub-avatar?url= — same allowlisted-CDN proxy fetch as fetchChubAvatarUrl,
 *  but for the card PNG behind the modal's Download button, and throwing with the server's reason
 *  on failure (an explicit download deserves an explicit error, not a silent null). */
export async function fetchChubCardPng(chubCardUrl: string, apiKey: string | null): Promise<Blob> {
  const res = await fetch(`/v1/characters/chub-avatar?url=${encodeURIComponent(chubCardUrl)}`, {
    headers: authHeaders(apiKey),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return res.blob();
}

/** pia_proxy_url (stacks/pia-proxy) — same no-restart, admin-only shape as timezone. */
export async function adminGetPiaProxyUrl(adminKey: string | null): Promise<string | null> {
  const res = await fetch('/v1/admin/pia-proxy-settings', { headers: authHeaders(adminKey) });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  const body = (await res.json()) as { url: string | null };
  return body.url;
}

/** Resolves once saved — no restart, no polling; the next chub import/search call reads it live. */
export async function adminSetPiaProxyUrl(url: string, adminKey: string | null): Promise<void> {
  const res = await fetch('/v1/admin/pia-proxy-settings', {
    method: 'POST',
    headers: { ...authHeaders(adminKey), 'content-type': 'application/json' },
    body: JSON.stringify({ value: url }),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
}

/** persona_name/persona_description (docs/plans/prompt-macros.md's Stage 1) — the household's own name
 *  and self-description, folded into a chat's prompt stack when a preset enables the 'persona'
 *  marker slot. Same no-restart, admin-authed shape as pia_proxy_url. */
export async function adminGetPersonaSettings(adminKey: string | null): Promise<PersonaSettings> {
  const res = await fetch('/v1/admin/persona-settings', { headers: authHeaders(adminKey) });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return res.json() as Promise<PersonaSettings>;
}

export async function adminSetPersonaSettings(body: { name?: string; description?: string }, adminKey: string | null): Promise<PersonaSettings> {
  const res = await fetch('/v1/admin/persona-settings', {
    method: 'POST',
    headers: { ...authHeaders(adminKey), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return res.json() as Promise<PersonaSettings>;
}

/** ntfy_server_url/notifications_enabled (plugins/notifications) — same no-restart shape as
 *  timezone: send_push_notification reads both live on every call. */
export async function adminGetNotificationSettings(adminKey: string | null): Promise<NotificationSettings> {
  const res = await fetch('/v1/admin/notification-settings', { headers: authHeaders(adminKey) });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return res.json() as Promise<NotificationSettings>;
}

/** Resolves once saved — no restart, no polling; the next send_push_notification call reads it live. */
export async function adminSetNotificationSettings(
  patch: { server_url?: string; enabled?: boolean },
  adminKey: string | null,
): Promise<void> {
  const res = await fetch('/v1/admin/notification-settings', {
    method: 'POST',
    headers: { ...authHeaders(adminKey), 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
}

/** The Settings tab's own read/write of the screen-lock fields — admin-gated, unlike
 *  getScreenLockSettings above. Resolves once saved — no restart, the overlay's next poll picks
 *  it up live. */
export async function adminGetScreenLockSettings(adminKey: string | null): Promise<ScreenLockSettings> {
  const res = await fetch('/v1/admin/screen-lock-settings', { headers: authHeaders(adminKey) });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return res.json() as Promise<ScreenLockSettings>;
}

export async function adminSetScreenLockSettings(
  patch: { password?: string; timeout_minutes?: number },
  adminKey: string | null,
): Promise<void> {
  const res = await fetch('/v1/admin/screen-lock-settings', {
    method: 'POST',
    headers: { ...authHeaders(adminKey), 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
}

/** docs/chat-memory.md — mirrors SillyTavern-Canonize's own "Connections & Prompts" panel: a
 *  connection override for the rolling-sync pipeline plus a "default + bespoke" prompt per stage.
 *  Same no-restart shape as timezone: chatMemorySync.ts reads all of this live on every tick. */
export async function adminGetChatMemorySettings(adminKey: string | null): Promise<ChatMemorySettings> {
  const res = await fetch('/v1/admin/chat-memory-settings', { headers: authHeaders(adminKey) });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return res.json() as Promise<ChatMemorySettings>;
}

/** The review panel's data source — read-only confirmation that the background sync loop
 *  (chunk/embed/distill) actually ran per chat, not a settings/editing endpoint. No POST
 *  counterpart. */
export async function adminGetChatMemorySyncStatus(adminKey: string | null): Promise<ChatMemorySyncStatusRow[]> {
  const res = await fetch('/v1/admin/chat-memory-sync-status', { headers: authHeaders(adminKey) });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  const body = (await res.json()) as { chats: ChatMemorySyncStatusRow[] };
  return body.chats;
}

/** docs/plans/chunk-size-resize-plan.md — triggers the one-time backfill that re-chunks every
 *  chat's archived history at the live chat_memory_chunk_pairs size. 202 = claimed and started
 *  (poll adminGetChunkResizeStatus for progress); 409 = a pass is already running. */
export async function adminTriggerChunkResize(adminKey: string | null): Promise<void> {
  const res = await fetch('/v1/admin/chat-memory-resize', { method: 'POST', headers: authHeaders(adminKey) });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
}

/** The resize pass's singleton progress row — polled by the Settings tab while a pass is
 *  running (chatsDone/chatsTotal advance per chat; status flips to 'done'/'error' at the end). */
export async function adminGetChunkResizeStatus(adminKey: string | null): Promise<ChunkResizeStatus> {
  const res = await fetch('/v1/admin/chat-memory-resize-status', { headers: authHeaders(adminKey) });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  const body = (await res.json()) as { resize: ChunkResizeStatus };
  return body.resize;
}

/** The Backgrounds tab's data source — read-only confirmation that the bg-gen pipeline
 *  (describer → render) actually ran per location, not a settings/editing endpoint. No POST
 *  counterpart. */
export async function adminGetLocationRenderStatus(adminKey: string | null): Promise<LocationRenderStatusRow[]> {
  const res = await fetch('/v1/admin/location-render-status', { headers: authHeaders(adminKey) });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  const body = (await res.json()) as { locations: LocationRenderStatusRow[] };
  return body.locations;
}

export async function adminGetCanonSettings(adminKey: string | null): Promise<CanonSettings> {
  const res = await fetch('/v1/admin/canon-settings', { headers: authHeaders(adminKey) });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return res.json() as Promise<CanonSettings>;
}

export async function adminSetCanonSettings(
  patch: { recall_top_k?: number; recall_min?: number; extraction_prompt?: string },
  adminKey: string | null,
): Promise<CanonSettings> {
  const res = await fetch('/v1/admin/canon-settings', {
    method: 'POST',
    headers: { ...authHeaders(adminKey), 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return res.json() as Promise<CanonSettings>;
}

// --- Lorebooks (docs/lorebook-plan.md §8a) ---
// Settings panel + library/editor CRUD, all admin-gated. Write bodies carry user_id (the owning
// user from the list rows) because books/entries are user-scoped RLS tables and the admin key
// only grants the cross-user read.

export async function adminGetLorebookSettings(adminKey: string | null): Promise<LorebookSettings> {
  const res = await fetch('/v1/admin/lorebook-settings', { headers: authHeaders(adminKey) });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return res.json() as Promise<LorebookSettings>;
}

export async function adminSetLorebookSettings(
  patch: {
    lorebook_mode?: 'on' | 'off';
    lorebook_token_budget?: number | null;
    lorebook_recall_top_k?: number;
    lorebook_recursion_enabled?: boolean;
  },
  adminKey: string | null,
): Promise<LorebookSettings> {
  const res = await fetch('/v1/admin/lorebook-settings', {
    method: 'POST',
    headers: { ...authHeaders(adminKey), 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return res.json() as Promise<LorebookSettings>;
}

export async function adminListLorebooks(adminKey: string | null): Promise<LorebookAdminRow[]> {
  const res = await fetch('/v1/admin/lorebooks', { headers: authHeaders(adminKey) });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  const body = (await res.json()) as { lorebooks: LorebookAdminRow[] };
  return body.lorebooks;
}

export async function adminCreateLorebook(
  body: { user_id: string; name: string },
  adminKey: string | null,
): Promise<LorebookAdminRow> {
  const res = await fetch('/v1/admin/lorebooks', {
    method: 'POST',
    headers: { ...authHeaders(adminKey), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return res.json() as Promise<LorebookAdminRow>;
}

export async function adminUpdateLorebook(
  lorebookId: string,
  body: {
    user_id: string;
    name?: string;
    global_scope?: boolean;
    character_ids?: string[];
  },
  adminKey: string | null,
): Promise<void> {
  const res = await fetch(`/v1/admin/lorebooks/${encodeURIComponent(lorebookId)}`, {
    method: 'PATCH',
    headers: { ...authHeaders(adminKey), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
}

export async function adminDeleteLorebook(lorebookId: string, userId: string, adminKey: string | null): Promise<void> {
  const res = await fetch(`/v1/admin/lorebooks/${encodeURIComponent(lorebookId)}?userId=${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    headers: authHeaders(adminKey),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
}

export async function adminCreateLorebookEntry(
  body: {
    user_id: string;
    lorebook_id: string;
    content: string;
    key?: string[];
    comment?: string;
    constant?: boolean;
    disable?: boolean;
    order_value?: number;
    probability?: number;
    use_probability?: boolean;
    group_name?: string;
    group_weight?: number;
    group_override?: boolean;
    sticky?: number;
    cooldown?: number;
    delay?: number;
  },
  adminKey: string | null,
): Promise<LorebookEntryAdminRow> {
  const res = await fetch('/v1/admin/lorebook-entries', {
    method: 'POST',
    headers: { ...authHeaders(adminKey), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return res.json() as Promise<LorebookEntryAdminRow>;
}

export async function adminUpdateLorebookEntry(
  entryId: string,
  body: {
    user_id: string;
    key?: string[];
    comment?: string;
    content?: string;
    constant?: boolean;
    disable?: boolean;
    order_value?: number;
    probability?: number;
    use_probability?: boolean;
    group_name?: string;
    group_weight?: number;
    group_override?: boolean;
    sticky?: number;
    cooldown?: number;
    delay?: number;
  },
  adminKey: string | null,
): Promise<void> {
  const res = await fetch(`/v1/admin/lorebook-entries/${encodeURIComponent(entryId)}`, {
    method: 'PATCH',
    headers: { ...authHeaders(adminKey), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
}

export async function adminDeleteLorebookEntry(entryId: string, userId: string, adminKey: string | null): Promise<void> {
  const res = await fetch(`/v1/admin/lorebook-entries/${encodeURIComponent(entryId)}?userId=${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    headers: authHeaders(adminKey),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
}

// --- Chat-sidebar Lorebook panel (docs/lorebook-plan.md §8b) — user-scoped chat routes, the
// regular authenticated key (no admin key needed). ---

export async function getLorebookPanel(chatId: string, apiKey: string | null): Promise<LorebookPanelData> {
  return jsonRequest<LorebookPanelData>(`/v1/chats/${encodeURIComponent(chatId)}/lorebook-panel`, apiKey);
}

export async function setLorebookChatOverride(
  chatId: string,
  body: { lorebook_id: string; enabled: boolean },
  apiKey: string | null,
): Promise<void> {
  await jsonRequest(`/v1/chats/${encodeURIComponent(chatId)}/lorebook-book-override`, apiKey, { method: 'PUT', body });
}

export async function setLorebookEntryOverride(
  chatId: string,
  body: { entry_id: string; enabled: boolean },
  apiKey: string | null,
): Promise<void> {
  await jsonRequest(`/v1/chats/${encodeURIComponent(chatId)}/lorebook-entry-override`, apiKey, { method: 'PUT', body });
}

export async function quickAddLorebookEntry(
  chatId: string,
  content: string,
  apiKey: string | null,
): Promise<{ bookId: string; entryId: string }> {
  return jsonRequest<{ bookId: string; entryId: string }>(`/v1/chats/${encodeURIComponent(chatId)}/lorebook-quick-add`, apiKey, {
    method: 'POST',
    body: { content },
  });
}

// --- Lorebook import/export (plan §8a step 7, bi_principles.md §7) — admin-gated. ---

export interface WorldInfoImportResult {
  lorebookId: string;
  name: string;
  entryCount: number;
}

export async function adminImportLorebookWorldInfo(
  userId: string,
  worldInfo: { name: string; entries: Record<string, unknown> },
  adminKey: string | null,
): Promise<WorldInfoImportResult> {
  return jsonRequest<WorldInfoImportResult>(`/v1/admin/lorebooks/import`, adminKey, {
    method: 'POST',
    body: { user_id: userId, world_info: worldInfo },
  });
}

export async function adminExportLorebookWorldInfo(
  lorebookId: string,
  userId: string,
  adminKey: string | null,
): Promise<{ name: string; entries: Record<string, unknown> }> {
  return jsonRequest<{ name: string; entries: Record<string, unknown> }>(
    `/v1/admin/lorebooks/${encodeURIComponent(lorebookId)}/export?userId=${encodeURIComponent(userId)}`,
    adminKey,
  );
}

export async function adminSetChatMemorySettings(
  patch: {
    profile?: string;
    live_window_pairs?: number;
    sync_every_pairs?: number;
    digest_horizon_pairs?: number;
    chunk_pairs?: number;
    chunk_summary_prompt?: string;
    distill_prompt?: string;
    household_memory_prompt?: string;
    bridge_prompt?: string;
    world_curator_prompt?: string;
    people_curator_prompt?: string;
    auto_recall_enabled?: boolean;
    auto_recall_pairs?: number;
    auto_recall_chunk_top_k?: number;
    auto_recall_chunk_min?: number;
    auto_recall_pool_multiple?: number;
    auto_recall_cutoff_mode?: string;
    plot_recall_top_k?: number;
    plot_recall_min?: number;
    plot_recall_floor_syncs?: number;
    inject_bridge_prompt?: string;
    inject_plot_prompt?: string;
    inject_auto_recall_prompt?: string;
    inject_recent_history_prompt?: string;
    auto_recall_chunk_prompt?: string;
    auto_recall_lead_in_chunks?: number;
    auto_recall_lead_in_prompt?: string;
    inject_sync_summaries_prompt?: string;
    sync_summary_entry_prompt?: string;
  },
  adminKey: string | null,
): Promise<ChatMemorySettings> {
  const res = await fetch('/v1/admin/chat-memory-settings', {
    method: 'POST',
    headers: { ...authHeaders(adminKey), 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return res.json() as Promise<ChatMemorySettings>;
}

// --- Async cleanup subloop (cleanupLoop.ts) — the floating chat status pill + Cleanup page ---

/** GET /v1/cleanup/status?chat_id= — polled by the floating pill in the chat header. null on a
 *  failed poll (best-effort, keep last-known state) like getChatTurnStatus; the pill renders
 *  nothing when the response says enabled:false (chat not opted in / not RP / archived). */
export async function getCleanupStatus(chatId: string, apiKey: string | null): Promise<CleanupStatus | null> {
  const res = await fetch(`/v1/cleanup/status?chat_id=${encodeURIComponent(chatId)}`, { headers: authHeaders(apiKey) });
  if (!res.ok) return null;
  return res.json() as Promise<CleanupStatus>;
}

/** POST /v1/cleanup/run — the pill click / Cleanup page run-now: one immediate pass over one
 *  chat (the poll tick keeps the rest). Fire-and-forget; the caller polls status for results. */
export async function runCleanupNow(chatId: string, apiKey: string | null): Promise<void> {
  const res = await fetch('/v1/cleanup/run', {
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId }),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
}

/** GET /v1/cleanup/jobs?chat_id=&limit= — the Cleanup page's recent activity list for one chat. */
export async function getCleanupJobs(chatId: string, apiKey: string | null, limit = 20): Promise<CleanupJob[]> {
  const res = await fetch(
    `/v1/cleanup/jobs?chat_id=${encodeURIComponent(chatId)}&limit=${limit}`,
    { headers: authHeaders(apiKey) },
  );
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  const body = (await res.json()) as { jobs: CleanupJob[] };
  return body.jobs;
}

/** GET /v1/admin/cleanup-settings — the Cleanup page's setup block: header/footer format +
 *  repair prompts and the full slop-rules table. Admin-gated like every other Settings-tab
 *  field; the subloop re-reads it live every tick, so a save takes effect on the next poll. */
export async function adminGetCleanupSettings(adminKey: string | null): Promise<CleanupSettings> {
  const res = await fetch('/v1/admin/cleanup-settings', { headers: authHeaders(adminKey) });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return res.json() as Promise<CleanupSettings>;
}

export async function adminSetCleanupSettings(
  patch: {
    header_regex?: string;
    header_prompt?: string;
    footer_regex?: string;
    footer_prompt?: string;
    slop_rules?: {
      setName: string;
      position: number;
      pattern: string;
      flags: string;
      action: 'remove' | 'replace-paragraph' | 'llm';
      replacement: string | null;
      llmPrompt: string | null;
      enabled: boolean;
    }[];
    // Reasoning-block tag pair (reasoning-blocks-plan.md): the open/close markers; either one
    // '' = detection disabled. Same optional-patch semantics as the header/footer fields.
    reasoning_open_tag?: string;
    reasoning_close_tag?: string;
  },
  adminKey: string | null,
): Promise<CleanupSettings> {
  const res = await fetch('/v1/admin/cleanup-settings', {
    method: 'POST',
    headers: { ...authHeaders(adminKey), 'content-type': 'application/json' },
    // Request bodies are snake_case on the wire (the server parses set_name/llm_prompt, etc.);
    // responses come back camelCase — see CleanupSettings/SlopRule in types.ts. The caller
    // works in camelCase (the GET shape); translate only for the POST.
    body: JSON.stringify(
      patch.slop_rules === undefined
        ? patch
        : {
            ...patch,
            slop_rules: patch.slop_rules.map((r) => ({
              set_name: r.setName,
              position: r.position,
              pattern: r.pattern,
              flags: r.flags,
              action: r.action,
              replacement: r.replacement,
              llm_prompt: r.llmPrompt,
              enabled: r.enabled,
            })),
          },
    ),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return res.json() as Promise<CleanupSettings>;
}

// ============================================================================
// Portrait Studio (docs/plans/portrait-studio-plan.md) — the user-scoped visual_* routes
// (orchestrator/src/server/portraitRoutes.ts). Entities/wiki/generate/feedback + the layers read
// are regular user routes (the visual_* tables are user-scoped RLS); only the layers WRITE is
// admin-gated (a visual_layer_stack settings write), so it takes adminKey like Connections-tab
// writes do.
// ============================================================================

/** GET /v1/portraits/entities — the Studio's entity list, ordered by layer then name. */
export async function listPortraitEntities(apiKey: string | null): Promise<PortraitEntityRow[]> {
  const body = await jsonRequest<{ entities: PortraitEntityRow[] }>('/v1/portraits/entities', apiKey);
  return body.entities;
}

/** POST /v1/portraits/entities — create a visual_entities row. A subject entity requires
 *  characterId (one subject per character — 409 when one already exists). */
export function createPortraitEntity(input: CreatePortraitEntityInput, apiKey: string | null): Promise<PortraitEntityRow> {
  return jsonRequest<PortraitEntityRow>('/v1/portraits/entities', apiKey, { method: 'POST', body: input });
}

/** GET /v1/portraits/entities/:id — one entity. */
export function getPortraitEntity(entityId: string, apiKey: string | null): Promise<PortraitEntityRow> {
  return jsonRequest<PortraitEntityRow>(`/v1/portraits/entities/${encodeURIComponent(entityId)}`, apiKey);
}

/** PATCH /v1/portraits/entities/:id — partial update; null clears
 *  standingInstructions/template/characterId (not name/slots). */
export function updatePortraitEntity(entityId: string, input: UpdatePortraitEntityInput, apiKey: string | null): Promise<PortraitEntityRow> {
  return jsonRequest<PortraitEntityRow>(`/v1/portraits/entities/${encodeURIComponent(entityId)}`, apiKey, { method: 'PATCH', body: input });
}

/** DELETE /v1/portraits/entities/:id. */
export async function deletePortraitEntity(entityId: string, apiKey: string | null): Promise<{ deleted: boolean }> {
  return jsonRequest<{ deleted: boolean }>(`/v1/portraits/entities/${encodeURIComponent(entityId)}`, apiKey, { method: 'DELETE' });
}

/** GET /v1/portraits/wiki — the Studio wiki's entries. */
export async function listPortraitWikiEntries(apiKey: string | null): Promise<PortraitWikiEntry[]> {
  const body = await jsonRequest<{ entries: PortraitWikiEntry[] }>('/v1/portraits/wiki', apiKey);
  return body.entries;
}

/** PATCH /v1/portraits/wiki/:id — partial edit; subscriptions replaces, not merges. */
export function updatePortraitWikiEntry(entryId: string, input: UpdatePortraitWikiInput, apiKey: string | null): Promise<PortraitWikiEntry> {
  return jsonRequest<PortraitWikiEntry>(`/v1/portraits/wiki/${encodeURIComponent(entryId)}`, apiKey, { method: 'PATCH', body: input });
}

/** DELETE /v1/portraits/wiki/:id. */
export async function deletePortraitWikiEntry(entryId: string, apiKey: string | null): Promise<{ deleted: boolean }> {
  return jsonRequest<{ deleted: boolean }>(`/v1/portraits/wiki/${encodeURIComponent(entryId)}`, apiKey, { method: 'DELETE' });
}

/** GET /v1/portraits/layers — the active layer manifest (user-gated read; seeds the default
 *  four-layer manifest on first read). */
export async function getPortraitLayerManifest(apiKey: string | null): Promise<PortraitLayerManifest> {
  const body = await jsonRequest<{ manifest: PortraitLayerManifest }>('/v1/portraits/layers', apiKey);
  return body.manifest;
}

/** POST /v1/portraits/layers — replace the layer manifest. Admin-gated: visual_layer_stack is
 *  an orchestrator_settings write, and every settings write on the server is admin-gated. */
export async function setPortraitLayerManifest(manifest: PortraitLayerManifest, adminKey: string | null): Promise<PortraitLayerManifest> {
  const body = await jsonRequest<{ manifest: PortraitLayerManifest }>('/v1/portraits/layers', adminKey, { method: 'POST', body: manifest });
  return body.manifest;
}

/** POST /v1/portraits/generate — run one generation round; returns the round's candidates in
 *  grid order (imageUrl null = that candidate's render failed and it is omitted from the grid). */
export async function generatePortraitCandidates(input: PortraitGenerateInput, apiKey: string | null): Promise<PortraitCandidate[]> {
  const body = await jsonRequest<{ candidates: PortraitCandidate[] }>('/v1/portraits/generate', apiKey, { method: 'POST', body: input });
  return body.candidates;
}

/** POST /v1/portraits/feedback — record the round's evaluation and run the Reflection
 *  Investigation; the response carries the episode id and the wiki write it produced. */
export function submitPortraitFeedback(input: PortraitFeedbackInput, apiKey: string | null): Promise<PortraitFeedbackResult> {
  return jsonRequest<PortraitFeedbackResult>('/v1/portraits/feedback', apiKey, { method: 'POST', body: input });
}
