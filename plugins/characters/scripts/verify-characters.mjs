// Proves runtime-only Characters plugin (Task 4.1): no Card tools, list/detail/update/delete are chat-scoped runtime only.
import { createPostgresClient } from '@bigbrain/orchestrator/postgres';
import { createToolRegistry } from '@bigbrain/orchestrator/tool-registry';
import { info, registerTools } from '../dist/index.js';

function assert(cond, message) {
  if (!cond) { console.error(`FAIL: ${message}`); process.exitCode = 1; } else { console.log(`ok: ${message}`); }
}

function createFakePool() {
  const characters = [];
  const characterChatLinks = [];
  const chatSessions = [];
  const scenes = [];
  const scenesPresence = [];
  let counter = 0;
  const runSql = [];
  return {
    characters, characterChatLinks, chatSessions, scenes, scenesPresence, runSql,
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params=[]) {
          if (sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK') return {rows:[]};
          if (sql.includes('set_config')) { scopedUserId=params[0]; return {rows:[]}; }
          runSql.push(sql);
          if (sql.startsWith('select character_id, name, created_at from characters')) {
            const [userId, chatId] = params;
            const rows = characters.filter(c=>c.user_id===userId && c.status!==null && c.status!=='inactive' && characterChatLinks.some(l=>l.character_id===c.character_id && l.chat_id===chatId)).sort((a,b)=>a.name.localeCompare(b.name)).map(c=>({character_id:c.character_id, name:c.name, created_at:c.created_at}));
            return {rows};
          }
          if (sql.startsWith('select character_id, name, persona')) {
            const [characterId, userId, chatId] = params;
            const row = characters.find(c=>c.character_id===characterId && c.user_id===userId && c.status!==null && c.status!=='inactive' && characterChatLinks.some(l=>l.character_id===c.character_id && l.chat_id===chatId));
            if (!row) return {rows:[]};
            return {rows:[{character_id:row.character_id, name:row.name, persona:row.persona, appearance:row.appearance, scenario:row.scenario, system_prompt:row.system_prompt, example_dialogue:row.example_dialogue, greetings:row.greetings, spec_version:row.spec_version, has_avatar:false, has_source_json:false, created_at:row.created_at, updated_at:'2026-08-22T00:00:00Z'}]};
          }
          if (sql.startsWith('update characters set')) {
            const [characterId, userId, ...rest] = params;
            const row = characters.find(c=>c.character_id===characterId && c.user_id===userId && c.status!==null);
            if (!row) return {rows:[]};
            const fieldOrder=['name','persona','appearance','scenario','system_prompt','example_dialogue','greetings'];
            const patched=fieldOrder.filter(f=>sql.includes(`${f} = $`));
            patched.forEach((field,i)=>{ row[field]=field==='greetings'?JSON.parse(rest[i]):rest[i]; });
            return {rows:[{character_id:row.character_id, name:row.name}]};
          }
          if (sql.startsWith('delete from characters')) {
            const [characterId, userId]=params;
            const idx=characters.findIndex(c=>c.character_id===characterId && c.user_id===userId);
            if (idx===-1) return {rows:[]};
            const [removed]=characters.splice(idx,1);
            return {rows:[{character_id:removed.character_id}]};
          }
          if (sql.startsWith('delete from character_chat_links')) {
            const [characterId, chatId, userId]=params;
            const owned=characters.some(c=>c.character_id===characterId && c.user_id===userId);
            const idx=characterChatLinks.findIndex(l=>l.character_id===characterId && l.chat_id===chatId && owned);
            if (idx===-1) return {rows:[]};
            characterChatLinks.splice(idx,1);
            if (!characterChatLinks.some(l=>l.character_id===characterId)) {
              const ci=characters.findIndex(c=>c.character_id===characterId);
              if (ci!==-1) characters.splice(ci,1);
            }
            return {rows:[{character_id:characterId}]};
          }
          if (sql.startsWith('delete from scene_presence sp')) return {rows:[]};
          if (sql.startsWith('select count(*)::text as count from character_chat_links')) {
            const [characterId]=params;
            return {rows:[{count:String(characterChatLinks.filter(l=>l.character_id===characterId).length)}]};
          }
          throw new Error(`unexpected query: ${sql}`);
        }, release(){}
      };
    }
  };
}

assert(info.id==='characters','info.id is characters');
const tools = await registerTools({});
assert(tools.length===5,'registerTools returns exactly five runtime tools');
for (const name of ['get_characters','get_character','update_character','delete_character','remove_character_from_chat']) {
  assert(tools.some(d=>d.definition.name===name), `${name} is registered`);
}
for (const name of ['create_character','import_character_card','import_character_card_from_url','search_chub_characters','export_character_card','get_character_avatar','apply_character_to_chat']) {
  assert(!tools.some(d=>d.definition.name===name), `${name} is not registered (Card surface removed)`);
}

