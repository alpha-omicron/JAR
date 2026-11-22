'use strict';

const assert = require('assert');
const { buildPartialCharacter, refreshedCharacter } = require('../src/index');

const meta = {
  name: 'Alice', allow_proxy: false, description: 'Public description',
  personality: 'must not copy hidden data', scenario: 'must not copy hidden scenario',
  custom_tags: ['test'], first_messages: ['catalog greeting'],
};
const chat = { character: { first_messages: ['primary', 'alternate'] } };
const card = buildPartialCharacter(meta, 'avatar', chat);
assert.strictEqual(card.definitionSource, 'partial');
assert.strictEqual(card.name, 'Alice');
assert.strictEqual(card.creatorNotes, 'Public description');
assert.strictEqual(card.description, '');
assert.strictEqual(card.scenario, '');
assert.strictEqual(card.firstMessage, 'primary');
assert.deepStrictEqual(card.alternateGreetings, ['alternate']);

const edited = { ...card, description: 'manual persona', scenario: 'manual scenario' };
const refreshed = refreshedCharacter({ character: edited }, {
  meta, avatarBase64: 'new avatar', greetingChat: chat,
});
assert.strictEqual(refreshed.description, 'manual persona');
assert.strictEqual(refreshed.scenario, 'manual scenario');
assert.strictEqual(refreshed.avatarBase64, 'new avatar');
assert.strictEqual(buildPartialCharacter(meta, '', null).firstMessage, 'catalog greeting');

const shiftedChat = { character: { first_message: 'primary', first_messages: [null, 'alt 1', 'alt 2'] } };
const shifted = { firstMessage: 'alt 1', alternateGreetings: ['alt 2'], scenario: 'manual' };
const repaired = buildPartialCharacter(meta, '', shiftedChat, shifted);
assert.strictEqual(repaired.firstMessage, 'primary');
assert.deepStrictEqual(repaired.alternateGreetings, ['alt 1', 'alt 2']);
assert.strictEqual(repaired.scenario, 'manual');
const manuallyEdited = buildPartialCharacter(meta, '', shiftedChat, { ...shifted, firstMessage: 'my edit' });
assert.strictEqual(manuallyEdited.firstMessage, 'my edit');
assert.deepStrictEqual(manuallyEdited.alternateGreetings, ['alt 2']);
const fullChat = { character: { first_message: 'primary', first_messages: ['primary', 'alt 1', 'alt 2'] } };
assert.strictEqual(buildPartialCharacter({ ...meta, first_messages: [null, 'alt 1', 'alt 2'] }, '', fullChat, shifted).firstMessage, 'primary');

console.log('partial card tests passed');
