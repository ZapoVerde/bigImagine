/**
 * @file orchestrator/src/server/characterSpriteRefresh.ts
 * @stamp 2026-08-21
 * @architectural-role Orchestrator — the Cast "Refresh Imagery" recovery action
 * @description
 * POST /v1/chats/:chatId/character-sprites/refresh — the narrow, authenticated
 * Cast refresh (required behaviour §Required Behaviour). Reads the current chat's
 * scene_presence (sole authority), and for every currently-present character
 * attempts to ensure their current imagery through the *existing* character
 * visual-state, autofire, combination, BGRM and SpriteStage machinery — never a
 * second pipeline.
 *
 * Per present character:
 *  - existing state + valid combination (matching the live BGRM dimension) → reused,
 *    no generation;
 *  - existing state but missing combination → existing autofire path generates it;
 *  - missing visual state → recover via the canonical footer parser against the
 *    latest persisted assistant reply (header + footer, parseCharacterVisualStateFooter
 *    canonical grammar requiring `- Slot:` — never weakened to `*`), persist through
 *    applyCharacterVisualState and continue;
 *  - if that latest footer cannot produce valid state → per-character failure with
 *    reason, other cast members continue (partial failure does not prevent others).
 *
 * BGRM (`character_visual_bgrm_enabled`) is read live and obeyed, not overridden:
 * when disabled the raw portrait is the success output; when enabled the transparent
 * variant is attempted via the existing post-process path (raw → BGRM upgrade when
 * a raw row already exists).
 *
 * Does not modify scene_presence, does not infer cast membership, does not create
 * Portrait Studio visual_entities copies, does not use the manual
 * `from-cast-character` Studio workflow, and does not blindly regenerate already-
 * valid combinations (idempotent where valid).
 *
 * @api-declaration
 * handleChatCharacterSpritesRefresh(req, res, deps, userId, url) -> Promise<void>
 *   POST /v1/chats/:chatId/character-sprites/refresh; 200 { results }, 401/404/405/500 otherwise
 * refreshCharacterSpritesForChat(deps, userId, chatId) -> Promise<RefreshResult[]>
 *   orchestration core, reuses existing pipeline functions directly
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO, settings read, optional LLM mints + image provider via autofire)
 *     state_ownership: []
 *     external_io:     [Postgres (withUserScope), orchestrator_settings read, LLM + image provider when generating]
 *     never:           modifies scene_presence, creates visual_entities via from-cast path, invents outfit/expression defaults
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '../io/logger.js';
import type { HttpServerDeps } from './httpServer.js';
import { sendJson } from './httpUtils.js';
import { applyCharacterVisualState } from '../orchestrator/characterVisualState.js';
import { renderCharacterVisualCombination } from '../orchestrator/characterVisualAutofire.js';
import { resolveCleanupConfig } from '../orchestrator/cleanupLoop.js';
import { resolvePortraitLlm } from './portraitRoutes.js';
import { parseStoryHeader } from '../orchestrator/locationAndPresenceScraper.js';
import { parseCharacterVisualStateFooter, normalizeExpression, normalizeOutfitKey, type OutfitFields } from '../orchestrator/characterVisualStateParser.js';
import { extractRegion } from '../orchestrator/cleanupHeuristics.js';

export type RefreshStatus = 'reused' | 'generated' | 'recovered' | 'failed';

export interface RefreshResult {
  characterId: string;
  name: string;
  status: RefreshStatus;
  imageUrl: string | null;
  reason?: string;
}

interface SceneRow {
  scene_id: string | null;
}
interface PresenceRow {
  character_id: string;
  presence_order: number;
  name: string;
  status: string | null;
}
interface VisualStateRow {
  inner_thoughts: string;
  expression: string;
  outerwear: string;
  top: string;
  bottom: string;
  underwear_top: string;
  underwear_bottom: string;
  accessory: string;
  message_id: string | null;
  swipe_id: string | null;
}
interface CombinationRow {
  image_url: string | null;
}
interface MessageRow {
  message_id: string;
  content: string;
  active_swipe_id: string | null;
  created_at: string;
}

function outfitFieldsFromState(row: VisualStateRow): OutfitFields {
  return {
    outerwear: row.outerwear ?? '',
    top: row.top ?? '',
    bottom: row.bottom ?? '',
    underwear_top: row.underwear_top ?? '',
    underwear_bottom: row.underwear_bottom ?? '',
    accessory: row.accessory ?? '',
  };
}

async function readVisualState(
  deps: HttpServerDeps,
  userId: string,
  chatId: string,
  characterId: string,
): Promise<VisualStateRow | null> {
  const rows = await deps.db.withUserScope(userId, (session) =>
    session.query<VisualStateRow>(
      `select inner_thoughts, expression, outerwear, top, bottom, underwear_top, underwear_bottom, accessory, message_id, swipe_id
       from character_visual_states where user_id = $1 and chat_id = $2 and character_id = $3`,
      [userId, chatId, characterId],
    ),
  );
  return rows[0] ?? null;
}

async function readCombination(
  deps: HttpServerDeps,
  userId: string,
  chatId: string,
  characterId: string,
  outfitKey: string,
  expressionKey: string,
  bgrmApplied: boolean,
): Promise<CombinationRow | null> {
  const rows = await deps.db.withUserScope(userId, (session) =>
    session.query<CombinationRow>(
      `select image_url from character_visual_combinations
       where user_id = $1 and chat_id = $2 and character_id = $3 and outfit_key = $4 and expression_key = $5 and bgrm_applied = $6`,
      [userId, chatId, characterId, outfitKey, expressionKey, bgrmApplied],
    ),
  );
  return rows[0] ?? null;
}

export async function refreshCharacterSpritesForChat(
  deps: HttpServerDeps,
  userId: string,
  chatId: string,
): Promise<RefreshResult[]> {
  // 1. BGRM config live
  const bgrmEnabled = (await deps.settings.get('character_visual_bgrm_enabled').catch(() => undefined)) === 'true';

  // 2. Current scene pointer via chat_sessions (withUserScope so RLS scopes it)
  const chatRows = await deps.db.withUserScope(userId, (session) =>
    session.query<SceneRow>('select scene_id from chat_sessions where chat_id = $1', [chatId]),
  );
  if (!chatRows[0]) {
    // Chat not found / not owned — caller maps to 404
    throw Object.assign(new Error('chat not found'), { statusCode: 404 });
  }
  const sceneId = chatRows[0].scene_id ?? null;
  if (!sceneId) {
    return [];
  }

  // 3. Ordered presence
  const presenceRows = await deps.db.withUserScope(userId, (session) =>
    session.query<PresenceRow>(
      `select sp.character_id, sp.presence_order, c.name, c.status
       from scene_presence sp
       join characters c on c.character_id = sp.character_id and c.user_id = $2
       where sp.scene_id = $1 and sp.user_id = $2
       order by sp.presence_order`,
      [sceneId, userId],
    ),
  );
  if (presenceRows.length === 0) return [];

  const linkRows = await deps.db.withUserScope(userId, (session) =>
    session.query<{ character_id: string }>('select character_id from character_chat_links where chat_id = $1', [chatId]),
  );
  const linkedSet = new Set(linkRows.map((r) => r.character_id));
  const eligible = presenceRows.filter((r) => {
    if (r.status === null) return true;
    if (r.status === 'inactive') return false;
    return linkedSet.has(r.character_id);
  });
  if (eligible.length === 0) return [];

  // 4. Snapshot states & combinations initial read
  const stateMap = new Map<string, VisualStateRow | null>();
  for (const p of eligible) {
    const st = await readVisualState(deps, userId, chatId, p.character_id);
    stateMap.set(p.character_id, st);
  }

  // 5. Recovery for missing states — single attempt using latest persisted assistant reply
  const missingBefore = eligible.filter((p) => !stateMap.get(p.character_id));
  let recoveryReason: string | null = null;
  let recoveryAttempted = false;
  if (missingBefore.length > 0) {
    recoveryAttempted = true;
    try {
      const footerCfg = await resolveCleanupConfig(deps.settings);
      const msgRows = await deps.db.withUserScope(userId, (session) =>
        session.query<MessageRow>(
          `select message_id, content, active_swipe_id, created_at
           from chat_messages where chat_id = $1 and role = 'assistant'
           order by created_at desc, message_id desc limit 1`,
          [chatId],
        ),
      );
      const latest = msgRows[0] ?? null;
      if (!latest) {
        recoveryReason = 'no assistant message in chat';
      } else {
        const header = parseStoryHeader(latest.content);
        if (!header) {
          recoveryReason = 'latest assistant message has no Present: header';
        } else {
          const region = extractRegion(latest.content, footerCfg.footer);
          if (!region) {
            recoveryReason = 'latest assistant message has no footer region';
          } else {
            const parsed = parseCharacterVisualStateFooter(region.text, header);
            if (!parsed.ok) {
              recoveryReason = `footer parse failed: ${parsed.reason}`;
            } else {
              // Persist via existing machinery (handles one-to-one roster, stale swipe guard, etc.)
              const res = await applyCharacterVisualState({ db: deps.db }, userId, chatId, latest.message_id, latest.content, footerCfg.footer);
              if (!res.applied) {
                // Provide diagnostic: re-evaluate parse reason or generic
                recoveryReason = `visual-state extraction rejected: ${parsed.records.length} record(s) parsed but roster resolution or stale-swipe guard rejected the write`;
              } else {
                recoveryReason = null; // success, even if not all present characters were in that footer
              }
              // Re-read recovered states
              for (const p of missingBefore) {
                const st = await readVisualState(deps, userId, chatId, p.character_id);
                stateMap.set(p.character_id, st);
              }
              // If still missing after a successful apply, we keep recoveryReason as null but per-character will still be failed with specific reason
              if (stateMap.get(missingBefore[0]!.character_id) === null && !recoveryReason) {
                // At least one still missing implies that character had no block in the footer
                recoveryReason = 'footer parsed but produced no state for this character (no block or roster mismatch)';
              }
            }
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recoveryReason = `recovery failed: ${msg}`;
      log.warn('characterSpriteRefresh: recovery attempt failed', { chatId, err });
    }
    // After recovery attempt, re-evaluate: if recoveryReason still null but some characters still missing, set per-character reason
    if (!recoveryReason) {
      const stillMissing = eligible.filter((p) => !stateMap.get(p.character_id));
      if (stillMissing.length > 0) {
        // Keep a generic fallback reason for those still missing; per-character will override with this
        recoveryReason = 'no valid Character Status for this character in latest assistant reply';
      }
    }
  }

  // 6. For each present character, ensure imagery via autofire path where needed
  const llm = await resolvePortraitLlm(deps).catch(() => deps.llm);
  const results: RefreshResult[] = [];

  for (const pres of eligible) {
    const state = stateMap.get(pres.character_id) ?? null;
    if (!state) {
      results.push({
        characterId: pres.character_id,
        name: pres.name,
        status: 'failed',
        imageUrl: null,
        reason: recoveryAttempted ? (recoveryReason ?? 'no visual state and recovery produced none') : 'no visual state',
      });
      continue;
    }

    const outfitFields = outfitFieldsFromState(state);
    const outfitKey = normalizeOutfitKey(outfitFields);
    const expressionKey = normalizeExpression(state.expression);

    const desired = await readCombination(deps, userId, chatId, pres.character_id, outfitKey, expressionKey, bgrmEnabled);
    if (desired?.image_url) {
      results.push({
        characterId: pres.character_id,
        name: pres.name,
        status: 'reused',
        imageUrl: desired.image_url,
      });
      continue;
    }

    // Need generation — check fallback raw when BGRM enabled for reporting, but still generate desired variant
    // Do not blindly regenerate when desired exists (handled above); upgrade path counts as generation
    const wasRecovered = missingBefore.some((m) => m.character_id === pres.character_id) && recoveryAttempted && state !== null;

    try {
      await renderCharacterVisualCombination(
        { db: deps.db, settings: deps.settings, imageConnections: deps.imageConnections },
        llm,
        userId,
        chatId,
        pres.character_id,
        outfitFields,
        state.expression,
      );
    } catch (err) {
      log.warn('characterSpriteRefresh: renderCharacterVisualCombination threw', { characterId: pres.character_id, chatId, err });
    }

    const after = await readCombination(deps, userId, chatId, pres.character_id, outfitKey, expressionKey, bgrmEnabled);
    if (after?.image_url) {
      // If BGRM enabled but still only fallback exists, sprite stage would still show it via fallback read — treat as generated if we just created desired, otherwise fallback is still success
      const fallback = bgrmEnabled
        ? await readCombination(deps, userId, chatId, pres.character_id, outfitKey, expressionKey, false)
        : null;
      const finalUrl = after.image_url ?? fallback?.image_url ?? null;
      if (finalUrl) {
        const status: RefreshStatus = wasRecovered ? 'recovered' : 'generated';
        results.push({
          characterId: pres.character_id,
          name: pres.name,
          status,
          imageUrl: finalUrl,
        });
        continue;
      }
    }
    // No combination after attempt — check fallback raw for BGRM-enabled degraded success? SpriteStage fallback would show raw, so we could consider fallback URL as success if present
    if (bgrmEnabled) {
      const fallback = await readCombination(deps, userId, chatId, pres.character_id, outfitKey, expressionKey, false);
      if (fallback?.image_url) {
        const status: RefreshStatus = wasRecovered ? 'recovered' : 'generated';
        results.push({
          characterId: pres.character_id,
          name: pres.name,
          status,
          imageUrl: fallback.image_url,
          reason: 'BGRM variant unavailable; using raw portrait (BGRM enabled but post-process failed or no BGRM connection)',
        });
        continue;
      }
    }
    // Generation truly failed — no image available
    // Determine reason: portrait connection missing is common
    let reason = 'image generation failed — no active portrait connection or provider error';
    try {
      const profile = await deps.imageConnections.resolveActive('portrait').catch(() => null);
      if (!profile) reason = 'no active portrait image connection configured';
    } catch {}
    results.push({
      characterId: pres.character_id,
      name: pres.name,
      status: 'failed',
      imageUrl: null,
      reason,
    });
  }

  // Preserve presence_order in result order already
  log.info('characterSpriteRefresh: completed', {
    chatId,
    total: results.length,
    reused: results.filter((r) => r.status === 'reused').length,
    generated: results.filter((r) => r.status === 'generated').length,
    recovered: results.filter((r) => r.status === 'recovered').length,
    failed: results.filter((r) => r.status === 'failed').length,
  });
  return results;
}

export async function handleChatCharacterSpritesRefresh(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
  userId: string,
  url: URL,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  const m = url.pathname.match(/^\/v1\/chats\/([^/]+)\/character-sprites\/refresh$/);
  if (!m) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const chatId = decodeURIComponent(m[1]!);
  // Drain any body so the connection closes cleanly; refresh carries no body contract
  try {
    await new Promise<void>((resolve) => {
      if ((req as { complete?: boolean }).complete) {
        resolve();
        return;
      }
      const onData = () => {};
      const onEnd = () => {
        req.off?.('data', onData);
        req.off?.('end', onEnd);
        resolve();
      };
      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onEnd);
      setTimeout(() => resolve(), 80);
    });
  } catch {}

  try {
    const results = await refreshCharacterSpritesForChat(deps, userId, chatId);
    sendJson(res, 200, { results });
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 404) {
      sendJson(res, 404, { error: 'chat not found' });
      return;
    }
    log.error('characterSpriteRefresh: handler failed', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  }
}
