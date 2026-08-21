/**
 * @file orchestrator/src/orchestrator/characterVisualAutofire.ts
 * @stamp 2026-08-19
 * @architectural-role Orchestrator — the character visual-state autofire pipeline
 * @description
 * The portrait-render half of the character visual-state feature (docs/plans/
 * character-visual-state-plan.md §4), fired by Stage 3 exactly the way
 * fireCharacterDescription/fireLocationImageGeneration are fired: after the response is sent,
 * never blocking the chat turn. Takes one character's freshly-changed visual snapshot (the
 * normalized outfit fields + the normalized one-word expression) and renders that exact
 * combination through the active Portrait Studio connection — structurally the direct sibling of
 * generateLocationImage.ts, sharing the same waste-prevention machinery (in-memory in-flight
 * guard, cache hit, pre-provider drop check) and the same fail-open contract.
 *
 * The render pipeline reuses the Portrait Studio's existing composition machinery verbatim —
 * renderPortraitPreview's per-layer resolution strategy differs, the compile/render chain does
 * not:
 *
 *   - Subject slots come from character_subject_visuals, minted lazily via describeStudioSlots
 *     (layerId 'subject', context = the character's appearance text) and keyed by
 *     source_appearance_hash = sha256(appearance). A hash mismatch (the operator edited
 *     characters.appearance after a prior mint) re-mints on the next autofire call for that
 *     character — never a proactive sweep.
 *   - Expression slots come from visual_expression_definitions, minted lazily via
 *     describeStudioSlots (layerId 'expression', name = the normalized word, context '') and
 *     keyed by the normalized word.
 *   - Outfit slots are NOT minted: the six normalized visual-state fields become the Outfit
 *     layer's slots directly, `none` → omitted.
 *   - Every other promptable layer (style, format, any operator-added layer) resolves through the
 *     existing ensureEntityForLayer(..., undefined) fallback — most-recently-used entity or a
 *     seeded placeholder, exactly the unspecified-layer lookup the Studio already uses.
 *
 * These three (subject/outfit/expression) become synthetic EntityRow-shaped map entries
 * (details '', template null); style/format are real entities (style's per-entity template
 * override applies). The map feeds the unchanged buildParentChromosome/buildParentDetails/
 * compileTemplate/createImageGenProvider(...).generate(...) chain — the same chain
 * renderPortraitPreview already runs, so the composed prompt and provider call are byte-identical
 * machinery.
 *
 * Success persists character_visual_combinations (the image URL + composed prompt, keyed by the
 * normalized outfit_key/expression_key — the dedupe cache). Provider failure logs and returns
 * with NO combination row written, so the exact same trigger next time retries from scratch
 * rather than caching a failure (bi_principles.md §11, plan §Edge Cases).
 *
 * @api-declaration
 * renderCharacterVisualCombination(deps, llm, userId, chatId, characterId, outfit, expressionWord)
 *   -> Promise<void> — the whole pipeline; never throws
 *
 * @contract
 *   assertions:
 *     purity:          impure (settings read, Postgres IO, up to two text-LLM mints, one image
 *                       provider call)
 *     state_ownership: [module-level combinationInFlight — nothing else mutates it]
 *     external_io:     [Postgres, orchestrator_settings (read), the LLM via the injected
 *                       provider (mints), the active portrait image provider]
 *     never:           throws. Every failure path logs and returns; the caller treats it as a
 *                      no-op (fire-and-forget, same contract as generateLocationImage.ts).
 */

import { createHash } from 'node:crypto';
import { log } from '../io/logger.js';
import { generateImageWithReference } from '../io/imageGen/index.js';
import { postProcessCharacterImage } from './characterImagePostProcess.js';
import type { LlmProvider } from '../io/llm/types.js';
import { compileTemplate } from '../portraits/composer.js';
import { getPromptableLayers, loadLayerManifest } from '../portraits/layerStack.js';
import { describeStudioSlots } from './describeStudioSlots.js';
import {
  normalizeExpression,
  normalizeOutfitField,
  normalizeOutfitKey,
  OUTFIT_SLOT_KEYS,
  type OutfitFields,
} from './characterVisualStateParser.js';
import {
  buildParentChromosome,
  buildParentDetails,
  ensureEntityForLayer,
  type EntityRow,
  type PortraitGenerationDeps,
} from './portraitGeneration.js';

// The outfit key (normalizeOutfitKey joins the six fields with the U+0001 separator) already
// uses '\u0001' as its in-band delimiter — the in-flight key joins on the same separator, so a
// plain joiner can never collide with a value's own contents.
const KEY_SEP = '\u0001';

const combinationInFlight = new Set<string>();

