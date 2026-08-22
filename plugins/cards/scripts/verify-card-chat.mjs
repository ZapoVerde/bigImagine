// Proves canonical Card-to-chat application: source fields come from cards, card_id is stamped,
// greetings seed only empty chats, and no runtime Character tables are touched.
import { createApplyCardToChatTool } from '../dist/applyCardToChatTool.js';

const assert = (value, message) => { if (!value) throw new Error(message); console.log(`ok: ${message}`); };
const cardId = 'card-1';
const chatId = 'chat-1';
const userId = 'user-1';
const queries = [];
const chat = { params: { temperature: 0.4 }, card_id: null, messages: 0 };
const db = { async query(sql, params = []) {
  queries.push({ sql, params });
  if (sql.includes('characters') || sql.includes('character_chat_links')) throw new Error('runtime Character path used');
  if (sql.startsWith('select name, persona')) return [{ name: 'Sydney', persona: 'A traveller', scenario: 'A road', system_prompt: 'Be vivid', example_dialogue: '', greetings: ['Hello', 'Hi again'] }];
  if (sql.startsWith('select params from chat_sessions') || sql.startsWith('select params from')) return [chat];
  if (sql.startsWith('update chat_sessions')) { chat.params = JSON.parse(params[1]); chat.card_id = params[2]; return []; }
  if (sql.startsWith('select count(*)')) return [{ count: String(chat.messages) }];
  if (sql.startsWith('insert into chat_messages')) { chat.messages++; return [{ message_id: 'message-1' }]; }
  if (sql.startsWith('insert into chat_message_swipes')) return [{ swipe_id: `swipe-${params[1]}` }];
  if (sql.startsWith('update chat_messages')) return [];
  throw new Error(`unexpected query: ${sql}`);
} };

const result = await createApplyCardToChatTool().handler({ cardId, chatId }, { db, userId });
assert(result.applied && result.greetingInserted, 'Card apply stamps a fresh chat and seeds its greeting');
assert(chat.card_id === cardId, 'Card apply writes chat_sessions.card_id');
assert(result.systemText.includes('A traveller') && result.systemText.includes('A road'), 'Card fields compose into the chat system prompt');
assert(queries.filter((q) => q.sql.startsWith('insert into chat_message_swipes')).length === 2, 'alternate greetings become swipe history');

const reapplied = await createApplyCardToChatTool().handler({ cardId, chatId }, { db, userId });
assert(reapplied.applied && !reapplied.greetingInserted, 'reapplying a Card does not reseed an existing chat');
console.log('\nCard chat verification passed');
