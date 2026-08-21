// Proves the character visual-state feature (docs/plans/character-visual-state-plan.md) against
// pure imports + a fake Postgres pool — no server, no network. The suite exercises:
//   - the parser (pure): the canonical hidden footer parses into one structured record per roster
//     character; every malformed shape fails with a structured reason (never throws); the
//     normalization helpers match the storage/cache-key semantics; the visible-field diff ignores
//     inner thoughts;
//   - the Cleaner's structure-aware footerRegex (DEFAULT_CLEANUP_CONFIG): the canonical block
//     matches, the legacy 0066 <inner thoughts> block fails (it becomes 'malformed' and is
//     repaired), and the revised footer prompt names the {{roster}} macro + roster order;
//   - applyCharacterVisualState (Stage 3): header gate, parse gate, the guarded upsert
//     transaction (stale-swipe `for update` content guard, initialized/identical/inner-only/
//     visible-change sequences, events, and the autofire trigger list), one-to-one roster
//     resolution rejecting the WHOLE extraction on missing/ambiguous names, and end-to-end
//     fail-open (DB failure never throws);
//   - renderCharacterVisualCombination (Stage 4): combination-cache hit (no mints, no provider
//     call), the pre-provider drop check (stale state), the full render (subject + expression
//     mints via describeStudioSlots, ensureEntityForLayer fallbacks, compileTemplate →
//     provider → combination upsert), provider failure (no combination row written, retryable),
//     and the in-flight guard (a duplicate trigger never double-spends a provider call).

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPostgresClient } from '../dist/io/postgres.js';
import { DEFAULT_CLEANUP_CONFIG, extractRegion } from '../dist/orchestrator/cleanupHeuristics.js';
import { buildRepairPrompt } from '../dist/orchestrator/cleanupHeuristics.js';
import { parseStoryHeader } from '../dist/orchestrator/locationAndPresenceScraper.js';
import {
  parseCharacterVisualStateFooter,
  normalizeExpression,
  normalizeOutfitField,
  normalizeOutfitKey,
  diffVisibleFields,
  innerThoughtsChanged,
  OUTFIT_SLOT_KEYS,
} from '../dist/orchestrator/characterVisualStateParser.js';
import { applyCharacterVisualState } from '../dist/orchestrator/characterVisualState.js';
import { renderCharacterVisualCombination } from '../dist/orchestrator/characterVisualAutofire.js';
import { SETTING_NAMES } from '../dist/io/orchestratorSettings.js';

const bgrmMigration = readFileSync(new URL('../../db/migrations/0132_character_image_bgrm.sql', import.meta.url), 'utf8');

// --- BGRM persistence boundary (migration 0132). ----------------------------------------------
assert(SETTING_NAMES.includes('chat_memory_household_memory_prompt'), 'migration 0132: existing household-memory setting remains legal');
assert(SETTING_NAMES.includes('portrait_bgrm_enabled') && SETTING_NAMES.includes('character_visual_bgrm_enabled'), 'migration 0132: both BGRM setting names are legal in the typed vocabulary');
assert(bgrmMigration.includes('bgrm_applied boolean not null default false'), 'migration 0132: character combinations gain a default-off BGRM state');
assert(bgrmMigration.includes('unique (user_id, chat_id, character_id, outfit_key, expression_key, bgrm_applied)'), 'migration 0132: cache uniqueness includes actual BGRM state');
assert(!bgrmMigration.includes('insert into orchestrator_settings'), 'migration 0132: BGRM settings are not seeded');
assert(!bgrmMigration.includes('location_image_combinations') && !bgrmMigration.includes('location_swipe_images'), 'migration 0132: location image persistence is unchanged');

const legacyRows = [{ image_url: 'https://cdn.example/raw.png' }];
const migratedRows = legacyRows.map((row) => ({ ...row, bgrm_applied: false }));
assert(migratedRows[0].image_url === 'https://cdn.example/raw.png' && migratedRows[0].bgrm_applied === false, 'migration 0132: existing raw rows retain their URL and default to false');
const rawVariant = ['user', 'chat', 'character', 'outfit', 'expression', false].join('|');
const bgrmVariant = ['user', 'chat', 'character', 'outfit', 'expression', true].join('|');
const identity = (row) => row.join('|');
const migratedIdentities = new Set([rawVariant]);
assert(rawVariant !== bgrmVariant, 'migration 0132: raw and BGRM variants have distinct cache identities');
migratedIdentities.add(bgrmVariant);
assert(migratedIdentities.size === 2, 'migration 0132: one raw and one BGRM variant can coexist');
const duplicateIdentity = identity(['user', 'chat', 'character', 'outfit', 'expression', false]);
assert(migratedIdentities.has(duplicateIdentity), 'migration 0132: duplicate rows with the same BGRM state target the same unique identity');
let duplicateRejected = false;
try {
  if (migratedIdentities.has(duplicateIdentity)) throw new Error('unique violation');
} catch {
  duplicateRejected = true;
}
assert(duplicateRejected, 'migration 0132: duplicate rows with the same BGRM state are rejected by the modeled unique constraint');

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const USER = '11111111-1111-1111-1111-111111111111';
const CHAT = '22222222-2222-2222-2222-222222222222';
const MSG = '33333333-3333-3333-3333-333333333333';
const SWIPE = '44444444-4444-4444-4444-444444444444';
const AVA_ID = '55555555-5555-5555-5555-555555555555';
const KAI_ID = '66666666-6666-6666-6666-666666666666';

// --- Fixtures: the canonical header + hidden footer (plan §Canonical footer format). -----------
const HEADER = '[ Late Evening | 🗓️ Wednesday, June 15, 2026 AD | 📍 The Drunken Kraken - Main Hall ]\nPresent: Ava';
const AVA_BLOCK = `<details><summary>▸</summary>
<Ava>
Inner thoughts: She is watching the door, waiting for him.
Expression: composed
Outfit:
- Outerwear: leather jacket
- Top: white blouse
- Bottom: jeans
- Underwear top: none
- Underwear bottom: none
- Accessory: silver pendant
</Ava>
</details>`;
const TWO_BLOCK = `<details><summary>▸</summary>
<Ava>
Inner thoughts: She is watching the door, waiting for him.
Expression: composed
Outfit:
- Outerwear: leather jacket
- Top: white blouse
- Bottom: jeans
- Underwear top: none
- Underwear bottom: none
- Accessory: silver pendant
</Ava>
<Kai>
Inner thoughts: He keeps his voice low.
Expression: calm
Outfit:
- Outerwear: none
- Top: shirt
- Bottom: trousers
- Underwear top: none
- Underwear bottom: none
- Accessory: none
</Kai>
</details>`;
const CANONICAL_TURN = `${HEADER}\n\nShe folded her hands.\n\n${AVA_BLOCK}`;

// The Cleaner's resolved footer region config (what fireCharacterVisualState passes in): the
// editable footer regex/flags/prompt, resolved live from orchestrator_settings.
const FOOTER_CFG = {
  regex: DEFAULT_CLEANUP_CONFIG.footerRegex,
  flags: DEFAULT_CLEANUP_CONFIG.footerFlags,
  prompt: DEFAULT_CLEANUP_CONFIG.footerPrompt,
};

// A no-summary footer with a PARTIAL outfit (plan §Partial outfit state): two slots declared,
// the rest omitted — valid, and the omitted slots carry no information.
const PARTIAL_FOOTER = `<details>
<Ava>
Inner thoughts: She is watching the door, waiting for him.
Expression: composed
Outfit:
- Top: white blouse
- Accessory: silver pendant
</Ava>
</details>`;
const PARTIAL_TURN = `${HEADER}\n\nShe folded her hands.\n\n${PARTIAL_FOOTER}`;

// A partial footer that changes exactly one previously-set slot (merge override).
const PARTIAL_CHANGE_FOOTER = `<details>
<Ava>
Inner thoughts: She is watching the door, waiting for him.
Expression: composed
Outfit:
- Top: black blouse
</Ava>
</details>`;
const PARTIAL_CHANGE_TURN = `${HEADER}\n\nShe folded her hands.\n\n${PARTIAL_CHANGE_FOOTER}`;

// A partial footer that declares only `- Top: none` — explicitly topless (a visible change from a
// concrete prior value, not an "unknown").
const TOPLESS_FOOTER = `<details>
<Ava>
Inner thoughts: She pulled the blouse over her head.
Expression: defiant
Outfit:
- Top: none
</Ava>
</details>`;
const TOPLESS_TURN = `${HEADER}\n\nShe folded her hands.\n\n${TOPLESS_FOOTER}`;

// A footer that changes ONLY inner thoughts — no outfit slots at all (omission alone must never
// autofire: the merged snapshot is identical in every visible field).
const OMISSION_ONLY_FOOTER = `<details>
<Ava>
Inner thoughts: A different thought entirely.
Expression: composed
Outfit:
</Ava>
</details>`;
const OMISSION_ONLY_TURN = `${HEADER}\n\nShe folded her hands.\n\n${OMISSION_ONLY_FOOTER}`;

