/**
 * @file orchestrator/src/orchestrator/characterVisualState.ts
 * @stamp 2026-08-20
 * @architectural-role Orchestrator — post-Cleaner state extraction, diff, and event sequence
 * @description
 * docs/plans/character-visual-state-plan.md Pipeline §3: after the turn's text is final, locate the
 * footer region through the Cleaner's own configuration (extractRegion + the resolved
 * cleanup_footer_regex — the single authority on where the footer is), parse it deterministically
 * (orchestrator/characterVisualStateParser.ts), resolve each parsed record to exactly one eligible
 * roster character, and compare the structured fields against the existing character_visual_states
 * row inside one user-scoped transaction — guarded against a stale swipe the same way cleanupLoop.ts
 * guards its own writeback (`for update` row lock on the message, then compare its current
 * `content` against the text we parsed; drop the write if the swipe has moved on).
 * `chat_messages.active_swipe_id` is also read under the same lock and carried onto the
 * state/event rows as `swipe_id` provenance.
 *
 * Outfit slots are a partial update (plan §Partial outfit state): the parsed footer may declare
 * zero or more slots, and each is merged against the prior state — a parsed slot overrides, an
 * omitted slot keeps the prior value, a slot with no prior value stays '' (unknown). The stored
 * snapshot is always a complete six-slot OutfitFields; `''` (unknown) and `none` (explicitly not
 * worn) are distinct values that are never converted into each other.
 *
 * Per character the sequence is:
 *   - no row yet → insert the snapshot, record an 'initialized' event, no autofire;
 *   - identical normalized values → update provenance only, no event, no autofire;
 *   - inner-thoughts-only change → persist, no event, no autofire;
 *   - expression/outfit change (normalized) → persist, append one 'visible_change' event per
 *     affected character/turn, and return it in `fired` so the caller fires the autofire
 *     fire-and-forget AFTER the transaction commits — never inline, never awaited (plan §3).
 *
 * Fail-open end to end (bi_principles.md §11): no valid header, no footer region, a rejected footer
 * parse, a name that isn't uniquely resolvable, or any DB failure logs and returns
 * `{ applied: false }` — existing visual state stays unchanged and nothing fires. Identity comes
 * only from the trusted header roster (plan §4); a footer tag never creates or selects a character.
 *
 * @api-declaration
 * applyCharacterVisualState(deps, userId, chatId, messageId, text, footerCfg) ->
 *   Promise<CharacterVisualStateResult> — fail-open; locate region → parse → guarded upsert →
 *   diff/events, returns { applied, fired: VisualStateAutofireTrigger[] } where fired lists every
 *   (character, outfit, expression) that visibly changed this turn and needs an autofire render
 * VisualStateAutofireTrigger — { characterId, outfit, expression } in normalized form, the exact
 *   arguments the autofire pipeline consumes
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected db wrapper)
 *     state_ownership: []
 *     external_io:     [Postgres (db.withUserScope)]
 *     never:           throws. Errors are logged and swallowed; a turn is never blocked or
 *                      degraded by extraction (plan §Edge cases).
 */

import type { PostgresClient, DbSession } from '../io/postgres.js';
import { log } from '../io/logger.js';
import { extractRegion, type RegionConfig } from './cleanupHeuristics.js';
import { parseStoryHeader } from './locationAndPresenceScraper.js';
import {
  OUTFIT_SLOT_KEYS,
  diffVisibleFields,
  innerThoughtsChanged,
  normalizeExpression,
  normalizeOutfitField,
  parseCharacterVisualStateFooter,
  type CharacterVisualRecord,
  type CharacterVisualSnapshot,
  type OutfitFields,
  type OutfitUpdate,
  type VisibleFieldKey,
} from './characterVisualStateParser.js';

/** One visibly-changed character this turn — the autofire trigger. Values are already in
 *  normalized form (the stored snapshot), so the autofire pipeline can consume them directly. */
export interface VisualStateAutofireTrigger {
  characterId: string;
  outfit: OutfitFields;
  expression: string;
}

export interface CharacterVisualStateResult {
  /** True when extraction committed at least one state row (false = skipped/rejected/failed). */
  applied: boolean;
  /** Every (character, outfit, expression) that visibly changed — one autofire each, fired by
   *  the caller after this transaction commits. */
  fired: VisualStateAutofireTrigger[];
}

export interface CharacterVisualStateDeps {
  db: PostgresClient;
}

interface StateRow {
  inner_thoughts: string;
  expression: string;
  outerwear: string;
  top: string;
  bottom: string;
  underwear_top: string;
  underwear_bottom: string;
  accessory: string;
}

/** db/migrations/0096's chat-scoping eligibility predicate, replicated from
 *  locationAndPresenceScraper.ts's eligibleClause (that helper is not exported). A character is
 *  eligible iff user-authored (status null) OR linked to this chat and not demoted to inactive.
 *  The existence check resolves a name to the *resolved roster* character — never a character
 *  from another chat of the same name. */
