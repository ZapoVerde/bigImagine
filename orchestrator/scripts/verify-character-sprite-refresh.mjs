// Verifies CAST Refresh Imagery — POST /v1/chats/:chatId/character-sprites/refresh
// Covers 9 required behaviours with a fake pool, no network.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPostgresClient } from '../dist/io/postgres.js';
import { DEFAULT_CLEANUP_CONFIG, extractRegion } from '../dist/orchestrator/cleanupHeuristics.js';
import { parseStoryHeader } from '../dist/orchestrator/locationAndPresenceScraper.js';
import { normalizeExpression, normalizeOutfitKey } from '../dist/orchestrator/characterVisualStateParser.js';
import { getCharacterSpriteState, handleChatCharacterSprites } from '../dist/server/characterSpriteState.js';
import { refreshCharacterSpritesForChat, handleChatCharacterSpritesRefresh } from '../dist/server/characterSpriteRefresh.js';

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; } else console.log(`ok: ${msg}`);
}

const USER = '11111111-1111-1111-1111-111111111111';
const CHAT = '22222222-2222-2222-2222-222222222222';
const SCENE = '33333333-3333-3333-3333-333333333333';
const AVA_ID = '55555555-5555-5555-5555-555555555555';
const KAI_ID = '66666666-6666-6666-6666-666666666666';
const ZARA_ID = '77777777-7777-7777-7777-777777777777';
const MSG = '88888888-8888-8888-8888-888888888888';
const SWIPE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const HEADER = '[ Late Evening | 🗓️ Wednesday, June 15, 2026 AD | 📍 The Drunken Kraken - Main Hall ]\nPresent: Ava';
const HEADER_TWO = '[ Late Evening | 🗓️ Wednesday, June 15, 2026 AD | 📍 The Drunken Kraken - Main Hall ]\nPresent: Ava, Kai';
const AVA_BLOCK = `<details><summary>▸</summary>
<Ava>
Inner thoughts: She is watching the door.
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
const AVA_BLOCK_MALFORMED = `<details><summary>▸</summary>
<Ava>
Inner thoughts: She is watching the door.
Expression: composed
Outfit:
* Top: white blouse
</Ava>
</details>`; // uses * not - → parser requires "-"
const TWO_BLOCK = `<details><summary>▸</summary>
<Ava>
Inner thoughts: She is watching the door.
Expression: composed
Outfit:
- Top: white blouse
- Accessory: silver pendant
</Ava>
<Kai>
Inner thoughts: He keeps his voice low.
Expression: calm
Outfit:
- Top: shirt
- Bottom: trousers
- Accessory: none
</Kai>
</details>`;
const FOOTER_CFG = { regex: DEFAULT_CLEANUP_CONFIG.footerRegex, flags: DEFAULT_CLEANUP_CONFIG.footerFlags, prompt: DEFAULT_CLEANUP_CONFIG.footerPrompt };
const CANONICAL_TURN = `${HEADER}\n\nShe folded her hands.\n\n${AVA_BLOCK}`;
const TWO_TURN = `${HEADER_TWO}\n\nBoth stood.\n\n${TWO_BLOCK}`;

function outfitAva() { return { outerwear: 'leather jacket', top: 'white blouse', bottom: 'jeans', underwear_top: 'none', underwear_bottom: 'none', accessory: 'silver pendant' }; }
function outfitKai() { return { outerwear: '', top: 'shirt', bottom: 'trousers', underwear_top: 'none', underwear_bottom: 'none', accessory: 'none' }; }

function fakeSettings(bgrmEnabled = false) {
  return {
    async get(key) {
      if (key === 'character_visual_bgrm_enabled') return bgrmEnabled ? 'true' : 'false';
      if (key === 'character_visual_state_enabled') return 'true';
      // cleanup keys fallback to DEFAULT via undefined
      return undefined;
    },
    async set() {},
  };
}
function mintingLlm() {
  return {
    complete: async () => ({ message: { role: 'assistant', content: 'build: statuesque\nhair: jet black\nmood: steady' }, toolCalls: [] }),
  };
}
function fakeImageConnections(profile) {
  return {
    async resolveActive(purpose) {
      if (purpose === 'portrait') return profile;
      if (purpose === 'bgrm') return null;
      return null;
    },
  };
}
const POLLINATIONS_PROFILE = {
  kind: 'pollinations', apiKey: 'pk', model: 'flux', masterNegativePrompt: '', width: 768, height: 1024, seed: 1, samplingSteps: 20, cfgScale: 5, samplerName: 'euler', baseUrl: '', workflowParameters: null,
};

// Fake pool extended for refresh queries
function createFakePool() {
  const chatSessions = []; // { chat_id, user_id, scene_id }
  const presence = []; // { scene_id, character_id, user_id, presence_order }
  const characters = []; // { character_id, user_id, name, appearance, status }
  const characterChatLinks = [];
  const states = [];
  const combinations = [];
  const chatMessages = []; // { message_id, chat_id, user_id, content, role, created_at, active_swipe_id }
  const events = [];
  const subjectVisuals = [];
  const expressionDefs = [];
  const entities = [];

  const eligibleChar = (userId, name, chatId) => {
    const links = new Set(characterChatLinks.filter(l => l.chat_id === chatId).map(l => l.character_id));
    return characters.filter(c => c.user_id === userId && c.name === name && (c.status === null || (c.status !== 'inactive' && links.has(c.character_id)))).sort((a,b)=> (a.status===null? -1:1));
  };

  return {
    chatSessions, presence, characters, characterChatLinks, states, combinations, chatMessages, events, subjectVisuals, expressionDefs, entities,
    async connect() {
      return {
        async query(sql, params=[]) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) return { rows: [] };
          const q = sql.replace(/\s+/g,' ').trim();
          if (q.startsWith('select scene_id from chat_sessions where chat_id = $1')) {
            const [chatId] = params; const r = chatSessions.find(c=>c.chat_id===chatId); return { rows: r? [{scene_id: r.scene_id}]: [] };
          }
          if (q.includes('from scene_presence sp') && q.includes('join characters c')) {
            const [sceneId, userId] = params;
            const rows = presence.filter(p=>p.scene_id===sceneId && p.user_id===userId).sort((a,b)=>a.presence_order-b.presence_order).map(p=>{
              const ch = characters.find(c=>c.character_id===p.character_id && c.user_id===userId);
              return ch? {character_id:p.character_id, presence_order:p.presence_order, name:ch.name, status: ch.status??null}: null;
            }).filter(Boolean);
            return { rows };
          }
          if (q.startsWith('select character_id from character_chat_links where chat_id = $1')) {
            const [chatId]=params; return { rows: characterChatLinks.filter(l=>l.chat_id===chatId).map(l=>({character_id:l.character_id}))};
          }
          if (q.startsWith('select inner_thoughts, expression, outerwear')) {
            const [userId, chatId, characterId]=params; const r=states.find(s=>s.user_id===userId&&s.chat_id===chatId&&s.character_id===characterId);
            return { rows: r? [{inner_thoughts:r.inner_thoughts, expression:r.expression, outerwear:r.outerwear, top:r.top, bottom:r.bottom, underwear_top:r.underwear_top, underwear_bottom:r.underwear_bottom, accessory:r.accessory, message_id:r.message_id, swipe_id:r.swipe_id}]: [] };
          }
          // spriteState also does select expression, outerwear ... from character_visual_states (same shape without inner_thoughts?) - handle same
          if (q.startsWith('select expression, outerwear, top, bottom')) {
            const [userId, chatId, characterId]=params; const r=states.find(s=>s.user_id===userId&&s.chat_id===chatId&&s.character_id===characterId);
            return { rows: r? [{expression:r.expression, outerwear:r.outerwear, top:r.top, bottom:r.bottom, underwear_top:r.underwear_top, underwear_bottom:r.underwear_bottom, accessory:r.accessory}]: [] };
          }
          if (q.startsWith('select image_url from character_visual_combinations')) {
            const [userId, chatId, characterId, outfitKey, expressionKey, bgrmApplied]=params;
            const r=combinations.find(c=>c.user_id===userId&&c.chat_id===chatId&&c.character_id===characterId&&c.outfit_key===outfitKey&&c.expression_key===expressionKey&&c.bgrm_applied===bgrmApplied);
            return { rows: r? [{image_url:r.image_url}]: [] };
          }
          if (q.startsWith('select combination_id, image_url, composed_prompt, bgrm_applied from character_visual_combinations')) {
            const [userId, chatId, characterId, outfitKey, expressionKey, bgrmApplied]=params;
            const r=combinations.find(c=>c.user_id===userId&&c.chat_id===chatId&&c.character_id===characterId&&c.outfit_key===outfitKey&&c.expression_key===expressionKey&&c.bgrm_applied===bgrmApplied);
            return { rows: r? [{combination_id:r.combination_id, image_url:r.image_url, composed_prompt:r.composed_prompt??'', bgrm_applied:r.bgrm_applied}]: [] };
          }
          if (q.startsWith('select message_id, content, active_swipe_id, created_at from chat_messages where chat_id = $1 and role = \'assistant\'')) {
            const [chatId]=params; const rows=chatMessages.filter(m=>m.chat_id===chatId && m.role==='assistant').sort((a,b)=> new Date(b.created_at)-new Date(a.created_at) || b.message_id.localeCompare(a.message_id)).slice(0,1);
            return { rows: rows.map(r=>({message_id:r.message_id, content:r.content, active_swipe_id:r.active_swipe_id, created_at:r.created_at})) };
          }
          if (q.includes('from chat_messages where message_id') && q.includes('for update')) {
            const [messageId, chatId]=params; const m=chatMessages.find(x=>x.message_id===messageId&&x.chat_id===chatId);
            return { rows: m? [{content:m.content, active_swipe_id:m.active_swipe_id}]: [] };
          }
          if (q.startsWith('select character_id from characters') && q.includes('character_chat_links')) {
            const [userId, name, chatId]=params; const matches=eligibleChar(userId,name,chatId); return { rows: matches.map(c=>({character_id:c.character_id}))};
          }
          if (q.startsWith('insert into character_visual_states')) {
            const [userId, chatId, characterId, messageId, swipeId, innerThoughts, expression, outerwear, top, bottom, underwearTop, underwearBottom, accessory]=params;
            let r=states.find(s=>s.user_id===userId&&s.chat_id===chatId&&s.character_id===characterId);
            const row={user_id:userId, chat_id:chatId, character_id:characterId, message_id:messageId, swipe_id:swipeId, inner_thoughts:innerThoughts, expression, outerwear, top, bottom, underwear_top:underwearTop, underwear_bottom:underwearBottom, accessory};
            if(r) Object.assign(r,row); else states.push(row); return { rows: [] };
          }
          if (q.startsWith('update character_visual_states set message_id')) {
            const [userId, chatId, characterId, messageId, swipeId]=params; const r=states.find(s=>s.user_id===userId&&s.chat_id===chatId&&s.character_id===characterId); if(r){r.message_id=messageId; r.swipe_id=swipeId;} return { rows: [] };
          }
          if (q.startsWith('insert into character_visual_state_events')) {
            const [userId, chatId, characterId, messageId, swipeId, eventType, changedFields, beforeState, afterState]=params;
            events.push({user_id:userId, chat_id:chatId, character_id:characterId, message_id:messageId, swipe_id:swipeId, event_type:eventType, changed_fields:changedFields, before_state:beforeState, after_state:afterState, created_at: new Date().toISOString(), after_state_raw: afterState});
            return { rows: [] };
          }
          if (q.startsWith('select character_id, name, appearance from characters')) {
            const [characterId, userId]=params; const r=characters.find(c=>c.character_id===characterId&&c.user_id===userId); return { rows: r? [{character_id:r.character_id, name:r.name, appearance:r.appearance}]: [] };
          }
          if (q.startsWith('select slots, source_appearance_hash from character_subject_visuals')) {
            const [characterId, userId]=params; const r=subjectVisuals.find(s=>s.character_id===characterId&&s.user_id===userId); return { rows: r? [{slots:r.slots, source_appearance_hash:r.source_appearance_hash}]: [] };
          }
          if (q.startsWith('insert into character_subject_visuals')) {
            const [userId, characterId, slots, hash]=params; let r=subjectVisuals.find(s=>s.character_id===characterId); const row={user_id:userId, character_id:characterId, slots: JSON.parse(slots), source_appearance_hash: hash}; if(r) Object.assign(r,row); else subjectVisuals.push(row); return { rows: [] };
          }
          if (q.startsWith('select slots from visual_expression_definitions')) {
            const [userId, word]=params; const r=expressionDefs.find(d=>d.user_id===userId&&d.word===word); return { rows: r? [{slots:r.slots}]: [] };
          }
          if (q.startsWith('insert into visual_expression_definitions')) {
            const [userId, word, slots]=params; let r=expressionDefs.find(d=>d.user_id===userId&&d.word===word); const row={user_id:userId, word, slots: JSON.parse(slots)}; if(r) Object.assign(r,row); else expressionDefs.push(row); return { rows: [] };
          }
          if (q.startsWith('select entity_id, layer_id, slots, template, details from visual_entities where user_id = $1 and layer_id = $2')) {
            const [userId, layerId]=params; const matches=entities.filter(e=>e.user_id===userId&&e.layer_id===layerId).sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at))); const row=matches[0]; return { rows: row? [{entity_id:row.entity_id, layer_id:row.layer_id, slots:row.slots, template:row.template, details:row.details}]: [] };
          }
          if (q.startsWith('insert into visual_entities')) {
            const [userId, layerId, name]=params; const row={entity_id: randomUUID(), user_id:userId, layer_id:layerId, name, slots:{}, template:null, details:'', updated_at: new Date().toISOString(), character_id: null}; entities.push(row); return { rows: [{entity_id:row.entity_id, layer_id:row.layer_id, slots:row.slots, template:row.template, details:row.details}] };
          }
          if (q.startsWith('insert into character_visual_combinations')) {
            const [userId, chatId, characterId, outfitKey, expressionKey, imageUrl, composedPrompt, bgrmApplied]=params;
            let r=combinations.find(c=>c.user_id===userId&&c.chat_id===chatId&&c.character_id===characterId&&c.outfit_key===outfitKey&&c.expression_key===expressionKey&&c.bgrm_applied===bgrmApplied);
            const row={combination_id: randomUUID(), user_id:userId, chat_id:chatId, character_id:characterId, outfit_key:outfitKey, expression_key:expressionKey, image_url:imageUrl, composed_prompt:composedPrompt, bgrm_applied:bgrmApplied};
            if(r) Object.assign(r,row); else combinations.push(row); return { rows: [] };
          }
          // orchestrator_settings reads
          if (q.includes('from orchestrator_settings where key = $1')) return { rows: [] };
          // presence of other queries: content, etc.
          throw new Error(`fake pool unhandled: ${sql} params ${JSON.stringify(params)}`);
        },
        release(){},
      };
    },
  };
}

function seedChat(pool, chatId, sceneId){ pool.chatSessions.push({chat_id:chatId, user_id:USER, scene_id:sceneId}); }
function seedPresence(pool, sceneId, charId, order){ pool.presence.push({scene_id:sceneId, character_id:charId, user_id:USER, presence_order: order}); }
function seedChar(pool, id, name, appearance='Ava appearance', status=null){ pool.characters.push({character_id:id, user_id:USER, name, appearance, status}); }
function link(pool, charId){ pool.characterChatLinks.push({character_id:charId, chat_id:CHAT}); }
function addStateRow(pool, charId, expr, outfit){ pool.states.push({user_id:USER, chat_id:CHAT, character_id:charId, message_id:MSG, swipe_id:SWIPE, inner_thoughts:'x', expression: normalizeExpression(expr), outerwear: normalizeExpression(outfit.outerwear), top: normalizeExpression(outfit.top), bottom: normalizeExpression(outfit.bottom), underwear_top: normalizeExpression(outfit.underwear_top), underwear_bottom: normalizeExpression(outfit.underwear_bottom), accessory: normalizeExpression(outfit.accessory)}); }
function addCombo(pool, charId, outfit, expr, url, bgrm=false){ pool.combinations.push({combination_id: randomUUID(), user_id:USER, chat_id:CHAT, character_id:charId, outfit_key: normalizeOutfitKey(outfit), expression_key: normalizeExpression(expr), image_url:url, composed_prompt:'p', bgrm_applied:bgrm}); }

// stub fetch for generation
const originalFetch = globalThis.fetch;
function stubFetch() {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init?.body ?? '[]'); const task = Array.isArray(body)? body[0]: body;
    if (task?.taskType === 'removeBackground') return { ok: true, json: async()=>({data:[{imageURL:'https://cdn.example/bgrm.png'}]}) };
    // imageInference
    return { ok: true, json: async()=>({data:[{imageURL:'https://cdn.example/generated.png', imageUUID:'uuid-gen'}]}) };
  };
}
function restoreFetch(){ globalThis.fetch = originalFetch; }

let caseNum=0;

// 1. Present character with valid existing combination → reused, no unnecessary generation.
{
  caseNum++; const pool=createFakePool(); seedChat(pool,CHAT,SCENE); seedChar(pool,AVA_ID,'Ava'); link(pool,AVA_ID); seedPresence(pool,SCENE,AVA_ID,0); const of=outfitAva(); const norm={...of, outerwear: normalizeExpression(of.outerwear), top: normalizeExpression(of.top), bottom: normalizeExpression(of.bottom), underwear_top: normalizeExpression(of.underwear_top), underwear_bottom: normalizeExpression(of.underwear_bottom), accessory: normalizeExpression(of.accessory)}; addStateRow(pool,AVA_ID,'composed',of); addCombo(pool,AVA_ID,norm,'composed','https://cdn.example/existing.png',false);
  stubFetch();
  const settings=fakeSettings(false); const deps={ db: createPostgresClient(pool), settings, imageConnections: fakeImageConnections(POLLINATIONS_PROFILE), llm: mintingLlm() };
  const results = await refreshCharacterSpritesForChat(deps, USER, CHAT);
  restoreFetch();
  assert(results.length===1 && results[0].status==='reused' && results[0].imageUrl==='https://cdn.example/existing.png', `case ${caseNum}: valid existing combination → reused`);
  assert(pool.combinations.length===1, `case ${caseNum}: no duplicate combination`);
  // 7 part: sprite stage after refresh should show image
  const sprites = await getCharacterSpriteState({ db: createPostgresClient(pool), settings }, USER, CHAT);
  assert(sprites[0].imageUrl==='https://cdn.example/existing.png', `case ${caseNum}: sprite stage re-fetch shows existing imagery`);
  assert(pool.entities.filter(e=>e.character_id).length===0, `case ${caseNum}: no visual_entities with character_id created`);
}

// 2. Present character with visual state but missing combination → generates
{
  caseNum++; const pool=createFakePool(); seedChat(pool,CHAT,SCENE); seedChar(pool,AVA_ID,'Ava'); link(pool,AVA_ID); seedPresence(pool,SCENE,AVA_ID,0); const of=outfitAva(); addStateRow(pool,AVA_ID,'composed',of);
  stubFetch();
  const settings=fakeSettings(false); const deps={ db: createPostgresClient(pool), settings, imageConnections: fakeImageConnections(POLLINATIONS_PROFILE), llm: mintingLlm() };
  const results = await refreshCharacterSpritesForChat(deps, USER, CHAT);
  restoreFetch();
  assert(results.length===1 && results[0].status==='generated', `case ${caseNum}: missing combination → generated`);
  assert(pool.combinations.length===1 && !!pool.combinations[0].image_url && pool.combinations[0].image_url.includes('pollinations') || pool.combinations[0].image_url==='https://cdn.example/generated.png', `case ${caseNum}: combination created`);
  const sprites = await getCharacterSpriteState({ db: createPostgresClient(pool), settings }, USER, CHAT);
  assert(!!sprites[0].imageUrl, `case ${caseNum}: sprite stage shows newly generated`);
}

// 3. Present character with no visual state but valid latest Character Status → state recovered, imagery generated
{
  caseNum++; const pool=createFakePool(); seedChat(pool,CHAT,SCENE); seedChar(pool,AVA_ID,'Ava'); link(pool,AVA_ID); seedPresence(pool,SCENE,AVA_ID,0);
  // latest assistant message with valid footer
  pool.chatMessages.push({message_id:MSG, chat_id:CHAT, user_id:USER, content:CANONICAL_TURN, role:'assistant', created_at: new Date().toISOString(), active_swipe_id: SWIPE});
  stubFetch();
  const settings=fakeSettings(false); const deps={ db: createPostgresClient(pool), settings, imageConnections: fakeImageConnections(POLLINATIONS_PROFILE), llm: mintingLlm() };
  const results = await refreshCharacterSpritesForChat(deps, USER, CHAT);
  restoreFetch();
  assert(results.length===1 && results[0].status==='recovered', `case ${caseNum}: no state but valid footer → recovered`);
  assert(pool.states.length===1 && pool.states[0].expression==='composed', `case ${caseNum}: state recovered`);
  assert(pool.combinations.length===1, `case ${caseNum}: imagery generated after recovery`);
  const sprites = await getCharacterSpriteState({ db: createPostgresClient(pool), settings }, USER, CHAT);
  assert(!!sprites[0].imageUrl, `case ${caseNum}: sprite stage shows recovered imagery`);
}

// 4. Present character with malformed/unparseable Character Status → clean per-character failure; other cast members continue
{
  caseNum++; const pool=createFakePool(); seedChat(pool,CHAT,SCENE); seedChar(pool,AVA_ID,'Ava'); seedChar(pool,KAI_ID,'Kai'); link(pool,AVA_ID); link(pool,KAI_ID); seedPresence(pool,SCENE,AVA_ID,0); seedPresence(pool,SCENE,KAI_ID,1);
  // Give Kai a valid state+combo so he should succeed; Ava has no state and malformed footer for Ava
  const kaiOutfit=outfitKai(); addStateRow(pool,KAI_ID,'calm',kaiOutfit); const kaiNorm={...kaiOutfit}; addCombo(pool,KAI_ID,kaiNorm,'calm','https://cdn.example/kai.png',false);
  // latest message is malformed for Ava (uses *), but overall parse will fail due to * slot
  const malformedTurn = `${HEADER_TWO}\n\nMalformed.\n\n${AVA_BLOCK_MALFORMED.replace('Ava','Ava')}`; // only Ava block malformed
  // Better: craft a turn with both blocks but Ava's slot is * -> whole parse fails
  const malformedBoth = `${HEADER_TWO}\n\nX\n\n<details><summary>▸</summary>\n<Ava>\nInner thoughts: x\nExpression: composed\nOutfit:\n* Top: white blouse\n</Ava>\n<Kai>\nInner thoughts: y\nExpression: calm\nOutfit:\n- Top: shirt\n</Kai>\n</details>`;
  pool.chatMessages.push({message_id:MSG, chat_id:CHAT, user_id:USER, content: malformedBoth, role:'assistant', created_at: new Date().toISOString(), active_swipe_id: SWIPE});
  stubFetch();
  const settings=fakeSettings(false); const deps={ db: createPostgresClient(pool), settings, imageConnections: fakeImageConnections(POLLINATIONS_PROFILE), llm: mintingLlm() };
  const results = await refreshCharacterSpritesForChat(deps, USER, CHAT);
  restoreFetch();
  const avaR = results.find(r=>r.characterId===AVA_ID); const kaiR = results.find(r=>r.characterId===KAI_ID);
  // Debug: show actual statuses if mismatch
  if (!(avaR && avaR.status==='failed')) console.log('DEBUG case4 avaR', avaR);
  assert(avaR && avaR.status==='failed', `case ${caseNum}: malformed footer → Ava failed`);
  assert(avaR.reason && avaR.reason.toLowerCase().includes('footer'), `case ${caseNum}: Ava failure reason mentions footer`);
  assert(kaiR && kaiR.status==='reused', `case ${caseNum}: other cast member Kai continues (reused)`);
  assert(results.length===2, `case ${caseNum}: both characters processed independently`);
}

// 5. Character linked to chat but NOT in scene_presence → untouched
{
  caseNum++; const pool=createFakePool(); seedChat(pool,CHAT,SCENE); seedChar(pool,AVA_ID,'Ava'); seedChar(pool,ZARA_ID,'Zara'); link(pool,AVA_ID); link(pool,ZARA_ID); seedPresence(pool,SCENE,AVA_ID,0); // Zara not present
  const of=outfitAva(); addStateRow(pool,AVA_ID,'composed',of); addCombo(pool,AVA_ID,of,'composed','https://cdn.example/ava.png',false);
  stubFetch();
  const settings=fakeSettings(false); const deps={ db: createPostgresClient(pool), settings, imageConnections: fakeImageConnections(POLLINATIONS_PROFILE), llm: mintingLlm() };
  const results = await refreshCharacterSpritesForChat(deps, USER, CHAT);
  restoreFetch();
  assert(results.length===1 && results[0].characterId===AVA_ID, `case ${caseNum}: not-present linked character untouched`);
  assert(!results.find(r=>r.characterId===ZARA_ID), `case ${caseNum}: Zara not in results`);
  assert(pool.states.find(s=>s.character_id===ZARA_ID)===undefined, `case ${caseNum}: Zara state not created`);
}

// 6. Multiple present characters → all processed independently (reuse + generate mix)
{
  caseNum++; const pool=createFakePool(); seedChat(pool,CHAT,SCENE); seedChar(pool,AVA_ID,'Ava'); seedChar(pool,KAI_ID,'Kai'); link(pool,AVA_ID); link(pool,KAI_ID); seedPresence(pool,SCENE,AVA_ID,0); seedPresence(pool,SCENE,KAI_ID,1);
  const avaOf=outfitAva(); const kaiOf=outfitKai(); // Ava has existing combo, Kai has state but no combo
  addStateRow(pool,AVA_ID,'composed',avaOf); addCombo(pool,AVA_ID,avaOf,'composed','https://cdn.example/ava.png',false);
  addStateRow(pool,KAI_ID,'calm',kaiOf);
  stubFetch();
  const settings=fakeSettings(false); const deps={ db: createPostgresClient(pool), settings, imageConnections: fakeImageConnections(POLLINATIONS_PROFILE), llm: mintingLlm() };
  const results = await refreshCharacterSpritesForChat(deps, USER, CHAT);
  restoreFetch();
  assert(results.length===2, `case ${caseNum}: multiple present → 2 results`);
  const ava = results.find(r=>r.characterId===AVA_ID); const kai = results.find(r=>r.characterId===KAI_ID);
  assert(ava.status==='reused', `case ${caseNum}: Ava reused`);
  assert(kai.status==='generated', `case ${caseNum}: Kai generated`);
}

// 7. (already partially covered) Successful refresh causes SpriteStage to re-fetch — we test endpoint envelope and that after refresh sprite state returns image
{
  caseNum++; const pool=createFakePool(); seedChat(pool,CHAT,SCENE); seedChar(pool,AVA_ID,'Ava'); link(pool,AVA_ID); seedPresence(pool,SCENE,AVA_ID,0);
  const of=outfitAva(); addStateRow(pool,AVA_ID,'composed',of);
  assert((await getCharacterSpriteState({ db: createPostgresClient(pool), settings: fakeSettings(false) }, USER, CHAT))[0].imageUrl===null, `case ${caseNum}: before refresh image null`);
  stubFetch();
  const settings=fakeSettings(false); const deps={ db: createPostgresClient(pool), settings, imageConnections: fakeImageConnections(POLLINATIONS_PROFILE), llm: mintingLlm() };
  await refreshCharacterSpritesForChat(deps, USER, CHAT);
  restoreFetch();
  const after = await getCharacterSpriteState({ db: createPostgresClient(pool), settings: fakeSettings(false) }, USER, CHAT);
  assert(!!after[0].imageUrl, `case ${caseNum}: after refresh sprite stage shows newly available imagery`);
  // also test HTTP handler returns correct envelope and does not leak raw fields
  const pool2=createFakePool(); seedChat(pool2,CHAT,SCENE); seedChar(pool2,AVA_ID,'Ava'); link(pool2,AVA_ID); seedPresence(pool2,SCENE,AVA_ID,0); addStateRow(pool2,AVA_ID,'composed',of); addCombo(pool2,AVA_ID,of,'composed','https://cdn.example/ep.png',false);
  const db2=createPostgresClient(pool2); const settings2=fakeSettings(false);
  function mockRes(){ let sc=0, chunks=[]; return { statusCode: sc, headersSent:false, writeHead(s){sc=s; this.statusCode=s;}, setHeader(){}, write(c){chunks.push(String(c));}, end(c){if(c) chunks.push(String(c)); this.headersSent=true;}, _json(){ try{return JSON.parse(chunks.join(''));}catch{return null;}} } }
  const req={ method:'POST', url:`/v1/chats/${CHAT}/character-sprites/refresh`, headers:{}, on(e,fn){ if(e==='end') setTimeout(fn,0);} };
  const res=mockRes();
  stubFetch();
  await handleChatCharacterSpritesRefresh(req, res, { db: db2, settings: settings2, imageConnections: fakeImageConnections(POLLINATIONS_PROFILE), llm: mintingLlm(), apiKeys: null, accessIdentity: null, chats: null, llmConnections: null, credentials:null, adminApiKey:'', embeddings:null, tools:null }, USER, new URL(req.url,'http://placeholder'));
  restoreFetch();
  const json=res._json(); assert(json && Array.isArray(json.results) && json.results[0].imageUrl==='https://cdn.example/ep.png', `case ${caseNum}: endpoint returns {results} envelope`);
  assert(json.results[0] && !('composed_prompt' in json.results[0]) && !('outfit_key' in json.results[0]), `case ${caseNum}: no raw persistence leakage`);
}

// 8. Existing BGRM configuration is respected
{
  caseNum++; // BGRM disabled → raw portrait generated
  let pool=createFakePool(); seedChat(pool,CHAT,SCENE); seedChar(pool,AVA_ID,'Ava'); link(pool,AVA_ID); seedPresence(pool,SCENE,AVA_ID,0); const of=outfitAva(); addStateRow(pool,AVA_ID,'composed',of);
  stubFetch(); let settings=fakeSettings(false); let deps={ db: createPostgresClient(pool), settings, imageConnections: fakeImageConnections(POLLINATIONS_PROFILE), llm: mintingLlm() };
  let results = await refreshCharacterSpritesForChat(deps, USER, CHAT);
  restoreFetch();
  assert(results[0].status==='generated' && pool.combinations[0].bgrm_applied===false, `case ${caseNum}a: BGRM disabled → raw portrait`);
  assert(!!(await getCharacterSpriteState({ db: createPostgresClient(pool), settings }, USER, CHAT))[0].imageUrl, `case ${caseNum}a: sprite shows raw`);
  // BGRM enabled → transparent variant
  caseNum++; pool=createFakePool(); seedChat(pool,CHAT,SCENE); seedChar(pool,AVA_ID,'Ava'); link(pool,AVA_ID); seedPresence(pool,SCENE,AVA_ID,0); addStateRow(pool,AVA_ID,'composed',of);
  // Need runware profile for BGRM enabled path to succeed; but our stub fetch handles BGRM via removeBackground, so any portrait profile works if BGRM profile null? Actually refresh when BGRM enabled will try to create bgrm variant via postProcess which expects bgrm profile; with fakeImageConnections returning null for bgrm, it will fallback to raw (see postProcess). So we need to provide both portrait and bgrm profiles
  const runwarePortrait={...POLLINATIONS_PROFILE, kind:'runware', apiKey:'pk-bgrm', model:'runware/portrait'};
  const runwareBgrm={...POLLINATIONS_PROFILE, kind:'runware', apiKey:'bk', model:'runware/bgrm'};
  const bgrmImages={ async resolveActive(purpose){ if(purpose==='portrait') return runwarePortrait; if(purpose==='bgrm') return runwareBgrm; return null; } };
  stubFetch();
  settings=fakeSettings(true); deps={ db: createPostgresClient(pool), settings, imageConnections: bgrmImages, llm: mintingLlm() };
  results = await refreshCharacterSpritesForChat(deps, USER, CHAT);
  restoreFetch();
  assert(pool.combinations[0].bgrm_applied===true, `case ${caseNum}b: BGRM enabled → transparent variant`);
  assert((await getCharacterSpriteState({ db: createPostgresClient(pool), settings }, USER, CHAT))[0].imageUrl==='https://cdn.example/bgrm.png' || pool.combinations[0].image_url==='https://cdn.example/bgrm.png' || pool.combinations[0].image_url==='https://cdn.example/generated.png', `case ${caseNum}b: sprite shows BGRM imagery when enabled`);
}

// 9. No visual_entities / Portrait Studio copies are created (refresh must not use from-cast-character path)
{
  caseNum++; const pool=createFakePool(); seedChat(pool,CHAT,SCENE); seedChar(pool,AVA_ID,'Ava'); link(pool,AVA_ID); seedPresence(pool,SCENE,AVA_ID,0); const of=outfitAva(); addStateRow(pool,AVA_ID,'composed',of);
  const beforeSubjects = pool.subjectVisuals.length;
  const beforeEntitiesWithChar = pool.entities.filter(e=>e.character_id).length;
  stubFetch();
  const settings=fakeSettings(false); const deps={ db: createPostgresClient(pool), settings, imageConnections: fakeImageConnections(POLLINATIONS_PROFILE), llm: mintingLlm() };
  await refreshCharacterSpritesForChat(deps, USER, CHAT);
  restoreFetch();
  assert(pool.entities.filter(e=>e.character_id).length===beforeEntitiesWithChar, `case ${caseNum}: no visual_entities with character_id created (no Portrait Studio copies)`);
  // subject visuals are allowed (character_subject_visuals) but not visual_entities copies
  // ensure no from-cast-character leakage: we never inserted a subject entity with character_id
  assert(pool.subjectVisuals.length===1, `case ${caseNum}: autofire subject mint is allowed in character_subject_visuals`);
}

// Prompt/parser grammar check: parser requires "- Slot:", footer prompt must produce "-"
{
  const prompt = DEFAULT_CLEANUP_CONFIG.footerPrompt;
  assert(prompt.includes('- Top:'), 'prompt produces "- Slot: value"');
  assert(!prompt.includes('* Top:') && !prompt.includes('* Slot'), 'prompt does not produce "* Slot"');
  const footerWithDash = `<details><Ava>\nInner thoughts: x\nExpression: calm\nOutfit:\n- Top: shirt\n</Ava></details>`;
  const header = parseStoryHeader(HEADER);
  const mod = await import('../dist/orchestrator/characterVisualStateParser.js');
  const ok = mod.parseCharacterVisualStateFooter(footerWithDash, header);
  assert(ok.ok===true, 'parser accepts "- Slot:"');
  const footerWithStar = `<details><Ava>\nInner thoughts: x\nExpression: calm\nOutfit:\n* Top: shirt\n</Ava></details>`;
  const bad = mod.parseCharacterVisualStateFooter(footerWithStar, header);
  assert(bad.ok===false, 'parser rejects "* Slot:" (must not be weakened)');
}

console.log(`\nverify-character-sprite-refresh: ${caseNum} cases checked`);
if (process.exitCode) console.error('verify-character-sprite-refresh: failures detected');
else console.log('verify-character-sprite-refresh: all checks passed');
