/**
 * @file orchestrator/src/server/handleChats.ts
 * @stamp 2026-08-12
 * @architectural-role IO Wrapper — the /v1/chats route family from httpServer.ts
 * @description
 * The Chat tab's persisted-session surface (io/chatSessions.ts): chat CRUD (list/create/get/
 * patch/delete, fork, lineage), the prompt-preview and sync-status/inspection reads,
 * the lorebook sidebar panel + overrides + quick-add, the location-image background read, and
 * the message-mutation family (delete/truncate/edit/swipe — swipe includes the streaming
 * "Rerun" branch, same SSE shape as handleChatCompletions). The dispatcher resolves the userId
 * first (household-key/Access gate) and passes it in. Still imports the prompt-assembly /
 * location-image / turn-execution helpers from httpServer.ts until plan step 6 extracts those
 * (benign ESM cycle — function declarations used only at request time).
 *
 * The swipe route's streaming branch also relays reasoning deltas (reasoning-blocks-plan.md) as
 * bigimagine_reasoning SSE frames — gated only on streamingRp, NOT on cleanup_enabled_at, since
 * reasoning is independent of the cleanup opt-in — via regenerateSwipe's onReasoningDelta,
 * mirroring handleChatCompletions exactly (send/swipe parity).
 *
 * @api-declaration
 * handleChatRoutes(req, res, deps, userId, url)
 *   — GET/POST /v1/chats; GET/POST/DELETE /v1/chats/:id
 *   — POST /v1/chats/:id/fork; GET /v1/chats/:id/prompt-preview|lineage|sync-status|syncs|location-image
 *   — GET/PUT /v1/chats/:id/lorebook-panel|book-override|entry-override; POST /v1/chats/:id/lorebook-quick-add
 *   — DELETE /v1/chats/:id/messages/:msgId; POST .../truncate|edit|swipe
 *
 * @contract
 *   assertions:
 *     purity:          impure (reads/writes chats/messages/folders via deps.chats; fires
 *                       background passes: ensureActiveLocationImage,
 *                       fireLocationImageGeneration)
 *     state_ownership: []
 *     external_io:     [Postgres (via deps.chats/deps.db), LLM (via regenerateSwipe),
 *                       EmbeddingProvider (via quickAddLorebookEntry)]
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '../io/logger.js';
import { clearPromptTrace } from '../io/promptTrace.js';
import { DEFAULT_LIVE_WINDOW_PAIRS, DEFAULT_SYNC_EVERY_PAIRS } from '../orchestrator/chatMemorySync.js';
import { abortTurn } from '../orchestrator/turnAbort.js';
import { beginInteractiveTurn, endInteractiveTurn } from '../orchestrator/interactiveTurnLock.js';
import { interpolateMacros } from '../util/interpolateMacros.js';
import { getLorebookPanelData, quickAddLorebookEntry, setLorebookChatOverride, setLorebookEntryOverride } from '../io/lorebook/panelData.js';
import type { ChatParams } from '../io/chatSessions.js';
import { buildChatCompletionChunk } from './openai.js';
import { readJsonBody, sendJson, writeStreamErrorTerminalFrame, writeStreamHeaders } from './httpUtils.js';
import {
  buildMacroSnapshot,
  decorateMessageForDisplay,
} from './promptAssembly.js';
import { buildPromptPreview } from './promptPreview.js';
import { handleTurnDisplayMetricsLatest } from './handleTurnDisplayMetricsLatest.js';
import {
  ensureActiveLocationImage,
  fireLocationImageGeneration,
  resolveChatLocationImage,
} from './locationImages.js';
import { fireCharacterDescription } from './characterDescription.js';
import { fireCharacterVisualState } from './characterVisualState.js';
import { regenerateSwipe } from './turnExecution.js';
import type { CleanupLiveEvent } from '../orchestrator/liveCleanup.js';
import type { HttpServerDeps } from './httpServer.js';
import { isMessageSettled } from '../orchestrator/chatHistoryBoundary.js';

async function rejectSettledMessageMutation(deps: HttpServerDeps, userId: string, chatId: string, messageId: string, res: ServerResponse): Promise<boolean> {
  const settled = await deps.db.withUserScope(userId, (session) => isMessageSettled(session, chatId, messageId));
  if (!settled) return false;
  sendJson(res, 409, {
    error: 'CHAT_HISTORY_SETTLED',
    message: 'This message has already been synchronized. Fork from this point or truncate the conversation to change earlier history.',
  });
  return true;
}

/** The decoupled post-regeneration trigger shared by both finish-event sites (rp-cast-
 *  infrastructure-plan.md A3): fires the location-image generation pass for the scraped
 *  location AND the fire-and-forget character describer for every resolved `Present:` character.
 *  Both are no-op safe for already-described rows (their own skip rules). Also fires the
 *  character visual-state pipeline (character-visual-state-plan.md) for the regenerated swipe —
 *  gated on the header having parsed (result.locationId or characterIds set), so a headerless
 *  swipe is left to the cleanup path's deferred hook rather than double-firing from both call
 *  sites. The visual-state fire uses the household gated provider (deps.llm) like the rest of the
 *  swipe path's decoupled passes — only the in-stream turn passes its own turnLlm. */