const ELIGIBLE_CHARACTER_SQL = `select character_id from characters
  where user_id = $1 and name = $2
    and (status is null or (status <> 'inactive' and exists (
      select 1 from character_chat_links
      where character_chat_links.character_id = characters.character_id
        and character_chat_links.chat_id = $3
    )))
  order by (status is null) desc, (status = 'permanent') desc, character_id`;

/** The single entry point. Parse the header first (no valid header → skip entirely — the footer
 *  never decides scene membership), then locate the footer region through the Cleaner's own
 *  resolved footer config (no region matched → skip), then parse the region's records against
 *  that roster, then the guarded transaction. Fail-open: any failure returns applied:false with
 *  nothing fired. */
export async function applyCharacterVisualState(
  deps: CharacterVisualStateDeps,
  userId: string,
  chatId: string,
  messageId: string,
  text: string,
  footerCfg: RegionConfig,
): Promise<CharacterVisualStateResult> {
  const header = parseStoryHeader(text);
  if (!header) {
    log.debug('character visual state: no two-line header, skipping extraction', { chatId, messageId });
    return { applied: false, fired: [] };
  }
  const region = extractRegion(text, footerCfg);
  if (!region) {
    log.debug('character visual state: no footer region matched, skipping extraction (fail-open)', { chatId, messageId });
    return { applied: false, fired: [] };
  }
  const parsed = parseCharacterVisualStateFooter(region.text, header);
  if (!parsed.ok) {
    log.debug('character visual state: footer parse rejected, skipping extraction (fail-open)', {
      chatId,
      messageId,
      reason: parsed.reason,
    });
    return { applied: false, fired: [] };
  }
  try {
    return await deps.db.withUserScope(userId, (session) =>
      applyInSession(session, userId, chatId, messageId, text, parsed.records),
    );
  } catch (err) {
    // bi_principles.md §11: log the seam — a silent failure here would quietly lose trusted
    // scene state, but it must never take the turn down with it.
    log.error('character visual state: extraction failed, skipping (fail-open)', { chatId, messageId, err });
    return { applied: false, fired: [] };
  }
}

async function applyInSession(
  session: DbSession,
  userId: string,
  chatId: string,
  messageId: string,
  text: string,
  records: CharacterVisualRecord[],
): Promise<CharacterVisualStateResult> {
  // Stale-swipe guard (plan §Edge cases): lock the message row and verify its content is still
  // the text we parsed. If a regeneration/cycle swapped content between the parse and here, the
  // swipe has moved on — drop the whole extraction rather than overwrite the active snapshot.
  const [msg] = await session.query<{ content: string; active_swipe_id: string | null }>(
    `select content, active_swipe_id from chat_messages where message_id = $1 and chat_id = $2 for update`,
    [messageId, chatId],
  );
  if (!msg) {
    log.warn('character visual state: message gone before extraction, skipping', { chatId, messageId });
    return { applied: false, fired: [] };
  }
  if (msg.content !== text) {
    log.info('character visual state: message content moved on since parse, dropping extraction (stale swipe)', {
      chatId,
      messageId,
    });
    return { applied: false, fired: [] };
  }

  // Resolve each roster name to exactly one eligible character (plan §4 — identity comes from
  // the trusted roster, never a footer tag). A missing or ambiguous name rejects the ENTIRE
  // extraction: prior state stays, no partial snapshot, no autofire (plan §Edge cases).
  const characterIds: string[] = [];
  for (const record of records) {
    const matches = await session.query<{ character_id: string }>(ELIGIBLE_CHARACTER_SQL, [userId, record.name, chatId]);
    if (matches.length !== 1) {
      log.warn('character visual state: roster name not uniquely resolvable, rejecting whole extraction (fail-open)', {
        chatId,
        messageId,
        name: record.name,
        matches: matches.length,
      });
      return { applied: false, fired: [] };
    }
    characterIds.push(matches[0]!.character_id);
  }

  const fired: VisualStateAutofireTrigger[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    const characterId = characterIds[i]!;
    const before = await readState(session, userId, chatId, characterId);
    const snapshot = buildSnapshot(record, before);

    if (!before) {
      await upsertState(session, userId, chatId, characterId, messageId, msg.active_swipe_id, snapshot);
      await insertEvent(session, userId, chatId, characterId, messageId, msg.active_swipe_id, 'initialized', [], null, snapshot);
      continue;
    }

    const visibleChanged = diffVisibleFields(before, snapshot);
    const innerChanged = innerThoughtsChanged(before, snapshot);
    if (visibleChanged.length === 0 && !innerChanged) {
      // Identical normalized values: provenance only, no event, no autofire.
      await updateProvenance(session, userId, chatId, characterId, messageId, msg.active_swipe_id);
      continue;
    }

    await upsertState(session, userId, chatId, characterId, messageId, msg.active_swipe_id, snapshot);
    if (visibleChanged.length > 0) {
      // One visible-change event per affected character/turn; fired so the caller autofires
      // after commit (never inline, never awaited by the request path).
      await insertEvent(session, userId, chatId, characterId, messageId, msg.active_swipe_id, 'visible_change', visibleChanged, before, snapshot);
      fired.push({ characterId, outfit: snapshot.outfit, expression: snapshot.expression });
    }
  }
  return { applied: true, fired };
}

