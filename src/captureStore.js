'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'captures');

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

function fileFor(id) {
  return path.join(DIR, `${id}.json`);
}

/** Short, sortable, collision-resistant id (timestamp + random suffix). */
function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Persist a captured generateAlpha payload.
 * @param {{url:string, payload:object, source?:string}} record
 * @returns {object} the stored record (with id + ts)
 */
function save(record) {
  ensureDir();
  const id = newId();
  const stored = {
    id,
    ts: Date.now(),
    url: record.url || '',
    source: record.source || 'generateAlpha',
    characterId: record.characterId || '',
    characterName: record.characterName || '',
    payload: record.payload,
  };
  fs.writeFileSync(fileFor(id), JSON.stringify(stored, null, 2), 'utf8');
  return stored;
}

/**
 * Persist an INSPECTION record — character metadata, public lorebooks, avatar and
 * key-inference context gathered WITHOUT running the generateAlpha extraction. The
 * `payload` is left null until the user explicitly extracts (see {@link attachPayload}).
 * @param {object} record
 * @returns {object} the stored record (with id + ts)
 */
function saveInspection(record) {
  ensureDir();
  const id = newId();
  const stored = {
    id,
    ts: Date.now(),
    url: record.url || '',
    source: record.source || 'inspect',
    characterId: record.characterId || '',
    characterName: record.characterName || '',
    meta: record.meta || null,
    context: record.context || null,
    publicLorebooks: record.publicLorebooks || [],
    avatarBase64: record.avatarBase64 || '',
    character: record.character || null,
    cardPublic: !!record.cardPublic,
    conversations: Array.isArray(record.conversations) ? record.conversations : [],
    payload: null,
  };
  fs.writeFileSync(fileFor(id), JSON.stringify(stored, null, 2), 'utf8');
  return stored;
}

/** Find the newest stored character record for a JanitorAI character id. */
function findByCharacterId(characterId) {
  const wanted = String(characterId || '');
  if (!wanted) return null;
  return list()
    .filter((item) => item.characterId === wanted)
    .map((item) => get(item.id))
    .filter(Boolean)
    .sort((a, b) => b.ts - a.ts)[0] || null;
}

