'use strict';

const assert = require('assert');
const { freshGreetingMessageIds } = require('../src/autotrigger');
const { excludeChatMessages } = require('../src/capture');

assert.deepStrictEqual(freshGreetingMessageIds({
  chatMessages: [{ id: 10, is_bot: true }],
}), [10]);
assert.deepStrictEqual(freshGreetingMessageIds({
  chatMessages: [{ id: 10, is_bot: true }, { id: 12, is_bot: false }],
}), []);

const body = {
  chatMessages: [
    { id: 10, is_bot: true, message: 'Opening greeting' },
    { id: 11, is_bot: false, message: '.' },
  ],
};
assert.deepStrictEqual(excludeChatMessages(body, [10]), ['10']);
assert.deepStrictEqual(body.chatMessages.map((message) => message.id), [11]);
assert.deepStrictEqual(excludeChatMessages(body, [10]), []);
assert.deepStrictEqual(excludeChatMessages(body, []), []);

console.log('probe exclusion tests passed');