// ---------------------------------------------------------------------------
// Fake pool: in-memory chat_messages / characters / character_chat_links /
// character_visual_states / character_visual_state_events / character_subject_visuals /
// visual_expression_definitions / character_visual_combinations / visual_entities — covering
// exactly the queries characterVisualState.ts and characterVisualAutofire.ts issue.
// ---------------------------------------------------------------------------
function createFakePool() {
  const chatMessages = []; // { message_id, chat_id, user_id, content, active_swipe_id }
  const characters = []; // { character_id, user_id, name, appearance, status }
  const characterChatLinks = []; // { character_id, chat_id }
  const states = []; // { user_id, chat_id, character_id, message_id, swipe_id, inner_thoughts, expression, outerwear, top, bottom, underwear_top, underwear_bottom, accessory }
  const events = []; // { user_id, chat_id, character_id, message_id, swipe_id, event_type, changed_fields, before_state, after_state }
  const subjectVisuals = []; // { user_id, character_id, slots, source_appearance_hash }
  const expressionDefs = []; // { user_id, word, slots }
  const combinations = []; // { user_id, chat_id, character_id, outfit_key, expression_key, image_url, composed_prompt, bgrm_applied }
  const entities = []; // { entity_id, user_id, layer_id, name, slots, template, details, updated_at }

  const eligibleCharacterIds = (userId, name, chatId) => {
    const links = new Set(characterChatLinks.filter((l) => l.chat_id === chatId).map((l) => l.character_id));
    return characters
      .filter(
        (c) =>
          c.user_id === userId &&
          c.name === name &&
          (c.status === null || (c.status !== 'inactive' && links.has(c.character_id))),
      )
      .sort((a, b) => {
        if ((a.status === null) !== (b.status === null)) return a.status === null ? -1 : 1;
        if ((a.status === 'permanent') !== (b.status === 'permanent')) return a.status === 'permanent' ? -1 : 1;
        return a.character_id.localeCompare(b.character_id);
      });
  };

  return {
    chatMessages,
    characters,
    characterChatLinks,
    states,
    events,
    subjectVisuals,
    expressionDefs,
    combinations,
    entities,
    async connect() {
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) return { rows: [] };
          const q = sql.replace(/\s+/g, ' ').trim();

          // --- Stage 3: stale-swipe guard (for update lock on the message row). ---
          if (q.includes('from chat_messages where message_id') && q.includes('for update')) {
            const [messageId, chatId] = params;
            const m = chatMessages.find((x) => x.message_id === messageId && x.chat_id === chatId);
            return { rows: m ? [{ content: m.content, active_swipe_id: m.active_swipe_id }] : [] };
          }

          // --- Stage 3: one-to-one roster resolution (db/migrations/0096 eligibility). ---
          if (q.startsWith('select character_id from characters') && q.includes('character_chat_links')) {
            const [userId, name, chatId] = params;
            return { rows: eligibleCharacterIds(userId, name, chatId).map((c) => ({ character_id: c.character_id })) };
          }

          // --- Stage 3: read current state. ---
          if (q.startsWith('select inner_thoughts, expression, outerwear')) {
            const [userId, chatId, characterId] = params;
            const row = states.find((s) => s.user_id === userId && s.chat_id === chatId && s.character_id === characterId);
            return {
              rows: row
                ? [
                    {
                      inner_thoughts: row.inner_thoughts,
                      expression: row.expression,
                      outerwear: row.outerwear,
                      top: row.top,
                      bottom: row.bottom,
                      underwear_top: row.underwear_top,
                      underwear_bottom: row.underwear_bottom,
                      accessory: row.accessory,
                    },
                  ]
                : [],
            };
          }

          // --- Stage 3: upsert state (on conflict user_id/chat_id/character_id). ---
          if (q.startsWith('insert into character_visual_states')) {
            const [userId, chatId, characterId, messageId, swipeId, innerThoughts, expression, outerwear, top, bottom, underwearTop, underwearBottom, accessory] = params;
            const existing = states.find((s) => s.user_id === userId && s.chat_id === chatId && s.character_id === characterId);
            const row = {
              user_id: userId,
              chat_id: chatId,
              character_id: characterId,
              message_id: messageId,
              swipe_id: swipeId,
              inner_thoughts: innerThoughts,
              expression,
              outerwear,
              top,
              bottom,
              underwear_top: underwearTop,
              underwear_bottom: underwearBottom,
              accessory,
            };
            if (existing) Object.assign(existing, row);
            else states.push(row);
            return { rows: [] };
          }

          // --- Stage 3: provenance-only refresh (identical snapshot). ---
          if (q.startsWith('update character_visual_states set message_id')) {
            const [userId, chatId, characterId, messageId, swipeId] = params;
            const row = states.find((s) => s.user_id === userId && s.chat_id === chatId && s.character_id === characterId);
            if (row) {
              row.message_id = messageId;
              row.swipe_id = swipeId;
            }
            return { rows: [] };
          }

          // --- Stage 3: append-only audit event. ---
          if (q.startsWith('insert into character_visual_state_events')) {
            const [userId, chatId, characterId, messageId, swipeId, eventType, changedFields, beforeState, afterState] = params;
            events.push({
              user_id: userId,
              chat_id: chatId,
              character_id: characterId,
              message_id: messageId,
              swipe_id: swipeId,
              event_type: eventType,
              changed_fields: changedFields,
              before_state: beforeState,
              after_state: afterState,
            });
            return { rows: [] };
          }

          // --- Stage 4: combination cache lookup. ---
          if (q.startsWith('select combination_id, image_url, bgrm_applied from character_visual_combinations')) {
            const [userId, chatId, characterId, outfitKey, expressionKey, requestedBgrm] = params;
            const row = combinations.find(
              (c) =>
                c.user_id === userId &&
                c.chat_id === chatId &&
                c.character_id === characterId &&
                c.outfit_key === outfitKey &&
                c.expression_key === expressionKey &&
                (c.bgrm_applied ?? false) === (params.length === 6 ? requestedBgrm : false),
            );
            return { rows: row ? [{ combination_id: row.combination_id, image_url: row.image_url, bgrm_applied: row.bgrm_applied ?? false }] : [] };
          }

          // --- Stage 4: drop-check re-read of the current state. ---
          if (q.startsWith('select expression, outerwear, top, bottom')) {
            const [userId, chatId, characterId] = params;
            const row = states.find((s) => s.user_id === userId && s.chat_id === chatId && s.character_id === characterId);
            return {
              rows: row
                ? [
                    {
                      expression: row.expression,
                      outerwear: row.outerwear,
                      top: row.top,
                      bottom: row.bottom,
                      underwear_top: row.underwear_top,
                      underwear_bottom: row.underwear_bottom,
                      accessory: row.accessory,
                    },
                  ]
                : [],
            };
          }

          // --- Stage 4: the character row (appearance for the subject hash). ---
          if (q.startsWith('select character_id, name, appearance from characters')) {
            const [characterId, userId] = params;
            const row = characters.find((c) => c.character_id === characterId && c.user_id === userId);
            return { rows: row ? [{ character_id: row.character_id, name: row.name, appearance: row.appearance }] : [] };
          }

          // --- Stage 4: subject mint cache. ---
          if (q.startsWith('select slots, source_appearance_hash from character_subject_visuals')) {
            const [characterId, userId] = params;
            const row = subjectVisuals.find((s) => s.character_id === characterId && s.user_id === userId);
            return { rows: row ? [{ slots: row.slots, source_appearance_hash: row.source_appearance_hash }] : [] };
          }
          if (q.startsWith('insert into character_subject_visuals')) {
            const [userId, characterId, slots, hash] = params;
            const existing = subjectVisuals.find((s) => s.character_id === characterId);
            const row = { user_id: userId, character_id: characterId, slots: JSON.parse(slots), source_appearance_hash: hash };
            if (existing) Object.assign(existing, row);
            else subjectVisuals.push(row);
            return { rows: [] };
          }

          // --- Stage 4: expression mint cache. ---
          if (q.startsWith('select slots from visual_expression_definitions')) {
            const [userId, word] = params;
            const row = expressionDefs.find((d) => d.user_id === userId && d.word === word);
            return { rows: row ? [{ slots: row.slots }] : [] };
          }
          if (q.startsWith('insert into visual_expression_definitions')) {
            const [userId, word, slots] = params;
            const existing = expressionDefs.find((d) => d.user_id === userId && d.word === word);
            const row = { user_id: userId, word, slots: JSON.parse(slots) };
            if (existing) Object.assign(existing, row);
            else expressionDefs.push(row);
            return { rows: [] };
          }

          // --- Stage 4: ensureEntityForLayer (unspecified-layer fallback: most-recently-used
          //     entity or a seeded placeholder). ---
          if (q.startsWith('select entity_id, layer_id, slots, template, details from visual_entities where user_id = $1 and layer_id = $2')) {
            const [userId, layerId] = params;
            const matches = entities
              .filter((e) => e.user_id === userId && e.layer_id === layerId)
              .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
            const row = matches[0];
            return { rows: row ? [{ entity_id: row.entity_id, layer_id: row.layer_id, slots: row.slots, template: row.template, details: row.details }] : [] };
          }
          if (q.startsWith('insert into visual_entities')) {
            const [userId, layerId, name] = params;
            const row = {
              entity_id: randomUUID(),
              user_id: userId,
              layer_id: layerId,
              name,
              slots: {},
              template: null,
              details: '',
              updated_at: new Date().toISOString(),
            };
            entities.push(row);
            return { rows: [{ entity_id: row.entity_id, layer_id: row.layer_id, slots: row.slots, template: row.template, details: row.details }] };
          }

          // --- Stage 4: combination upsert. ---
          if (q.startsWith('insert into character_visual_combinations')) {
            const [userId, chatId, characterId, outfitKey, expressionKey, imageUrl, composedPrompt, bgrmApplied] = params;
            const existing = combinations.find(
              (c) =>
                c.user_id === userId &&
                c.chat_id === chatId &&
                c.character_id === characterId &&
                c.outfit_key === outfitKey &&
                c.expression_key === expressionKey &&
                (c.bgrm_applied ?? false) === bgrmApplied,
            );
            const row = {
              combination_id: randomUUID(),
              user_id: userId,
              chat_id: chatId,
              character_id: characterId,
              outfit_key: outfitKey,
              expression_key: expressionKey,
              image_url: imageUrl,
              composed_prompt: composedPrompt,
              bgrm_applied: bgrmApplied ?? false,
            };
            if (existing) Object.assign(existing, row);
            else combinations.push(row);
            return { rows: [] };
          }

          throw new Error(`fake pool: unhandled query: ${sql} (params: ${JSON.stringify(params)})`);
        },
        release() {},
      };
    },
  };
}

