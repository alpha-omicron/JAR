'use strict';

const { randomUUID } = require('crypto');
const { authedFetch } = require('./autotrigger');

const PERSONAS_URL = 'https://janitorai.com/hampter/personas';

async function createMacroCapturePersona(page) {
  const name = `JAR_USER_${randomUUID().replace(/-/g, '')}`;
  const r = await authedFetch(page, PERSONAS_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appearance: '', avatar: '', groupId: null, name, pronouns: null }),
  });
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  let persona;
  try { persona = JSON.parse(r.body); } catch (_) { throw new Error('response was not JSON'); }
  if (!persona || !persona.id) throw new Error('response omitted id');
  // Preserve our generated name even if the endpoint returns a partial record.
  return { ...persona, name };
}

async function deletePersona(page, personaId) {
  if (!personaId) return false;
  const r = await authedFetch(page, `${PERSONAS_URL}/${personaId}`, { method: 'DELETE' });
  if (r.status >= 400) { console.warn(`[persona] delete failed: HTTP ${r.status}`); return false; }
  return true;
}

module.exports = { createMacroCapturePersona, deletePersona };
