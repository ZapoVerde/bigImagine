/**
 * @file orchestrator/src/server/handleChatCompletions.ts
 * @stamp 2026-08-12
 * @architectural-role IO Wrapper — POST /v1/chat/completions from httpServer.ts
 * @description
 * The main turn endpoint (docs/plans/completed/rp-streaming-plan.md, turn-loop-plan.md): body validation
 * + vision gate, the persisted-session path (chat_id → params/tools, assembleSessionTurnContext,
 * pre-persisted user anchor message, 'main' prompt-trace capture), the buffered runTurn lane and
 * the RP streaming lane (SSE deferred until first delta, client-close abort), post-turn
 * persistence (appendMessages, lorebook activation log, first-turn header repair, location
 * scrape, background chat naming, canvas note), and the response tails that fire the decoupled
 * location-image pass on 'finish'. Stateless Open WebUI traffic keeps the original behavior
 * bit-for-bit (no chat_id → no assembly, no trace, no persistence).
 *
 * Reasoning blocks (docs/plans/reasoning-blocks-plan.md) ride this endpoint's SSE stream: each
 * reasoning delta the turn classifies is relayed as a { bigimagine_reasoning: true, delta }
 * frame (onReasoningDelta → res.write), independent of the cleanup opt-in, and the accumulated
 * reasoning is persisted in its own column via appendMessages — and carried forward into the
 * cleanup handoff's composed swipe (finalizeCleanupResult's reasoning param), so a live repair
 * never nulls it out. Turn 1 withholds reasoning like it withholds content, and sends it as one
 * frame before the whole-reply chunk once persistence completes.
 *
 * @api-declaration
 * handleChatCompletions(req, res, deps) — POST /v1/chat/completions
 *
 * @contract
 *   assertions:
 *     purity:          impure (LLM calls, chat persistence, lorebook log, background title gen)
 *     state_ownership: []
 *     external_io:     [LLM (via turnLlm), Postgres (via deps.db/deps.chats)]
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { generateChatTitle } from '../io/llm/generateChatTitle.js';
import { runWithCallContext } from '../io/llm/callContext.js';
import { log } from '../io/logger.js';
import { recordPromptTrace, type PromptTraceEntry } from '../io/promptTrace.js';
import { runTurn } from '../orchestrator/loop.js';
import { runStreamingRpTurn, type RunStreamingRpTurnResult } from '../orchestrator/streamingTurn.js';
import { abortTurn, isAbortError, registerTurnAbort, unregisterTurnAbort } from '../orchestrator/turnAbort.js';
import { claimCleanupInFlight, finalizeCleanupResult, releaseCleanupInFlight, type CleanupLoopDeps, type CleanupRegionOutcome } from '../orchestrator/cleanupLoop.js';
import { clearCleanupLiveStatus } from '../orchestrator/cleanupLiveStatus.js';
import { finishStream, type CleanupLiveEvent } from '../orchestrator/liveCleanup.js';
import { writeLorebookActivationLog } from '../io/lorebook/writeLorebookActivationLog.js';
import { maybeEagerChunk } from '../orchestrator/eagerChunkSync.js';
import { parseStoryHeader, scrapeTurnPresence } from '../orchestrator/locationAndPresenceScraper.js';
import { ensureFirstTurnHeader } from '../orchestrator/ensureFirstTurnHeader.js';
import { appendAttachmentsToLatestUserMessage, attachImagesToLatestUserMessage } from '../util/attachmentContext.js';
import { formatCurrentDateContext } from '../util/dateContext.js';
import { createToolRegistry, filterToolRegistry } from '../orchestrator/toolRegistry.js';
import { getHouseholdTimezone } from './adminServer.js';
import { assembleSessionTurnContext } from './promptAssembly.js';
import { toPreviewItem, type PromptPreviewItem } from './promptPreview.js';
import { fireLocationImageGeneration } from './locationImages.js';
import { resolveTurnLlm } from './turnExecution.js';
import { buildChatCompletion, buildChatCompletionChunk, isChatCompletionRequestBody } from './openai.js';
import {
  authenticate,
  JsonBodyTooLargeError,
  readJsonBody,
  sendJson,
  writeStreamErrorTerminalFrame,
  writeStreamHeaders,
} from './httpUtils.js';
import type { ChatParams } from '../io/chatSessions.js';
import type { LlmMessage } from '../io/llm/types.js';
import type { HttpServerDeps } from './httpServer.js';

const ALLOWED_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

// Uncapped until Stage 5 (images/vision) — a chat-completions body carrying several base64-encoded
// images is the first realistic way this could balloon; everything else here is chat text, which
// never approached a size worth guarding against. Generous enough for MAX_IMAGES_PER_TURN images
// at openai.ts's own MAX_IMAGE_BYTES ceiling, plus normal chat text/attachments Markdown.


export async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
): Promise<void> {
  const { db, settings, tools, apiKeys, accessIdentity, chats } = deps;

  const userId = await authenticate(req, apiKeys, accessIdentity);
  if (!userId) {
    sendJson(res, 401, { error: 'missing or unrecognized API key' });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof JsonBodyTooLargeError) {
      sendJson(res, 413, { error: `request body exceeds the ${Math.floor(err.maxBytes / (1024 * 1024))}MB limit` });
      return;
    }
    throw err;
  }
  if (!isChatCompletionRequestBody(body)) {
    sendJson(res, 400, { error: 'expected { messages: [{role, content}, ...] }' });
    return;
  }

  // The location resolved by Stage 2's scraper (segway.md §4.2) — captured here so endpoint.md
  // §5's decoupled image-generation trigger can fire after the reply is sent (see the SSE and
  // sendJson tails of this handler).
  let scrapedLocationId: string | undefined;

  const messages: LlmMessage[] = body.messages
    .filter((m) => ALLOWED_ROLES.has(m.role))
    .map((m) => ({ role: m.role as LlmMessage['role'], content: m.content }));

  // Attached files (already turned into Markdown by POST /v1/attachments/extract) are appended
  // only to the copy of history sent to the model this one turn — never persisted. Everything
  // below that reads from `messages` (chat storage, the auto-generated title) deliberately keeps
  // using the original, un-spliced array; only the runTurn call below gets messagesForLlm. Images
  // (if any) are spliced in further down, only after confirming the resolved connection actually
  // supports vision — see the explicit-failure gate below.
  let messagesForLlm = body.attachments?.length
    ? appendAttachmentsToLatestUserMessage(messages, body.attachments)
    : messages;

  // Persisted-session path (bigBrain's own frontend): chat_id ties this turn to a chat_sessions
  // row — its params/tool allow-list apply and the exchange is stored after the turn resolves.
  // No chat_id (Open WebUI's traffic) keeps the original fully stateless behavior.
  let sessionParams: ChatParams = {};
  let sessionTools = tools;
  let sessionWasEmpty = false;
  let sessionTitle: string | undefined;
  let priorMessageCount = 0;
  let sessionKind: 'chat' | 'rp' = 'chat';
  // Which character (if any) this chat is linked to (applyCharacterToChatTool.ts) — only read
  // here for docs/plans/prompt-macros.md's {{char}} macro (see the interpolateMacros call below);
  // everything else about the turn is indifferent to it.
  let sessionCharacterId: string | null = null;
  // Which context_stack_presets row (if any) drives this turn's per-turn narrator assembly
  // (docs/plans/turn-loop-plan.md §3.2). The legacy post-runTurn cleanup pass is gone — cleanup is now
  // the async heuristic subloop (cleanupLoop.ts), opted in per chat via cleanup_enabled_at.
  let sessionPromptStackPresetId: string | null = null;
  // When this chat opted into the cleanup subloop (migration 0072) — non-null gates the live
  // cleanup path (in-stream-cleanup-plan.md) for this turn's stream. Hoisted out of the chat_id
  // block below because the streaming branch (which reads it) sits outside that block's scope.
  let sessionCleanupEnabledAt: string | null = null;
  // The already-persisted latest user message's id (rerun/edit-resend case, where there's no new
  // user turn to insert) — carried forward so point-in-time canon recall still has an anchor to
  // use even when this turn doesn't add a fresh chat_messages row of its own.
  let existingLatestUserMessageId: string | undefined;
  // The last user message the DB actually holds (role+content), read in the chat_id block below —
  // used by the isNewTurn decision further down as the identity side of its check (see there).
  let lastPersistedUserMessage: { content: string } | undefined;
  if (body.chat_id) {
    const detail = await chats.getChat(userId, body.chat_id);
    if (!detail) {
      sendJson(res, 404, { error: 'unknown chat_id' });
      return;
    }
    sessionParams = detail.session.params;
    sessionWasEmpty = detail.messages.length === 0;
    sessionTitle = detail.session.title;
    priorMessageCount = detail.messages.length;
    sessionKind = detail.session.kind;
    sessionCharacterId = detail.session.characterId;
    sessionPromptStackPresetId = detail.session.promptStackPresetId;
    sessionCleanupEnabledAt = detail.session.cleanupEnabledAt;
    existingLatestUserMessageId = [...detail.messages].reverse().find((m) => m.role === 'user')?.messageId;
    lastPersistedUserMessage = [...detail.messages].reverse().find((m) => m.role === 'user');
    if (detail.session.toolNames !== null) {
      sessionTools = filterToolRegistry(tools, detail.session.toolNames);
    }
  }
  // The RP lane runs with NO tools at all (2026-08-10 user direction) — the model just executes
  // its prompt stack (the Comfy 2 preset) and can never emit a tool call, character creation
  // included. Overrides any stored tool_names value (the legacy recall pair, or null = all).
  // Auto-recall still injects into the stack server-side; it never needed a model tool call.
  if (sessionKind === 'rp') sessionTools = createToolRegistry([]);

  const { turnLlm, turnDefaultModel, turnPrice } = await resolveTurnLlm(deps, sessionParams, body.chat_id);

  // The one deterministic gate bb_principles.md §2/§11 requires for images: fail the whole turn
  // visibly, before runTurn/llm.complete is ever called, rather than silently dropping the image
  // or letting a non-vision model claim to have seen it. Checked against whichever connection this
  // turn actually resolved to (a per-chat override or the household-wide active one), not just the
  // active one — supportsVision travels with the profile (io/llm/profiles.ts), not the pick.
  if (body.images?.length) {
    if (!turnLlm.supportsVision) {
      const connectionLabel = sessionParams.profile ? `the "${sessionParams.profile}" connection` : 'the active connection';
      sendJson(res, 422, {
        error: `${connectionLabel} doesn't support image input — enable vision support for it in Settings, or switch connections`,
      });
      return;
    }
    messagesForLlm = attachImagesToLatestUserMessage(messagesForLlm, body.images);
  }

  // A client's own model picker (Open WebUI's dropdown, populated from GET /v1/models) sends
  // its selection here — that's what actually takes effect, not the fixed modelName below.
  // turnDefaultModel only remains as the label echoed back when the request didn't specify one.
  const model = body.model ?? sessionParams.model;
  // Unconditional, on every turn — a model has no reliable sense of "today" on its own, and
  // date-taking tools (add_meal_plan_entry, get_meal_plan, ...) need it regardless of whether
  // this chat has its own custom system prompt, or even a chat_id at all (Open WebUI's stateless
  // traffic gets it too). household_timezone is read live, not cached at boot, so changing it in
  // Settings takes effect on the very next turn, no restart.
  const timezone = await getHouseholdTimezone(deps.settings);

  // docs/plans/prompt-macros.md's Stage 1: resolved fresh every turn (not baked at apply_prompt_stack_
  // to_chat time) specifically so a persona/character-card edit takes effect on the very next
  // message with no re-apply needed — bi_principles.md §13's live-read, no-restart guarantee
  // applied to {{user}}/{{char}}/{{persona}} the same way it already applies to every other
  // Settings-backed value. Gated to 'rp' chats (a household 'chat'-kind session could legitimately
  // contain literal `{{...}}`-looking text, e.g. discussing templating syntax, that has no
  // business being rewritten) and to a cheap .includes('{{') check, so the common case — an RP
  // chat whose system prompt has no macros in it — pays for none of the extra reads below.
  // docs/chat-memory.md: only the persisted-session path (bigBrain's own frontend, which the
  // rolling-sync pipeline actually maintains derived state for) gets server-side history trimming
  // and memory injection — a stateless caller (Open WebUI) gets exactly what it sent, unchanged,
  // same as before this feature existed.
  let systemPrompt: string;
  // The assistant message this turn will persist is pre-generated before prompt assembly so
  // the lorebook gate can seed its deterministic per-turn probability roll from the message
  // being generated (docs/lorebook-plan.md §4) — never Math.random, so a retry or re-assembly
  // reproduces the same bytes and the byte-prefix cache survives. Only set for persisted turns
  // (body.chat_id); threaded to appendMessages below so the activation-log row's message_id
  // matches the seed exactly.
  let assistantMessageId: string | undefined;
  let lorebookActivatedEntryIds: string[] = [];
  if (body.chat_id) {
    assistantMessageId = randomUUID();
    const assembled = await assembleSessionTurnContext(
      db,
      deps.settings,
      deps.embeddings,
      userId,
      body.chat_id,
      sessionKind,
      sessionCharacterId,
      sessionPromptStackPresetId,
      sessionParams,
      messagesForLlm,
      timezone,
      assistantMessageId,
    );
    systemPrompt = assembled.systemPrompt;
    messagesForLlm = assembled.messagesForLlm;
    lorebookActivatedEntryIds = assembled.lorebookActivatedEntryIds;
  } else {
    systemPrompt = [formatCurrentDateContext(timezone), sessionParams.system].filter(Boolean).join('\n\n');
  }

  // Point-in-time canon recall's anchor (db/migrations/0053_canon_facts_chat_anchor.sql) needs the
  // triggering user message's id available to mid-turn tool calls, not just to the post-turn
  // appendMessages below — so a genuinely new turn's user message is persisted here, before
  // runTurn runs, rather than only after. A rerun/edit-resend has no new user message to insert
  // (see below); it anchors to the existing one instead.
  //
  // "Genuinely new" is decided two ways, because the count check alone is not robust: a previous
  // turn whose reply was persisted but whose SSE [DONE] never reached the client (server restart,
  // proxy timeout, or a post-persistence step throwing mid-stream) leaves the client's optimistic
  // state one message shorter than the persisted transcript. The next send then ties the count
  // (its own length equals the DB's), the new user message never gets persisted, and the post-send
  // refresh silently drops the just-sent bubble. So the count check is joined with an identity
  // check — the client's latest user text differs from the last one the DB holds. That recovers
  // the desynced case; the count check still catches exact-duplicate sends (the same text twice in
  // a row, where content comparison alone would misclassify), and rerun/Resend (byte-identical
  // history) stays a no-insert either way.
  const latestUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  const isNewTurn =
    messages.length > priorMessageCount ||
    (!!latestUserMessage && !!lastPersistedUserMessage && latestUserMessage.content !== lastPersistedUserMessage.content);
  let anchorMessageId: string | undefined = existingLatestUserMessageId;
  if (body.chat_id && latestUserMessage && isNewTurn) {
    const [inserted] = await chats.appendMessages(userId, body.chat_id, [{ role: 'user', content: latestUserMessage.content }]);
    anchorMessageId = inserted?.messageId;
  }

  // The Prompt Inspector's "Main Prompt" is the exact text this turn sends, captured at send time
  // (io/promptTrace.ts) — record-before-the-call, same rule the cleanup subloop's repair prompts
  // follow (cleanupLoop.ts's dispatchStep). runTurn prepends systemPrompt to messagesForLlm; that
  // final array is what the model sees, so that's what the trace records. This is what lets the
  // inspector show "the last turn that was sent" (bi_principles.md §17) instead of a live
  // reconstruction of the next one.
  // Persisted chats only — no chat_id is stateless Open WebUI traffic with nothing to trace
  // against. Images ride on LlmMessage.images (util/attachmentContext.ts), never in content, so
  // this never embeds base64 blobs into the trace.
  // The entry stays live after recordPromptTrace so usage/price can be attached once the turn
  // resolves — the same "absent until the call returns, absent forever if it failed" contract
  // as reply. Undefined while stateless (no chat_id): nothing to trace, nothing to attach.
  let mainTraceEntry: PromptTraceEntry | undefined;
  if (body.chat_id) {
    mainTraceEntry = {
      kind: 'main',
      title: 'Main Prompt',
      items: [
        ...(systemPrompt ? [toPreviewItem('system', systemPrompt)] : []),
        ...messagesForLlm.map((m) => toPreviewItem(m.role as PromptPreviewItem['role'], m.content)),
      ],
      capturedAt: Date.now(),
    };
    recordPromptTrace(body.chat_id, mainTraceEntry);
  }

  let reply: string;
  let focusedNoteId: string | null | undefined;
  // Real token-level streaming for the RP lane (docs/plans/completed/rp-streaming-plan.md): when an RP chat
  // asks for stream: true, the turn runs through runStreamingRpTurn instead of runTurn and every
  // delta is relayed to the client as it arrives. The chat-kind lane (tool-calling turns, Open
  // WebUI) is untouched and keeps the buffered runTurn path byte-for-byte.
  const streamingRp = sessionKind === 'rp' && body.stream === true;
  // Echoed back in every SSE chunk's model field (the OpenAI-compatible framing). Declared here,
  // before the streaming branch, because its onDelta closure reads it during the turn.
  const echoedModel = model ?? turnDefaultModel;
  // First LLM turn of a new RP chat (≤1 pre-turn message: empty chat, a seeded greeting only, or
  // a user message left by a failed first attempt): the reply's scene header may be repaired by
  // ensureFirstTurnHeader (below) after the LLM resolves but before persistence. Declared here,
  // before the streaming branch, because its onDelta closure reads it during the turn — turn 1 is
  // deliberately NOT streamed live (rp-streaming-plan.md Edge Cases), so the client never sees
  // raw pre-repair text that wouldn't match what actually gets saved.
  const firstLlmTurn = sessionKind === 'rp' && priorMessageCount <= 1;
  // SSE headers are deliberately deferred until the first delta (plan Contracts: "no headers sent
  // yet, respond with 499/500 as today") — so a zero-delta failure still surfaces as a normal
  // HTTP status instead of a committed-200 terminal frame.
  let streamHeadersSent = false;
  const sseId = `chatcmpl-${randomUUID()}`;
  const taskId = body.chat_id ?? randomUUID();
  // A dropped client connection cancels the in-flight LLM call (plan Edge Cases) instead of
  // burning tokens on a stream nobody is reading — fires the same abort path as the explicit
  // Stop button. Detached when the streaming branch ends (every outcome) so a close event that
  // fires after this turn finished can't abort the next turn registered under the same chat_id.
  const onClientClose = () => {
    if (streamingRp) abortTurn(taskId);
  };
  req.on('close', onClientClose);

  // In-stream cleanup (docs/plans/completed/in-stream-cleanup-plan.md): wired only for RP chats that opted
  // into the cleanup subloop (cleanup_enabled_at) and have a persisted session (chat_id) — the
  // live engine's bigimagine_cleanup / bigimagine_patch frames ride the same SSE stream, and the
  // finalizeCleanupResult handoff writes the composed swipe exactly the way the poll tick does.
  // The gate keeps a chat that never enabled cleanup free of both live repairs and cleanup frames.
  const liveCleanupActive = streamingRp && !!body.chat_id && sessionCleanupEnabledAt != null;
  const cleanupDeps: CleanupLoopDeps = {
    db,
    llm: deps.llm, // the household gated provider — same one the poll tick's repairs use
    settings,
    chats,
    // Same deferred post-repair location-scrape trigger the poll tick wires at the composition
    // root (index.ts): a live header repair also lands a location, so the bg pass fires too.
    onLocationScraped: (u, c, locationId) => fireLocationImageGeneration(deps, u, c, locationId),
  };
  const onCleanupEvent: ((event: CleanupLiveEvent) => void) | undefined = liveCleanupActive
    ? (event) => {
        // Cleanup frames can arrive before the first content delta (turn 1's finishStream runs
        // after persistence; the header check can fire on an early delta) — commit SSE headers
        // on the first frame of any kind.
        if (!streamHeadersSent) {
          writeStreamHeaders(res);
          streamHeadersSent = true;
        }
        // Turn 1 is never streamed live (same rule as onDelta below): the client has accumulated
        // no raw text, so a patch span would splice against an empty buffer — and the composed
        // text arrives wholesale in the post-persistence chunk anyway, making any in-place
        // correction redundant. Status frames still go out so the pills track the repairs.
        if (event.kind === 'patch' && firstLlmTurn) return;
        if (event.kind === 'status') {
          res.write(`data: ${JSON.stringify({ bigimagine_cleanup: true, region: event.region, state: event.state })}\n\n`);
        } else {
          res.write(
            `data: ${JSON.stringify({ bigimagine_patch: true, region: event.region, start: event.start, end: event.end, replacement: event.replacement })}\n\n`,
          );
        }
      }
    : undefined;
  // Reasoning blocks (docs/plans/reasoning-blocks-plan.md): every reasoning delta the turn's
  // detector classifies is relayed as its own bigimagine_reasoning frame — the same
  // always-before-[DONE] interleaving as the cleanup frames, and the client renders them into a
  // <details> sibling above the markdown. Deliberately NOT gated by liveCleanupActive (reasoning
  // is independent of the cleanup opt-in) and NOT gated by skipLiveTriggers (the detector runs
  // unconditionally inside streamingTurn; this callback only relays what it classified — the plan
  // says detection happens on every RP streaming turn). Reasoning frames can arrive before the
  // first content delta (models emit thinking first), so headers are committed on the first frame
  // of any kind, exactly like the cleanup frames. Turn 1 withholds reasoning exactly like content
  // (firstLlmTurn below — the raw reply is never streamed live): it is sent as one frame in the
  // final SSE phase, right before the whole-reply chunk, preserving "reasoning, then reply".
  const onReasoningDelta: (reasoningDelta: string) => void = (reasoningDelta) => {
    if (firstLlmTurn) return;
    if (!streamHeadersSent) {
      writeStreamHeaders(res);
      streamHeadersSent = true;
    }
    res.write(`data: ${JSON.stringify({ bigimagine_reasoning: true, delta: reasoningDelta })}\n\n`);
  };
  // The live path holds the loop's in-flight guard for (chat, messageId, '*') from stream start
  // through finalizeCleanupResult — the assistant messageId is pre-generated before the turn and
  // the swipeId isn't known until appendMessages runs, so the wildcard key keeps the 5s poll tick
  // from launching a duplicate repair pass in the appendMessages→finalizeCleanupResult window.
  let cleanupHandoff: RunStreamingRpTurnResult['cleanup'] | undefined;
  let cleanupAbortController: AbortController | undefined;
  let liveCleanupGuardHeld = false;
  // The turn's accumulated reasoning span (reasoning-blocks-plan.md): read after runStreamingRpTurn
  // resolves for persistence (appendMessages) and for turn-1's final reasoning frame; absent when
  // the turn produced no reasoning span. Declared here because both consumers live outside the
  // turn's own try block scope.
  let turnReasoning: RunStreamingRpTurnResult['reasoning'] | undefined;
  // The composed text/outcomes the handoff produced — read again after the if (body.chat_id)
  // block closes (turn-1's final SSE chunk carries the composed text), so declared here.
  let cleanupComposed: string | undefined;
  let cleanupOutcomes: CleanupRegionOutcome[] | undefined;
  const releaseLiveCleanupGuard = () => {
    if (liveCleanupGuardHeld) {
      liveCleanupGuardHeld = false;
      if (body.chat_id && assistantMessageId) releaseCleanupInFlight(body.chat_id, assistantMessageId, '*');
      if (cleanupAbortController) unregisterTurnAbort(taskId, cleanupAbortController);
      // The settled cleanup_jobs rows finalizeCleanupResult just wrote are authoritative now —
      // drop the live overlay so a later getCleanupStatus polls the DB, not this turn's frames.
      if (body.chat_id) clearCleanupLiveStatus(body.chat_id);
    }
  };
  if (liveCleanupActive && body.chat_id && assistantMessageId) {
    claimCleanupInFlight(body.chat_id, assistantMessageId, '*');
    // A second controller under the same taskId — registerTurnAbort supports several per key —
    // so finishStream's end-of-stream repairs share the turn's abort signal (one Stop cancels
    // everything, including a repair still in flight when the stream ended).
    cleanupAbortController = registerTurnAbort(taskId);
    liveCleanupGuardHeld = true;
  }

  if (streamingRp) {
    try {
      const turnResult = await runStreamingRpTurn({
        userId,
        taskId,
        messages: messagesForLlm,
        systemPrompt,
        model,
        sampling: {
          temperature: sessionParams.temperature,
          topP: sessionParams.top_p,
          maxTokens: sessionParams.max_tokens,
        },
        llm: turnLlm,
        db,
        settings,
        chats,
        onCleanupEvent,
        skipLiveTriggers: firstLlmTurn,
        onReasoningDelta,
        onDelta: (delta) => {
          // Turn 1 is deliberately NOT streamed live (plan Edge Cases): ensureFirstTurnHeader may
          // rewrite the reply after the stream resolves, so relaying raw pre-repair text would show
          // the client something that doesn't match what gets saved. The core still accumulates
          // it; the header-repaired text is sent as a single chunk once persistence completes.
          if (firstLlmTurn) return;
          if (!streamHeadersSent) {
            writeStreamHeaders(res);
            streamHeadersSent = true;
          }
          res.write(`data: ${JSON.stringify(buildChatCompletionChunk(echoedModel, sseId, { role: 'assistant', content: delta }, null))}\n\n`);
        },
      });
      reply = turnResult.content;
      cleanupHandoff = turnResult.cleanup;
      turnReasoning = turnResult.reasoning;
      if (mainTraceEntry) {
        mainTraceEntry.usage = turnResult.usage;
        mainTraceEntry.price = turnPrice;
      }
    } catch (err) {
      if (!streamHeadersSent) {
        // Nothing has been streamed yet — today's exact behavior, no SSE at all (plan Contracts).
        if (isAbortError(err)) {
          log.info(`runStreamingRpTurn aborted for user ${userId}`, { chatId: body.chat_id ?? 'stateless' });
          req.off('close', onClientClose);
          releaseLiveCleanupGuard();
          sendJson(res, 499, { error: 'turn aborted' });
          return;
        }
        log.error(`runStreamingRpTurn failed for user ${userId}`, err);
        req.off('close', onClientClose);
        releaseLiveCleanupGuard();
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      // Streaming had already begun: headers are committed, so the failure/abort surfaces as the
      // terminal frame before [DONE] instead of an HTTP status change (plan Contracts). Nothing
      // is persisted — the client that sees this frame knows the turn didn't complete.
      log.error(`runStreamingRpTurn failed for user ${userId} after streaming began`, err);
      writeStreamErrorTerminalFrame(res, isAbortError(err), err instanceof Error ? err.message : String(err));
      req.off('close', onClientClose);
      releaseLiveCleanupGuard();
      return;
    }
  } else {
    try {
      const turnResult = await runTurn({
        userId,
        // A stateless request (no chat_id — Open WebUI's traffic, or any caller not using bigBrain's
        // own persisted-session frontend) still needs a task id for bb_principles.md §14: a fresh
        // one per turn is fine there, since kind stays 'chat' (never capped, only metered) and
        // nothing needs it to be stable across calls the way an agent_routine's job_id must be.
        taskId,
        messages: messagesForLlm,
        systemPrompt,
        model,
        sampling: {
          temperature: sessionParams.temperature,
          topP: sessionParams.top_p,
          maxTokens: sessionParams.max_tokens,
        },
        llm: turnLlm,
        db,
        tools: sessionTools,
        anchorMessageId,
        embeddings: deps.embeddings,
      });
      reply = turnResult.content;
      focusedNoteId = turnResult.focusedNoteId;
      if (mainTraceEntry) {
        mainTraceEntry.usage = turnResult.usage;
        mainTraceEntry.price = turnPrice;
      }
    } catch (err) {
      // Surfaced to the client rather than falling through to startHttpServer's generic top-level
      // catch (bare "internal error") — a provider quirk (truncated tool-call JSON, a malformed
      // upstream response) should be diagnosable from the chat itself, not just the server log.
      if (isAbortError(err)) {
        // The user hit Stop (POST /v1/chat/abort). Not an error: the upstream call was cancelled,
        // nothing was appended, and the frontend treats 499 as the expected "turn stopped" outcome.
        log.info(`runTurn aborted for user ${userId}`, { chatId: body.chat_id ?? 'stateless' });
        sendJson(res, 499, { error: 'turn aborted' });
        return;
      }
      log.error(`runTurn failed for user ${userId}`, err);
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
  }

  if (body.chat_id) {
    // Repair the scene header synchronously when the raw reply lacks one, so the scrape below has
    // a header to resolve a location from and the bg pass fires on turn 1 — the async cleanup
    // subloop would otherwise add the header only after this reply was already persisted and
    // scraped, and nothing re-scrapes (see orchestrator/ensureFirstTurnHeader.ts). One small LLM
    // call, first turn only, fail-open: a failed repair stores and sends the raw reply,
    // byte-identical to before.
    // Everything between the wildcard claim above and this finally can throw — appendMessages on
    // a DB error, ensureFirstTurnHeader on a provider bug — and the guard must drop either way,
    // or the 5s poll tick would never process this message again until restart. releaseLiveCleanupGuard
    // is idempotent, so the finally is the handoff segment's single release point. The composed
    // text and outcomes are read after the finally (turn-1's final SSE chunk carries the composed
    // text), so they are declared here in the enclosing block.
    let firstTurnHeaderRepaired = false;
    let assistantMessage: { messageId: string; role: 'user' | 'assistant' } | undefined;
    try {
      if (firstLlmTurn && reply) {
        const rawReply = reply;
        reply = await ensureFirstTurnHeader(
          { settings: deps.settings },
          turnLlm,
          userId,
          body.chat_id,
          reply,
          messagesForLlm,
        );
        firstTurnHeaderRepaired = reply !== rawReply;
      }
      // The raw reply is persisted BEFORE the cleanup handoff runs, matching regenerateSwipe's
      // ordering exactly (recordSwipe, then finishStream) — finishStream fires independent LLM
      // calls (tail body, footer, deferred 'llm' pass) that can take a while and, in principle,
      // fail unexpectedly; the reply the user already watched stream to their screen must be
      // durable either way, not held hostage to cleanup succeeding. The user message (if this was
      // a genuinely new turn) is already persisted above, before runTurn ran — only the assistant
      // reply is appended here now. Stage 2 (segway.md §4) then scrapes the turn's header block
      // into trusted scene state, anchored to the new message's active swipe — fail-open inside
      // the scraper, so it can never block or degrade the turn.
      const [insertedAssistant] = await chats.appendMessages(userId, body.chat_id, [
        { role: 'assistant', content: reply, messageId: assistantMessageId, reasoning: turnReasoning?.text },
      ]);
      assistantMessage = insertedAssistant;
      // Live cleanup persistence handoff (in-stream-cleanup-plan.md): finishStream's end-of-stream
      // repairs (tail body, footer, deferred 'llm' pass) patch the composed buffer, and every
      // patch was already relayed to the client via SSE frames; the composed text is what
      // finalizeCleanupResult writes as the next swipe, with the raw reply already durable as
      // swipe #0 above (the same durable shape the poll tick produces). Turn 1: baseText is
      // ensureFirstTurnHeader's output and the header region is attributed from its own result.
      if (cleanupHandoff) {
        try {
          const fsResult = await finishStream(cleanupHandoff.ctx, cleanupDeps, reply, {
            userId,
            chatId: body.chat_id,
            signal: cleanupAbortController!.signal,
            onCleanupEvent,
            skipLiveTriggers: firstLlmTurn,
            headerDeployed: firstTurnHeaderRepaired,
          });
          cleanupComposed = fsResult.composed;
          cleanupOutcomes = fsResult.outcomes;
        } catch (err) {
          if (isAbortError(err)) {
            // A Stop landed during the end-of-stream repairs: the raw reply is already persisted
            // above, but no composed swipe and no job rows — the message stays due and the poll
            // tick catches it, same as the tick's own abort path.
            log.info(`live cleanup handoff aborted for user ${userId}`, { chatId: body.chat_id });
          } else {
            throw err; // finishStream is fail-open internally — a non-abort throw here is a bug
          }
        }
      }
      // The composed text (if the live path ran) becomes the next swipe, exactly the poll tick's
      // writeback — same finalizeCleanupResult, so the message is indistinguishable in
      // cleanup_jobs from one the tick caught. Fail-open inside; then the in-flight guard drops.
      if (cleanupOutcomes && cleanupComposed) {
        await finalizeCleanupResult(
          cleanupDeps,
          userId,
          body.chat_id,
          assistantMessageId!,
          reply,
          cleanupComposed,
          cleanupOutcomes,
          turnReasoning?.text, // carry the reasoning into the composed swipe — see finalizeCleanupResult
        );
      }
    } finally {
      releaseLiveCleanupGuard();
    }
    // docs/lorebook-plan.md §3e/§4 — the activation log is written after the turn completes
    // ("write after, not during"): one row per entry this turn injected, the source sticky/
    // cooldown resolve from next turn. writeLorebookActivationLog fails open inside itself, so a
    // log hiccup can never fail a turn that already succeeded. Deliberately NOT wired into the
    // swipe-regenerate path — regenerating a message re-rolls the gate with the same message id
    // (same seed), and the message's original rows stay the audit trail for that message.
    if (lorebookActivatedEntryIds.length > 0 && assistantMessageId) {
      await deps.db.withUserScope(userId, (session) =>
        writeLorebookActivationLog(session, userId, body.chat_id!, assistantMessageId, lorebookActivatedEntryIds),
      );
    }
    if (assistantMessage) {
      // 'extend': a genuinely new turn — a location change advances previous_scene_id
      // (endpoint.md §5.1.8's last-turn location state), so the background can revert to the
      // location that was showing before this turn while the new render is pending.
      // location.md §4.2's header-good gate: only scrape when the reply's header parses — a bad
      // header is left to the cleanup subloop, which repairs it and then fires the deferred
      // scrape on the repaired text (cleanupLoop.ts's onLocationScraped hook). This is the same
      // race ensureFirstTurnHeader.ts already closes for turn 1, generalized to every turn.
      scrapedLocationId = parseStoryHeader(reply)
        ? await scrapeTurnPresence(
            { db, settings, ensureActiveSwipe: (u, c, m) => chats.ensureActiveSwipe(u, c, m) },
            userId,
            body.chat_id,
            assistantMessage.messageId,
            reply,
            'extend',
          )
        : undefined;
    }
    // First exchange in a still-untitled session names it, once — bigBrain never retitles a
    // chat again after this. Reuses the same llm/provider the turn itself just used (this is a
    // single tiny forced-schema call, not worth a separate cheap-model concept); a truncated
    // fallback keeps a naming hiccup from being visible as a broken turn.
    // Deliberately *not* awaited: naming the chat is background polish, and the reply the user
    // is waiting on has no business sitting behind a second LLM round-trip. The call runs
    // decoupled — the same shape as fireLocationImageGeneration and chatMemorySync.ts's tick —
    // and the title lands in the DB whenever it lands; the client picks it up on its next chat
    // refresh (ChatView's refreshActiveMessages re-reads the session). A naming failure still
    // falls back to the truncated title, and a failed persist is logged, never surfaced.
    if (sessionWasEmpty && sessionTitle === 'New chat' && latestUserMessage) {
      // Const captures for the background task — TypeScript doesn't preserve let/narrowed
      // variable types inside closures, and these are read after this function has returned.
      const chatId = body.chat_id;
      const userMessageText = latestUserMessage.content;
      void (async () => {
        let title: string;
        try {
          title = await runWithCallContext({ taskId: chatId, kind: 'system', userId }, () =>
            generateChatTitle(turnLlm, userMessageText, reply),
          );
        } catch (err) {
          log.error('generateChatTitle failed, falling back to a truncated title', err);
          title = userMessageText.slice(0, 60);
        }
        await chats.updateChat(userId, chatId, { title }).catch((err) =>
          log.error(`failed to persist chat title for ${chatId}`, err),
        );
      })();
    }
    // Canvas: only when this turn actually touched a note (a tool's own focusHint said so) —
    // omitted entirely otherwise, so an unrelated turn never clears/overwrites the chat's
    // existing canvas focus (updateChat's dynamic patch treats "not present" as "leave alone").
    if (focusedNoteId !== undefined) {
      await chats.updateChat(userId, body.chat_id, { canvasNoteId: focusedNoteId });
    }
    // Eager chat-memory chunking (docs/plans/eager-chunk-sync-plan.md): the turn pair is now
    // durably persisted — fire the eager chunk step without awaiting it, so the chunk rows
    // mostly exist by the time the sync tick runs and the tick's job shrinks to consolidation.
    // Fire-and-forget, never awaited before the response is sent; maybeEagerChunk catches and
    // logs its own errors, so nothing here can fail or delay the turn (a missed eager pass just
    // falls back to the tick's own chunking, the same graceful degradation an app restart
    // causes). Only the completion of a turn (an assistant reply persisted) triggers it — a
    // rerun/abort never grew the transcript in a way this matters for, and the eager call
    // re-derives everything from the DB anyway.
    if (assistantMessage) {
      const eagerChatId = body.chat_id;
      void maybeEagerChunk(
        { db, llm: deps.llm, embeddings: deps.embeddings, settings: deps.settings, llmConnections: deps.llmConnections },
        userId,
        eagerChatId,
      );
    }
  }

  if (streamingRp) {
    // The stream has resolved and persistence above completed. The final SSE frames are written
    // only now, after persistence succeeds — so a client that sees [DONE] can trust the message is
    // already saved, the same guarantee the non-streaming path gives via its single response
    // (rp-streaming-plan.md Logic). Turn 1 (buffered by onDelta above) gets its one whole-reply
    // chunk here, post header-repair.
    if (!streamHeadersSent) writeStreamHeaders(res);
    if (firstLlmTurn) {
      // Reasoning was withheld during the turn exactly like the reply itself (firstLlmTurn in
      // onReasoningDelta); it's sent here as one frame before the whole-reply chunk — "present
      // only when the turn produced a reasoning span" (the frame is skipped entirely otherwise),
      // preserving the reasoning-then-reply order of live streaming.
      if (turnReasoning) {
        res.write(`data: ${JSON.stringify({ bigimagine_reasoning: true, delta: turnReasoning.text })}\n\n`);
      }
      // The composed text (if the live path ran) is what finalizeCleanupResult persisted as the
      // active swipe; turn-1's raw reply is never relayed to the client, so send the composed
      // text here (falling back to reply when no live pass ran — byte-identical to the old path).
      res.write(
        `data: ${JSON.stringify(buildChatCompletionChunk(echoedModel, sseId, { role: 'assistant', content: cleanupComposed ?? reply }, null))}\n\n`,
      );
    }
    res.write(`data: ${JSON.stringify(buildChatCompletionChunk(echoedModel, sseId, {}, 'stop'))}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    req.off('close', onClientClose);
    if (scrapedLocationId) {
      // endpoint.md §5: fire the location-image generation pass only once the reply is actually
      // sent — never awaited inline (a provider round-trip has no place blocking the reply).
      // turnLlm is the connection this very turn ran on — the describer uses it too (the same
      // "the room's description is written by the story's own voice" default VLZ uses).
      res.once('finish', () => fireLocationImageGeneration(deps, userId, body.chat_id, scrapedLocationId!, turnLlm));
    }
    return;
  }

  if (body.stream) {
    const id = `chatcmpl-${randomUUID()}`;
    writeStreamHeaders(res);
    res.write(
      `data: ${JSON.stringify(buildChatCompletionChunk(echoedModel, id, { role: 'assistant', content: reply }, null))}\n\n`,
    );
    res.write(`data: ${JSON.stringify(buildChatCompletionChunk(echoedModel, id, {}, 'stop'))}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    if (scrapedLocationId) {
      // endpoint.md §5: fire the location-image generation pass only once the reply is actually
      // sent — never awaited inline (a provider round-trip has no place blocking the reply).
      // turnLlm is the connection this very turn ran on — the describer uses it too (the same
      // "the room's description is written by the story's own voice" default VLZ uses).
      res.once('finish', () => fireLocationImageGeneration(deps, userId, body.chat_id, scrapedLocationId!, turnLlm));
    }
    return;
  }

  sendJson(res, 200, buildChatCompletion(echoedModel, reply));
  if (scrapedLocationId) {
    // endpoint.md §5: same decoupled trigger as the streaming branch — the reply is sent, the
    // image pass starts in the background like chatMemorySync.ts's tick. Same turnLlm threading
    // as the streaming branch above.
    res.once('finish', () => fireLocationImageGeneration(deps, userId, body.chat_id, scrapedLocationId!, turnLlm));
  }
}