function poolWithTurn(pool, text = CANONICAL_TURN) {
  pool.chatMessages.push({ message_id: MSG, chat_id: CHAT, user_id: USER, content: text, active_swipe_id: SWIPE });
  return pool;
}

function seedAva(pool) {
  pool.characters.push({ character_id: AVA_ID, user_id: USER, name: 'Ava', appearance: 'Statuesque with jet-black hair.', status: null });
  return pool;
}

function seedKai(pool) {
  pool.characters.push({ character_id: KAI_ID, user_id: USER, name: 'Kai', appearance: 'Lean, sharp-eyed.', status: null });
  return pool;
}

// ---------------------------------------------------------------------------
// Pure parser: canonical shapes + every structured failure.
// ---------------------------------------------------------------------------
{
  const header = parseStoryHeader(HEADER);
  const parsed = parseCharacterVisualStateFooter(AVA_BLOCK, header);
  assert(parsed.ok === true, 'parser: the canonical footer region parses');
  const rec = parsed.records[0];
  assert(rec.name === 'Ava', 'parser: the record carries the block tag name');
  assert(rec.innerThoughts === 'She is watching the door, waiting for him.', 'parser: inner thoughts capture the full line');
  assert(rec.expression === 'composed', 'parser: the one-word expression is captured');
  assert(rec.outfit.outerwear === 'leather jacket' && rec.outfit.top === 'white blouse' && rec.outfit.bottom === 'jeans', 'parser: the outfit slots capture their values');
  assert(rec.outfit.underwear_top === 'none' && rec.outfit.underwear_bottom === 'none' && rec.outfit.accessory === 'silver pendant', "parser: 'none' slots and remaining slots capture verbatim");

  // Wrapper tolerance: the parser does not hardcode <details>/<summary> — a bare character block
  // (no wrapper at all) and the full wrapped turn both parse.
  const bare = parseCharacterVisualStateFooter(
    '<Ava>\nInner thoughts: x.\nExpression: calm\nOutfit:\n- Top: shirt\n</Ava>',
    header,
  );
  assert(bare.ok === true && bare.records.length === 1 && bare.records[0].name === 'Ava', 'parser: a bare character block (no <details> wrapper) parses');
  const wrapped = parseCharacterVisualStateFooter(CANONICAL_TURN, header);
  assert(wrapped.ok === true && wrapped.records.length === 1, 'parser: the full turn parses via wrapper tolerance (the region regex is the only footer authority)');
}

{
  // Partial outfit: zero or more slots in canonical relative order — omitted slots carry no
  // information, but the slots that ARE present must still follow the fixed slot sequence.
  const header = parseStoryHeader(HEADER);
  const partial = parseCharacterVisualStateFooter(PARTIAL_FOOTER, header);
  assert(partial.ok === true && partial.records.length === 1, 'parser: a partial-outfit footer (no summary, two slots) parses');
  const rec = partial.records[0];
  assert(rec.outfit.top === 'white blouse' && rec.outfit.accessory === 'silver pendant', 'parser: declared partial slots capture their values');
  assert(rec.outfit.outerwear === undefined && rec.outfit.underwear_top === undefined, 'parser: omitted slots are simply absent from the partial record');
  assert(rec.outfit.top === 'white blouse', 'parser: a partial outfit with a gap (Top then Accessory, skipping Bottom/Underwear) is still canonical order and parses');
  const topless = parseCharacterVisualStateFooter(TOPLESS_FOOTER, header);
  assert(topless.ok === true && topless.records[0].outfit.top === 'none', "parser: '- Slot: none' is an ordinary explicit value, never a rejection");
  const outOfOrder = parseCharacterVisualStateFooter(
    '<details>\n<Ava>\nInner thoughts: x.\nExpression: calm\nOutfit:\n- Accessory: ring\n- Top: shirt\n</Ava>\n</details>',
    header,
  );
  assert(outOfOrder.ok === false && outOfOrder.reason.includes('outfit-slots-out-of-order'), 'parser: partial slots out of canonical relative order (Accessory before Top) reject');
}

{
  // Multi-character: roster order is not enforced, but the SET must match exactly.
  const header = parseStoryHeader('[ Late Evening | 🗓️ Wednesday, June 15, 2026 AD | 📍 The Drunken Kraken - Main Hall ]\nPresent: Kai, Ava');
  const parsed = parseCharacterVisualStateFooter(TWO_BLOCK, header);
  assert(parsed.ok === true && parsed.records.length === 2, 'parser: a multi-character footer parses when the roster set matches');
  const names = parsed.records.map((r) => r.name).sort();
  assert(names.join(',') === 'Ava,Kai', 'parser: roster order is not enforced — blocks are matched by name');
}

{
  // Headerless → no extraction (identity comes only from the trusted header).
  const parsed = parseCharacterVisualStateFooter('She folded her hands.', null);
  assert(parsed.ok === false && parsed.reason === 'no-present', 'parser: no header roster rejects with no-present');
  const emptyRoster = parseCharacterVisualStateFooter(CANONICAL_TURN, parseStoryHeader('[ Late Evening | 🗓️ Wednesday, June 15, 2026 AD | 📍 The Kraken ]\nPresent:'));
  assert(emptyRoster.ok === false && emptyRoster.reason === 'no-present', 'parser: an empty Present: roster rejects with no-present');

  // No footer region → extraction locates nothing (the Cleaner's config is the authority).
  const noFooter = extractRegion(`${HEADER}\n\nShe folded her hands.`, FOOTER_CFG);
  assert(noFooter === null, 'extraction: a turn without a footer region yields null');
  const emptyText = parseCharacterVisualStateFooter('', parseStoryHeader(HEADER));
  assert(emptyText.ok === false && emptyText.reason === 'no-footer', 'parser: empty footer text rejects with no-footer');

  // Roster mismatch: a footer tag never invents identity.
  const stranger = parseCharacterVisualStateFooter(
    `<details><summary>▸</summary>\n<Zara>\nInner thoughts: x.\nExpression: calm\nOutfit:\n- Outerwear: none\n- Top: a\n- Bottom: b\n- Underwear top: none\n- Underwear bottom: none\n- Accessory: none\n</Zara>\n</details>`,
    parseStoryHeader(HEADER),
  );
  assert(stranger.ok === false && stranger.reason.includes('character-not-in-present'), 'parser: an unknown block tag rejects the whole extraction');

  // A roster name with no block → structured failure.
  const missingHeader = parseStoryHeader('[ Late Evening | 🗓️ Wednesday, June 15, 2026 AD | 📍 The Drunken Kraken - Main Hall ]\nPresent: Ava, Kai');
  const missing = parseCharacterVisualStateFooter(AVA_BLOCK, missingHeader);
  assert(missing.ok === false && missing.reason.includes('missing-character-block'), 'parser: a roster name with no block rejects (missing-character-block)');
}

