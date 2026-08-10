// Proves the Location Tracker (docs/vistalyze_integration/location.md, migration 0083) against
// fakes — no server, no network, no LLM. The suite exercises:
//   - splitLocationName (pure): the first-" - " parent split, standalone, and edge cases;
//   - renderLocationBlock (pure): the known-locations <locations> block — token expansion,
//     built-in default vs override, the omission rules (empty parents / no sub-section);
//   - parseSetLocationSettingsBody (admin): patch shape validation + boolean→string mapping;
//   - buildRepairPrompt's {{known_locations}} token (location.md §5.5): resolved to the block,
//     never leaked verbatim when unset;
//   - loadLocationBlock's contract (location.md §5.2): the injection_enabled gate, eligibility
//     filtering (§2.6), the current-parent sub grouping, and the fail-open '' on error.

import { randomUUID } from 'node:crypto';
import { createPostgresClient } from '../dist/io/postgres.js';
import { splitLocationName, loadLocationBlock } from '../dist/orchestrator/locationAndPresenceScraper.js';
import { renderLocationBlock, DEFAULT_LOCATION_BLOCK_TEMPLATE } from '../dist/util/renderLocationBlock.js';
import { parseSetLocationSettingsBody } from '../dist/server/adminServer.js';
import { buildRepairPrompt, DEFAULT_CLEANUP_CONFIG } from '../dist/orchestrator/cleanupHeuristics.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// --- splitLocationName (location.md §3.1) --------------------------------------------------------
{
  const r = splitLocationName('The Tavern - Kitchen');
  assert(r.parent === 'The Tavern' && r.sub === 'The Tavern - Kitchen', 'a room splits on the first " - ": parent "The Tavern", sub keeps the FULL string');
  const r2 = splitLocationName('The Tavern - Kitchen - Cellar');
  assert(r2.parent === 'The Tavern' && r2.sub === 'The Tavern - Kitchen - Cellar', 'only the FIRST " - " is the parent boundary');
  const r3 = splitLocationName('The Smoking Pipe');
  assert(r3.parent === 'The Smoking Pipe' && r3.sub === null, 'a standalone location is its own parent (no split)');
  const r4 = splitLocationName(' - Kitchen');
  assert(r4.parent === ' - Kitchen' && r4.sub === null, 'a leading separator is not a split');
  const r5 = splitLocationName('  ');
  assert(r5.parent === '  ' && r5.sub === null, 'whitespace-only name is not a split');
  const r6 = splitLocationName('A - B - ');
  assert(r6.parent === 'A' && r6.sub === 'A - B - ', 'trailing junk after the last separator keeps the sub full-string');
}

// --- renderLocationBlock (location.md §5.1) ------------------------------------------------------
{
  const lists = { parents: ['The Tavern', 'Harbor'], subs: ['The Tavern - Kitchen'], currentParent: 'The Tavern' };
  const out = renderLocationBlock(undefined, lists);
  assert(out.startsWith('<locations>') && out.endsWith('</locations>'), 'the default block is wrapped in <locations>…</locations>');
  assert(out.includes('The Tavern\nHarbor'), 'parent/standalone locations are newline-joined into the default template');
  assert(out.includes('The Tavern - Kitchen'), 'the current parent\'s sub-locations are listed');
  assert(out.includes('match against known locations exactly'), 'the rules text (Triggeryze\'s adapted) is present in the default');
  assert(out.includes('The Tavern sub-locations:'), 'the sub-section header carries the current parent name');

  const out2 = renderLocationBlock(undefined, { parents: ['The Tavern'], subs: [], currentParent: null });
  assert(!out2.includes('sub-locations'), 'with no current parent, the sub-section lines are omitted entirely, not left dangling');
  assert(out2.includes('The Tavern'), 'the parents list survives the omission rule');

  assert(renderLocationBlock(undefined, { parents: [], subs: [], currentParent: null }) === '', 'an empty parents list renders no block (caller must not emit one)');

  const custom = renderLocationBlock('Places:\n{{parent_locations}}\nRooms:\n{{sub_locations}}', { parents: ['A'], subs: ['A - 1'], currentParent: 'A' });
  assert(custom === 'Places:\nA\nRooms:\nA - 1', 'an override template expands the three tokens and passes everything else verbatim');

  const passthrough = renderLocationBlock('Keep {{unknown_token}} as-is\n{{parent_locations}}', { parents: ['A'], subs: [], currentParent: null });
  assert(passthrough.includes('Keep {{unknown_token}} as-is') && passthrough.includes('A'), 'unknown tokens in an override pass through verbatim (author\'s responsibility, §18)');
  assert(DEFAULT_LOCATION_BLOCK_TEMPLATE.includes('{{parent_locations}}') && DEFAULT_LOCATION_BLOCK_TEMPLATE.includes('{{sub_locations}}'), 'the built-in template itself carries the two list tokens');
}

