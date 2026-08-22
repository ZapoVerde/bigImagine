// Proves prompt macro Card reads use the canonical Card row and observe edits on the next read.
import { buildMacroSnapshot } from '../dist/server/promptAssembly.js';

const assert = (value, message) => { if (!value) throw new Error(message); console.log(`ok: ${message}`); };
const card = { name: 'Sydney', persona: 'First version', scenario: 'Old road' };
const calls = [];
const db = { withUserScope: async (_userId, fn) => fn({ query: async (sql, params) => { calls.push({ sql, params }); return [{ ...card }]; } }) };
const settings = { get: async () => undefined };

const first = await buildMacroSnapshot(db, settings, 'user-1', null, 'card-1');
assert(first.charName === 'Sydney' && first.description === 'First version', 'macro snapshot reads Card-owned fields');
assert(calls[0].sql.includes('from cards') && calls[0].params[0] === 'card-1', 'macro snapshot queries the canonical Card reference');
card.persona = 'Edited version';
const second = await buildMacroSnapshot(db, settings, 'user-1', null, 'card-1');
assert(second.description === 'Edited version', 'the next prompt read observes a live Card edit');
console.log('\nCard prompt live verification passed');