{
  // Field/slot structural failures inside one block. The region text is the parser's input —
  // the wrapper (if any) is tolerated by rescanning.
  const block = (inner) =>
    `<details><summary>▸</summary>\n<Ava>\n${inner}\n</Ava>\n</details>`;
  const header = parseStoryHeader(HEADER);
  const run = (text) => parseCharacterVisualStateFooter(text, header);

  let r = run(block('Expression: composed\nOutfit:\n- Outerwear: none\n- Top: a\n- Bottom: b\n- Underwear top: none\n- Underwear bottom: none\n- Accessory: none'));
  assert(r.ok === false && r.reason.includes('missing-field-in-block'), 'parser: missing Inner thoughts rejects');
  r = run(block('Inner thoughts: x\nOutfit:\n- Outerwear: none\n- Top: a\n- Bottom: b\n- Underwear top: none\n- Underwear bottom: none\n- Accessory: none\nExpression: composed'));
  assert(r.ok === false && r.reason.includes('field-order-in-block'), 'parser: field order is enforced (Inner < Expression < Outfit)');
  r = run(block('Inner thoughts: x\nExpression: quite composed\nOutfit:\n- Outerwear: none\n- Top: a\n- Bottom: b\n- Underwear top: none\n- Underwear bottom: none\n- Accessory: none'));
  assert(r.ok === false && r.reason.includes('expression-not-one-word'), 'parser: a multi-word expression rejects');
  r = run(block('Inner thoughts: x\nExpression: composed\nOutfit:\n- Outerwear: none\n- Top: a\n- Bottom: b'));
  assert(r.ok === true && Object.keys(r.records[0].outfit).length === 3, 'parser: a partial outfit (3 of 6 slots) is valid — omitted slots are optional');
  r = run(block('Inner thoughts: x\nExpression: composed\nOutfit:\n- Top: '));
  assert(r.ok === false && r.reason.includes('empty-outfit-slot-value'), 'parser: an empty slot value rejects (ambiguous between unknown and none)');
  r = run(block('Inner thoughts: x\nExpression: composed\nOutfit:\n- Top: a\n- Outerwear: none\n- Bottom: b\n- Underwear top: none\n- Underwear bottom: none\n- Accessory: none'));
  assert(r.ok === false && r.reason.includes('outfit-slots-out-of-order'), 'parser: full slots out of canonical order reject (Outerwear must precede Top)');
  r = run(block('Inner thoughts: x\nExpression: composed\nOutfit:\n- Outerwear: none\n- Hat: a\n- Top: a\n- Bottom: b\n- Underwear top: none\n- Underwear bottom: none\n- Accessory: none'));
  assert(r.ok === false && r.reason.includes('unknown-outfit-slot'), 'parser: an unknown slot label rejects');
  r = run(block('Inner thoughts: x\nExpression: composed\nOutfit:\n- Outerwear: none\n- Outerwear: coat\n- Top: a\n- Bottom: b\n- Underwear top: none\n- Underwear bottom: none\n- Accessory: none'));
  assert(r.ok === false && r.reason.includes('duplicate-outfit-slot'), 'parser: a duplicated slot rejects');
}

{
  // Normalization + diff semantics (the shared implementation Stage 3 and Stage 4 rely on).
  assert(normalizeExpression('  Composed ') === 'composed', 'normalization: expression trims + casefolds');
  assert(normalizeOutfitField(' NONE ') === 'none', 'normalization: outfit fields trim + casefold ("none" sentinel included)');
  const outfit = { outerwear: 'Leather Jacket', top: 'white blouse', bottom: 'jeans', underwear_top: 'none', underwear_bottom: 'none', accessory: 'silver pendant' };
  const key = normalizeOutfitKey(outfit);
  assert(key === 'leather jacket\u0001white blouse\u0001jeans\u0001none\u0001none\u0001silver pendant', 'normalization: the outfit key joins the six fields in canonical order');
  // Three-state semantics: '' (unknown), 'none' (explicitly not worn) and a concrete item are
  // three DISTINCT cache keys — the merge never converts between them.
  const allNone = { outerwear: 'none', top: 'none', bottom: 'none', underwear_top: 'none', underwear_bottom: 'none', accessory: 'none' };
  const allEmpty = { outerwear: '', top: '', bottom: '', underwear_top: '', underwear_bottom: '', accessory: '' };
  assert(normalizeOutfitKey(allNone) !== normalizeOutfitKey(allEmpty), 'normalization: an all-none outfit and an all-unknown outfit are distinct cache keys');
  assert(normalizeOutfitKey(allNone) !== normalizeOutfitKey(outfit), 'normalization: a concrete outfit and an all-none outfit are distinct cache keys');
  const before = { innerThoughts: 'x', expression: 'composed', outfit };
  const after = { innerThoughts: 'completely different', expression: 'composed', outfit: { ...outfit, top: 'black blouse' } };
  const changed = diffVisibleFields(before, after);
  assert(changed.length === 1 && changed[0] === 'top', 'diff: only the visibly changed slot is reported');
  assert(innerThoughtsChanged(before, after) === true, 'diff: inner-thoughts change is tracked separately from the visible diff');
  assert(diffVisibleFields(before, before).length === 0, 'diff: identical snapshots report no visible change');
}

// ---------------------------------------------------------------------------
// Cleaner: the structure-aware footerRegex + revised {{roster}} prompt.
// ---------------------------------------------------------------------------
{
  const { footerRegex, footerFlags, footerPrompt } = DEFAULT_CLEANUP_CONFIG;
  const re = new RegExp(footerRegex, footerFlags);
  assert(re.test(CANONICAL_TURN), 'cleaner: the canonical footer matches the structure-aware footerRegex');
  assert(re.test(`${HEADER}\n\nx\n\n${TWO_BLOCK}`), 'cleaner: a multi-block canonical footer matches');
  const legacy = '<details><summary>▸</summary>\n<inner thoughts>\nAva:\nWatching the door.\n</inner thoughts>\n</details>';
  assert(!re.test(legacy), 'cleaner: the legacy 0066 <inner thoughts> block fails the structure-aware footerRegex (malformed → repaired)');
  assert(!re.test('<details><summary>▸</summary>\nplain text\n</details>'), 'cleaner: a footer with no field markers fails');
  // The canonical format is no longer locked to <summary>▸</summary> + all six slots (plan §Partial
  // outfit state): a summary-less footer with a partial outfit is valid.
  assert(re.test(PARTIAL_TURN), 'cleaner: a no-summary partial-outfit footer matches');
  assert(re.test(TOPLESS_TURN), "cleaner: a footer declaring only '- Top: none' matches");
  assert(!re.test('<details>\n<Ava>\nOutfit:\n- Top: a\n</Ava>\n</details>'), 'cleaner: a block without Inner thoughts/Expression still fails (field markers are mandatory)');

  // The revised footer prompt must not be able to recreate the obsolete format.
  assert(footerPrompt.includes('{{roster}}'), 'cleaner: the footer repair prompt carries the {{roster}} token');
  assert(/in roster order[^:]*:/.test(footerPrompt), 'cleaner: the footer repair prompt demands roster order');
  assert(footerPrompt.includes('- Top:'), 'cleaner: the footer repair prompt shows a slot line');
  assert(!footerPrompt.includes('- Outerwear:'), 'cleaner: the footer repair prompt no longer demands all six slot lines');
  assert(!footerPrompt.includes('<summary>▸'), 'cleaner: the footer repair prompt no longer emits the summary arrow');
  assert(!footerPrompt.includes('Underwear top: none'), "cleaner: the footer repair prompt no longer fills unspecified slots with 'none'");
  assert(footerPrompt.includes('{{history, 1}}'), 'cleaner: the footer repair prompt uses one history pair, not two');
  const withRoster = buildRepairPrompt('Block order: {{roster}}', { message: 'x', roster: 'Ava, Kai' });
  assert(withRoster === 'Block order: Ava, Kai', 'cleaner: {{roster}} resolves through buildRepairPrompt');
  assert(buildRepairPrompt('{{roster}}', { message: 'x' }) === '', 'cleaner: unset roster renders empty, never an error');
}

{
  // extractRegion: the single region authority, shared with inspectFooter (same compilation).
  const canonical = extractRegion(CANONICAL_TURN, FOOTER_CFG);
  assert(canonical !== null && canonical.text.startsWith('<details>') && canonical.text.endsWith('</details>'), 'extraction: the canonical footer region is the matched <details> block');
  assert(extractRegion(PARTIAL_TURN, FOOTER_CFG) !== null, 'extraction: a no-summary partial footer region matches');
  const invalid = extractRegion(CANONICAL_TURN, { regex: '([', flags: '', prompt: '' });
  assert(invalid === null, 'extraction: an unparseable footer regex yields null (fail-open, no throw)');
}

