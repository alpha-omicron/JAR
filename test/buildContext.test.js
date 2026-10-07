'use strict';

const assert = require('assert');
const { buildLlmContext } = require('../src/index');

const probePayload = {
  messages: [{
    role: 'system',
    content: "<Alice's Persona>Probe persona</Alice's Persona>\n<Scenario>Probe scenario</Scenario>",
  }],
};
const triggeredPayload = {
  messages: [{
    role: 'system',
    content: "<Alice's Persona>Triggered persona plus injected lore</Alice's Persona>\n<Scenario>Triggered scenario plus injected lore</Scenario>",
  }],
};

const context = buildLlmContext({
  character: {
    description: 'Stored clean persona', scenario: 'Stored clean scenario',
    firstMessage: 'Stored greeting', alternateGreetings: ['Alternate greeting'],
  },
  probePayload,
  payload: triggeredPayload,
}, { useGreetings: true }, { description: 'Catalog', scenario: 'Catalog scenario' });

assert.strictEqual(context.card, 'Stored clean persona');
assert.strictEqual(context.scenario, 'Stored clean scenario');
assert.strictEqual(context.greetings, 'Stored greeting\n\nAlternate greeting');

const probeFallback = buildLlmContext({ probePayload, payload: triggeredPayload }, {}, {});
assert.strictEqual(probeFallback.card, 'Probe persona');
assert.strictEqual(probeFallback.scenario, 'Probe scenario');

const legacyFallback = buildLlmContext({ payload: triggeredPayload }, {}, {});
assert.strictEqual(legacyFallback.card, 'Triggered persona plus injected lore');
assert.strictEqual(legacyFallback.scenario, 'Triggered scenario plus injected lore');

console.log('build context tests passed');
