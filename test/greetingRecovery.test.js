'use strict';

const assert = require('assert');
const { collectGreetings, assembleResult } = require('../src/index');

const extractionChat = {
  character: {
    first_messages: ['Chat primary greeting', 'Chat alternate greeting'],
    first_message: 'Chat primary greeting',
  },
  chatMessages: [{ is_bot: true, message: 'Selected chat greeting' }],
};

assert.deepStrictEqual(collectGreetings(
  { first_messages: ['Catalog greeting'] }, 'Probe response', extractionChat,
), ['Chat primary greeting', 'Chat alternate greeting']);

// JanitorAI may reserve slot 0 as null and provide the primary separately.
assert.deepStrictEqual(collectGreetings(null, '', {
  character: { first_message: 'Primary', first_messages: [null, 'Alt 1', 'Alt 2'] },
}), ['Primary', 'Alt 1', 'Alt 2']);

// Hidden definitions occasionally omit greeting fields from chat.character;
// the initial bot message is still the real opening greeting.
assert.deepStrictEqual(collectGreetings(
  { first_messages: ['Catalog greeting'] }, 'Probe response', {
    character: {}, chatMessages: [{ is_bot: true, message: 'Initial bot greeting' }],
  },
), ['Initial bot greeting']);

// Once saved, a recovered greeting remains preferred when a later operation no
// longer has the temporary extraction-chat response in memory.
assert.deepStrictEqual(collectGreetings(
  { first_messages: ['Catalog greeting'] }, 'Probe response', null,
  { firstMessage: 'Stored greeting', alternateGreetings: ['Stored alternate'] },
), ['Stored greeting', 'Stored alternate']);

const payload = {
  messages: [
    { role: 'system', content: "<Alice's Persona>Private card</Alice's Persona>" },
    { role: 'assistant', content: 'Generated probe response' },
  ],
};
const result = assembleResult(
  { payload, character: { definitionSource: 'pending' } }, payload, 'Private card', {},
  { name: 'Alice', first_messages: ['Catalog greeting'] }, '', [], extractionChat,
);
assert.strictEqual(result.character.firstMessage, 'Chat primary greeting');
assert.deepStrictEqual(result.character.alternateGreetings, ['Chat alternate greeting']);

console.log('greeting recovery tests passed');