// ---------------------------------------------------------------------------
// Stage 3: applyCharacterVisualState.
// ---------------------------------------------------------------------------
{
  // No header → applied false, zero DB work (the fail-open header gate).
  const pool = poolWithTurn(createFakePool(), 'She folded her hands.');
  const result = await applyCharacterVisualState({ db: createPostgresClient(pool) }, USER, CHAT, MSG, 'She folded her hands.', FOOTER_CFG);
  assert(result.applied === false && result.fired.length === 0, 'stage3: a headerless turn is skipped entirely (applied false, nothing fired)');
  assert(pool.states.length === 0 && pool.events.length === 0, 'stage3: a headerless turn writes nothing');

  // Header + no footer → parse gate rejects (fail-open).
  const pool2 = poolWithTurn(createFakePool(), `${HEADER}\n\nShe folded her hands.`);
  const result2 = await applyCharacterVisualState({ db: createPostgresClient(pool2) }, USER, CHAT, MSG, `${HEADER}\n\nShe folded her hands.`, FOOTER_CFG);
  assert(result2.applied === false && result2.fired.length === 0, 'stage3: a header with no footer is skipped (parse gate, fail-open)');
  assert(pool2.states.length === 0 && pool2.events.length === 0, 'stage3: a rejected parse writes nothing');

  // An unparseable footer regex config degrades to no-region (fail-open, never throws).
  const pool3 = poolWithTurn(seedAva(createFakePool()));
  const badCfg = { regex: '([', flags: '', prompt: '' };
  const result3 = await applyCharacterVisualState({ db: createPostgresClient(pool3) }, USER, CHAT, MSG, CANONICAL_TURN, badCfg);
  assert(result3.applied === false && result3.fired.length === 0, 'stage3: an unparseable footer regex skips extraction (fail-open)');
  assert(pool3.states.length === 0 && pool3.events.length === 0, 'stage3: an unparseable footer regex writes nothing');
}

{
  // First visit: insert the snapshot + one 'initialized' event, no autofire.
  const pool = poolWithTurn(seedAva(createFakePool()));
  const db = createPostgresClient(pool);
  const result = await applyCharacterVisualState({ db }, USER, CHAT, MSG, CANONICAL_TURN, FOOTER_CFG);
  assert(result.applied === true && result.fired.length === 0, 'stage3: a new snapshot applies with no autofire trigger');
  assert(pool.states.length === 1, 'stage3: exactly one state row is written');
  const s = pool.states[0];
  assert(s.character_id === AVA_ID && s.message_id === MSG && s.swipe_id === SWIPE, 'stage3: the state row carries the message + swipe provenance');
  assert(s.expression === 'composed' && s.outerwear === 'leather jacket' && s.top === 'white blouse', 'stage3: the stored snapshot is normalized (trim + casefold)');
  assert(s.inner_thoughts === 'She is watching the door, waiting for him.', 'stage3: inner thoughts are stored trimmed');
  assert(pool.events.length === 1 && pool.events[0].event_type === 'initialized', 'stage3: the first visit records an initialized event');
  assert(pool.events[0].changed_fields === '[]', 'stage3: the initialized event carries an empty changed-fields list');
  const after = JSON.parse(pool.events[0].after_state);
  assert(after.expression === 'composed', 'stage3: the initialized event stores the full normalized after-snapshot');
}

{
  // Visible change: persist + one 'visible_change' event + one autofire trigger.
  const pool = poolWithTurn(seedAva(createFakePool()));
  pool.states.push({
    user_id: USER,
    chat_id: CHAT,
    character_id: AVA_ID,
    message_id: MSG,
    swipe_id: SWIPE,
    inner_thoughts: 'old',
    expression: 'angry',
    outerwear: 'none',
    top: 'none',
    bottom: 'none',
    underwear_top: 'none',
    underwear_bottom: 'none',
    accessory: 'none',
  });
  const result = await applyCharacterVisualState({ db: createPostgresClient(pool) }, USER, CHAT, MSG, CANONICAL_TURN, FOOTER_CFG);
  assert(result.applied === true && result.fired.length === 1, 'stage3: a visible change fires exactly one autofire trigger');
  const fired = result.fired[0];
  assert(fired.characterId === AVA_ID && fired.expression === 'composed' && fired.outfit.top === 'white blouse', 'stage3: the trigger carries the normalized (character, outfit, expression)');
  assert(pool.states[0].expression === 'composed', 'stage3: the visible change persisted');
  assert(pool.events.length === 1 && pool.events[0].event_type === 'visible_change', 'stage3: a visible change records one visible_change event');
  const changedFields = JSON.parse(pool.events[0].changed_fields);
  assert(changedFields.includes('expression') && changedFields.includes('outerwear') && changedFields.includes('top'), 'stage3: the visible_change event lists exactly the changed slots');
  const beforeState = JSON.parse(pool.events[0].before_state);
  assert(beforeState.expression === 'angry', 'stage3: the visible_change event stores the before-state for audit');
}

{
  // Inner-thoughts-only change: persist, no event, no autofire.
  const pool = poolWithTurn(seedAva(createFakePool()));
  pool.states.push({
    user_id: USER,
    chat_id: CHAT,
    character_id: AVA_ID,
    message_id: MSG,
    swipe_id: SWIPE,
    inner_thoughts: 'old thought',
    expression: 'composed',
    outerwear: 'leather jacket',
    top: 'white blouse',
    bottom: 'jeans',
    underwear_top: 'none',
    underwear_bottom: 'none',
    accessory: 'silver pendant',
  });
  const result = await applyCharacterVisualState({ db: createPostgresClient(pool) }, USER, CHAT, MSG, CANONICAL_TURN, FOOTER_CFG);
  assert(result.applied === true && result.fired.length === 0, 'stage3: an inner-thoughts-only change never autofires');
  assert(pool.states[0].inner_thoughts === 'She is watching the door, waiting for him.', 'stage3: the inner-thoughts-only change persisted');
  assert(pool.events.length === 0, 'stage3: an inner-thoughts-only change records no event');
}

{
  // Identical snapshot: provenance refresh only, no event, no autofire.
  const pool = poolWithTurn(seedAva(createFakePool()));
  pool.states.push({
    user_id: USER,
    chat_id: CHAT,
    character_id: AVA_ID,
    message_id: 'stale-msg',
    swipe_id: 'stale-swipe',
    inner_thoughts: 'She is watching the door, waiting for him.',
    expression: 'composed',
    outerwear: 'leather jacket',
    top: 'white blouse',
    bottom: 'jeans',
    underwear_top: 'none',
    underwear_bottom: 'none',
    accessory: 'silver pendant',
  });
  const result = await applyCharacterVisualState({ db: createPostgresClient(pool) }, USER, CHAT, MSG, CANONICAL_TURN, FOOTER_CFG);
  assert(result.applied === true && result.fired.length === 0, 'stage3: an identical snapshot never autofires');
  assert(pool.states[0].message_id === MSG && pool.states[0].swipe_id === SWIPE, 'stage3: an identical snapshot refreshes provenance to the active turn');
  assert(pool.events.length === 0, 'stage3: an identical snapshot records no event');
}

{
  // Partial outfit on a fresh state: declared slots normalize, omitted slots stay '' (unknown) —
  // never filled with 'none'.
  const pool = poolWithTurn(seedAva(createFakePool()), PARTIAL_TURN);
  const result = await applyCharacterVisualState({ db: createPostgresClient(pool) }, USER, CHAT, MSG, PARTIAL_TURN, FOOTER_CFG);
  assert(result.applied === true && result.fired.length === 0, 'stage3 (partial): a fresh partial snapshot applies with no autofire (initialized)');
  const s = pool.states[0];
  assert(s.top === 'white blouse' && s.accessory === 'silver pendant', 'stage3 (partial): declared slots are stored normalized');
  assert(s.outerwear === '' && s.bottom === '' && s.underwear_top === '' && s.underwear_bottom === '', "stage3 (partial): omitted slots on a fresh state are stored '' (unknown), not 'none'");
  assert(s.expression === 'composed', 'stage3 (partial): the expression is stored as usual');
}

