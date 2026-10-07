'use strict';

const assert = require('assert');
const { assembleResult } = require('../src/index');

const probePayload = {
  messages: [
    {
      role: 'system',
      content: "<Alice's Persona>Clean card line one\nClean card line two</Alice's Persona>\n<Scenario>Clean scenario line one\nClean scenario line two</Scenario>\n<Example dialogs>Clean example line one\nClean example line two</Example dialogs>",
    },
    { role: 'assistant', content: 'Probe greeting' },
  ],
};
const triggerPayload = {
  messages: [
    {
      role: 'system',
      content: "<Alice's Persona>Clean card line one\nInjected persona lore that belongs in the closed lorebook.\nClean card line two</Alice's Persona>\n<Scenario>Clean scenario line one\nInjected scenario lore that belongs in the closed lorebook.\nClean scenario line two</Scenario>\n<Example dialogs>Clean example line one\nInjected example lore that belongs in the closed lorebook.\nClean example line two</Example dialogs>\n\nClosed lore entry",
    },
    { role: 'assistant', content: 'Triggered greeting' },
  ],
};

const result = assembleResult(
  { payload: triggerPayload }, probePayload, 'Clean card line one\nClean card line two', {}, null, '', [],
);

assert.strictEqual(result.character.description, 'Clean card line one\nClean card line two');
assert.strictEqual(result.character.scenario, 'Clean scenario line one\nClean scenario line two');
assert.strictEqual(result.character.exampleMessages, 'Clean example line one\nClean example line two');
assert.strictEqual(result.character.firstMessage, 'Probe greeting');
assert.strictEqual(result.lorebookText, [
  'Closed lore entry',
  'Injected persona lore that belongs in the closed lorebook.',
  'Injected scenario lore that belongs in the closed lorebook.',
  'Injected example lore that belongs in the closed lorebook.',
].join('\n\n'));
assert.deepStrictEqual(result.fieldInjections.map((block) => block.field), [
  'persona', 'scenario', 'example',
]);

// Captures saved before probePayload was introduced still reconstruct from their
// single (trigger) payload rather than failing or producing an empty card.
const legacyResult = assembleResult(
  { payload: triggerPayload }, null, '', {}, null, '', [],
);
assert.match(legacyResult.character.description, /Injected persona lore/);
assert.match(legacyResult.character.scenario, /Injected scenario lore/);
assert.match(legacyResult.character.exampleMessages, /Injected example lore/);
assert.strictEqual(legacyResult.character.firstMessage, 'Triggered greeting');
assert.strictEqual(legacyResult.lorebookText, 'Closed lore entry');
console.log('probe capture tests passed');