/** The in-flight dedupe key for one render attempt: everything that makes a combination unique
 *  within a chat. Mirrors generateLocationImage.ts's per-location guard mechanism exactly. */
function combinationKey(
  userId: string,
  chatId: string,
  characterId: string,
  outfitKey: string,
  expressionKey: string,
  bgrmApplied: boolean,
): string {
  return [userId, chatId, characterId, outfitKey, expressionKey, bgrmApplied ? '1' : '0'].join(KEY_SEP);
}

interface SubjectVisualRow {
  slots: Record<string, string>;
  source_appearance_hash: string;
}

interface CharacterRow {
  character_id: string;
  name: string;
  appearance: string;
}

interface ExpressionDefinitionRow {
  slots: Record<string, string>;
}

interface VisualStateRow {
  expression: string;
  outerwear: string;
  top: string;
  bottom: string;
  underwear_top: string;
  underwear_bottom: string;
  accessory: string;
}

interface CombinationRow {
  combination_id: string;
  image_url: string | null;
  bgrm_applied: boolean;
}

/** The outfit fields → the Outfit layer's slot map, `none` (and blank) omitted — the "no
 *  minting" rule: the six canonical, normalized fields ARE the slots, nothing invented. */
function outfitSlotsFrom(outfit: OutfitFields): Record<string, string> {
  const slots: Record<string, string> = {};
  for (const key of OUTFIT_SLOT_KEYS) {
    const value = normalizeOutfitField(outfit[key]);
    if (value && value !== 'none') slots[key] = value;
  }
  return slots;
}

/** The stored state row → the same OutfitFields shape normalizeOutfitKey compares against. */
function outfitFieldsFrom(row: VisualStateRow): OutfitFields {
  return {
    outerwear: row.outerwear,
    top: row.top,
    bottom: row.bottom,
    underwear_top: row.underwear_top,
    underwear_bottom: row.underwear_bottom,
    accessory: row.accessory,
  };
}

/** The one sha256 usage site in this feature: characters.appearance → source_appearance_hash.
 *  Trivially computable in-process, no external dependency. */
function appearanceHash(appearance: string): string {
  return createHash('sha256').update(appearance ?? '').digest('hex');
}