{
  // Partial-outfit merge against a prior state: a parsed slot overrides; an omitted slot keeps
  // its prior value; the change autofires.
  const pool = poolWithTurn(seedAva(createFakePool()), PARTIAL_CHANGE_TURN);
  pool.states.push({
    user_id: USER,
    chat_id: CHAT,
    character_id: AVA_ID,
    message_id: 'old-msg',
    swipe_id: 'old-swipe',
    inner_thoughts: 'old',
    expression: 'composed',
    outerwear: 'leather jacket',
    top: 'white blouse',
    bottom: 'jeans',
    underwear_top: 'none',
    underwear_bottom: 'none',
    accessory: 'silver pendant',
  });
  const result = await applyCharacterVisualState({ db: createPostgresClient(pool) }, USER, CHAT, MSG, PARTIAL_CHANGE_TURN, FOOTER_CFG);
  assert(result.applied === true && result.fired.length === 1, 'stage3 (merge): a declared slot change fires one autofire trigger');
  assert(pool.states[0].top === 'black blouse', 'stage3 (merge): the parsed slot overrides the prior value');
  assert(pool.states[0].outerwear === 'leather jacket' && pool.states[0].accessory === 'silver pendant' && pool.states[0].underwear_top === 'none', 'stage3 (merge): omitted slots keep their prior values');
  const changedFields = JSON.parse(pool.events[0].changed_fields);
  assert(changedFields.length === 1 && changedFields[0] === 'top', 'stage3 (merge): the visible_change event lists only the actually-changed slot');
}

{
  // 'Top: shirt' → 'Top: none' = topless: an explicit transition that fires, and the stored 'none'
  // stays distinct from the '' it would have been as an omission.
  const pool = poolWithTurn(seedAva(createFakePool()), TOPLESS_TURN);
  pool.states.push({
    user_id: USER,
    chat_id: CHAT,
    character_id: AVA_ID,
    message_id: 'old-msg',
    swipe_id: 'old-swipe',
    inner_thoughts: 'old',
    expression: 'composed',
    outerwear: 'none',
    top: 'white blouse',
    bottom: 'jeans',
    underwear_top: 'none',
    underwear_bottom: 'none',
    accessory: 'none',
  });
  const result = await applyCharacterVisualState({ db: createPostgresClient(pool) }, USER, CHAT, MSG, TOPLESS_TURN, FOOTER_CFG);
  assert(result.applied === true && result.fired.length === 1, "stage3: a concrete → 'none' transition is a visible change that fires");
  assert(pool.states[0].top === 'none', "stage3: the stored snapshot carries 'none' (explicitly not worn)");
  assert(pool.states[0].expression === 'defiant', 'stage3: the co-changed expression persisted too');
}

{
  // Omission alone never autofires: only inner thoughts changed, every slot omitted → the merged
  // snapshot is visible-identical, so it is an inner-only persist (no event, no autofire).
  const pool = poolWithTurn(seedAva(createFakePool()), OMISSION_ONLY_TURN);
  pool.states.push({
    user_id: USER,
    chat_id: CHAT,
    character_id: AVA_ID,
    message_id: 'old-msg',
    swipe_id: 'old-swipe',
    inner_thoughts: 'old',
    expression: 'composed',
    outerwear: 'leather jacket',
    top: 'white blouse',
    bottom: 'jeans',
    underwear_top: 'none',
    underwear_bottom: 'none',
    accessory: 'silver pendant',
  });
  const result = await applyCharacterVisualState({ db: createPostgresClient(pool) }, USER, CHAT, MSG, OMISSION_ONLY_TURN, FOOTER_CFG);
  assert(result.applied === true && result.fired.length === 0, 'stage3 (omission): a footer declaring no slots never autofires');
  assert(pool.events.length === 0, 'stage3 (omission): a no-slot footer records no visible_change event');
  assert(pool.states[0].top === 'white blouse' && pool.states[0].outerwear === 'leather jacket', 'stage3 (omission): the prior outfit is fully preserved');
  assert(pool.states[0].inner_thoughts === 'A different thought entirely.', 'stage3 (omission): the inner-thoughts change still persists');
}

{
  // Stale swipe guard: the message content moved on since the parse — drop the whole extraction.
  const pool = seedAva(createFakePool());
  pool.chatMessages.push({ message_id: MSG, chat_id: CHAT, user_id: USER, content: `${HEADER}\n\nA regenerated swipe.\n\n${AVA_BLOCK}`, active_swipe_id: SWIPE });
  pool.states.push({
    user_id: USER,
    chat_id: CHAT,
    character_id: AVA_ID,
    message_id: MSG,
    swipe_id: SWIPE,
    inner_thoughts: 'old',
    expression: 'angry',
    outerwear: 'none',
    top: 'none',
    bottom: 'none',
    underwear_top: 'none',
    underwear_bottom: 'none',
    accessory: 'none',
  });
  // The stored message content differs from the text we parsed (a regeneration/cycle swapped it).
  const result = await applyCharacterVisualState({ db: createPostgresClient(pool) }, USER, CHAT, MSG, CANONICAL_TURN, FOOTER_CFG);
  assert(result.applied === false && result.fired.length === 0, 'stage3: a stale swipe (content mismatch under the row lock) drops the extraction');
  assert(pool.states[0].expression === 'angry', 'stage3: the stale-swipe drop leaves the existing snapshot untouched');
  assert(pool.events.length === 0, 'stage3: a stale swipe records no event');
}

{
  // Roster resolution: an unknown name (0 eligible matches) rejects the ENTIRE extraction.
  const pool = poolWithTurn(createFakePool()); // no Ava character row at all
  const result = await applyCharacterVisualState({ db: createPostgresClient(pool) }, USER, CHAT, MSG, CANONICAL_TURN, FOOTER_CFG);
  assert(result.applied === false && result.fired.length === 0, 'stage3: an unresolvable roster name rejects the whole extraction (fail-open)');
  assert(pool.states.length === 0 && pool.events.length === 0, 'stage3: a rejected roster writes nothing');

  // Ambiguous: two eligible same-named rows → the exact-one rule rejects.
  const pool2 = poolWithTurn(seedAva(createFakePool()));
  pool2.characters.push({ character_id: randomUUID(), user_id: USER, name: 'Ava', appearance: 'a twin', status: null });
  const result2 = await applyCharacterVisualState({ db: createPostgresClient(pool2) }, USER, CHAT, MSG, CANONICAL_TURN, FOOTER_CFG);
  assert(result2.applied === false && result2.fired.length === 0, 'stage3: an ambiguous roster name (2 eligible matches) rejects the whole extraction');
}

{
  // DB failure anywhere → applied false, never throws (fail-open end to end).
  const db = {
    async withUserScope() {
      throw new Error('connection refused');
    },
  };
  let threw = false;
  try {
    const result = await applyCharacterVisualState({ db }, USER, CHAT, MSG, CANONICAL_TURN, FOOTER_CFG);
    assert(result.applied === false && result.fired.length === 0, 'stage3: a DB failure resolves to applied false');
  } catch {
    threw = true;
  }
  assert(!threw, 'stage3: a DB failure never throws out of applyCharacterVisualState');
}

// ---------------------------------------------------------------------------
// Stage 4: renderCharacterVisualCombination.
// ---------------------------------------------------------------------------
function fakeSettings() {
  return { get: async () => undefined, set: async () => {} };
}

function mintingLlm() {
  const calls = [];
  return {
    calls,
    complete: async (messages) => {
      calls.push(messages[0]?.content ?? '');
      return { message: { role: 'assistant', content: 'build: statuesque\nhair: jet black, thick\nmood: steady gaze' }, toolCalls: [] };
    },
  };
}

function fakeImageConnections({ profile, resolveDelay }) {
  const resolves = [];
  let resolveFn;
  const gate = new Promise((r) => (resolveFn = r));
  return {
    profile,
    gate,
    resolve: resolveFn,
    async resolveActive(purpose) {
      resolves.push(purpose);
      if (resolveDelay) await gate;
      return profile;
    },
    resolveCalls: resolves,
  };
}

const POLLINATIONS_PROFILE = {
  kind: 'pollinations',
  apiKey: 'pk-live',
  model: 'flux',
  masterNegativePrompt: 'blurry',
  width: 768,
  height: 1024,
  seed: 12345,
  samplingSteps: 20,
  cfgScale: 5,
  samplerName: 'euler',
  baseUrl: '',
  workflowParameters: null,
};

const OUTFIT = { outerwear: 'leather jacket', top: 'white blouse', bottom: 'jeans', underwear_top: 'none', underwear_bottom: 'none', accessory: 'silver pendant' };

{
  // Combination cache hit: no mints, no provider call, no new rows.
  const pool = createFakePool();
  seedAva(pool);
  pool.combinations.push({
    combination_id: randomUUID(),
    user_id: USER,
    chat_id: CHAT,
    character_id: AVA_ID,
    outfit_key: normalizeOutfitKey(OUTFIT),
    expression_key: normalizeExpression('composed'),
    image_url: 'https://cdn.example.com/ava-composed.png',
    composed_prompt: 'cached',
  });
  const llm = mintingLlm();
  const images = fakeImageConnections({ profile: POLLINATIONS_PROFILE });
  await renderCharacterVisualCombination(
    { db: createPostgresClient(pool), settings: fakeSettings(), imageConnections: images },
    llm,
    USER,
    CHAT,
    AVA_ID,
    OUTFIT,
    'composed',
  );
  assert(llm.calls.length === 0, 'stage4: a combination cache hit makes no mint calls');
  assert(images.resolveCalls.length === 0, 'stage4: a combination cache hit never reaches the provider resolution');
  assert(pool.subjectVisuals.length === 0 && pool.expressionDefs.length === 0 && pool.entities.length === 0, 'stage4: a cache hit writes nothing');
  assert(pool.combinations.length === 1, 'stage4: a cache hit does not duplicate the combination row');
}

