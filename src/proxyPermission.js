'use strict';

/**
 * JanitorAI omits allow_proxy for ordinary characters. Only an explicit false
 * prevents proxy-based prompt assembly.
 */
function allowsProxy(meta) {
  return !meta || meta.allow_proxy !== false;
}

/** Whether a generateAlpha response is JanitorAI's proxy-permission refusal. */
function isProxyForbiddenResponse(status, body) {
  if (Number(status) !== 403) return false;
  const text = String(body || '');
  return /\bprox(?:y|ies)\b[\s\S]{0,100}\bforbidden\b/i.test(text)
    || /\bforbidden\b[\s\S]{0,100}\bprox(?:y|ies)\b/i.test(text);
}

function proxyForbiddenError() {
  return new Error(
    'This character forbids proxy generation, so JAR cannot extract its hidden definition or closed lorebooks. Public data can still be refreshed.',
  );
}

module.exports = { allowsProxy, isProxyForbiddenResponse, proxyForbiddenError };