export async function renderCharacterVisualCombination(
  deps: PortraitGenerationDeps,
  llm: LlmProvider,
  userId: string,
  chatId: string,
  characterId: string,
  outfit: OutfitFields,
  expressionWord: string,
): Promise<void> {
  const outfitKey = normalizeOutfitKey(outfit);
  const expressionKey = normalizeExpression(expressionWord);
  const bgrmEnabled = (await deps.settings.get('character_visual_bgrm_enabled').catch(() => null)) === 'true';
  const key = combinationKey(userId, chatId, characterId, outfitKey, expressionKey, bgrmEnabled);

  // 1. In-flight guard — one render per exact combination at a time, so overlapping triggers
  //    (the post-turn fire and a deferred cleanup-path fire on the same turn) never double-spend
  //    an image provider round-trip. Cleared in finally, so a failed render can never wedge the
  //    combination.
  if (combinationInFlight.has(key)) {
    log.debug('characterVisualAutofire: render already in flight, skipping duplicate', { userId, chatId, characterId });
    return;
  }
  combinationInFlight.add(key);
  try {
    // 2. Cache lookup — a previously rendered combination is the dedupe cache: hit means the
    //    image for this exact outfit+expression already exists, zero provider cost.
    const cached = await deps.db.withUserScope(userId, (session) =>
      session.query<CombinationRow>(
        `select combination_id, image_url, bgrm_applied from character_visual_combinations
         where user_id = $1 and chat_id = $2 and character_id = $3 and outfit_key = $4 and expression_key = $5
           and bgrm_applied = $6`,
        [userId, chatId, characterId, outfitKey, expressionKey, bgrmEnabled],
      ),
    );
    if (cached[0]) {
      log.info('characterVisualAutofire: combination cache hit, no render needed', {
        userId,
        chatId,
        characterId,
        combinationId: cached[0].combination_id,
      });
      return;
    }

    let rawSource: string | undefined;
    if (bgrmEnabled) {
      const rawRows = await deps.db.withUserScope(userId, (session) =>
        session.query<CombinationRow>(
          `select combination_id, image_url, bgrm_applied from character_visual_combinations
           where user_id = $1 and chat_id = $2 and character_id = $3 and outfit_key = $4 and expression_key = $5
             and bgrm_applied = false`,
          [userId, chatId, characterId, outfitKey, expressionKey],
        ),
      );
      rawSource = rawRows[0]?.image_url ?? undefined;
    }

    // 3. Drop check — a miss spends a render only when this trigger is still the character's
    //    current state: if a newer turn moved state on while this async pass was starting, drop
    //    without rendering (generateLocationImage.ts's waste-prevention rule) — the newer state's
    //    own autofire call handles it.
    const stateRows = await deps.db.withUserScope(userId, (session) =>
      session.query<VisualStateRow>(
        `select expression, outerwear, top, bottom, underwear_top, underwear_bottom, accessory
         from character_visual_states where user_id = $1 and chat_id = $2 and character_id = $3`,
        [userId, chatId, characterId],
      ),
    );
    const state = stateRows[0];
    if (!state || state.expression !== expressionKey || normalizeOutfitKey(outfitFieldsFrom(state)) !== outfitKey) {
      log.info('characterVisualAutofire: trigger stale, dropping render', { userId, chatId, characterId });
      return;
    }

    const manifest = await loadLayerManifest({ settings: deps.settings });
    const promptableLayers = getPromptableLayers(manifest);
    const subjectLayer = promptableLayers.find((l) => l.id === 'subject');
    const expressionLayer = promptableLayers.find((l) => l.id === 'expression');
    if (!subjectLayer || !expressionLayer) {
      log.warn('characterVisualAutofire: manifest lacks subject/expression layer, aborting render', {
        userId,
        chatId,
        characterId,
      });
      return;
    }

    // 4. Subject — read the mint cache; miss or a source_appearance_hash mismatch (the operator
    //    edited characters.appearance) → mint lazily via describeStudioSlots, upsert the cache
    //    row. An empty mint (the LLM failed or replied with nothing) aborts the render — the
    //    next real trigger retries.
    const [character] = await deps.db.withUserScope(userId, (session) =>
      session.query<CharacterRow>(
        `select character_id, name, appearance from characters where character_id = $1 and user_id = $2`,
        [characterId, userId],
      ),
    );
    if (!character) {
      log.warn('characterVisualAutofire: character not found, aborting render', { userId, chatId, characterId });
      return;
    }
    const subjectHash = appearanceHash(character.appearance);
    const subjectRows = await deps.db.withUserScope(userId, (session) =>
      session.query<SubjectVisualRow>(
        `select slots, source_appearance_hash from character_subject_visuals
         where character_id = $1 and user_id = $2`,
        [characterId, userId],
      ),
    );
    let subjectSlots = subjectRows[0]?.slots;
    if (!subjectSlots || subjectRows[0]!.source_appearance_hash !== subjectHash) {
      subjectSlots = await describeStudioSlots(deps.settings, llm, userId, {
        layerId: 'subject',
        layerLabel: subjectLayer.label,
        layerBoundary: subjectLayer.boundary,
        name: character.name,
        context: character.appearance,
      });
      if (Object.keys(subjectSlots).length === 0) {
        log.warn('characterVisualAutofire: subject mint produced no slots, aborting render', { userId, chatId, characterId });
        return;
      }
      await deps.db.withUserScope(userId, (session) =>
        session.query(
          `insert into character_subject_visuals (user_id, character_id, slots, source_appearance_hash)
           values ($1, $2, $3::jsonb, $4)
           on conflict (character_id) do update
             set slots = excluded.slots, source_appearance_hash = excluded.source_appearance_hash, updated_at = now()`,
          [userId, characterId, JSON.stringify(subjectSlots), subjectHash],
        ),
      );
      log.info('characterVisualAutofire: subject minted', { userId, chatId, characterId, slotCount: Object.keys(subjectSlots).length });
    }

    // 5. Expression — read visual_expression_definitions by the normalized word; miss → mint,
    //    insert. Same empty-mint abort as the subject.
    const exprRows = await deps.db.withUserScope(userId, (session) =>
      session.query<ExpressionDefinitionRow>(
        `select slots from visual_expression_definitions where user_id = $1 and word = $2`,
        [userId, expressionKey],
      ),
    );
    let expressionSlots = exprRows[0]?.slots;
    if (!expressionSlots) {
      expressionSlots = await describeStudioSlots(deps.settings, llm, userId, {
        layerId: 'expression',
        layerLabel: expressionLayer.label,
        layerBoundary: expressionLayer.boundary,
        name: expressionKey,
        context: '',
      });
      if (Object.keys(expressionSlots).length === 0) {
        log.warn('characterVisualAutofire: expression mint produced no slots, aborting render', {
          userId,
          chatId,
          characterId,
          expression: expressionKey,
        });
        return;
      }
      await deps.db.withUserScope(userId, (session) =>
        session.query(
          `insert into visual_expression_definitions (user_id, word, slots)
           values ($1, $2, $3::jsonb)
           on conflict (user_id, word) do update set slots = excluded.slots`,
          [userId, expressionKey, JSON.stringify(expressionSlots)],
        ),
      );
      log.info('characterVisualAutofire: expression minted', {
        userId,
        chatId,
        characterId,
        expression: expressionKey,
        slotCount: Object.keys(expressionSlots).length,
      });
    }

    // 6. Outfit — no minting: the six normalized fields become the Outfit layer's slots.
    const outfitSlots = outfitSlotsFrom(outfit);

    // 7. Every other promptable layer (style, format, any operator-added layer) resolves through
    //    the same unspecified-layer fallback the Studio already uses: most-recently-used entity,
    //    else a seeded placeholder. Never a new resolution rule.
    const entities = new Map<string, EntityRow>();
    for (const layer of promptableLayers) {
      if (layer.id === 'subject' || layer.id === 'outfit' || layer.id === 'expression') continue;
      entities.set(layer.id, await ensureEntityForLayer(deps.db, userId, layer, undefined));
    }
    // 8. The three minted/canonical layers are synthetic EntityRow-shaped entries — the same
    //    shape buildParentChromosome/buildParentDetails consume, with no persisted row behind
    //    them (details '' and template null except style, which keeps its per-entity override).
    const synthetic: EntityRow[] = [
      { entity_id: '', layer_id: 'subject', slots: subjectSlots!, template: null, details: '' },
      { entity_id: '', layer_id: 'outfit', slots: outfitSlots, template: null, details: '' },
      { entity_id: '', layer_id: 'expression', slots: expressionSlots!, template: null, details: '' },
    ];
    for (const entry of synthetic) entities.set(entry.layer_id, entry);

    const template = entities.get('style')?.template ?? manifest.template;
    const parent = buildParentChromosome(entities, promptableLayers);
    const parentDetails = buildParentDetails(entities, promptableLayers);
    const composedPrompt = compileTemplate(template, parent.slots, manifest.layers, parentDetails);

    const profile = rawSource ? undefined : await deps.imageConnections.resolveActive('portrait');
    if (!rawSource && !profile) {
      log.warn('characterVisualAutofire: no active portrait image connection configured, aborting render', {
        userId,
        chatId,
        characterId,
      });
      return;
    }

    let imageUrl: string;
    let bgrmApplied = false;
    try {
      const generated = rawSource
        ? { imageUrl: rawSource }
        : await generateImageWithReference(profile!, {
        prompt: composedPrompt,
        negativePrompt: profile!.masterNegativePrompt ?? '',
        model: profile!.model,
        apiKey: profile!.apiKey,
        baseUrl: profile!.baseUrl,
        width: profile!.width,
        height: profile!.height,
        seed: profile!.seed,
        steps: profile!.samplingSteps,
        cfgScale: profile!.cfgScale,
        samplerName: profile!.samplerName,
        workflowParameters: profile!.workflowParameters,
        });
      const bgrmProfile = bgrmEnabled
        ? await deps.imageConnections.resolveActive('bgrm').catch((error) => {
            log.warn('characterVisualAutofire: BGRM profile resolution failed; using raw image', { error });
            return undefined;
          })
        : undefined;
      const processed = await postProcessCharacterImage(generated, bgrmProfile);
      imageUrl = processed.imageUrl;
      bgrmApplied = processed.bgrmApplied;
    } catch (err) {
      // 9. Provider failure — fail-open, no combination row written: the exact same trigger next
      //    time attempts again rather than caching a failure (plan §Edge Cases).
      log.warn('characterVisualAutofire: render failed, not caching', {
        userId,
        chatId,
        characterId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (rawSource && !bgrmApplied) return;
    await deps.db.withUserScope(userId, (session) =>
      session.query(
        `insert into character_visual_combinations
           (user_id, chat_id, character_id, outfit_key, expression_key, image_url, composed_prompt, bgrm_applied)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (user_id, chat_id, character_id, outfit_key, expression_key, bgrm_applied)
           do update set image_url = excluded.image_url, composed_prompt = excluded.composed_prompt, updated_at = now()`,
        [userId, chatId, characterId, outfitKey, expressionKey, imageUrl, composedPrompt, bgrmApplied],
      ),
    );
    log.info('characterVisualAutofire: combination rendered and cached', {
      userId,
      chatId,
      characterId,
      outfitKey,
      expressionKey,
    });
  } catch (err) {
    // bi_principles.md §11: log the seam. A failed autofire is a missing portrait, never a
    // broken chat turn.
    log.error('characterVisualAutofire: pipeline failed', { userId, chatId, characterId, err });
  } finally {
    combinationInFlight.delete(key);
  }
}