{
  // Drop check: the state moved on since the trigger was fired — miss, but no render.
  const pool = createFakePool();
  seedAva(pool);
  pool.states.push({
    user_id: USER,
    chat_id: CHAT,
    character_id: AVA_ID,
    message_id: MSG,
    swipe_id: SWIPE,
    inner_thoughts: 'x',
    expression: 'angry',
    outerwear: 'none',
    top: 'none',
    bottom: 'none',
    underwear_top: 'none',
    underwear_bottom: 'none',
    accessory: 'none',
  });
  const llm = mintingLlm();
  const images = fakeImageConnections({ profile: POLLINATIONS_PROFILE });
  await renderCharacterVisualCombination(
    { db: createPostgresClient(pool), settings: fakeSettings(), imageConnections: images },
    llm,
    USER,
    CHAT,
    AVA_ID,
    OUTFIT,
    'composed',
  );
  assert(llm.calls.length === 0, 'stage4: a stale trigger (state moved on) makes no mint calls');
  assert(images.resolveCalls.length === 0, 'stage4: a stale trigger never reaches the provider');
  assert(pool.combinations.length === 0, 'stage4: a stale trigger writes no combination row');
}

{
  // Full render: subject + expression mints, ensureEntityForLayer fallbacks for style/format,
  // compileTemplate → provider → combination upsert (cache-miss writes the dedupe row).
  const pool = createFakePool();
  seedAva(pool);
  pool.states.push({
    user_id: USER,
    chat_id: CHAT,
    character_id: AVA_ID,
    message_id: MSG,
    swipe_id: SWIPE,
    inner_thoughts: 'x',
    expression: 'composed',
    outerwear: 'leather jacket',
    top: 'white blouse',
    bottom: 'jeans',
    underwear_top: 'none',
    underwear_bottom: 'none',
    accessory: 'silver pendant',
  });
  const llm = mintingLlm();
  const images = fakeImageConnections({ profile: POLLINATIONS_PROFILE });
  await renderCharacterVisualCombination(
    { db: createPostgresClient(pool), settings: fakeSettings(), imageConnections: images },
    llm,
    USER,
    CHAT,
    AVA_ID,
    OUTFIT,
    'composed',
  );
  assert(llm.calls.length === 2, 'stage4: a fresh render mints exactly subject + expression (two slot-bootstrapper calls)');
  assert(pool.subjectVisuals.length === 1, 'stage4: the subject mint is cached in character_subject_visuals');
  assert(pool.subjectVisuals[0].character_id === AVA_ID && Object.keys(pool.subjectVisuals[0].slots).length === 3, 'stage4: the subject cache row carries the minted slot map');
  assert(pool.expressionDefs.length === 1 && pool.expressionDefs[0].word === 'composed', 'stage4: the expression mint is cached by the normalized word');
  assert(pool.entities.some((e) => e.layer_id === 'style') && pool.entities.some((e) => e.layer_id === 'format'), 'stage4: unspecified layers resolve through the seeded-placeholder fallback (style + format)');
  assert(images.resolveCalls.length === 1 && images.resolveCalls[0] === 'portrait', 'stage4: the active portrait connection is resolved exactly once');
  assert(pool.combinations.length === 1, 'stage4: a successful render writes the combination dedupe row');
  assert(pool.combinations[0].outfit_key === normalizeOutfitKey(OUTFIT) && pool.combinations[0].expression_key === 'composed', 'stage4: the combination row is keyed by the normalized outfit/expression');
  assert(pool.combinations[0].image_url.startsWith('https://image.pollinations.ai/prompt/'), 'stage4: the combination row stores the provider CDN URL');
  assert(pool.combinations[0].composed_prompt.length > 0 && pool.combinations[0].composed_prompt.includes('statuesque'), 'stage4: the composed prompt embeds the minted subject slots');

  // A second identical render is a pure cache hit — no new mints, no provider call, no duplicate.
  const llm2 = mintingLlm();
  await renderCharacterVisualCombination(
    { db: createPostgresClient(pool), settings: fakeSettings(), imageConnections: images },
    llm2,
    USER,
    CHAT,
    AVA_ID,
    OUTFIT,
    'composed',
  );
  assert(llm2.calls.length === 0, 'stage4: the same combination on the same character is a cache hit (dedupe)');
  assert(pool.combinations.length === 1, 'stage4: the dedupe upsert does not duplicate the row');
}

{
  // BGRM upgrade: a raw cache row is the source, so no portrait generation is spent; the raw row
  // remains and the transparent variant is added under its separate identity.
  const pool = createFakePool();
  seedAva(pool);
  pool.states.push({ user_id: USER, chat_id: CHAT, character_id: AVA_ID, message_id: MSG, swipe_id: SWIPE, inner_thoughts: 'x', expression: 'composed', outerwear: 'leather jacket', top: 'white blouse', bottom: 'jeans', underwear_top: 'none', underwear_bottom: 'none', accessory: 'silver pendant' });
  pool.combinations.push({ combination_id: randomUUID(), user_id: USER, chat_id: CHAT, character_id: AVA_ID, outfit_key: normalizeOutfitKey(OUTFIT), expression_key: 'composed', image_url: 'https://cdn.example/raw-character.png', composed_prompt: 'raw', bgrm_applied: false });
  const portraitProfile = { ...POLLINATIONS_PROFILE, kind: 'runware', apiKey: 'portrait-key', model: 'runware/portrait' };
  const bgrmProfile = { ...POLLINATIONS_PROFILE, kind: 'runware', apiKey: 'bgrm-key', model: 'runware/bgrm' };
  const images = { resolveCalls: [], async resolveActive(purpose) { this.resolveCalls.push(purpose); return purpose === 'portrait' ? portraitProfile : purpose === 'bgrm' ? bgrmProfile : null; } };
  const settings = { get: async (key) => key === 'character_visual_bgrm_enabled' ? 'true' : undefined, set: async () => {} };
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const task = JSON.parse(init.body)[0];
    requests.push(task);
    return task.taskType === 'imageInference'
      ? { ok: true, json: async () => ({ data: [{ imageURL: 'https://cdn.example/unexpected-generation.png', imageUUID: 'unexpected-uuid' }] }) }
      : { ok: true, json: async () => ({ data: [{ imageURL: 'https://cdn.example/transparent-character.png' }] }) };
  };
  try {
    await renderCharacterVisualCombination({ db: createPostgresClient(pool), settings, imageConnections: images }, mintingLlm(), USER, CHAT, AVA_ID, OUTFIT, 'composed');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert(requests.length === 1 && requests[0].taskType === 'removeBackground' && requests[0].inputs.image === 'https://cdn.example/raw-character.png', 'stage4 BGRM: raw cache URL reaches BGRM without generation');
  assert(pool.combinations.length === 2 && pool.combinations.some((row) => row.bgrm_applied === false) && pool.combinations.some((row) => row.bgrm_applied === true), 'stage4 BGRM: raw and transparent variants coexist');
}

{
  // Fresh Runware generation uses the native UUID immediately and persists the actual successful
  // BGRM state. A later transparent hit must not resolve either provider again.
  const pool = createFakePool();
  seedAva(pool);
  pool.states.push({ user_id: USER, chat_id: CHAT, character_id: AVA_ID, message_id: MSG, swipe_id: SWIPE, inner_thoughts: 'x', expression: 'composed', outerwear: 'leather jacket', top: 'white blouse', bottom: 'jeans', underwear_top: 'none', underwear_bottom: 'none', accessory: 'silver pendant' });
  const portraitProfile = { ...POLLINATIONS_PROFILE, kind: 'runware', apiKey: 'portrait-key', model: 'runware/portrait' };
  const bgrmProfile = { ...POLLINATIONS_PROFILE, kind: 'runware', apiKey: 'bgrm-key', model: 'runware/bgrm' };
  const images = { resolveCalls: [], async resolveActive(purpose) { this.resolveCalls.push(purpose); return purpose === 'portrait' ? portraitProfile : purpose === 'bgrm' ? bgrmProfile : null; } };
  const settings = { get: async (key) => key === 'character_visual_bgrm_enabled' ? 'true' : undefined, set: async () => {} };
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    const task = JSON.parse(init.body)[0];
    requests.push(task);
    return task.taskType === 'imageInference'
      ? { ok: true, json: async () => ({ data: [{ imageURL: 'https://cdn.example/raw-fresh.jpg', imageUUID: 'fresh-native-uuid' }] }) }
      : { ok: true, json: async () => ({ data: [{ imageURL: 'https://cdn.example/transparent-fresh.png' }] }) };
  };
  try {
    await renderCharacterVisualCombination({ db: createPostgresClient(pool), settings, imageConnections: images }, mintingLlm(), USER, CHAT, AVA_ID, OUTFIT, 'composed');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert(requests.length === 2 && requests[1].inputs.image === 'fresh-native-uuid', 'stage4 BGRM: fresh Runware generation forwards its native UUID');
  assert(pool.combinations.length === 1 && pool.combinations[0].bgrm_applied === true && pool.combinations[0].image_url === 'https://cdn.example/transparent-fresh.png', 'stage4 BGRM: successful fresh render persists the transparent state');
  const lookupCount = images.resolveCalls.length;
  await renderCharacterVisualCombination({ db: createPostgresClient(pool), settings, imageConnections: { resolveActive: async () => { throw new Error('cache hit resolved a provider'); } } }, mintingLlm(), USER, CHAT, AVA_ID, OUTFIT, 'composed');
  assert(pool.combinations.length === 1 && images.resolveCalls.length === lookupCount, 'stage4 BGRM: transparent cache hit avoids provider and BGRM calls');
}

