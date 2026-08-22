// Verifies the Card-specific binary HTTP handlers return Card-domain tool results and status/body
// shapes. The generic server suite covers authentication/routing; this check covers these handlers'
// Card contract without a listening socket or real database.

import { PassThrough } from 'node:stream';
import { handleCardExportRoutes } from '../../../orchestrator/dist/server/handleCardExport.js';
import { importCard } from '../../../orchestrator/dist/server/handleCardImport.js';
import { createToolRegistry } from '../../../orchestrator/dist/orchestrator/toolRegistry.js';
import { createPostgresClient } from '../../../orchestrator/dist/io/postgres.js';
import { createImportCardTool } from '../dist/importCardTool.js';
import { createExportCardTool } from '../dist/exportCardTool.js';
import { createGetCardAvatarTool } from '../dist/getCardAvatarTool.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); console.log(`ok: ${message}`); };
const source = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'HTTP Card', description: 'source', first_mes: 'Hello' } };
const blank = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const tools = createToolRegistry([createImportCardTool(), createExportCardTool(), createGetCardAvatarTool()]);
const card = { card_id: 'card-http', user_id: 'user-http', name: 'HTTP Card', persona: 'source', scenario: '', system_prompt: '', example_dialogue: '', greetings: ['Hello'], source_json: source, has_avatar: false };
const pool = { async connect() { let scope; return { async query(sql, params = []) {
  if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
  if (sql.includes('set_config')) { scope = params[0]; return { rows: [] }; }
  if (sql.startsWith('insert into cards')) return { rows: [{ card_id: card.card_id, name: card.name }] };
  if (sql.startsWith('select name')) return { rows: [{ ...card, has_avatar: false }] };
  if (sql.startsWith('select avatar_path')) return { rows: [{ has_avatar: false }] };
  throw new Error(`unexpected HTTP fake query (${scope}): ${sql}`);
} , release() {} }; } };
const db = createPostgresClient(pool);
const deps = { db, tools, embeddings: { async embed() { return []; } } };

const req = new PassThrough();
req.headers = { 'content-type': 'multipart/form-data; boundary=cardverify' };
const importPromise = importCard(req, deps, 'user-http');
req.end('--cardverify\r\nContent-Disposition: form-data; name="file"; filename="card.json"\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify(source) + '\r\n--cardverify--\r\n');
const imported = await importPromise;
assert(imported.status === 200 && imported.body.cardId === 'card-http' && !('characterId' in imported.body), 'Card HTTP import returns cardId');

function response() { return { status: 0, body: Buffer.alloc(0), writeHead(status) { this.status = status; }, end(body) { this.body = Buffer.isBuffer(body) ? body : Buffer.from(body ?? ''); } }; }
const jsonRes = response();
await handleCardExportRoutes({}, jsonRes, deps, 'user-http', new URL('http://x/v1/cards/card-http/export.json'));
assert(jsonRes.status === 200 && JSON.parse(jsonRes.body).data.name === 'HTTP Card', 'Card HTTP JSON export returns the Card source');
const avatarRes = response();
await handleCardExportRoutes({}, avatarRes, deps, 'user-http', new URL('http://x/v1/cards/card-http/avatar'));
assert(avatarRes.status === 404, 'Card HTTP avatar reports missing Card media as not found');
console.log('\nCard HTTP verification passed');
