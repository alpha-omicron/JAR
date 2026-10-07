'use strict';

// One- or two-character names occur too freely in prose to restore safely.
const MIN_MACRO_NEEDLE = 3;

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Restore portable SillyTavern macros after JanitorAI expands them in the
 * assembled prompt. Candidates are known character names only; matches are
 * case-sensitive, longest-first, and bounded so a name never rewrites part of
 * an unrelated longer word.
 */
function restoreMacros(text, { charNames = [], userName = '' } = {}) {
  let out = String(text || '');
  if (!out) return out;
  const names = [...new Set(charNames.map((name) => String(name || '').trim())
    .filter((name) => name.length >= MIN_MACRO_NEEDLE && !/[{}]/.test(name)))]
    .sort((a, b) => b.length - a.length);
  const replaceBounded = (needle, replacement) => {
    // Braces are excluded too: never turn an already-restored `{{user}}` into
    // `{{{user}}}` by matching the word inside the macro token.
    const re = new RegExp(`(^|[^A-Za-z0-9_{}])(${escapeRegex(needle)})(?=$|[^A-Za-z0-9_{}])`, 'g');
    out = out.replace(re, (_, prefix) => `${prefix}${replacement}`);
  };
  names.forEach((name) => replaceBounded(name, '{{char}}'));
  const user = String(userName || '').trim();
  if (user.length >= MIN_MACRO_NEEDLE && !/[{}]/.test(user)) replaceBounded(user, '{{user}}');
  return out;
}

/** Restore macros in every portable text field of a character card. */
function restoreCharacterMacros(character, options) {
  const card = character || {};
  return {
    ...card,
    description: restoreMacros(card.description, options),
    personality: restoreMacros(card.personality, options),
    scenario: restoreMacros(card.scenario, options),
    firstMessage: restoreMacros(card.firstMessage, options),
    alternateGreetings: (Array.isArray(card.alternateGreetings) ? card.alternateGreetings : [])
      .map((greeting) => restoreMacros(greeting, options)),
    exampleMessages: restoreMacros(card.exampleMessages, options),
  };
}

module.exports = { MIN_MACRO_NEEDLE, restoreMacros, restoreCharacterMacros };