// --- parseSetLocationSettingsBody (location.md §6.3) ---------------------------------------------
{
  const ok = parseSetLocationSettingsBody({ split_enabled: true, injection_prompt: 'x', describer_history_pairs: '3' });
  assert(ok && ok.split_enabled === 'true' && ok.injection_prompt === 'x' && ok.describer_history_pairs === '3', 'a valid patch maps booleans to strings and passes strings through');
  assert(parseSetLocationSettingsBody({ split_enabled: false }).split_enabled === 'false', 'false maps to the "false" string (the scraper\'s on-unless-false check)');
  assert(parseSetLocationSettingsBody({}) === undefined, 'an empty body is rejected (nothing to patch)');
  assert(parseSetLocationSettingsBody({ split_enabled: 'yes' }) === undefined, 'a non-boolean toggle is rejected');
  assert(parseSetLocationSettingsBody({ injection_prompt: 42 }) === undefined, 'a non-string prompt is rejected');
  assert(parseSetLocationSettingsBody(null) === undefined, 'a null body is rejected');
}

// --- buildRepairPrompt {{known_locations}} (location.md §5.5) ------------------------------------
{
  const block = '<locations>\nKnown locations:\nThe Tavern\n</locations>';
  const withToken = buildRepairPrompt('Rewrite the header.\n{{known_locations}}\nReply:', { message: 'x', knownLocations: block });
  assert(withToken.includes(block) && !withToken.includes('{{known_locations}}'), 'the {{known_locations}} token resolves to the block, never leaking verbatim');
  const without = buildRepairPrompt('Rewrite.\n{{known_locations}}', { message: 'x' });
  assert(without === 'Rewrite.\n', 'unset knownLocations resolves to empty — a caller with no block (turn 1, disabled) still gets a clean prompt');
  assert(DEFAULT_CLEANUP_CONFIG.headerPrompt.includes('{{known_locations}}'), 'the default cleanup header prompt carries the token (canonical-name hint for the header-writer)');
}

// --- loadLocationBlock (location.md §5.2) ---------------------------------------------------------
// Fake pool covering exactly the four query shapes loadLocationBlock issues, with the §2.6
// eligibility subquery honored via the chat's active swipe ids (mirrors
// verify-location-presence-scraper.mjs's fake).
function createBlockPool() {
  const locations = []; // { location_id, user_id, name, parent_location_id, status, anchor_chat_id, anchor_swipe_id }
  const scenes = []; // { scene_id, user_id, chat_id, active_location_id }
  const chatSessions = new Map(); // chat_id -> scene_id
  const chatMessages = []; // { chat_id, active_swipe_id }
  return {
    locations,
    scenes,
    chatSessions,
    chatMessages,
    async connect() {
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) return { rows: [] };
          if (sql.includes('join scenes s on s.scene_id')) {
            const [userId, chatId] = params;
            const scene = scenes.find((sc) => sc.chat_id === chatId);
            if (!scene) return { rows: [] };
            const loc = locations.find((l) => l.location_id === scene.active_location_id && l.user_id === userId);
            return { rows: loc ? [{ location_id: loc.location_id, name: loc.name }] : [] };
          }
          if (sql.includes('parent_location_id = $2 or name like')) {
            const [userId, parentRowId, chatId, prefix] = params;
            const activeSwipeIds = new Set(chatMessages.filter((m) => m.chat_id === chatId && m.active_swipe_id).map((m) => m.active_swipe_id));
            const rows = locations
              .filter(
                (l) =>
                  l.user_id === userId &&
                  (l.parent_location_id === parentRowId || (prefix && l.name.startsWith(prefix.slice(0, -2)))) &&
                  (l.status === 'permanent' || (l.status === 'transient' && activeSwipeIds.has(l.anchor_swipe_id))),
              )
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((l) => ({ name: l.name }));
            return { rows };
          }
          if (sql.includes('parent_location_id is null')) {
            const [userId, chatId] = params;
            const activeSwipeIds = new Set(chatMessages.filter((m) => m.chat_id === chatId && m.active_swipe_id).map((m) => m.active_swipe_id));
            const rows = locations
              .filter(
                (l) =>
                  l.user_id === userId &&
                  l.parent_location_id === null &&
                  (l.status === 'permanent' || (l.status === 'transient' && activeSwipeIds.has(l.anchor_swipe_id))),
              )
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((l) => ({ name: l.name }));
            return { rows };
          }
          if (sql.includes('select location_id from locations where user_id = $1 and name = $2 limit 1')) {
            const [userId, name] = params;
            const row = locations.find((l) => l.user_id === userId && l.name === name);
            return { rows: row ? [{ location_id: row.location_id }] : [] };
          }
          throw new Error(`verify-location-tracker: unexpected query: ${sql.slice(0, 80)}`);
        },
        release() {},
      };
    },
  };
}

