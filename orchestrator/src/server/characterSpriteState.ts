/**
 * @file orchestrator/src/server/characterSpriteState.ts
 * @stamp 2026-08-21
 * @architectural-role Server — RP Sprite Stage read model (current + historical state)
 * @description
 * Read-only resolver for the RP Sprite Stage (docs/plans/rp-sprite-stage). Resolves the
 * current active-scene cast in canonical `scene_presence.presence_order` order and maps each
 * present character's current `character_visual_states` snapshot — or its historical
 * `character_visual_state_events` snapshot when a selected swipe/message is provided — to its
 * already-rendered `character_visual_combinations` image URL, or `null` when imagery is absent.
 *
 * Consumes the same normalization as the autofire pipeline (`normalizeOutfitKey`,
 * `normalizeExpression`) and the same BGRM cache dimension (`character_visual_bgrm_enabled`
 * + `bgrm_applied`). Does not generate, mint, call BGRM, or mutate any row.
 *
 * @api-declaration
 * getCharacterSpriteState(deps, userId, chatId, opts?) -> Promise<CharacterSpriteState[]>
 *   deps: { db: PostgresClient, settings?: OrchestratorSettingsStore }
 *   opts: { selectedSwipeId?: string | null, selectedMessageId?: string | null }
 *
 * Historical path prefers the current snapshot when its provenance matches the selected
 * swipe/message, otherwise uses the append-only event ledger (exact swipe_id match, then
 * latest event at-or-before the target swipe/message creation time). Never invents state.
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via withUserScope + optional settings read)
 *     state_ownership: []
 *     external_io:     [Postgres, orchestrator_settings (read)]
 *     never:           throws only on DB connectivity; no whole-request failure for missing imagery
 */

import type { PostgresClient } from '../io/postgres.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import { normalizeExpression, normalizeOutfitKey, type OutfitFields } from '../orchestrator/characterVisualStateParser.js';

export interface CharacterSpriteState {
  characterId: string;
  name: string;
  presenceOrder: number;
  imageUrl: string | null;
  expression: string | null;
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
  expression: string;
  outerwear: string;
  top: string;
  bottom: string;
  underwear_top: string;
  underwear_bottom: string;
  accessory: string;
  message_id?: string | null;
  swipe_id?: string | null;
}

interface EventRow {
  after_state: string; // jsonb
  created_at: string;
}

interface CombinationRow {
  image_url: string | null;
}

export interface CharacterSpriteHistoricalOpts {
  selectedSwipeId?: string | null;
  selectedMessageId?: string | null;
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

export interface CharacterSpriteStateDeps {
  db: PostgresClient;
  settings?: OrchestratorSettingsStore;
}

function parseAfterState(raw: string | object): VisualStateRow | null {
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== 'object') return null;
    // after_state shape is CharacterVisualSnapshot: { expression, outfit: { outerwear,...}, innerThoughts }
    const after = obj as { expression?: string; outfit?: OutfitFields; innerThoughts?: string };
    if (typeof after.expression !== 'string' || !after.outfit || typeof after.outfit !== 'object') return null;
    return {
      expression: after.expression,
      outerwear: after.outfit.outerwear ?? '',
      top: after.outfit.top ?? '',
      bottom: after.outfit.bottom ?? '',
      underwear_top: after.outfit.underwear_top ?? '',
      underwear_bottom: after.outfit.underwear_bottom ?? '',
      accessory: after.outfit.accessory ?? '',
    };
  } catch {
    return null;
  }
}

/**
 * Resolve current (or historical) RP sprite state for one chat. Read-only, never generates.
 * When opts.selectedSwipeId / selectedMessageId are provided, resolves the state as of that
 * historical swipe/message using the event ledger, not the current snapshot blindly.
 */
