'use strict';

const assert = require('assert');
const { parseChatId, toJsonl } = require('../src/chatExport');
const { chatListItems } = require('../src/autotrigger');

assert.strictEqual(parseChatId('https://janitorai.com/chats/12345'), '12345');
assert.strictEqual(parseChatId('https://janitorai.com/chats/12345/messages/999'), '12345');
assert.deepStrictEqual(chatListItems({ chats: [{ id: 1 }] }), [{ id: 1 }]);
assert.deepStrictEqual(chatListItems({ data: [{ id: 2 }] }), [{ id: 2 }]);
assert.deepStrictEqual(chatListItems({ chat_ids: [3, 4] }), [{ id: 3 }, { id: 4 }]);
assert.strictEqual(parseChatId('12345'), '12345');
assert.throws(() => parseChatId('https://janitorai.com/characters/nope'));

const source = {
  character: { name: 'Character', chat_name: 'Char' },
  chat: { persona_name: 'Alex' },
  chatMessages: [
    { is_bot: true, message: 'Hello, {{user}}!', created_at: '2025-01-01T10:00:00Z' },
    { is_bot: false, message: 'Hi!', created_at: '2025-01-01T10:01:00Z' },
    { is_bot: true, message: 'First reply', created_at: '2025-01-01T10:02:00Z' },
    { is_bot: true, message: 'Second reply', created_at: '2025-01-01T10:03:00Z' },
  ],
};
const out = toJsonl(source);
const lines = out.jsonl.split('\n').map(JSON.parse);
assert.strictEqual(out.sourceMessageCount, 4);
assert.strictEqual(lines.length, 4); // metadata, greeting, user turn, swipe turn
assert.strictEqual(lines[0].chat_metadata.imported_from, 'janitorai');
assert.strictEqual(lines[1].mes, 'Hello, {{user}}!');
assert.strictEqual(lines[2].is_user, true);
assert.deepStrictEqual(lines[3].swipes, ['Second reply', 'First reply']);
console.log('chatExport tests passed');
