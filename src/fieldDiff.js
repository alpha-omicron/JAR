'use strict';

const {
  extractCard, extractScenario, extractExample, extractFirstMessage, stripPublicEntries,
} = require('./separate');

const MIN_INJECTION_CHARS = 24;
const FIELDS = ['persona', 'scenario', 'example', 'firstMessage'];

function fold(text) {
  return String(text || '')
    .replace(/['‘’ʼ]/g, "'")
    .replace(/["“”]/g, '"')
    .replace(/[-–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function fieldsFromPayload(payload) {
  return {
    persona: extractCard(payload),
    scenario: extractScenario(payload),
    example: extractExample(payload),
    firstMessage: extractFirstMessage(payload),
  };
}

function fieldsFromMeta(meta) {
  const firstMessages = [];
  if (meta && meta.first_message) firstMessages.push(meta.first_message);
  if (meta && Array.isArray(meta.first_messages)) firstMessages.push(...meta.first_messages);
  return {
    persona: String((meta && meta.personality) || ''),
    scenario: String((meta && meta.scenario) || ''),
    example: String((meta && (meta.example_dialogs || meta.mes_example)) || ''),
    firstMessage: firstMessages.map((value) => String(value || '')).filter(Boolean).join('\n'),
  };
}

/**
 * Return contiguous lines in `after` which are not in `before`. We require at
 * least one shared line: if an entire field changed, it is not safe to call the
 * replacement lorebook injection.
 */
function residue(after, before) {
  if (!String(after || '').trim() || !String(before || '').trim()) return [];
  const known = new Set(String(before).split('\n').map(fold).filter(Boolean));
  const lines = String(after).split('\n');
  if (!lines.some((line) => known.has(fold(line)))) return [];

  const blocks = [];
  let current = [];
  const flush = () => {
    const text = current.join('\n').trim();
    current = [];
    if (fold(text).length >= MIN_INJECTION_CHARS) blocks.push(text);
  };
  for (const line of lines) {
    if (known.has(fold(line))) flush();
    else current.push(line);
  }
  flush();
  return blocks;
}

function cleanRecovered(text, publicContents) {
  return stripPublicEntries(text, publicContents).out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Recover trigger-only field additions. For public cards, `clean` additionally
 * finds entries already present in the neutral probe (always-on lore).
 */
function scanInjectedFields({ capture, probe, clean, publicContents = [], existing = '' }) {
  if (!probe && !clean) return [];
  const blocks = [];
  const seen = new Set();
  const isolated = fold(existing);
  const collect = (field, after, before) => {
    for (const candidate of residue(after, before)) {
      const text = cleanRecovered(candidate, publicContents);
      const key = fold(text);
      if (key.length < MIN_INJECTION_CHARS || isolated.includes(key) || seen.has(key)) continue;
      seen.add(key);
      blocks.push({ field, text });
    }
  };

  for (const field of FIELDS) {
    const after = String((capture && capture[field]) || '');
    if (!after.trim()) continue;
    if (probe) collect(field, after, probe[field]);
    const baseline = String((clean && clean[field]) || '');
    if (baseline.trim()) collect(field, probe ? probe[field] : after, baseline);
  }
  return blocks;
}

function appendRecovered(existing, blocks) {
  return [existing, ...blocks.map((block) => block.text)]
    .map((text) => String(text || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

module.exports = {
  FIELDS, fieldsFromPayload, fieldsFromMeta, scanInjectedFields, appendRecovered,
};