export async function getCharacterSpriteState(
  deps: CharacterSpriteStateDeps,
  userId: string,
  chatId: string,
  opts?: CharacterSpriteHistoricalOpts | null,
): Promise<CharacterSpriteState[]> {
  const selectedSwipeId = opts?.selectedSwipeId ?? null;
  const selectedMessageId = opts?.selectedMessageId ?? null;
  const hasHistorical = Boolean(selectedSwipeId || selectedMessageId);
  const bgrmEnabled = deps.settings ? (await deps.settings.get('character_visual_bgrm_enabled').catch(() => undefined)) === 'true' : false;

  return deps.db.withUserScope(userId, async (session) => {
    // 1. Current active scene pointer (chat_sessions.scene_id is the cache — segway.md §2.2)
    const chatRows = await session.query<SceneRow>('select scene_id from chat_sessions where chat_id = $1', [chatId]);
    const sceneId = chatRows[0]?.scene_id ?? null;
    if (!sceneId) return [];

    // 2. Ordered cast for the scene — preserve presence_order, join characters for name/status
    const presenceRows = await session.query<PresenceRow>(
      `select sp.character_id, sp.presence_order, c.name, c.status
       from scene_presence sp
       join characters c on c.character_id = sp.character_id and c.user_id = $2
       where sp.scene_id = $1 and sp.user_id = $2
       order by sp.presence_order`,
      [sceneId, userId],
    );

    if (presenceRows.length === 0) return [];

    // Fetch character_chat_links for eligibility filtering in JS (keeps fake-pool verification simple
    // while preserving the real predicate semantics).
    const linkRows = await session.query<{ character_id: string }>(
      'select character_id from character_chat_links where chat_id = $1',
      [chatId],
    );
    const linkedSet = new Set(linkRows.map((r) => r.character_id));

    const orderedEligible = presenceRows.filter((r) => {
      if (r.status === null) return true;
      if (r.status === 'inactive') return false;
      return linkedSet.has(r.character_id);
    });

    // Resolve target creation time once when historical is requested
    let targetCreatedAt: string | null = null;
    if (hasHistorical) {
      if (selectedSwipeId) {
        const sRows = await session.query<{ created_at: string }>('select created_at from chat_message_swipes where swipe_id = $1', [selectedSwipeId]);
        if (sRows[0]?.created_at) targetCreatedAt = sRows[0].created_at;
      }
      if (!targetCreatedAt && selectedMessageId) {
        const mRows = await session.query<{ created_at: string }>('select created_at from chat_messages where message_id = $1 and chat_id = $2', [selectedMessageId, chatId]);
        if (mRows[0]?.created_at) targetCreatedAt = mRows[0].created_at;
      }
    }

    const result: CharacterSpriteState[] = [];
    for (const pres of orderedEligible) {
      // Fetch current snapshot (includes provenance for fast-path check)
      const stateRows = await session.query<VisualStateRow>(
        `select expression, outerwear, top, bottom, underwear_top, underwear_bottom, accessory, message_id, swipe_id
         from character_visual_states where user_id = $1 and chat_id = $2 and character_id = $3`,
        [userId, chatId, pres.character_id],
      );
      const currentState = stateRows[0] ?? null;

      let effectiveState: VisualStateRow | null = null;
      let useHistoricalEvent = false;

      if (!hasHistorical) {
        effectiveState = currentState;
      } else {
        // Fast path: current snapshot provenance matches selected context
        const matchesSwipe = selectedSwipeId && currentState?.swipe_id === selectedSwipeId;
        const matchesMessage = selectedMessageId && currentState?.message_id === selectedMessageId && !selectedSwipeId;
        if ((matchesSwipe || matchesMessage) && currentState) {
          effectiveState = currentState;
        } else {
          // Try exact swipe_id event match
          if (selectedSwipeId) {
            const exact = await session.query<EventRow>(
              `select after_state, created_at from character_visual_state_events
               where user_id = $1 and chat_id = $2 and character_id = $3 and swipe_id = $4
               order by created_at desc limit 1`,
              [userId, chatId, pres.character_id, selectedSwipeId],
            );
            if (exact[0]?.after_state) {
              const parsed = parseAfterState(exact[0].after_state);
              if (parsed) {
                effectiveState = parsed;
                useHistoricalEvent = true;
              }
            }
          }
          // Fallback: exact message_id+swipe not found — find latest event at-or-before target time
          if (!effectiveState && targetCreatedAt) {
            const fallback = await session.query<EventRow>(
              `select after_state, created_at from character_visual_state_events
               where user_id = $1 and chat_id = $2 and character_id = $3 and created_at <= $4
               order by created_at desc limit 1`,
              [userId, chatId, pres.character_id, targetCreatedAt],
            );
            if (fallback[0]?.after_state) {
              const parsed = parseAfterState(fallback[0].after_state);
              if (parsed) {
                effectiveState = parsed;
                useHistoricalEvent = true;
              }
            }
          }
          // If no historical event found, effectiveState stays null → per-character null imagery, not failure
          // Do not fall back to currentState blindly — that would show newer snapshot for older swipe
        }
      }

      if (!effectiveState) {
        result.push({
          characterId: pres.character_id,
          name: pres.name,
          presenceOrder: pres.presence_order,
          imageUrl: null,
          expression: null,
        });
        continue;
      }

      const outfitFields = outfitFieldsFromState(effectiveState);
      const outfitKey = normalizeOutfitKey(outfitFields);
      const expressionKey = normalizeExpression(effectiveState.expression);

      let combo: CombinationRow | null = null;
      const comboRows = await session.query<CombinationRow>(
        `select image_url from character_visual_combinations
         where user_id = $1 and chat_id = $2 and character_id = $3 and outfit_key = $4 and expression_key = $5 and bgrm_applied = $6`,
        [userId, chatId, pres.character_id, outfitKey, expressionKey, bgrmEnabled],
      );
      combo = comboRows[0] ?? null;
      // Fail-open: when BGRM is enabled but the transparent variant is missing (e.g., BGRM unavailable/failed),
      // the effective stored row is the raw fallback with bgrm_applied=false. Fall back to raw instead of null (AC-19).
      if (!combo && bgrmEnabled) {
        const fallbackRows = await session.query<CombinationRow>(
          `select image_url from character_visual_combinations
           where user_id = $1 and chat_id = $2 and character_id = $3 and outfit_key = $4 and expression_key = $5 and bgrm_applied = $6`,
          [userId, chatId, pres.character_id, outfitKey, expressionKey, false],
        );
        combo = fallbackRows[0] ?? null;
      }
      result.push({
        characterId: pres.character_id,
        name: pres.name,
        presenceOrder: pres.presence_order,
        imageUrl: combo?.image_url ?? null,
        expression: effectiveState.expression ?? null,
      });
      void useHistoricalEvent;
    }

    return result;
  });
}

// Alias for Blueprint's suggested name
export const resolveCharacterSpriteState = getCharacterSpriteState;
export const getChatCharacterSprites = getCharacterSpriteState;

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpServerDeps } from './httpServer.js';
import { sendJson } from './httpUtils.js';

export async function handleChatCharacterSprites(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
  userId: string,
  url: URL,
): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  const m = url.pathname.match(/^\/v1\/chats\/([^/]+)\/character-sprites$/);
  if (!m) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const chatId = decodeURIComponent(m[1]!);
  const selectedSwipeId = url.searchParams.get('selectedSwipeId') ?? url.searchParams.get('swipeId') ?? null;
  const selectedMessageId = url.searchParams.get('selectedMessageId') ?? url.searchParams.get('messageId') ?? null;
  const sprites = await getCharacterSpriteState({ db: deps.db, settings: deps.settings }, userId, chatId, {
    selectedSwipeId,
    selectedMessageId,
  });
  sendJson(res, 200, { sprites });
}
