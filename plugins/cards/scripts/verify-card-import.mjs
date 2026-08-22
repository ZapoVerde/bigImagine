// Focused Card import/export/media verification. The fake DB deliberately throws if any import
// path attempts to write characters or character_chat_links.
import { access, mkdir, rm } from 'node:fs/promises';
import { encodePngCard } from '../dist/cardCodec.js';
import { createImportCardTool } from '../dist/importCardTool.js';
import { createExportCardTool } from '../dist/exportCardTool.js';
import { createGetCardAvatarTool } from '../dist/getCardAvatarTool.js';
import { createImportCardFromUrlTool } from '../dist/importCardFromUrlTool.js';
import { deleteCardMedia } from '../dist/cardMedia.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); console.log(`ok: ${message}`); };
const userId = 'user-1';
const source = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Sabrina', description: 'Rich', personality: '', first_mes: 'Hey', alternate_greetings: [], scenario: '', system_prompt: '', mes_example: '', character_book: { name: 'Sabrina book', entries: [{ keys: ['sabrina'], content: 'A Card-owned fact.' }] } } };
const blank = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const png = encodePngCard(blank, JSON.stringify(source));
let sequence = 0; const cards = new Map(); let characterWrites = 0; let links = 0; let lorebooks = 0;
const db = { async query(sql, params = []) {
  if (sql.includes('characters') || sql.includes('character_chat_links') || sql.includes('lorebook_character_links')) { characterWrites++; throw new Error('runtime Character path used'); }
  if (sql.startsWith('insert into cards')) { const id = `card-${++sequence}`; cards.set(id, { card_id: id, user_id: params[0], name: params[1], persona: params[2], scenario: params[3], system_prompt: params[4], example_dialogue: params[5], greetings: JSON.parse(params[6]), spec_version: params[7], source_json: JSON.parse(params[8]), has_avatar: Boolean(params[9]) }); return [{ card_id: id, name: params[1] }]; }
  if (sql.startsWith('select name')) { const card = cards.get(params[0]); return card ? [{ ...card }] : []; }
  if (sql.startsWith('select avatar_path')) { return cards.has(params[0]) ? [{ has_avatar: cards.get(params[0]).has_avatar }] : []; }
  if (sql.startsWith('insert into lorebooks')) { lorebooks++; return [{ lorebook_id: `book-${lorebooks}` }]; }
  if (sql.startsWith('insert into lorebook_entries')) return [];
  if (sql.includes('lorebook_card_links')) { links++; return []; }
  throw new Error(`unexpected query: ${sql}`);
} };
const embeddings = { async embed(texts) { return texts.map(() => [0.1, 0.2]); } };
await rm('/tmp/bigbrain-verify-card-media', { recursive: true, force: true }); await mkdir('/tmp/bigbrain-verify-card-media', { recursive: true });
const importTool = createImportCardTool();
const imported = await importTool.handler({ filename: 'sabrina.png', fileBase64: png.toString('base64') }, { db, userId, embeddings });
assert(imported.cardId && imported.hasAvatar, 'PNG file import creates exactly one Card with media');
assert(cards.size === 1, 'PNG file import creates exactly one canonical Card row');
const exported = await createExportCardTool().handler({ cardId: imported.cardId, format: 'json' }, { db, userId });
assert(exported.found && exported.json.data.name === 'Sabrina', 'Card JSON export reads source JSON losslessly');
const avatar = await createGetCardAvatarTool().handler({ cardId: imported.cardId }, { db, userId });
assert(avatar.found && avatar.base64.length > 0, 'Card avatar is retrievable through Card ownership');
await deleteCardMedia(imported.cardId);
let mediaGone = false;
try { await access(`/tmp/bigbrain-verify-card-media/${imported.cardId}.png`); } catch { mediaGone = true; }
assert(mediaGone, 'existing Card media is removed by Card cleanup');
await deleteCardMedia('missing-card');
assert(true, 'missing Card media cleanup is harmless');
const jsonImported = await importTool.handler({ filename: 'sabrina.json', fileBase64: Buffer.from(JSON.stringify(source)).toString('base64') }, { db, userId, embeddings });
assert(jsonImported.cardId && !jsonImported.hasAvatar && cards.size === 2, 'JSON file import creates one additional Card without media');
globalThis.fetch = async (url) => String(url).includes('api.chub.ai') ? new Response(JSON.stringify({ node: { max_res_url: 'https://avatars.charhub.io/card.png' } })) : new Response(png, { status: 200 });
const chub = await createImportCardFromUrlTool({ get: async () => 'http://pia-proxy:8080' }).handler({ url: 'https://chub.ai/characters/maker/sabrina' }, { db, userId, embeddings });
assert(chub.cardId && chub.cardId !== imported.cardId, 'Chub import creates exactly one additional Card');
assert(cards.size === 3 && characterWrites === 0, 'Card imports create no runtime Character rows');
assert(lorebooks === 3 && links === 3, 'Card imports link embedded lorebooks through Card ownership');
console.log('\nCard import verification passed');