function seed(pool, { locations, scenes, chatSessions, chatMessages }) {
  for (const l of locations) {
    pool.locations.push({
      location_id: randomUUID(),
      user_id: USER,
      status: 'transient',
      anchor_chat_id: CHAT,
      parent_location_id: null,
      anchor_swipe_id: SWIPE_ACTIVE,
      ...l,
    });
  }
  for (const sc of scenes) pool.scenes.push({ scene_id: randomUUID(), user_id: USER, chat_id: CHAT, active_location_id: null, ...sc });
  for (const [chatId, sceneId] of Object.entries(chatSessions)) pool.chatSessions.set(chatId, sceneId);
  for (const m of chatMessages) pool.chatMessages.push({ chat_id: CHAT, ...m });
}

const USER = 'u-tracker';
const CHAT = 'c-tracker';
const SWIPE_ACTIVE = 'swipe-active';
const SWIPE_STALE = 'swipe-stale';

function settingsStore(overrides = {}) {
  const values = { location_injection_enabled: 'true', location_injection_prompt: '', ...overrides };
  return { get: async (k) => values[k] ?? '' };
}

{
  // Happy path: current scene is "The Tavern - Kitchen" → parent "The Tavern"; its sibling room
  // "The Tavern - Cellar" and the unrelated place "Harbor" are all eligible (same active swipe).
  // Kitchen/Cellar are wired as subs of the tavern row (what the scraper's parent_location_id
  // linking produces); Harbor is a standalone place (parent_location_id null).
  const pool = createBlockPool();
  seed(pool, {
    locations: [{ name: 'The Tavern' }, { name: 'The Tavern - Kitchen' }, { name: 'The Tavern - Cellar' }, { name: 'Harbor' }],
    scenes: [{ active_location_id: null }],
    chatSessions: { [CHAT]: null },
    chatMessages: [{ active_swipe_id: SWIPE_ACTIVE }],
  });
  const tavernRow = pool.locations.find((l) => l.name === 'The Tavern');
  const kitchenRow = pool.locations.find((l) => l.name === 'The Tavern - Kitchen');
  pool.locations.find((l) => l.name === 'The Tavern - Cellar').parent_location_id = tavernRow.location_id;
  kitchenRow.parent_location_id = tavernRow.location_id;
  const sceneId = randomUUID();
  pool.scenes[0].scene_id = sceneId;
  pool.scenes[0].active_location_id = kitchenRow.location_id;
  pool.chatSessions.set(CHAT, sceneId);

  const db = createPostgresClient(pool);
  const { block, currentParent } = await loadLocationBlock({ db, settings: settingsStore() }, USER, CHAT);

  assert(currentParent === 'The Tavern', 'the current parent is derived by splitting the scene\'s active location name');
  assert(block.includes('Harbor\n\nThe Tavern') || (block.includes('Harbor') && block.includes('The Tavern') && block.indexOf('Harbor') < block.indexOf('The Tavern')), 'all eligible parent/standalone locations are listed, sorted (alphabetical: Harbor before The Tavern)');
  assert(block.includes('The Tavern - Kitchen\n\nThe Tavern - Cellar') || (block.includes('The Tavern - Kitchen') && block.includes('The Tavern - Cellar')), 'the current parent\'s sub-locations are listed (including the active one)');
  assert(block.includes('The Tavern sub-locations:'), 'the sub-section header is anchored to the current parent');
  assert(!block.includes('The Tavern - Kitchen\nHarbor'), 'subs and parents are not interleaved');
}