function fireSwipedPresenceTriggers(
  deps: HttpServerDeps,
  userId: string,
  chatId: string,
  result: { message: { messageId: string; content: string }; locationId?: string; characterIds?: string[] },
): void {
  if (result.locationId) fireLocationImageGeneration(deps, userId, chatId, result.locationId);
  result.characterIds?.forEach((characterId) => fireCharacterDescription(deps, userId, chatId, characterId));
  fireCharacterVisualState(deps, userId, chatId, result.message.messageId, result.message.content);
}

export function isChatPatchBody(value: unknown): value is {
  title?: string;
  folder_id?: string | null;
  params?: ChatParams;
  tool_names?: string[] | null;
  canvas_note_id?: string | null;
  cleanup_preset_id?: string | null;
  cleanup_enabled_at?: string | null;
} {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.title !== undefined && typeof v.title !== 'string') return false;
  if (v.folder_id !== undefined && v.folder_id !== null && typeof v.folder_id !== 'string') return false;
  if (v.params !== undefined && (typeof v.params !== 'object' || v.params === null)) return false;
  if (
    v.tool_names !== undefined &&
    v.tool_names !== null &&
    !(Array.isArray(v.tool_names) && v.tool_names.every((t) => typeof t === 'string'))
  ) {
    return false;
  }
  if (v.canvas_note_id !== undefined && v.canvas_note_id !== null && typeof v.canvas_note_id !== 'string') {
    return false;
  }
  if (v.cleanup_preset_id !== undefined && v.cleanup_preset_id !== null && typeof v.cleanup_preset_id !== 'string') {
    return false;
  }
  // '' is never a valid preset id — rejecting it here (instead of letting it reach Postgres's
  // uuid cast and 500) keeps a malformed patch a 400 like every other bad field.
  if (v.cleanup_preset_id === '') return false;
  if (v.cleanup_enabled_at !== undefined && v.cleanup_enabled_at !== null && typeof v.cleanup_enabled_at !== 'string') {
    return false;
  }
  if (v.cleanup_enabled_at === '') return false;
  return true;
}