const pool = createFakePool();
const db = createPostgresClient(pool);
const userId='11111111-1111-1111-1111-111111111111';
const registry = createToolRegistry(tools);
const getTool=registry.get('get_characters');
const getOneTool=registry.get('get_character');
const updateTool=registry.get('update_character');
const deleteTool=registry.get('delete_character');
const removeTool=registry.get('remove_character_from_chat');

// Seed runtime characters
pool.characters.push(
  {character_id:'char-a', user_id:userId, name:'Aria', persona:'p', appearance:'tall', scenario:'', system_prompt:'', example_dialogue:'', greetings:[], spec_version:'v2', created_at:new Date('2026-08-22T00:00:00Z'), status:'transient'},
  {character_id:'char-b', user_id:userId, name:'Bram', persona:'p', appearance:'', scenario:'', system_prompt:'', example_dialogue:'', greetings:[], spec_version:'v2', created_at:new Date('2026-08-22T00:00:01Z'), status:'transient'},
  {character_id:'char-card', user_id:userId, name:'CardLegacy', persona:'p', appearance:'', scenario:'', system_prompt:'', example_dialogue:'', greetings:[], spec_version:'v2', created_at:new Date('2026-08-22T00:00:02Z'), status:null},
  {character_id:'char-inactive', user_id:userId, name:'Ghost', persona:'p', appearance:'', scenario:'', system_prompt:'', example_dialogue:'', greetings:[], spec_version:'v2', created_at:new Date('2026-08-22T00:00:03Z'), status:'inactive'}
);
pool.characterChatLinks.push({character_id:'char-a', chat_id:'chat-1', anchor_swipe_id:'sw1'});
pool.characterChatLinks.push({character_id:'char-b', chat_id:'chat-1', anchor_swipe_id:'sw2'});
pool.characterChatLinks.push({character_id:'char-inactive', chat_id:'chat-1', anchor_swipe_id:'sw3'});
pool.chatSessions.push({chat_id:'chat-1', user_id:userId, character_id:'char-a', params:{}});
pool.chatSessions.push({chat_id:'chat-2', user_id:userId, character_id:'char-b', params:{}});

const withoutChat = await db.withUserScope(userId, s=>getTool.handler({}, {userId, db:s}));
assert(withoutChat.length===0,'get_characters without chat context returns empty (runtime-only, no Card library)');

const inChat = await db.withUserScope(userId, s=>getTool.handler({}, {userId, db:s, chatId:'chat-1'}));
assert(inChat.length===2 && inChat.some(c=>c.characterId==='char-a') && inChat.some(c=>c.characterId==='char-b'),'get_characters with chat returns only linked runtime characters');
assert(!inChat.some(c=>c.characterId==='char-card'),'Card legacy row is not surfaced');
assert(!inChat.some(c=>c.characterId==='char-inactive'),'inactive is never surfaced');

const detail = await db.withUserScope(userId, s=>getOneTool.handler({characterId:'char-a'}, {userId, db:s, chatId:'chat-1'}));
assert(detail.found && detail.name==='Aria','get_character returns runtime detail with chat context');
const missing = await db.withUserScope(userId, s=>getOneTool.handler({characterId:'char-card'}, {userId, db:s, chatId:'chat-1'}));
assert(!missing.found,'Card legacy row is not found via get_character');
const noChatDetail = await db.withUserScope(userId, s=>getOneTool.handler({characterId:'char-a'}, {userId, db:s}));
assert(!noChatDetail.found,'get_character without chat context reports not-found (runtime-only)');

const updated = await db.withUserScope(userId, s=>updateTool.handler({characterId:'char-a', persona:'new persona', appearance:'new appearance'}, {userId, db:s}));
assert(updated.found,'update_character finds runtime character');
const after = await db.withUserScope(userId, s=>getOneTool.handler({characterId:'char-a'}, {userId, db:s, chatId:'chat-1'}));
assert(after.persona==='new persona' && after.appearance==='new appearance','update_character patches runtime fields');

const beforeChats = pool.chatSessions.length;
const deleted = await db.withUserScope(userId, s=>deleteTool.handler({characterId:'char-a'}, {userId, db:s}));
assert(deleted.deleted && deleted.deletedChatIds.length===0,'delete_character deletes runtime row without deleting chats');
assert(pool.chatSessions.length===beforeChats,'chat_sessions untouched by runtime delete');
assert(!pool.characters.some(c=>c.character_id==='char-a'),'runtime row removed');

const shared = 'char-b';
const remove = await db.withUserScope(userId, s=>removeTool.handler({characterId:shared}, {userId, db:s, chatId:'chat-1'}));
assert(remove.removed===true,'remove_character_from_chat unlinks');
assert(!pool.characterChatLinks.some(l=>l.character_id===shared && l.chat_id==='chat-1'),'link removed');

if (process.exitCode) { console.error('\nverify-characters FAILED'); } else { console.log('\nverify-characters passed'); }