{
  // Injection gate: location_injection_enabled off → no block, no queries that would throw.
  const pool = createBlockPool();
  const db = createPostgresClient(pool);
  const { block, currentParent } = await loadLocationBlock({ db, settings: settingsStore({ location_injection_enabled: 'false' }) }, USER, CHAT);
  assert(block === '' && currentParent === null, 'injection disabled → the marker slot value is empty (the slot itself stays in the stack)');
}

{
  // Eligibility (§2.6): the stale-timeline row (anchor on a swipe outside this chat's active
  // path) must not appear in either list; the inactive parent must not appear either.
  const pool = createBlockPool();
  const tavern = { name: 'The Tavern' };
  const staleKitchen = { name: 'The Tavern - Kitchen', anchor_swipe_id: SWIPE_STALE, status: 'transient' };
  seed(pool, {
    locations: [tavern, staleKitchen],
    scenes: [],
    chatSessions: {},
    chatMessages: [{ active_swipe_id: SWIPE_ACTIVE }],
  });
  const db = createPostgresClient(pool);
  const { block } = await loadLocationBlock({ db, settings: settingsStore() }, USER, CHAT);
  assert(block.includes('The Tavern'), 'the eligible parent is listed');
  assert(!block.includes('Kitchen'), 'a transient row anchored to a different timeline\'s swipe is excluded (never resurrected into the block)');
}

{
  // Current-parent fallback: the scene's active location is "The Tavern - Kitchen" but the parent
  // row "The Tavern" is missing entirely — the derived parent must still be listed (it anchors
  // the block), and the room must appear via the name-prefix fallback.
  const pool = createBlockPool();
  const kitchen = { name: 'The Tavern - Kitchen' };
  seed(pool, {
    locations: [kitchen],
    scenes: [],
    chatSessions: {},
    chatMessages: [{ active_swipe_id: SWIPE_ACTIVE }],
  });
  const kitchenRow = pool.locations.find((l) => l.name === 'The Tavern - Kitchen');
  const sceneId = randomUUID();
  pool.scenes.push({ scene_id: sceneId, user_id: USER, chat_id: CHAT, active_location_id: kitchenRow.location_id });
  pool.chatSessions.set(CHAT, sceneId);
  const db = createPostgresClient(pool);
  const { block, currentParent } = await loadLocationBlock({ db, settings: settingsStore() }, USER, CHAT);
  assert(currentParent === 'The Tavern', 'the derived parent exists even with no parent row');
  assert(block.includes('The Tavern'), 'the derived (missing-row) parent is still listed — the block never dangles without its anchor');
}

{
  // Fail-open (§1.3): a DB error (or a missing scene) returns '' — the turn is never blocked
  // over context. Missing scene: no rows anywhere.
  const pool = createBlockPool();
  seed(pool, { locations: [], scenes: [], chatSessions: {}, chatMessages: [] });
  const db = createPostgresClient(pool);
  const { block } = await loadLocationBlock({ db, settings: settingsStore() }, USER, CHAT);
  assert(block === '', 'no scene/locations → empty block, no throw');

  // And a genuinely throwing pool is swallowed the same way.
  const throwing = { async connect() { throw new Error('boom'); } };
  const db2 = createPostgresClient(throwing);
  const r = await loadLocationBlock({ db: db2, settings: settingsStore() }, USER, CHAT);
  assert(r.block === '' && r.currentParent === null, 'a throwing DB is swallowed (fail-open) — no block, no crash');
}
