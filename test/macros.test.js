'use strict';

const assert = require('assert');
const { restoreMacros, restoreCharacterMacros } = require('../src/macros');
const {
  assembleResult, profileDisplayName, inferMacroUserName, restoreFieldFromTemplate,
} = require('../src/index');

assert.strictEqual(
  restoreMacros('Anna Lee meets Anna.', { charNames: ['Anna', 'Anna Lee'] }),
  '{{char}} meets {{char}}.',
);
assert.strictEqual(
  restoreMacros('Annabelle is not Anna.', { charNames: ['Anna'] }),
  'Annabelle is not {{char}}.',
);
assert.strictEqual(
  restoreMacros('Al always arrives early.', { charNames: ['Al'] }),
  'Al always arrives early.',
);
assert.strictEqual(
  restoreMacros('Morgan greets Taylor.', { charNames: ['Morgan'], userName: 'Taylor' }),
  '{{char}} greets {{user}}.',
);
assert.strictEqual(
  restoreMacros('{{user}} waits for {{char}}.', { charNames: ['char'], userName: 'user' }),
  '{{user}} waits for {{char}}.',
);

const card = restoreCharacterMacros({
  name: 'Morgan',
  description: 'Morgan is a guide for Taylor.',
  scenario: 'Taylor meets Morgan.',
  firstMessage: 'Hello Taylor, I am Morgan.',
  alternateGreetings: ['Morgan waves at Taylor.', 'Taylor finds Morgan waiting.'],
  exampleMessages: 'Morgan: Welcome, Taylor.',
}, { charNames: ['Morgan'], userName: 'Taylor' });
assert.strictEqual(card.name, 'Morgan');
assert.strictEqual(card.firstMessage, 'Hello {{user}}, I am {{char}}.');
assert.deepStrictEqual(card.alternateGreetings, [
  '{{char}} waves at {{user}}.', '{{user}} finds {{char}} waiting.',
]);
assert.strictEqual(card.exampleMessages, '{{char}}: Welcome, {{user}}.');
assert.strictEqual(profileDisplayName({ data: { profile: { username: 'Taylor' } } }), 'Taylor');
assert.strictEqual(inferMacroUserName(
  { name: 'Morgan', personality: '{{char}} greets {{user}}.' },
  { messages: [{ role: 'system', content: "<Morgan's Persona>Morgan greets Taylor.</Morgan's Persona>" }] },
), 'Taylor');
assert.strictEqual(
  restoreFieldFromTemplate(
    'Morgan has Morgan vibes, and greets Taylor.',
    '{{char}} has Morgan vibes, and greets {{user}}.',
    { charNames: ['Morgan'], userName: 'Taylor' },
  ),
  '{{char}} has Morgan vibes, and greets {{user}}.',
);

const payload = {
  messages: [
    { role: 'system', content: "<Morgan's Persona>Morgan guides Taylor.</Morgan's Persona>\n<Scenario>Taylor meets Morgan.</Scenario>\nMorgan protects Taylor." },
    { role: 'assistant', content: 'Hello Taylor, I am Morgan.' },
  ],
};
const assembled = assembleResult(
  { payload }, null, '', {}, { name: 'Morgan' }, '', [], null, 'Taylor',
);
assert.strictEqual(assembled.character.description, '{{char}} guides {{user}}.');
assert.strictEqual(assembled.character.scenario, '{{user}} meets {{char}}.');
assert.strictEqual(assembled.character.firstMessage, 'Hello {{user}}, I am {{char}}.');
assert.strictEqual(assembled.lorebookText, '{{char}} protects {{user}}.');

console.log('macro restoration tests passed');