{
  // BGRM failure stores only raw; the next enabled request upgrades that cached raw URL without
  // invoking portrait generation again.
  const pool = createFakePool();
  seedAva(pool);
  pool.states.push({ user_id: USER, chat_id: CHAT, character_id: AVA_ID, message_id: MSG, swipe_id: SWIPE, inner_thoughts: 'x', expression: 'composed', outerwear: 'leather jacket', top: 'white blouse', bottom: 'jeans', underwear_top: 'none', underwear_bottom: 'none', accessory: 'silver pendant' });
  const settings = { get: async (key) => key === 'character_visual_bgrm_enabled' ? 'true' : undefined, set: async () => {} };
  const portraitProfile = { ...POLLINATIONS_PROFILE, kind: 'runware', apiKey: 'portrait-key', model: 'runware/portrait' };
  const bgrmProfile = { ...POLLINATIONS_PROFILE, kind: 'runware', apiKey: 'bgrm-key', model: 'runware/bgrm' };
  const images = { async resolveActive(purpose) { return purpose === 'portrait' ? portraitProfile : purpose === 'bgrm' ? bgrmProfile : null; } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const task = JSON.parse(init.body)[0];
    if (task.taskType === 'imageInference') return { ok: true, json: async () => ({ data: [{ imageURL: 'https://cdn.example/raw-retry.jpg', imageUUID: 'retry-native-uuid' }] }) };
    return { ok: false, status: 503, text: async () => 'temporary failure' };
  };
  try {
    await renderCharacterVisualCombination({ db: createPostgresClient(pool), settings, imageConnections: images }, mintingLlm(), USER, CHAT, AVA_ID, OUTFIT, 'composed');
    assert(pool.combinations.length === 1 && pool.combinations[0].bgrm_applied === false, 'stage4 BGRM: failure stores only a raw fallback');
    const firstGenerationCount = pool.combinations.length;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ imageURL: 'https://cdn.example/transparent-retry.png' }] }) });
    await renderCharacterVisualCombination({ db: createPostgresClient(pool), settings, imageConnections: images }, mintingLlm(), USER, CHAT, AVA_ID, OUTFIT, 'composed');
    assert(pool.combinations.length === 2 && pool.combinations.some((row) => row.bgrm_applied === true) && firstGenerationCount === 1, 'stage4 BGRM: a later enabled request retries from cached raw without a new generation');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  // Provider failure: no combination row written — the exact same trigger retries next time.
  const pool = createFakePool();
  seedAva(pool);
  pool.states.push({
    user_id: USER,
    chat_id: CHAT,
    character_id: AVA_ID,
    message_id: MSG,
    swipe_id: SWIPE,
    inner_thoughts: 'x',
    expression: 'composed',
    outerwear: 'leather jacket',
    top: 'white blouse',
    bottom: 'jeans',
    underwear_top: 'none',
    underwear_bottom: 'none',
    accessory: 'silver pendant',
  });
  const llm = mintingLlm();
  const failing = fakeImageConnections({ profile: { ...POLLINATIONS_PROFILE, apiKey: '' } });
  await renderCharacterVisualCombination(
    { db: createPostgresClient(pool), settings: fakeSettings(), imageConnections: failing },
    llm,
    USER,
    CHAT,
    AVA_ID,
    OUTFIT,
    'composed',
  );
  assert(llm.calls.length === 2, 'stage4: the mints still run before the provider call');
  assert(failing.resolveCalls.length === 1, 'stage4: the provider is resolved before the call');
  assert(pool.combinations.length === 0, 'stage4: a provider failure writes NO combination row (never caches a failure)');
  assert(pool.subjectVisuals.length === 1 && pool.expressionDefs.length === 1, 'stage4: a provider failure still keeps the mint caches (they are independent of the render)');
}

{
  // Subject re-mint on appearance edit: the source_appearance_hash mismatch forces a re-mint.
  const pool = createFakePool();
  seedAva(pool);
  pool.states.push({
    user_id: USER,
    chat_id: CHAT,
    character_id: AVA_ID,
    message_id: MSG,
    swipe_id: SWIPE,
    inner_thoughts: 'x',
    expression: 'composed',
    outerwear: 'leather jacket',
    top: 'white blouse',
    bottom: 'jeans',
    underwear_top: 'none',
    underwear_bottom: 'none',
    accessory: 'silver pendant',
  });
  pool.subjectVisuals.push({
    user_id: USER,
    character_id: AVA_ID,
    slots: { build: 'old' },
    source_appearance_hash: 'stale-hash', // does not match sha256 of the character's appearance
  });
  pool.expressionDefs.push({ user_id: USER, word: 'composed', slots: { mood: 'steady' } });
  const llm = mintingLlm();
  const images = fakeImageConnections({ profile: POLLINATIONS_PROFILE });
  await renderCharacterVisualCombination(
    { db: createPostgresClient(pool), settings: fakeSettings(), imageConnections: images },
    llm,
    USER,
    CHAT,
    AVA_ID,
    OUTFIT,
    'composed',
  );
  assert(llm.calls.length === 1, 'stage4: a subject hash mismatch re-mints the subject only (expression was cached)');
  assert(pool.subjectVisuals[0].source_appearance_hash !== 'stale-hash' && Object.keys(pool.subjectVisuals[0].slots).length === 3, 'stage4: the re-minted subject replaces the stale cache row');
  assert(pool.combinations.length === 1, 'stage4: the appearance-edit render still completes');
}

{
  // In-flight guard: a duplicate trigger while the first render is still awaiting the provider
  // resolution never double-spends a provider round-trip.
  const pool = createFakePool();
  seedAva(pool);
  pool.states.push({
    user_id: USER,
    chat_id: CHAT,
    character_id: AVA_ID,
    message_id: MSG,
    swipe_id: SWIPE,
    inner_thoughts: 'x',
    expression: 'composed',
    outerwear: 'leather jacket',
    top: 'white blouse',
    bottom: 'jeans',
    underwear_top: 'none',
    underwear_bottom: 'none',
    accessory: 'silver pendant',
  });
  pool.subjectVisuals.push({ user_id: USER, character_id: AVA_ID, slots: { build: 'statuesque' }, source_appearance_hash: 'h' });
  pool.expressionDefs.push({ user_id: USER, word: 'composed', slots: { mood: 'steady' } });
  const llm = mintingLlm();
  // The provider resolution is held open so the first call stays in flight.
  const images = fakeImageConnections({ profile: POLLINATIONS_PROFILE, resolveDelay: true });
  const deps = { db: createPostgresClient(pool), settings: fakeSettings(), imageConnections: images };
  const first = renderCharacterVisualCombination(deps, llm, USER, CHAT, AVA_ID, OUTFIT, 'composed');
  await new Promise((r) => setImmediate(r));
  assert(images.resolveCalls.length === 1, 'stage4 (in-flight): the first render reaches the provider resolution');
  const second = renderCharacterVisualCombination(deps, llm, USER, CHAT, AVA_ID, OUTFIT, 'composed');
  await new Promise((r) => setImmediate(r));
  assert(images.resolveCalls.length === 1, 'stage4 (in-flight): a duplicate trigger is deduped before a second provider resolution');
  images.resolve(POLLINATIONS_PROFILE);
  await first;
  await second;
  assert(pool.combinations.length === 1, 'stage4 (in-flight): exactly one combination row after the guarded pair');
}

if (process.exitCode) {
  console.error('\ncharacter visual state verification FAILED');
  process.exit(1);
}
console.log('\ncharacter visual state verification passed');