// chat_memory_live_window_pairs / chat_memory_sync_every_pairs are stored as text and read live
// every sync tick by chatMemorySync.ts's resolveSyncSettings — this mirrors that parse (same
// positive-int-or-fallback shape) so the "when is the next sync due" math the UI shows never
// drifts from the loop's own.
export function pairsSetting(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function handleChatRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
  userId: string,
  url: URL,
): Promise<void> {
  // '' -> [] (list/create); '/<id>' -> ['<id>']; '/<id>/messages/<msgId>[/truncate]' -> [...].
  // Split-on-'/' rather than the old naive rest.slice(1) (which took everything past the first
  // slash verbatim, so a nested message path would've been misread as one giant, never-matching
  // chatId) — needed once routes could nest below a chat id at all.
  const segments = url.pathname.slice('/v1/chats'.length).split('/').filter(Boolean);

  if (segments.length === 0) {
    if (req.method === 'GET') {
      const search = url.searchParams.get('search') ?? undefined;
      const folderId = url.searchParams.get('folder_id') ?? undefined;
      const kindParam = url.searchParams.get('kind');
      const kind = kindParam === 'chat' || kindParam === 'rp' ? kindParam : undefined;
      sendJson(res, 200, { chats: await deps.chats.listChats(userId, { search, folderId, kind }) });
      return;
    }
    if (req.method === 'POST') {
      const body = (await readJsonBody(req)) as { title?: string; folder_id?: string; kind?: string };
      const kind = body.kind === 'rp' ? 'rp' : undefined;
      const session = await deps.chats.createChat(userId, {
        title: typeof body.title === 'string' ? body.title : undefined,
        folderId: typeof body.folder_id === 'string' ? body.folder_id : undefined,
        kind,
      });
      sendJson(res, 201, session);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  const chatId = decodeURIComponent(segments[0]!);

  if (segments.length === 1) {
    if (req.method === 'GET') {
      const detail = await deps.chats.getChat(userId, chatId);
      if (!detail) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      // Display-side macro resolution (docs/plans/prompt-macros.md's Stage 1, bi_principles.md §1): the
      // chat UI renders a message's resolvedContent — a per-read derived copy — so a character's
      // seeded greeting shows "Jeremy, …" instead of the literal {{user}} token, while the
      // canonical content stays verbatim and the client keeps re-sending it, so the per-turn
      // resolution pass (assembleSessionTurnContext) keeps re-resolving against the live persona —
      // a persona edit updates the greeting on the very next read with no re-apply. Gated like
      // every other macro pass: 'rp' chats only, and only when a message actually contains '{{'.
      if (detail.session.kind === 'rp' && detail.messages.some((m) => m.content.includes('{{'))) {
        const snapshot = await buildMacroSnapshot(deps.db, deps.settings, userId, detail.session.characterId);
        detail.messages = detail.messages.map((m) =>
          m.content.includes('{{') ? { ...m, resolvedContent: interpolateMacros(m.content, snapshot) } : m,
        );
      }
      sendJson(res, 200, detail);
      // endpoint.md §5.1.8's "restart bg discovery on return": a chat (re)open may find its
      // active location without a rendered image (a pass dropped by a swipe, or a failed
      // render) — fire the cache-first generation pass so discovery resumes. No-op whenever the
      // image already exists or a render is already in flight.
      void ensureActiveLocationImage(deps, userId, chatId);
      return;
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!isChatPatchBody(body)) {
        sendJson(res, 400, { error: 'expected { title?, folder_id?, params?, tool_names?, canvas_note_id?, cleanup_preset_id?, cleanup_enabled_at? }' });
        return;
      }
      const updated = await deps.chats.updateChat(userId, chatId, {
        title: body.title,
        folderId: body.folder_id,
        params: body.params,
        toolNames: body.tool_names,
        canvasNoteId: body.canvas_note_id,
        cleanupPresetId: body.cleanup_preset_id,
        cleanupEnabledAt: body.cleanup_enabled_at,
      });
      if (!updated) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, 200, updated);
      return;
    }
    if (req.method === 'DELETE') {
      const deleted = await deps.chats.deleteChat(userId, chatId);
      if (deleted) clearPromptTrace(chatId);
      sendJson(res, deleted ? 200 : 404, deleted ? { deleted: true } : { error: 'not found' });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  if (segments[1] === 'fork' && segments.length === 2 && req.method === 'POST') {
    const body = await readJsonBody(req);
    const fromMessageId = typeof (body as Record<string, unknown>)?.from_message_id === 'string'
      ? (body as { from_message_id: string }).from_message_id
      : undefined;
    const title = typeof (body as Record<string, unknown>)?.title === 'string' ? (body as { title: string }).title : undefined;
    if (!fromMessageId) {
      sendJson(res, 400, { error: 'expected { from_message_id: string, title?: string }' });
      return;
    }
    const forked = await deps.chats.forkChat(userId, chatId, fromMessageId, title);
    if (!forked) {
      sendJson(res, 404, { error: 'not found — chatId or from_message_id does not exist in this chat' });
      return;
    }
    sendJson(res, 201, forked);
    return;
  }

  if (segments[1] === 'prompt-preview' && segments.length === 2 && req.method === 'GET') {
    const result = await buildPromptPreview(deps, userId, chatId);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return;
    }
    sendJson(res, 200, result.preview);
    return;
  }

  // Branch Map panel's data source — the whole fork family this chat belongs to, root first.
  if (segments[1] === 'lineage' && segments.length === 2 && req.method === 'GET') {
    const nodes = await deps.chats.getLineage(userId, chatId);
    if (!nodes) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    sendJson(res, 200, { nodes });
    return;
  }

  // The chat drawer Timing section's durable "last turn" read (docs/plans/turn-timeline-graph-plan.md):
  // the newest recorded turn for this chat, or null when none — the table, not the session, so a
  // reload still remembers the last turn. Same regular chat auth as every route here; the read is
  // user_scoped by construction (migration 0102 RLS), so a foreign chatId reads no rows.
  if (segments[1] === 'turn-display-metrics' && segments[2] === 'latest' && segments.length === 3 && req.method === 'GET') {
    await handleTurnDisplayMetricsLatest(res, deps, userId, chatId);
    return;
  }

  // Per-chat slice of the rolling sync loop's status record (io/chatSessions.ts's
  // getChatSyncStatus) — the RP chat header menu's "Sync status" panel. User-scoped like every
  // other chat route (a user's own chat's sync history is no more sensitive than the chat
  // itself), unlike the cross-user Review Panel endpoint /v1/admin/chat-memory-sync-status.
  // The live/sync window pairs come from the same DB-backed settings the loop reads live every
  // tick, falling back to the loop's own defaults when unset; getChatSyncStatus derives the
  // dueAfterMessages threshold and syncHealth from them.
  if (segments[1] === 'sync-status' && segments.length === 2 && req.method === 'GET') {
    const [livePairsRaw, syncEveryPairsRaw] = await Promise.all([
      deps.settings.get('chat_memory_live_window_pairs'),
      deps.settings.get('chat_memory_sync_every_pairs'),
    ]);
    const livePairs = pairsSetting(livePairsRaw, DEFAULT_LIVE_WINDOW_PAIRS);
    const syncEveryPairs = pairsSetting(syncEveryPairsRaw, DEFAULT_SYNC_EVERY_PAIRS);
    const sync = await deps.chats.getChatSyncStatus(userId, chatId, livePairs, syncEveryPairs);
    if (!sync) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    sendJson(res, 200, { sync });
    return;
  }

  // One sync point's full inspection record (io/chatSessions.ts's getChatSyncInspection, 0079) —
  // what that pass actually produced: the memory entries it created/changed, the canon-fact
  // proposals it wrote, and the bridge prompt it sent the model. Fetched on demand when the Sync
  // Status panel expands a sync row, so the 30s status poll above never ships the heavy detail.
  if (segments[1] === 'syncs' && segments.length === 3 && req.method === 'GET') {
    const inspection = await deps.chats.getChatSyncInspection(userId, chatId, segments[2]);
    if (!inspection) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    sendJson(res, 200, { sync: inspection });
    return;
  }

  // Lorebook chat-sidebar panel (io/lorebook/panelData.ts, plan §8b) — user-scoped like every
  // other chat route: a user's own chat's lorebook state is no more sensitive than the chat
  // itself, so it rides the regular authenticated key, not the admin key. Returns the resolved
  // mode, the §3b in-scope books (with all entries, override state, and the §8b live-activation
  // badge from lorebook_activation_log's latest message), or an empty mode-correct panel on
  // failure — never an error the chat view has to survive.
  if (segments[1] === 'lorebook-panel' && segments.length === 2 && req.method === 'GET') {
    const detail = await deps.chats.getChat(userId, chatId);
    if (!detail) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const latestAssistantMessageId = [...detail.messages].reverse().find((m) => m.role === 'assistant')?.messageId ?? null;
    sendJson(
      res,
      200,
      await getLorebookPanelData(deps.db, deps.settings, {
        userId,
        chatId,
        characterId: detail.session.characterId,
        latestAssistantMessageId,
      }),
    );
    return;
  }

  if (segments[1] === 'lorebook-book-override' && segments.length === 2 && req.method === 'PUT') {
    const body = (await readJsonBody(req)) as { lorebook_id?: unknown; enabled?: unknown };
    if (typeof body.lorebook_id !== 'string' || typeof body.enabled !== 'boolean') {
      sendJson(res, 400, { error: 'lorebook_id (string) and enabled (boolean) are required' });
      return;
    }
    const ok = await setLorebookChatOverride(deps.db, userId, chatId, body.lorebook_id, body.enabled);
    if (!ok) {
      sendJson(res, 404, { error: 'book not found' });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (segments[1] === 'lorebook-entry-override' && segments.length === 2 && req.method === 'PUT') {
    const body = (await readJsonBody(req)) as { entry_id?: unknown; enabled?: unknown };
    if (typeof body.entry_id !== 'string' || typeof body.enabled !== 'boolean') {
      sendJson(res, 400, { error: 'entry_id (string) and enabled (boolean) are required' });
      return;
    }
    const ok = await setLorebookEntryOverride(deps.db, userId, chatId, body.entry_id, body.enabled);
    if (!ok) {
      sendJson(res, 404, { error: 'entry not found' });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (segments[1] === 'lorebook-quick-add' && segments.length === 2 && req.method === 'POST') {
    const body = (await readJsonBody(req)) as { content?: unknown };
    if (typeof body.content !== 'string') {
      sendJson(res, 400, { error: 'content (string) is required' });
      return;
    }
    const detail = await deps.chats.getChat(userId, chatId);
    if (!detail) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const result = await quickAddLorebookEntry(deps.db, deps.embeddings, userId, chatId, detail.session.title, body.content);
    if (!result) {
      sendJson(res, 400, { error: 'content must be non-empty' });
      return;
    }
    sendJson(res, 200, result);
    return;
  }

  if (segments[1] === 'location-image' && segments.length === 2 && req.method === 'GET') {
    // endpoint.md §6.4's chat background layer: resolve the chat's active location image — the
    // current eligible location (scene_id pointer, active-swipe fallback) plus the last settled
    // location (previous_scene_id). A current location whose image hasn't rendered yet comes
    // back with imageUrl: null — the post-turn bg pass (endpoint.md §5) fires after the reply
    // is sent, so the client keeps the previous background (or its current one) until the
    // pending render lands, never blanking the layer (§5.1.8).
    const image = await resolveChatLocationImage(deps.db, userId, chatId, deps.settings);
    sendJson(res, 200, {
      current: image.current ?? { locationId: null, name: null, definition: null, imageUrl: null },
      previous: image.previous ?? { locationId: null, name: null, definition: null, imageUrl: null },
    });
    return;
  }

  if (segments[1] === 'messages' && segments.length >= 3) {
    const messageId = decodeURIComponent(segments[2]!);

    if (segments.length === 3 && req.method === 'DELETE') {
      if (await rejectSettledMessageMutation(deps, userId, chatId, messageId, res)) return;
      const deleted = await deps.chats.deleteMessage(userId, chatId, messageId);
      sendJson(res, deleted ? 200 : 404, deleted ? { deleted: true } : { error: 'not found' });
      return;
    }
    if (segments.length === 4 && segments[3] === 'truncate' && req.method === 'POST') {
      const truncated = await deps.chats.truncateMessagesFrom(userId, chatId, messageId);
      sendJson(res, truncated ? 200 : 404, truncated ? { truncated: true } : { error: 'not found' });
      return;
    }
    if (segments.length === 4 && segments[3] === 'edit' && req.method === 'POST') {
      // In-place content rewrite (the Chat tab's "edit an LLM reply") — message keeps its id,
      // everything chronologically after it is untouched, and the pre-edit text is preserved as
      // a swipe (recordSwipeIfContent's stash-the-original path). Unlike the truncate+resend
      // user-edit, there is no "must be the last message" restriction: rewriting an earlier
      // reply's text is coherent mid-conversation, and swiping never touches earlier messages.
      const body = await readJsonBody(req);
      const content = (body as Record<string, unknown>)?.content;
      if (typeof content !== 'string' || !content.trim()) {
        sendJson(res, 400, { error: 'expected { content: non-empty string }' });
        return;
      }
      if (await rejectSettledMessageMutation(deps, userId, chatId, messageId, res)) return;
      const detail = await deps.chats.getChat(userId, chatId);
      if (!detail) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      // No-op guard: identical text must not mint a junk swipe in the canonical record — the
      // frontend already skips the call, but a raw-API client shouldn't corrupt the swipe list
      // either (each edit otherwise appends a swipe, exactly like a regeneration would).
      const existing = detail.messages.find((m) => m.messageId === messageId);
      if (existing && existing.content === content) {
        sendJson(res, 200, { message: await decorateMessageForDisplay(deps.db, deps.settings, userId, detail.session, existing) });
        return;
      }
      const updated = await deps.chats.editMessageContent(userId, chatId, messageId, content);
      if (!updated) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, 200, { message: await decorateMessageForDisplay(deps.db, deps.settings, userId, detail.session, updated) });
      // The edit made a new swipe active; if that swipe's location has no rendered image yet
      // (or the location changed under it), restart bg discovery — cache-first, so this is a
      // no-op whenever an image already exists or a render is in flight (see ensureActiveLocationImage).
      void ensureActiveLocationImage(deps, userId, chatId);
      return;
    }
    if (segments.length === 4 && segments[3] === 'swipe' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const direction = (body as Record<string, unknown>)?.direction;
      if (direction !== 'prev' && direction !== 'next' && direction !== 'regenerate') {
        sendJson(res, 400, { error: 'expected { direction: "prev" | "next" | "regenerate" }' });
        return;
      }
      // rp-streaming-plan.md: the swipe route accepts the same optional stream flag the completions
      // route does (default false — omitted is identical to false, fully backward compatible).
      // Only an RP chat's needs_regenerate outcome streams; prev/next cycling (pure content swaps,
      // no LLM call) and non-RP swipes are unaffected and stay plain JSON.
      const stream = (body as Record<string, unknown>)?.stream === true;

      // Swiping only ever touches the chat's current last message (this module's own preamble) —
      // enforced here, not left to cycleSwipe/recordSwipe, since an id belonging to an earlier
      // turn is a client bug (a stale UI) rather than something the store should silently allow.
      const detail = await deps.chats.getChat(userId, chatId);
      const last = detail?.messages[detail.messages.length - 1];
      if (!detail || !last || last.messageId !== messageId || last.role !== 'assistant') {
        sendJson(res, 404, { error: "not found — messageId must be this chat's current last assistant reply" });
        return;
      }
      if (await rejectSettledMessageMutation(deps, userId, chatId, messageId, res)) return;

      // Regenerate from any swipe (RP Chat tidy-up §4): 'regenerate' always appends a new variant
      // regardless of which swipe is currently displayed — it must not replace/insert/truncate.
      // 'next'/'prev' keep their existing cycle semantics; only 'regenerate' bypasses the cycle.
      if (direction !== 'regenerate') {
        const cycled = await deps.chats.cycleSwipe(userId, chatId, messageId, direction);
        if (cycled.status === 'not_found') {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        if (cycled.status === 'switched') {
          sendJson(res, 200, { message: await decorateMessageForDisplay(deps.db, deps.settings, userId, detail.session, cycled.message) });
          // endpoint.md §5.1.8's "restart bg discovery on return": cycling made a different swipe
          // active — if its location has no rendered image yet (a pass dropped by the earlier
          // swipe, or never run), fire the cache-first generation pass; if it has one, the
          // per-swipe association makes the read a reuse, no provider call. No-op when the image
          // exists or a render is already in flight.
          void ensureActiveLocationImage(deps, userId, chatId);
          return;
        }
        if (cycled.status === 'no_earlier_swipe') {
          sendJson(res, 200, { status: 'no_earlier_swipe' });
          return;
        }
      }
      // needs_regenerate: 'next' past the newest stored variant — this is "Rerun" (this module's
      // own preamble on the swipe route). 'regenerate' is the same but forced from any index.
      // Except when this message is the chat's only message: that
      // means it's the seeded opening greeting (applyCharacterToChatTool.ts only ever seeds one when
      // the chat has zero prior messages) and its "variants" are a card's pre-written
      // alternate_greetings, not an earlier LLM turn — there is no prior user message to regenerate a
      // reply to, and regenerateSwipe would otherwise run the LLM with an empty message history to
      // fabricate one. Content the platform was handed, not content the LLM reasoned about, so it's
      // never a Rerun candidate — cycling stops at the last stored greeting instead.
      if (detail.messages.length === 1) {
        sendJson(res, 200, { status: 'no_further_swipe' });
        return;
      }
      // Robust-chat-turns plan (docs/plans/completed/robust-chat-turns-plan.md): only the needs_regenerate
      // branch actually starts generation, so only it takes the per-chat interactive-turn lock
      // (orchestrator/interactiveTurnLock.ts) — a regeneration and a send on the same chat are
      // mutually exclusive, and two concurrent regenerations can't race the same message. Plain
      // prev/next cycling (pure content swaps, no LLM call) never takes the lock — those returns
      // above have already left the branch.
      if (!beginInteractiveTurn(chatId)) {
        sendJson(res, 409, { error: 'a turn is already in progress for this chat' });
        return;
      }
      try {
        // Streaming branch, same shape as handleChatCompletions's: SSE headers deferred until the
        // first delta, deltas relayed live via onDelta, and the failure/abort outcome decided by
        // whether any bytes were already committed. A dropped client connection cancels the LLM call
        // (plan Edge Cases) — detached on every exit so a late close can't abort the next turn.
        const streamingRp = detail.session.kind === 'rp' && stream === true;
        const sseId = `chatcmpl-${randomUUID()}`;
        let streamHeadersSent = false;
        const onClientClose = () => {
          if (streamingRp) abortTurn(chatId);
        };
        req.on('close', onClientClose);
        const onDelta = (delta: string) => {
          if (!streamHeadersSent) {
            writeStreamHeaders(res);
            streamHeadersSent = true;
          }
          res.write(`data: ${JSON.stringify(buildChatCompletionChunk(detail.session.params.model ?? '', sseId, { role: 'assistant', content: delta }, null))}\n\n`);
        };
        // In-stream cleanup (docs/plans/completed/in-stream-cleanup-plan.md): forward the cleanup events to
        // regenerateSwipe for RP chats that opted in (cleanup_enabled_at), which translates them
        // into SSE frames mirroring handleChatCompletions exactly — the send/swipe parity the plan
        // carries through to cleanup. Same first-frame-commits-headers rule as onDelta above.
        const onCleanupEvent: ((event: CleanupLiveEvent) => void) | undefined =
          streamingRp && detail.session.cleanupEnabledAt != null
            ? (event) => {
                if (!streamHeadersSent) {
                  writeStreamHeaders(res);
                  streamHeadersSent = true;
                }
                if (event.kind === 'status') {
                  res.write(`data: ${JSON.stringify({ bigimagine_cleanup: true, region: event.region, state: event.state })}\n\n`);
                } else {
                  res.write(
                    `data: ${JSON.stringify({ bigimagine_patch: true, region: event.region, start: event.start, end: event.end, replacement: event.replacement })}\n\n`,
                  );
                }
              }
            : undefined;
        // Reasoning blocks (docs/plans/reasoning-blocks-plan.md): forward each reasoning delta to
        // regenerateSwipe, which relays it to this callback for a bigimagine_reasoning SSE frame —
        // the send/swipe parity carried through to reasoning exactly like the cleanup frames. NOT
        // gated on cleanup_enabled_at: reasoning is independent of the cleanup opt-in (detection
        // runs unconditionally inside streamingTurn), so an RP swipe that never enabled cleanup
        // still streams its thinking live. Same first-frame-commits-headers rule as onDelta.
        const onReasoningDelta: ((reasoningDelta: string) => void) | undefined = streamingRp
          ? (reasoningDelta) => {
              if (!streamHeadersSent) {
                writeStreamHeaders(res);
                streamHeadersSent = true;
              }
              res.write(`data: ${JSON.stringify({ bigimagine_reasoning: true, delta: reasoningDelta })}\n\n`);
            }
          : undefined;
        const result = await regenerateSwipe(deps, userId, chatId, detail, messageId, streamingRp, onDelta, onCleanupEvent, onReasoningDelta);
        if (!result.ok) {
          if (streamingRp && streamHeadersSent) {
            // Streaming had already begun: headers are committed, so surface the failure/abort as
            // the terminal frame before [DONE] instead of an HTTP status change (plan Contracts).
            // Nothing was persisted (recordSwipe never ran) — the client that sees this frame knows
            // the regeneration didn't complete.
            log.error(`swipe regenerate failed for chat ${chatId} after streaming began`, result.error);
            writeStreamErrorTerminalFrame(res, result.aborted === true, result.error);
            req.off('close', onClientClose);
            return;
          }
          // 499 = the user stopped this regeneration (POST /v1/chat/abort) — same contract as the
          // main turn's aborted response, so the frontend treats both the same way.
          req.off('close', onClientClose);
          sendJson(res, result.aborted ? 499 : 500, { error: result.error });
          return;
        }
        if (streamingRp) {
          // The stream resolved and recordSwipe persisted the regenerated swipe above. The final SSE
          // frames go out only now — a client that sees [DONE] can trust the swipe is already saved
          // (plan Logic), the same guarantee the non-streaming response gives.
          if (!streamHeadersSent) writeStreamHeaders(res);
          res.write(`data: ${JSON.stringify(buildChatCompletionChunk(detail.session.params.model ?? '', sseId, {}, 'stop'))}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          req.off('close', onClientClose);
          // endpoint.md §5: fire the decoupled passes only once the reply is actually sent — a
          // provider round-trip has no place in the request path, so the triggers ride the
          // response's 'finish' event, decoupled the same way chatMemorySync.ts's tick is.
          if (result.locationId || (result.characterIds?.length ?? 0) > 0) {
            res.once('finish', () => fireSwipedPresenceTriggers(deps, userId, chatId, result));
          }
          return;
        }
        sendJson(res, 200, { message: await decorateMessageForDisplay(deps.db, deps.settings, userId, detail.session, result.message) });
        // endpoint.md §5: fire the decoupled passes only once the reply is actually sent — a
        // provider round-trip has no place in the request path, so the triggers ride the
        // response's 'finish' event, decoupled the same way chatMemorySync.ts's tick is.
        if (result.locationId || (result.characterIds?.length ?? 0) > 0) {
          res.once('finish', () => fireSwipedPresenceTriggers(deps, userId, chatId, result));
        }
        return;
      } finally {
        endInteractiveTurn(chatId);
      }
    }
  }

  sendJson(res, 404, { error: 'not found' });
}