/** Merge the parsed partial outfit into the full stored form: a parsed slot overrides the prior
 *  value (normalized); an omitted slot keeps the prior value; a slot with no prior value stays ''
 *  (unknown). `''` and `none` are distinct values that are never converted into each other. */
function mergeOutfit(parsed: OutfitUpdate, before: OutfitFields | null): OutfitFields {
  const outfit = {} as OutfitFields;
  for (const key of OUTFIT_SLOT_KEYS) {
    const value = parsed[key];
    outfit[key] = value !== undefined ? normalizeOutfitField(value) : before ? before[key] : '';
  }
  return outfit;
}

/** The stored snapshot form: normalized (trim + casefold) expression/outfit, trimmed inner
 *  thoughts — so the diff is a direct string comparison and the cache keys derive unchanged. */
function buildSnapshot(record: CharacterVisualRecord, before: CharacterVisualSnapshot | null): CharacterVisualSnapshot {
  return {
    innerThoughts: record.innerThoughts.trim(),
    expression: normalizeExpression(record.expression),
    outfit: mergeOutfit(record.outfit, before ? before.outfit : null),
  };
}

async function readState(
  session: DbSession,
  userId: string,
  chatId: string,
  characterId: string,
): Promise<CharacterVisualSnapshot | null> {
  const rows = await session.query<StateRow>(
    `select inner_thoughts, expression, outerwear, top, bottom, underwear_top, underwear_bottom, accessory
     from character_visual_states where user_id = $1 and chat_id = $2 and character_id = $3`,
    [userId, chatId, characterId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    innerThoughts: r.inner_thoughts,
    expression: r.expression,
    outfit: {
      outerwear: r.outerwear,
      top: r.top,
      bottom: r.bottom,
      underwear_top: r.underwear_top,
      underwear_bottom: r.underwear_bottom,
      accessory: r.accessory,
    },
  };
}

/** Upsert the current snapshot + provenance. `on conflict do update` makes the no-row insert
 *  safe against a rare concurrent extraction for the same (chat, character) — the unique
 *  (user_id, chat_id, character_id) constraint is the real concurrency guard. */
async function upsertState(
  session: DbSession,
  userId: string,
  chatId: string,
  characterId: string,
  messageId: string,
  swipeId: string | null,
  snapshot: CharacterVisualSnapshot,
): Promise<void> {
  await session.query(
    `insert into character_visual_states
       (user_id, chat_id, character_id, message_id, swipe_id, inner_thoughts, expression,
        outerwear, top, bottom, underwear_top, underwear_bottom, accessory, source_turn_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), now())
     on conflict (user_id, chat_id, character_id) do update set
       message_id = excluded.message_id,
       swipe_id = excluded.swipe_id,
       inner_thoughts = excluded.inner_thoughts,
       expression = excluded.expression,
       outerwear = excluded.outerwear,
       top = excluded.top,
       bottom = excluded.bottom,
       underwear_top = excluded.underwear_top,
       underwear_bottom = excluded.underwear_bottom,
       accessory = excluded.accessory,
       source_turn_at = now(),
       updated_at = now()`,
    [
      userId,
      chatId,
      characterId,
      messageId,
      swipeId,
      snapshot.innerThoughts,
      snapshot.expression,
      snapshot.outfit.outerwear,
      snapshot.outfit.top,
      snapshot.outfit.bottom,
      snapshot.outfit.underwear_top,
      snapshot.outfit.underwear_bottom,
      snapshot.outfit.accessory,
    ],
  );
}

/** Identical snapshot: refresh provenance only (the state's source turn follows the active
 *  timeline), never touch the stored values, never an event, never autofire. */
async function updateProvenance(
  session: DbSession,
  userId: string,
  chatId: string,
  characterId: string,
  messageId: string,
  swipeId: string | null,
): Promise<void> {
  await session.query(
    `update character_visual_states
     set message_id = $4, swipe_id = $5, source_turn_at = now(), updated_at = now()
     where user_id = $1 and chat_id = $2 and character_id = $3`,
    [userId, chatId, characterId, messageId, swipeId],
  );
}

/** Append one append-only audit row. `changedFields` is non-empty only for a visible change; the
 *  'initialized' event carries an empty list and no before-state. */
async function insertEvent(
  session: DbSession,
  userId: string,
  chatId: string,
  characterId: string,
  messageId: string,
  swipeId: string | null,
  eventType: 'initialized' | 'visible_change',
  changedFields: VisibleFieldKey[],
  before: CharacterVisualSnapshot | null,
  after: CharacterVisualSnapshot,
): Promise<void> {
  await session.query(
    `insert into character_visual_state_events
       (user_id, chat_id, character_id, message_id, swipe_id, event_type, changed_fields, before_state, after_state)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb)`,
    [
      userId,
      chatId,
      characterId,
      messageId,
      swipeId,
      eventType,
      JSON.stringify(changedFields),
      before ? JSON.stringify(before) : '{}',
      JSON.stringify(after),
    ],
  );
}