/** Link a known JanitorAI conversation to a character inspection record. */
function attachConversation(id, conversation) {
  const rec = get(id);
  if (!rec) return null;
  const chatId = String(conversation && conversation.chatId || '');
  if (!chatId) return rec;
  const list = Array.isArray(rec.conversations) ? rec.conversations : [];
  const next = { ...conversation, chatId };
  const index = list.findIndex((item) => String(item && item.chatId) === chatId);
  if (index >= 0) {
    const existing = list[index];
    // A bulk listing only carries IDs, while a user label is local-only. Never
    // replace either an existing title with an empty summary or a saved label.
    list[index] = {
      ...existing,
      ...next,
      title: next.title || existing.title || '',
      label: existing.label || '',
    };
  }
  else list.unshift(next);
  rec.conversations = list;
  fs.writeFileSync(fileFor(id), JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}

/** Update user-facing metadata for one linked conversation. */
function updateConversation(id, chatId, patch) {
  const rec = get(id);
  if (!rec) return null;
  const wanted = String(chatId || '');
  const conversations = Array.isArray(rec.conversations) ? rec.conversations : [];
  const index = conversations.findIndex((item) => String(item && item.chatId) === wanted);
  if (index < 0) return null;
  conversations[index] = { ...conversations[index], ...patch, chatId: wanted };
  rec.conversations = conversations;
  fs.writeFileSync(fileFor(id), JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}

/** Unlink a conversation without touching the remote JanitorAI chat. */
function removeConversation(id, chatId) {
  const rec = get(id);
  if (!rec) return null;
  const wanted = String(chatId || '');
  rec.conversations = (Array.isArray(rec.conversations) ? rec.conversations : [])
    .filter((item) => String(item && item.chatId) !== wanted);
  fs.writeFileSync(fileFor(id), JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}

/**
 * Attach a captured generateAlpha payload to an existing (inspected) record, in
 * place — used by the on-demand "extract" so the capture keeps the same id/context
 * instead of spawning a fresh record.
 * @returns {object|null} the updated record, or null if the id is unknown
 */
function attachPayload(id, payload, source) {
  const rec = get(id);
  if (!rec) return null;
  rec.payload = payload;
  // A new triggered prompt can contain different closed-lorebook content, so a
  // prior private reconstruction is no longer an export of the current source.
  delete rec.privateLorebookReconstruction;
  delete rec.macroUserName;
  if (source) rec.source = source;
  rec.capturedAt = Date.now();
  fs.writeFileSync(fileFor(id), JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}

/**
 * Attach the neutral generateAlpha probe captured before a lorebook trigger.
 * It is retained alongside the triggered payload so private card reconstruction
 * can use the unmodified character fields on later reloads and retries.
 */
function attachProbePayload(id, probePayload) {
  const rec = get(id);
  if (!rec) return false;
  rec.probePayload = probePayload || null;
  fs.writeFileSync(fileFor(id), JSON.stringify(rec, null, 2), 'utf8');
  return true;
}

/** Remember the account name only when {{user}} could not be preserved in capture. */
function attachMacroUserName(id, userName) {
  const rec = get(id);
  if (!rec) return false;
  rec.macroUserName = String(userName || '').trim();
  fs.writeFileSync(fileFor(id), JSON.stringify(rec, null, 2), 'utf8');
  return true;
}

/** Update catalog-derived data without replacing any captured prompt payloads. */
function refreshInspection(id, patch) {
  const rec = get(id);
  if (!rec) return null;
  rec.url = patch.url || rec.url;
  rec.characterId = patch.characterId || rec.characterId;
  rec.characterName = patch.characterName || rec.characterName;
  rec.meta = patch.meta || null;
  rec.context = patch.context || null;
  rec.publicLorebooks = mergePublicLorebooks(rec.publicLorebooks, patch.publicLorebooks || []);
  rec.avatarBase64 = patch.avatarBase64 || '';
  rec.cardPublic = !!patch.cardPublic;
  if (patch.character) rec.character = patch.character;
  rec.refreshedAt = Date.now();
  fs.writeFileSync(fileFor(id), JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}

/** Preserve public-script reconstructions across refreshes, marking changed source stale. */
function mergePublicLorebooks(previous, next) {
  const prior = new Map((previous || []).map((book) => [String(book && book.id), book]));
  return (next || []).map((book) => {
    const old = prior.get(String(book && book.id));
    if (!book || !book.isJs || !old || !old.reconstructedWorldInfo) return book;
    const sameSource = old.reconstructedSourceHash && old.reconstructedSourceHash === book.scriptSourceHash;
    return {
      ...book,
      reconstructedWorldInfo: old.reconstructedWorldInfo,
      reconstructedSourceHash: old.reconstructedSourceHash,
      reconstructedAt: old.reconstructedAt,
      reconstructedModel: old.reconstructedModel,
      reconstructionStale: !sameSource,
    };
  });
}

function systemContent(payload) {
  const msgs = payload && Array.isArray(payload.messages) ? payload.messages : [];
  const sys = msgs.find((m) => m && m.role === 'system');
  return (sys && typeof sys.content === 'string') ? sys.content : '';
}

/** Lightweight list view (no full payload) for the sidebar. */
function list() {
  ensureDir();
  const out = [];
  for (const name of fs.readdirSync(DIR)) {
    if (!name.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
      const sys = systemContent(rec.payload);
      out.push({
        id: rec.id,
        ts: rec.ts,
        source: rec.source,
        model: rec.payload && rec.payload.model ? rec.payload.model : '',
        characterName: rec.characterName || '',
        messageCount: rec.payload && Array.isArray(rec.payload.messages)
          ? rec.payload.messages.length : 0,
        preview: sys.slice(0, 140).replace(/\s+/g, ' ').trim(),
      });
    } catch (_) {
      // skip corrupt files
    }
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

function get(id) {
  const f = fileFor(id);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {
    return null;
  }
}

function remove(id) {
  const f = fileFor(id);
  if (fs.existsSync(f)) {
    fs.unlinkSync(f);
    return true;
  }
  return false;
}

/**
 * Attach structured key-inference context to a stored capture. `context` is the
 * `{ description, scenario, greetings, lorebooks }` object from buildContextParts;
 * each part is independently toggleable when building with the LLM.
 */
function attachCatalog(id, context) {
  const rec = get(id);
  if (!rec) return false;
  rec.context = context;
  fs.writeFileSync(fileFor(id), JSON.stringify(rec, null, 2), 'utf8');
  return true;
}

function attachCharacter(id, characterId, characterName) {
  const rec = get(id);
  if (!rec) return false;
  rec.characterId = characterId;
  rec.characterName = characterName;
  fs.writeFileSync(fileFor(id), JSON.stringify(rec, null, 2), 'utf8');
  return true;
}

function attachCardData(id, character) {
  const rec = get(id);
  if (!rec) return false;
  rec.character = character;
  fs.writeFileSync(fileFor(id), JSON.stringify(rec, null, 2), 'utf8');
  return true;
}

/** Attach downloaded public lorebooks (converted World Info books) to a capture. */
function attachPublicLorebooks(id, publicLorebooks) {
  const rec = get(id);
  if (!rec) return false;
  rec.publicLorebooks = mergePublicLorebooks(rec.publicLorebooks, publicLorebooks);
  fs.writeFileSync(fileFor(id), JSON.stringify(rec, null, 2), 'utf8');
  return true;
}

/** Atomically save a successful LLM reconstruction for one current public JS script. */
function attachPublicScriptReconstruction(id, scriptId, reconstruction) {
  const rec = get(id);
  if (!rec) return null;
  const wanted = String(scriptId);
  const books = Array.isArray(rec.publicLorebooks) ? rec.publicLorebooks : [];
  const index = books.findIndex((book) => book && String(book.id) === wanted && book.isJs);
  if (index < 0) return null;
  const book = books[index];
  const currentHash = book.scriptSourceHash || reconstruction.sourceHash;
  if (currentHash !== reconstruction.sourceHash) return null;
  books[index] = {
    ...book,
    scriptSourceHash: currentHash,
    reconstructedWorldInfo: reconstruction.worldInfo,
    reconstructedSourceHash: reconstruction.sourceHash,
    reconstructedAt: reconstruction.at || Date.now(),
    reconstructedModel: reconstruction.model || '',
    reconstructionStale: false,
  };
  rec.publicLorebooks = books;
  fs.writeFileSync(fileFor(id), JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}

/** Atomically persist a successful private/closed-lorebook LLM reconstruction. */
function attachPrivateLorebookReconstruction(id, reconstruction) {
  const rec = get(id);
  if (!rec) return null;
  rec.privateLorebookReconstruction = {
    worldInfo: reconstruction.worldInfo,
    sourceHash: reconstruction.sourceHash,
    reconstructedAt: reconstruction.at || Date.now(),
    reconstructedModel: reconstruction.model || '',
  };
  fs.writeFileSync(fileFor(id), JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}

/**
 * Save the JanitorAI chat id associated with a capture record, so future
 * extractions can reuse the same chat instead of creating a new one.
 */
function attachChatId(id, chatId) {
  const rec = get(id);
  if (!rec) return false;
  rec.chatId = chatId;
  fs.writeFileSync(fileFor(id), JSON.stringify(rec, null, 2), 'utf8');
  return true;
}

/** Remove the chat id from a record (after the chat was deleted). */
function clearChatId(id) {
  const rec = get(id);
  if (!rec) return false;
  delete rec.chatId;
  fs.writeFileSync(fileFor(id), JSON.stringify(rec, null, 2), 'utf8');
  return true;
}

module.exports = {
  save, saveInspection, attachPayload, list, get, remove,
  attachProbePayload, refreshInspection, attachCatalog, attachCharacter, attachCardData,
  attachPublicLorebooks, attachPublicScriptReconstruction, attachPrivateLorebookReconstruction, attachMacroUserName,
  mergePublicLorebooks, attachChatId, clearChatId,
  findByCharacterId, attachConversation, updateConversation, removeConversation,
  systemContent, DIR,
};
