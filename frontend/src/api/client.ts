import type {
  ActiveProfileSetting,
  ChatCompletionResponse,
  ChatDetail,
  ChatMemorySettings,
  ChatMessage,
  ChatParams,
  ChatSessionRow,
  ChatSummary,
  CredentialSummary,
  Folder,
  ImportedCharacter,
  NotificationSettings,
  ProfileModelsResult,
  ScreenLockSettings,
  StagedAttachment,
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

/** POST /v1/chat/completions — non-streaming: runTurn resolves the full reply server-side before
 *  anything is sent back, so there's no token stream worth consuming here. chatId ties the turn
 *  to a persisted session (the server applies its params/tools and stores the exchange).
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
): Promise<ChatCompletionResponse> {
  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'content-type': 'application/json' },
    body: JSON.stringify({
      messages,
      stream: false,
      ...(chatId ? { chat_id: chatId } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...(images?.length ? { images } : {}),
    }),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return res.json() as Promise<ChatCompletionResponse>;
}

/** GET /v1/chat/status — polled by ChatView while `sending` is true, alongside the still-in-flight
 *  chatCompletion POST above (not a replacement for it — see that function's own note on why this
 *  is a separate call at all). null means no tool call is currently running: not started yet, the
 *  turn already finished, or the reply needed no tools this round. */
export async function getChatTurnStatus(chatId: string, apiKey: string | null): Promise<string | null> {
  const res = await fetch(`/v1/chat/status?chat_id=${encodeURIComponent(chatId)}`, { headers: authHeaders(apiKey) });
  if (!res.ok) return null;
  const body = (await res.json()) as { status: string | null };
  return body.status;
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

export function updateChat(
  chatId: string,
  patch: {
    title?: string;
    folder_id?: string | null;
    params?: ChatParams;
    tool_names?: string[] | null;
    canvas_note_id?: string | null;
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

/** Removes the given message and everything chronologically after it — the shared step behind
 *  both "edit" (truncate the edited message, then resend with new content) and "rerun" (truncate
 *  the reply being regenerated, then resend the now-shorter history unchanged). Caller is
 *  responsible for the resend; this only clears room for it. */
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

/** The connection picker's current state — which named BIGBRAIN_LLM_PROFILES entry is active,
 *  and every selectable name. */
export async function adminGetActiveProfile(adminKey: string | null): Promise<ActiveProfileSetting> {
  const res = await fetch('/v1/admin/settings', { headers: authHeaders(adminKey) });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return res.json() as Promise<ActiveProfileSetting>;
}

/** Resolves once the save is accepted (202) — same restart-on-save shape as adminSetCredential.
 *  supportsVision, when passed, adds/removes profileName from the stored
 *  llm_vision_capable_profiles list; omitted leaves that profile's flag untouched. */
export async function adminSetActiveProfile(
  profileName: string,
  model: string,
  adminKey: string | null,
  supportsVision?: boolean,
): Promise<void> {
  const res = await fetch('/v1/admin/settings', {
    method: 'POST',
    headers: { ...authHeaders(adminKey), 'content-type': 'application/json' },
    body: JSON.stringify({ value: profileName, model, ...(supportsVision !== undefined ? { supportsVision } : {}) }),
  });
  if (res.status !== 202) throw new ApiError(res.status, await parseErrorBody(res));
}

/** The model catalog for one named connection — even one that isn't currently active — so the
 *  Settings tab can populate its model dropdown as soon as a profile is picked, before switching
 *  to it. defaultModel is that profile's own static config model, a sensible pre-selection. */
export async function adminListModelsForProfile(profileName: string, adminKey: string | null): Promise<ProfileModelsResult> {
  const res = await fetch(`/v1/admin/settings/models?profile=${encodeURIComponent(profileName)}`, {
    headers: authHeaders(adminKey),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return res.json() as Promise<ProfileModelsResult>;
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

export async function adminSetChatMemorySettings(
  patch: {
    profile?: string;
    live_window_pairs?: number;
    sync_every_pairs?: number;
    digest_horizon_pairs?: number;
    chunk_summary_prompt?: string;
    distill_prompt?: string;
    household_memory_prompt?: string;
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
