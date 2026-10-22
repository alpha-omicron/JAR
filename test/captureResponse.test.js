'use strict';

const assert = require('assert');
const { parseGenerateAlphaPayload } = require('../src/capture');

const payload = { messages: [{ role: 'system', content: '<Persona>card</Persona>' }] };

assert.deepStrictEqual(parseGenerateAlphaPayload(JSON.stringify(payload)), payload);
assert.deepStrictEqual(
  parseGenerateAlphaPayload(`event: message\ndata: ${JSON.stringify(payload)}\n\ndata: [DONE]`),
  payload,
);
assert.strictEqual(parseGenerateAlphaPayload('{"messages":[]}'), null);
assert.strictEqual(parseGenerateAlphaPayload('not a payload'), null);

console.log('capture response tests passed');
