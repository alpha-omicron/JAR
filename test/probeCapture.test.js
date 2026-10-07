'use strict';

const assert = require('assert');
const { assembleResult } = require('../src/index');

const probePayload = {
  messages: [
    {
      role: 'system',
      content: "<Alice's Persona>Clean card</Alice's Persona>\n<Scenario>Clean scenario</Scenario>\n<Example dialogs>Clean example</Example dialogs>",
    },
    { role: 'assistant', content: 'Probe greeting' },
  ],
};
const triggerPayload = {
  messages: [
    {
      role: 'system',
      content: "<Alice's Persona>Card plus injected lore</Alice's Persona>\n<Scenario>Scenario plus injected lore</Scenario>\n<Example dialogs>Example plus injected lore</Example dialogs>\n\nClosed lore entry",
    },
    { role: 'assistant', content: 'Triggered greeting' },
  ],
};

const result = assembleResult(
  { payload: triggerPayload }, probePayload, 'Clean card', {}, null, '', [],
);

assert.strictEqual(result.character.description, 'Clean card');
assert.strictEqual(result.character.scenario, 'Clean scenario');
assert.strictEqual(result.character.exampleMessages, 'Clean example');
assert.strictEqual(result.character.firstMessage, 'Probe greeting');
assert.strictEqual(result.lorebookText, 'Closed lore entry');

// Captures saved before probePayload was introduced still reconstruct from their
// single (trigger) payload rather than failing or producing an empty card.
const legacyResult = assembleResult(
  { payload: triggerPayload }, null, '', {}, null, '', [],
);
assert.strictEqual(legacyResult.character.description, 'Card plus injected lore');
assert.strictEqual(legacyResult.character.scenario, 'Scenario plus injected lore');
assert.strictEqual(legacyResult.character.exampleMessages, 'Example plus injected lore');
assert.strictEqual(legacyResult.character.firstMessage, 'Triggered greeting');
assert.strictEqual(legacyResult.lorebookText, 'Closed lore entry');
console.log('probe capture tests passed');
