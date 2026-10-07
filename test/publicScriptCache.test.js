'use strict';

const assert = require('assert');
const { contentHash, scriptSourceHash, publicEntryContents, hasPublicSource } = require('../src/publiclore');
const store = require('../src/captureStore');
const { mergePublicLorebooks } = store;

const source = 'const loreEntries = [{ content: "A" }];';
const hash = scriptSourceHash(source);
assert.strictEqual(hash.length, 64);
assert.strictEqual(hash, scriptSourceHash(source));
assert.notStrictEqual(hash, scriptSourceHash(`${source}\n`));
assert.strictEqual(hash, contentHash(source));

// A readable /scripts landing page does not make its source downloadable.
assert.strictEqual(hasPublicSource({ is_public: true, is_code_public: false }, { isPublic: true }), false);
assert.strictEqual(hasPublicSource({ is_public: true, is_code_public: true }, { isPublic: true }), true);
assert.strictEqual(hasPublicSource({ is_public: true }, { isPublic: true }), true);

const worldInfo = { entries: { 0: { content: 'Recovered public script entry' } } };
assert.deepStrictEqual(publicEntryContents([
  { isJs: true, scriptSourceHash: hash, reconstructedSourceHash: hash, reconstructedWorldInfo: worldInfo },
]), ['Recovered public script entry']);
assert.deepStrictEqual(publicEntryContents([
  { isJs: true, reconstructionStale: true, scriptSourceHash: hash, reconstructedSourceHash: hash, reconstructedWorldInfo: worldInfo },
]), []);
assert.deepStrictEqual(publicEntryContents([
  { isJs: true, scriptSourceHash: hash, reconstructedSourceHash: 'old', reconstructedWorldInfo: worldInfo },
]), []);

const cached = {
  id: 'script-1', isJs: true, scriptSourceHash: hash,
  reconstructedSourceHash: hash, reconstructedWorldInfo: worldInfo, reconstructedAt: 1,
};
assert.strictEqual(mergePublicLorebooks([cached], [{ id: 'script-1', isJs: true, scriptSourceHash: hash }])[0].reconstructionStale, false);
assert.strictEqual(mergePublicLorebooks([cached], [{ id: 'script-1', isJs: true, scriptSourceHash: 'changed' }])[0].reconstructionStale, true);

const inspection = store.saveInspection({ characterName: 'temporary cache test' });
try {
  store.attachPrivateLorebookReconstruction(inspection.id, { worldInfo, sourceHash: hash, model: 'test' });
  assert.deepStrictEqual(store.get(inspection.id).privateLorebookReconstruction.worldInfo, worldInfo);
  store.attachPayload(inspection.id, { messages: [] });
  assert.strictEqual(store.get(inspection.id).privateLorebookReconstruction, undefined);
} finally {
  store.remove(inspection.id);
}

console.log('public script cache tests passed');
