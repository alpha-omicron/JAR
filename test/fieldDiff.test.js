'use strict';

const assert = require('assert');
const {
  fieldsFromMeta, scanInjectedFields,
} = require('../src/fieldDiff');

const clean = fieldsFromMeta({
  personality: 'Public baseline one\nPublic baseline two',
  scenario: 'Clean scenario',
});
const probe = {
  persona: 'Public baseline one\nAlways-on injected lore long enough to recover.\nPublic baseline two',
  scenario: 'Clean scenario', example: '', firstMessage: '',
};
const capture = {
  persona: `${probe.persona}\nTrigger-only injected lore long enough to recover.`,
  scenario: 'Clean scenario', example: '', firstMessage: '',
};

const blocks = scanInjectedFields({ capture, probe, clean });
assert.deepStrictEqual(blocks, [
  { field: 'persona', text: 'Trigger-only injected lore long enough to recover.' },
  { field: 'persona', text: 'Always-on injected lore long enough to recover.' },
]);

// A complete replacement without shared baseline lines is too ambiguous to move.
assert.deepStrictEqual(scanInjectedFields({
  capture: { persona: 'A completely different field that is long enough to be suspicious.', scenario: '', example: '', firstMessage: '' },
  probe: { persona: 'Original field that was replaced entirely by something else.', scenario: '', example: '', firstMessage: '' },
}), []);

console.log('field diff tests passed');
