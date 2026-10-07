'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');

const store = require('./captureStore');
const {
  separate, splitEntries, getSystemContent,
  extractCard, extractCharName, extractScenario, extractExample, extractFirstMessage,
} = require('./separate');
const {
  fieldsFromPayload, fieldsFromMeta, scanInjectedFields, appendRecovered,
} = require('./fieldDiff');
const { extract, buildExtractionMessages } = require('./extract');
const {
  BrowserManager, openLogin, logout, requireLogin, getStatus, getAvatarUrl, downloadAvatar,
} = require('./capture');
const {
  sendMessage, parseCharacterId, createChat, deleteChat, fetchCharacter, fetchChat, fetchCharacterChats, fetchMyProfile, authedFetch,
} = require('./autotrigger');
const { fetchPublicLorebooks, publicEntryContents } = require('./publiclore');
const { enterExtractionMode, restoreProfile } = require('./profile');
const { ensureUserMacroPersona, deletePersona } = require('./personas');
const { allowsProxy, proxyForbiddenError } = require('./proxyPermission');
const { countTokens } = require('./tokenizer');
const saucepan = require('./saucepan');
const { parseChatId, toJsonl } = require('./chatExport');

const PORT = Number(process.env.PORT) || 4577;
const SETTINGS_FILE = path.join(__dirname, '..', 'settings.local.json');

// ---- extraction LLM settings (set via the web UI, persisted locally) ----
function loadSettings() {
  const base = {
    baseUrl: '',
    apiKey: '',
    model: '',
    dontHideBrowserWindow: false,
    defaultLoreTriggerText: '',
    saucepanToken: '',
  };
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      Object.assign(base, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
    }
  } catch (_) { /* ignore */ }
  return base;
}
function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8');
}

// Restore a persisted Saucepan bearer token into the module on boot.
saucepan.setToken(loadSettings().saucepanToken || '');

// ---- live capture notifications (SSE) ----
const sseClients = new Set();
function broadcast(event, data) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(line);
}

// ---- capture waiters (used by auto-trigger to await the next generateAlpha) ----
// When the auto-trigger sends its "." probe, the resulting capture is held in
// memory until it can be attached to the triggered record — it is not listed as
// an independent capture.
let suppressNextCapture = false;
// When set, the next NON-suppressed generateAlpha capture is attached to this
// existing (inspected) record instead of creating a brand-new one — keeps the
// on-demand extract on the same record/context the user is looking at.
let pendingCaptureId = null;
const captureWaiters = [];
function waitNextCapture(timeout) {
  return new Promise((resolve, reject) => {
    const w = { resolve, reject };
    w.timer = setTimeout(() => {
      const i = captureWaiters.indexOf(w);
      if (i >= 0) captureWaiters.splice(i, 1);
      reject(new Error('timed out waiting for a generateAlpha capture'));
    }, timeout);
    captureWaiters.push(w);
  });
}
function resolveWaiters(stored) {
  while (captureWaiters.length) {
    const w = captureWaiters.shift();
    clearTimeout(w.timer);
    w.resolve(stored);
  }
}
function rejectWaiters(error) {
  while (captureWaiters.length) {
    const w = captureWaiters.shift();
    clearTimeout(w.timer);
    w.reject(error);
  }
}

// ---- capture browser (open only during an operation, à la GlazeFlutter) ----
// The browser is NOT launched at boot, and never kept warm. It opens only for a
// login (visible window) or an extraction (real window pushed off-screen) and
// closes right after. Both are headful so Cloudflare clears. Extraction runs in
// the background by default; toggle "don't hide browser window" in settings to
// watch it on-screen instead.
function getExtractionMode() {
  return loadSettings().dontHideBrowserWindow ? 'visible' : 'background';
}
const browser = new BrowserManager({
  userDataDir: './user-data',
  onCapture: (rec) => {
    if (suppressNextCapture) {
      suppressNextCapture = false;
      console.log(`[capture] ${rec.source} (neutral probe — awaiting trigger capture)`);
      resolveWaiters({ id: null, payload: rec.payload, source: rec.source, ts: Date.now() });
      return;
    }
    if (pendingCaptureId) {
      const stored = store.attachPayload(pendingCaptureId, rec.payload, rec.source);
      pendingCaptureId = null;
      if (stored) {
        console.log(`[capture] ${stored.source} ${stored.id} (attached to inspection)`);
        broadcast('capture', { id: stored.id });
        resolveWaiters(stored);
        return;
      }
      // record vanished — fall through to a normal save
    }
    const stored = store.save(rec);
    console.log(`[capture] ${stored.source} ${stored.id} (${stored.payload.model || '?'})`);
    broadcast('capture', { id: stored.id });
    resolveWaiters(stored);
  },
  onCaptureError: (error) => {
    rejectWaiters(error);
  },
});

function composerOpts() {
  return {
    inputSelector: undefined,
    sendSelector: undefined,
  };
}

/**
 * Send "." to read the card (probe, not saved), then send a keyword-dense message
 * so the closed lorebook fires on as many keys as possible. We stuff the card
 * (and selected trigger sources) into a single latest
 * user turn so every keyword is within scan depth regardless of JanitorAI's
 * server-side scan rules (which scan recent messages by depth, not by author).
 * Returns the neutral probe (for card recovery) and the second ("full") capture.
 * The trigger capture is intentionally reserved for lorebook isolation: it can
 * contain lorebook text injected into character fields.
 */
async function runAutoTrigger(page, extraTriggerText = '', includeCard = true) {
  const opts = composerOpts();
  const settleMs = 1500;

  suppressNextCapture = true;
  const dotWait = waitNextCapture(60000);
  await sendMessage(page, '.', opts);
  const dotCap = await dotWait;
  console.log('[capture] neutral probe captured; preparing lorebook trigger');

  const card = extractCard(dotCap.payload);
  if (!card) throw new Error('could not find the character card in the capture');

  const triggerText = includeCard ? [card, extraTriggerText].filter(Boolean).join('\n\n') : extraTriggerText;
  if (!triggerText) throw new Error('select at least one trigger source');

  await page.waitForTimeout(settleMs);
  const fullWait = waitNextCapture(120000);
  await sendMessage(page, triggerText, opts);
  const fullCap = await fullWait;
  console.log('[capture] lorebook trigger captured');

  return { card, probeCap: dotCap, fullCap };
}

function lorebookNames(rec) {
  const names = new Set();
  for (const book of rec.publicLorebooks || []) {
    const title = String((book && book.title) || '').trim();
    if (title) names.add(title);
  }
  for (const script of ((rec.meta && rec.meta.scripts) || [])) {
    const title = String((script && script.title) || '').trim();
    if (title) names.add(title);
  }
  return [...names].join('\n');
}

function buildTriggerText(rec, trigger) {
  const opts = trigger && typeof trigger === 'object' ? trigger : {};
  const ctx = rec.context || {};
  const add = (key, text, fallback = false) => {
    if ((opts[key] ?? fallback) && text) return String(text).trim();
    return '';
  };
  const savedDefault = loadSettings().defaultLoreTriggerText || '';
  const parts = [
    add('siteDescription', ctx.description),
    add('scenario', ctx.scenario),
    add('greetings', ctx.greetings, true),
    add('lorebookNames', lorebookNames(rec)),
    add('savedDefault', savedDefault, true),
    add('custom', opts.customText),
  ].filter(Boolean);
  return { includeCard: opts.card !== false, text: parts.join('\n\n') };
}

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/version', (_req, res) => {
  const pkg = require('../package.json');
  res.json({ version: pkg.version });
});

// Token counting (o200k_base, same tokenizer as GlazeFlutter). Accepts either a
// single `{ text }` → `{ n }`, or a batch `{ texts: [...] }` → `{ counts: [...] }`.
app.post('/api/tokens', (req, res) => {
  const { text, texts } = req.body || {};
  if (Array.isArray(texts)) {
    return res.json({ counts: texts.map((t) => countTokens(t)) });
  }
  res.json({ n: countTokens(text) });
});

app.get('/api/captures', (req, res) => res.json(store.list()));

app.get('/api/captures/:id', (req, res) => {
  const rec = store.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  res.json(rec);
});

app.delete('/api/captures/:id', (req, res) => {
  res.json({ ok: store.remove(req.params.id) });
});

app.post('/api/separate', (req, res) => {
  const rec = store.get(req.body.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  const publicContents = publicEntryContents(rec.publicLorebooks);
  const base = separate(rec.payload, req.body.knownCard || '', publicContents);
  const built = assembleResult(
    rec, rec.probePayload, '', rec.context, rec.meta, rec.avatarBase64, publicContents,
  );
  res.json({
    ...base,
    lorebookText: built.lorebookText,
    entries: splitEntries(built.lorebookText),
    removed: built.provenance,
    fieldInjections: built.fieldInjections,
  });
});

/**
 * Resolve the raw lorebook text and the per-source context the build LLM should
 * receive, from the request body + stored record. Shared by /api/extract (which
 * calls the model) and /api/extract-preview (which only shows the prompt).
 * @returns {{lorebookText:string, opts:object}}
 */
function resolveExtractInputs(req) {
  const rec = req.body.id ? store.get(req.body.id) : null;
  // "advanced" / Nine API lorebooks inject entries the heuristic separator cannot
  // reliably isolate, so the model is handed the FULL assembled system prompt (plus
  // the clean card/scenario as context) and isolates the lore itself.
  const fromRaw = req.body.fromRaw === true;
  let lorebookText = req.body.lorebookText;
  if (!lorebookText) {
    if (!rec || !rec.payload) {
      throw Object.assign(new Error('not found'), { status: 404 });
    }
    if (fromRaw) {
      lorebookText = getSystemContent(rec.payload);
    } else {
      const publicContents = publicEntryContents(rec.publicLorebooks);
      lorebookText = assembleResult(
        rec, rec.probePayload, '', rec.context, rec.meta, rec.avatarBase64, publicContents,
      ).lorebookText;
    }
  }
  // Stored structured context, with a fallback for older captures that only
  // have the legacy combined `catalog` string.
  const ctx = (rec && rec.context)
    || (rec && rec.catalog ? { description: rec.catalog } : {})
    || {};
  const opts = {
    ...buildLlmContext(rec, req.body, ctx),
    // When the raw text is a JanitorAI "advanced" / Nine API lorebook (JS source
    // rather than concatenated entry bodies), select the JS-aware build prompt.
    fromJs: req.body.fromJs === true,
    // When the source is the full, un-separated generateAlpha system prompt (the
    // "advanced" lorebook path), select the isolate-then-build prompt.
    fromRaw,
  };
  return { lorebookText, opts };
}

/**
 * Build LLM context from the cleanest available character source. The triggered
 * capture is deliberately last: it can contain lore injected into card fields.
 */
function buildLlmContext(rec, body = {}, ctx = {}) {
  // Context sources for key inference — each independently selectable from the
  // UI. Custom text is an extra opt-in source. First message(s) default OFF
  // (they can be large); the rest default ON when present.
  const useCard = body.useCard !== false;
  const useCatalog = body.useCatalog !== false;
  const useScenario = body.useScenario !== false;
  const useGreetings = body.useGreetings === true;
  const useLorebookDescs = body.useLorebookDescs !== false;
  const character = (rec && rec.character) || {};
  const baselinePayload = rec && (rec.probePayload || rec.payload);
  const greetingParts = [character.firstMessage, ...(character.alternateGreetings || [])]
    .map((text) => String(text || '').trim())
    .filter(Boolean);

  const card = useCard
    ? (String(character.description || '').trim()
      || extractCard(baselinePayload)
      || body.knownCard || '')
    : '';
  return {
    card,
    catalog: useCatalog ? (ctx.description || '') : '',
    scenario: useScenario
      ? (String(character.scenario || '').trim() || extractScenario(baselinePayload) || ctx.scenario || '')
      : '',
    greetings: useGreetings ? (greetingParts.join('\n\n') || ctx.greetings || '') : '',
    lorebookDescs: useLorebookDescs ? (ctx.lorebooks || '') : '',
    extra: String(body.extraContext || '').trim(),
  };
}

app.post('/api/extract', async (req, res) => {
  try {
    const { lorebookText, opts } = resolveExtractInputs(req);
    const cfg = loadSettings();
    const result = await extract(lorebookText, cfg, opts);
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: String(e.message || e) });
  }
});

// Build the exact prompt the build LLM would receive, WITHOUT calling it — lets
// the UI preview what's being sent.
app.post('/api/extract-preview', (req, res) => {
  try {
    const { lorebookText, opts } = resolveExtractInputs(req);
    res.json({ messages: buildExtractionMessages(lorebookText, opts) });
  } catch (e) {
    res.status(e.status || 500).json({ error: String(e.message || e) });
  }
});

function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
}

/**
 * Build the separately-toggleable key-inference context parts from character
 * catalog metadata. Each part is independently opt-in/out from the UI, so they
 * are kept apart rather than pre-concatenated:
 *   - description: the public catalog card description (name, tags, blurb)
 *   - scenario:    the roleplay scenario/setup
 *   - greetings:   every opening message (joined; all of them when there are many)
 *   - lorebooks:   PUBLIC titles + descriptions of attached lorebooks (the
 *                  lorebook *contents* stay hidden — only their public descriptions)
 */
function buildContextParts(meta) {
  const empty = { description: '', scenario: '', greetings: '', lorebooks: '' };
  if (!meta) return empty;
  const descParts = [];
  if (meta.name) descParts.push(`Name: ${meta.name}`);
  if (Array.isArray(meta.custom_tags) && meta.custom_tags.length) {
    descParts.push(`Tags: ${meta.custom_tags.join(', ')}`);
  }
  const desc = htmlToText(meta.description);
  if (desc) descParts.push(`Card description:\n${desc}`);

  const greetings = collectGreetings(meta, '');

  let lorebooks = '';
  if (Array.isArray(meta.scripts)) {
    // Only items whose description is publicly exposed in the catalog metadata —
    // never the lorebook script/contents themselves.
    const books = meta.scripts
      .filter((s) => s && (s.type === 'lorebook' || s.type === 'advanced'))
      .map((s) => {
        const title = String(s.title || '').trim();
        const d = htmlToText(s.description);
        if (!title && !d) return '';
        return `- ${title}${d ? `: ${d}` : ''}`;
      })
      .filter(Boolean);
    if (books.length) lorebooks = books.join('\n');
  }

  return {
    description: descParts.join('\n\n'),
    scenario: htmlToText(meta.scenario),
    greetings: greetings.join('\n\n---\n\n'),
    lorebooks,
  };
}

/**
 * Build the "lorebook descriptions" context from fetched public lorebooks: each
 * book's page title plus its page description (`- Title: description`). A closed
 * or description-less page contributes only its title (`- Title`). The lorebook
 * *contents* are never included — only the public page description.
 *
 * JanitorAI exposes only lorebook titles in the character metadata; the
 * descriptions live on each lorebook's own /hampter/script/<id> page, so they
 * come from the {@link module:publiclore.fetchPublicLorebooks} records.
 */
function lorebookDescsFromBooks(books) {
  const lines = [];
  for (const b of books || []) {
    const title = String((b && b.title) || '').trim();
    const desc = htmlToText(b && b.description);
    if (!title && !desc) continue;
    lines.push(desc ? `- ${title}: ${desc}` : `- ${title}`);
  }
  return lines.join('\n');
}

/** Flatten context parts into a single string (legacy combined `catalog` field). */
function combineContext(ctx) {
  if (!ctx) return '';
  const parts = [];
  if (ctx.description) parts.push(ctx.description);
  if (ctx.scenario) parts.push(`Scenario:\n${ctx.scenario}`);
  if (ctx.greetings) parts.push(`Opening message(s):\n${ctx.greetings}`);
  if (ctx.lorebooks) {
    parts.push(`Attached lorebooks (public descriptions only — contents hidden):\n${ctx.lorebooks}`);
  }
  return parts.join('\n\n');
}

/**
 * Collect every opening message a character ships with, de-duplicated and in
 * order. JanitorAI exposes multiple greetings as `first_messages` (array);
 * older/single-greeting cards only have `first_message`. The captured prompt's
 * greeting is used as a fallback when metadata is unavailable.
 * @returns {string[]} greetings — index 0 is the primary, the rest are alternates.
 */
function collectGreetings(meta, capturedFirst) {
  const out = [];
  const push = (v) => {
    const s = String(v == null ? '' : v).trim();
    if (s && !out.includes(s)) out.push(s);
  };
  if (meta) {
    if (Array.isArray(meta.first_messages)) meta.first_messages.forEach(push);
    push(meta.first_message);
    if (Array.isArray(meta.alternate_greetings)) meta.alternate_greetings.forEach(push);
  }
  if (!out.length) push(capturedFirst);
  return out;
}

/**
 * Whether the creator left the definition PUBLIC (`showdefinition`). When true,
 * JanitorAI's own /hampter/characters/:id returns the real card fields, so the
 * card can be taken verbatim with NO generateAlpha extraction needed.
 */
function isCardPublic(meta) {
  return !!(meta && meta.showdefinition
    && (String(meta.personality || '').trim() || String(meta.scenario || '').trim()));
}

/**
 * Build the character card straight from public catalog metadata — exact and
 * lossless, no reconstruction. Used when {@link isCardPublic} is true (both at
 * inspection time and in the capture result).
 */
function buildPublicCharacter(meta, avatarBase64) {
  const greetings = collectGreetings(meta, '');
  return {
    name: (meta && meta.name) || '',
    avatarBase64: avatarBase64 || '',
    description: String((meta && meta.personality) || '').trim(),
    personality: '',
    scenario: String((meta && meta.scenario) || '').trim(),
    firstMessage: greetings[0] || '',
    alternateGreetings: greetings.slice(1),
    exampleMessages: String((meta && meta.example_dialogs) || '').trim(),
    creatorNotes: (meta && meta.description) || '',
    tags: (meta && meta.custom_tags) || [],
    definitionSource: 'janitor',
  };
}

/** Build a card from the character definition embedded in a chat archive. */
function buildChatCharacter(chat) {
  const meta = (chat && chat.character) || {};
  const greetings = collectGreetings(meta, '');
  return {
    name: meta.name || meta.chat_name || '',
    avatarBase64: '',
    description: String(meta.personality || meta.description || '').trim(),
    personality: '',
    scenario: String(meta.scenario || '').trim(),
    firstMessage: greetings[0] || '',
    alternateGreetings: greetings.slice(1),
    exampleMessages: String(meta.example_dialogs || '').trim(),
    creatorNotes: String(meta.description || '').trim(),
    tags: Array.isArray(meta.custom_tags) ? meta.custom_tags : [],
    definitionSource: 'chat',
  };
}

function conversationSummary(chat, chatId) {
  const meta = (chat && chat.chat) || chat || {};
  return {
    chatId: String(chatId || meta.id || meta.chat_id),
    url: `https://janitorai.com/chats/${chatId || meta.id || meta.chat_id}`,
    title: String(meta.name || meta.title || meta.chat_name || meta.name_for_display || '').trim(),
    messageCount: Array.isArray(chat && chat.chatMessages) ? chat.chatMessages.length : (meta.message_count || 0),
    updatedAt: meta.updated_at || meta.updatedAt || meta.created_at || new Date().toISOString(),
    createdAt: meta.created_at || meta.createdAt || '',
  };
}

/**
 * Assemble the capture result: isolated lorebook text and the extracted
 * character card. Does NOT auto-build with LLM — user triggers that manually.
 */
function assembleResult(fullCap, probePayload, card, ctx, meta, avatarBase64, publicContents) {
  const sep = separate(fullCap.payload, '', publicContents);
  const fieldInjections = scanInjectedFields({
    capture: fieldsFromPayload(fullCap.payload),
    probe: probePayload ? fieldsFromPayload(probePayload) : null,
    clean: isCardPublic(meta) ? fieldsFromMeta(meta) : null,
    publicContents,
    existing: sep.lorebookText,
  });
  const lorebookText = appendRecovered(sep.lorebookText, fieldInjections);
  const provenance = sep.removed.concat(fieldInjections.map((block) => ({
    label: `injected${block.field[0].toUpperCase()}${block.field.slice(1)}`,
    text: block.text,
  })));

  // The trigger is keyword-dense by design, so JanitorAI may inject lorebook
  // content into its persona/scenario/example fields. Build the private card
  // from the neutral "." probe instead, falling back to the trigger only for
  // older captures that have no saved probe at all.
  const payload = probePayload || fullCap.payload;
  const greetings = collectGreetings(meta, extractFirstMessage(payload));

  // Public definition → take the real fields verbatim; otherwise reconstruct the
  // card from the leaked generateAlpha prompt. `definitionSource` tells the UI.
  const character = isCardPublic(meta) ? buildPublicCharacter(meta, avatarBase64) : {
    name: extractCharName(payload) || (meta && meta.name) || '',
    avatarBase64: avatarBase64 || '',
    description: extractCard(payload) || card || '',
    personality: '',
    scenario: extractScenario(payload) || (meta && meta.scenario) || '',
    firstMessage: greetings[0] || '',
    alternateGreetings: greetings.slice(1),
    exampleMessages: extractExample(payload) || '',
    creatorNotes: (meta && meta.description) || '',
    tags: (meta && meta.custom_tags) || [],
    definitionSource: 'reconstructed',
  };

  return {
    lorebookText,
    card,
    catalog: combineContext(ctx),
    character,
    fieldInjections,
    provenance,
  };
}

/** Fetch the catalog-facing character data without generating a chat prompt. */
async function inspectCharacter(charUrl, characterId) {
  return browser.withBrowser(async (ctx) => {
    await requireLogin(ctx);
    const pages = ctx.pages();
    const page = pages.find((p) => p.url().includes('janitorai.com')) || pages[0]
      || (await ctx.newPage());
    await page.goto(charUrl, { waitUntil: 'domcontentloaded' }).catch(() => { });

    const meta = await fetchCharacter(page, characterId).catch(() => null);
    const ctxParts = buildContextParts(meta);

    let publicLorebooks = [];
    try {
      publicLorebooks = await fetchPublicLorebooks(page, meta);
      const ok = publicLorebooks.filter((b) => b.accessible).length;
      console.log(`[publiclore] ${publicLorebooks.length} attached, ${ok} downloadable`);
      // The character metadata only carries lorebook titles — replace the
      // titles-only context with the real page descriptions now that the
      // lorebook pages have been fetched.
      if (publicLorebooks.length) {
        ctxParts.lorebooks = lorebookDescsFromBooks(publicLorebooks);
      }
    } catch (e) {
      console.warn('[publiclore] fetch failed:', e.message);
    }

    let avatarUrl = await getAvatarUrl(page);
    if (!avatarUrl && meta) {
      const av = meta.avatar || meta.profile_image || '';
      if (av) avatarUrl = /^https?:\/\//i.test(av) ? av : `https://ella.janitorai.com/bot-avatars/${av}?width=1200`;
    }
    const avatarBase64 = avatarUrl ? await downloadAvatar(page, avatarUrl) : '';

    return { meta, ctxParts, publicLorebooks, avatarBase64 };
  }, { mode: getExtractionMode() });
}

function refreshedCharacter(rec, out) {
  if (isCardPublic(out.meta)) return buildPublicCharacter(out.meta, out.avatarBase64);

  // A catalog refresh cannot recover a hidden definition. Keep a prior prompt- or
  // chat-derived card visible until the user explicitly re-extracts it, but update
  // the safe catalog fields that accompany it.
  const existing = rec.character || {};
  if (existing.definitionSource === 'reconstructed' || existing.definitionSource === 'chat') {
    return {
      ...existing,
      name: (out.meta && out.meta.name) || existing.name || '',
      avatarBase64: out.avatarBase64 || existing.avatarBase64 || '',
    };
  }
  return {
    name: (out.meta && out.meta.name) || '',
    avatarBase64: out.avatarBase64 || '',
    definitionSource: 'pending',
  };
}

// INSPECT a character from its URL — read-only. Pulls metadata, avatar, public
// lorebooks and key-inference context WITHOUT running the generateAlpha
// extraction. Anything public (the card when `showdefinition` is set, downloadable
// lorebooks) is returned right away; closed lorebooks / a private card require a
// follow-up /api/capture, triggered explicitly by the user.
app.post('/api/inspect', async (req, res) => {
  try {
    const characterId = parseCharacterId(req.body.url);
    const charUrl = /^https?:\/\//i.test(req.body.url)
      ? req.body.url
      : `https://janitorai.com/characters/${characterId}`;
    const out = await inspectCharacter(charUrl, characterId);

    const cardPublic = isCardPublic(out.meta);
    const character = cardPublic
      ? buildPublicCharacter(out.meta, out.avatarBase64)
      : {
        name: (out.meta && out.meta.name) || '',
        avatarBase64: out.avatarBase64 || '',
        definitionSource: 'pending',
      };

    const rec = store.saveInspection({
      url: charUrl,
      characterId,
      characterName: (out.meta && out.meta.name) || '',
      meta: out.meta,
      context: out.ctxParts,
      publicLorebooks: out.publicLorebooks,
      avatarBase64: out.avatarBase64,
      character,
      cardPublic,
    });
    broadcast('capture', { id: rec.id });

    res.json({
      id: rec.id,
      characterName: rec.characterName,
      cardPublic,
      character,
      publicLorebooks: out.publicLorebooks,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Refresh catalog-facing data on an existing record. This intentionally does not
// run a chat capture, so it can update public cards/lorebooks without replacing a
// hidden card or closed-lorebook extraction.
app.post('/api/captures/:id/refresh', async (req, res) => {
  try {
    const rec = store.get(req.params.id);
    if (!rec) return res.status(404).json({ error: 'not found' });
    const characterId = rec.characterId || parseCharacterId(rec.url);
    const charUrl = rec.url || `https://janitorai.com/characters/${characterId}`;
    const out = await inspectCharacter(charUrl, characterId);
    const updated = store.refreshInspection(rec.id, {
      url: charUrl,
      characterId,
      characterName: (out.meta && out.meta.name) || rec.characterName,
      meta: out.meta,
      context: out.ctxParts,
      publicLorebooks: out.publicLorebooks,
      avatarBase64: out.avatarBase64,
      cardPublic: isCardPublic(out.meta),
      character: refreshedCharacter(rec, out),
    });
    broadcast('capture', { id: updated.id });
    res.json({ id: updated.id, cardPublic: updated.cardPublic });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// EXTRACT on demand — runs the generateAlpha capture for an already-inspected
// character (create chat, "." probe → card, then card-as-message → closed
// lorebook). The capture is attached to the SAME record. Shared by the card and
// lorebook "extract" buttons; if the record is already captured it is reused
// (a single capture yields both the reconstructed card and the raw lorebook).
app.post('/api/capture', async (req, res) => {
  try {
    const rec = req.body.id ? store.get(req.body.id) : null;
    if (!rec) return res.status(404).json({ error: 'not found' });

    const meta = rec.meta || null;
    if (!allowsProxy(meta)) {
      return res.status(422).json({ error: proxyForbiddenError().message, code: 'PROXY_FORBIDDEN' });
    }
    const publicContents = publicEntryContents(rec.publicLorebooks);
    const avatarBase64 = (rec.character && rec.character.avatarBase64) || '';

    // Already captured → reuse the stored payload unless the user explicitly
    // requests a fresh trigger run with different source selections or keywords.
    if (rec.payload && !req.body.force) {
      const built = assembleResult(
        rec, rec.probePayload, '', rec.context, meta, avatarBase64, publicContents,
      );
      return res.json({
        id: rec.id, lorebookText: built.lorebookText, character: built.character, reused: true,
      });
    }

    const characterId = rec.characterId || parseCharacterId(rec.url);
    const built = await browser.withBrowser(async (ctx) => {
      await requireLogin(ctx);
      const pages = ctx.pages();
      const page = pages.find((p) => p.url().includes('janitorai.com')) || pages[0]
        || (await ctx.newPage());

      let profileSnapshot = null;
      try {
        profileSnapshot = await enterExtractionMode(page);
      } catch (e) {
        console.warn('[profile] could not enter extraction mode:', e.message);
      }

      let personaId = null;
      let chatId = null;
      try {
        await page.goto(rec.url || `https://janitorai.com/characters/${characterId}`,
          { waitUntil: 'domcontentloaded' }).catch(() => { });

        try {
          const persona = await ensureUserMacroPersona(page);
          personaId = persona.id;
          browser.setPersonaOverride(persona);
        } catch (e) {
          console.warn('[persona] could not ensure {{user}} persona:', e.message);
        }

        // Reuse an existing chat when available, otherwise create a new one.
        // If the saved chat is no longer accessible (deleted externally), fall
        // back to creating a fresh chat.
        if (rec.chatId) {
          chatId = rec.chatId;
          try {
            const probe = await authedFetch(page, `https://janitorai.com/hampter/chats/${chatId}`);
            if (probe.status >= 400) {
              console.log(`[chat] saved chat ${chatId} is gone, creating new one`);
              chatId = null;
            }
          } catch (_) {
            chatId = null;
          }
        }
        if (!chatId) {
          chatId = await createChat(page, characterId);
          store.attachChatId(rec.id, chatId);
        } else {
          console.log(`[chat] reusing existing chat ${chatId}`);
        }
        await page.goto(`https://janitorai.com/chats/${chatId}`, { waitUntil: 'domcontentloaded' });

        // JanitorAI caches the selected proxy preset in its client store, so the
        // dummy preset switched in by enterExtractionMode() above may not take
        // effect on the first chat load — the captured `/generateAlpha` would then
        // run against the previous (e.g. JLLM) preset and lose its wrappers. Reload
        // the chat page once to force the new preset to take effect before the
        // auto-trigger fires generateAlpha.
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => { });

        const trigger = buildTriggerText(rec, req.body.trigger);
        // Attach the upcoming generateAlpha capture to THIS inspected record.
        pendingCaptureId = rec.id;
        const { card, probeCap, fullCap } = await runAutoTrigger(
          page, trigger.text, trigger.includeCard,
        );

        const result = assembleResult(
          fullCap, probeCap.payload, card, rec.context, meta, avatarBase64, publicContents,
        );
        store.attachProbePayload(rec.id, probeCap.payload);
        console.log(`[capture] neutral probe stored with ${rec.id}`);
        store.attachCardData(fullCap.id, result.character);

        // If closed lorebook content was extracted → the chat served its purpose,
        // clean it up. Otherwise keep it so the user can retry with different
        // messages (or the next auto-trigger variant).
        if (result.lorebookText && result.lorebookText.trim()) {
          try {
            await deleteChat(page, chatId);
            store.clearChatId(rec.id);
          } catch (e) {
            console.warn('[chat] delete failed (chat kept):', e.message);
          }
        } else {
          console.log(`[chat] no closed content extracted, keeping chat ${chatId} for retry`);
        }

        return result;
      } finally {
        pendingCaptureId = null;
        browser.setPersonaOverride(null);
        if (personaId) {
          await deletePersona(page, personaId)
            .catch((e) => console.warn('[persona] delete failed:', e.message));
        }
        if (profileSnapshot) {
          await restoreProfile(page, profileSnapshot)
            .catch((e) => console.warn('[profile] restore failed:', e.message));
        }
      }
    }, { mode: getExtractionMode() });

    res.json({ id: rec.id, lorebookText: built.lorebookText, character: built.character });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    suppressNextCapture = false;
    pendingCaptureId = null;
  }
});

// Download the PUBLIC lorebooks attached to a character, by URL/id. Lighter than
// /api/run (no chat creation / auto-trigger): just opens the browser, reads the
// character metadata and pulls each attached public lorebook script.
app.post('/api/public-lorebooks', async (req, res) => {
  try {
    const characterId = parseCharacterId(req.body.url);
    const books = await browser.withBrowser(async (ctx) => {
      await requireLogin(ctx);
      const pages = ctx.pages();
      const page = pages.find((p) => p.url().includes('janitorai.com')) || pages[0]
        || (await ctx.newPage());
      const meta = await fetchCharacter(page, characterId).catch(() => null);
      if (!meta) throw new Error('could not read character metadata');
      return fetchPublicLorebooks(page, meta);
    }, { mode: getExtractionMode() });
    res.json({ publicLorebooks: books });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Export exactly one conversation owned by the active JanitorAI account. The
// browser-page fetch retains the Cloudflare/session context; no login token is
// exposed, and the archive is only returned to the local UI for download.
app.post('/api/chat-export', async (req, res) => {
  try {
    const chatId = parseChatId(req.body && req.body.chat);
    const result = await browser.withBrowser(async (ctx) => {
      await requireLogin(ctx);
      const pages = ctx.pages();
      const page = pages.find((p) => p.url().includes('janitorai.com')) || pages[0]
        || (await ctx.newPage());
      const [chat, profile] = await Promise.all([fetchChat(page, chatId), fetchMyProfile(page)]);
      return { ...toJsonl(chat, profile), raw: chat };
    }, { mode: getExtractionMode() });
    if (!result.sourceMessageCount) return res.status(404).json({ error: 'this conversation has no messages' });
    res.json({
      chatId,
      characterName: result.names.fullName,
      userName: result.names.userName,
      messageCount: result.sourceMessageCount,
      raw: result.raw,
      jsonl: result.jsonl,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Turn a pasted chat/message URL into a character record, then retain the chat
// id on that record. Later exports always re-fetch the conversation, so they
// include its latest messages without duplicating whole chat archives on disk.
app.post('/api/chat-import', async (req, res) => {
  try {
    const chatId = parseChatId(req.body && req.body.chat);
    const chat = await browser.withBrowser(async (ctx) => {
      await requireLogin(ctx);
      const pages = ctx.pages();
      const page = pages.find((p) => p.url().includes('janitorai.com')) || pages[0]
        || (await ctx.newPage());
      return fetchChat(page, chatId);
    }, { mode: getExtractionMode() });
    const meta = chat.character || {};
    const characterId = String(meta.id || chat.chat && chat.chat.character_id || '');
    if (!characterId) throw new Error('the chat archive did not include a character id');
    const conversation = conversationSummary(chat, chatId);
    const requestedRecord = req.body && req.body.recordId ? store.get(req.body.recordId) : null;
    if (req.body && req.body.recordId && !requestedRecord) {
      return res.status(404).json({ error: 'character record not found' });
    }
    if (requestedRecord && requestedRecord.characterId !== characterId) {
      return res.status(400).json({ error: 'this conversation belongs to a different character' });
    }
    let rec = requestedRecord || store.findByCharacterId(characterId);
    if (rec) {
      rec = store.attachConversation(rec.id, conversation);
    } else {
      const character = buildChatCharacter(chat);
      rec = store.saveInspection({
        url: `https://janitorai.com/characters/${characterId}`,
        source: 'chat',
        characterId,
        characterName: character.name,
        meta,
        context: buildContextParts(meta),
        character,
        cardPublic: true,
        conversations: [conversation],
      });
    }
    broadcast('capture', { id: rec.id });
    res.json({ id: rec.id, conversation });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Find every chat belonging to the signed-in account for this exact character.
// Archives remain remote until exported; only lightweight IDs/details are kept.
app.post('/api/character-conversations', async (req, res) => {
  try {
    const recordId = req.body && req.body.recordId;
    const record = store.get(recordId);
    if (!record) return res.status(404).json({ error: 'character record not found' });
    if (!record.characterId) return res.status(400).json({ error: 'this character does not have a JanitorAI character id' });
    const result = await browser.withBrowser(async (ctx) => {
      await requireLogin(ctx);
      const pages = ctx.pages();
      const page = pages.find((p) => p.url().includes('janitorai.com')) || pages[0]
        || (await ctx.newPage());
      const listing = await fetchCharacterChats(page, record.characterId);
      // The current listing is a compact ID list. Re-fetch every returned chat
      // to confirm it is this character and to retain useful local metadata.
      const chats = [];
      for (const listed of listing.chats) {
        const chatId = String(listed.id || listed.chat_id);
        const chat = await fetchChat(page, chatId);
        const characterId = String((chat.character && chat.character.id)
          || (chat.chat && chat.chat.character_id) || '');
        if (characterId === record.characterId) chats.push(chat);
      }
      return { chats, source: listing.source };
    }, { mode: getExtractionMode() });
    let updated = record;
    for (const chat of result.chats) {
      const chatId = String((chat.chat && chat.chat.id) || chat.id || chat.chat_id);
      updated = store.attachConversation(record.id, conversationSummary(chat, chatId));
    }
    broadcast('capture', { id: record.id });
    res.json({ id: record.id, found: result.chats.length, source: result.source, conversations: updated.conversations || [] });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/conversation-refresh', async (req, res) => {
  try {
    const record = store.get(req.body && req.body.recordId);
    const chatId = String(req.body && req.body.chatId || '');
    if (!record) return res.status(404).json({ error: 'character record not found' });
    if (!(record.conversations || []).some((item) => String(item && item.chatId) === chatId)) {
      return res.status(404).json({ error: 'conversation is not linked to this character' });
    }
    const chat = await browser.withBrowser(async (ctx) => {
      await requireLogin(ctx);
      const pages = ctx.pages();
      const page = pages.find((p) => p.url().includes('janitorai.com')) || pages[0] || (await ctx.newPage());
      return fetchChat(page, chatId);
    }, { mode: getExtractionMode() });
    const characterId = String((chat.character && chat.character.id) || (chat.chat && chat.chat.character_id) || '');
    if (characterId !== record.characterId) return res.status(400).json({ error: 'this conversation belongs to a different character' });
    const prior = (record.conversations || []).find((item) => String(item && item.chatId) === chatId) || {};
    const summary = conversationSummary(chat, chatId);
    if (!summary.title) summary.title = prior.title || '';
    const updated = store.updateConversation(record.id, chatId, summary);
    broadcast('capture', { id: record.id });
    res.json({ id: record.id, conversation: updated.conversations.find((item) => item.chatId === chatId) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/conversation-label', (req, res) => {
  const recordId = req.body && req.body.recordId;
  const chatId = req.body && req.body.chatId;
  const title = String(req.body && req.body.title || '').trim().slice(0, 200);
  const updated = store.updateConversation(recordId, chatId, { label: title });
  if (!updated) return res.status(404).json({ error: 'conversation is not linked to this character' });
  broadcast('capture', { id: recordId });
  res.json({ id: recordId });
});

app.post('/api/conversation-delete', (req, res) => {
  const recordId = req.body && req.body.recordId;
  const chatId = req.body && req.body.chatId;
  const updated = store.removeConversation(recordId, chatId);
  if (!updated) return res.status(404).json({ error: 'character record not found' });
  broadcast('capture', { id: recordId });
  res.json({ id: recordId });
});

// Check login status (opens browser briefly in background, closes after).
app.get('/api/status', async (req, res) => {
  try {
    const data = await browser.withBrowser((ctx) => getStatus(ctx),
      { mode: 'background' });
    res.json(data);
  } catch (e) {
    res.json({ ready: false, loggedIn: false });
  }
});

// ---- JanitorAI login (interactive in the real browser; self-checked) --------
// Opens janitorai.com/login in a VISIBLE window; the user signs in there
// (email/password, Google, Cloudflare). The server auto-detects the session
// itself (polls the authed endpoint, like GlazeFlutter's login sheet). Once
// logged in we CLOSE the browser — the session persists in user-data/ and
// extraction reopens it off-screen on demand. If sign-in hasn't completed within
// the window, we leave it open so the user can finish.
app.post('/api/login', async (req, res) => {
  try {
    const data = await browser.withBrowser(async (ctx) => {
      const login = await openLogin(ctx);
      if (!login.loggedIn) return login;

      // Confirm the persistent profile survives the close/reopen transition used
      // by extraction, rather than reporting success from the login window alone.
      await browser.dispose();
      try {
        const freshContext = await browser.ensureStarted('background');
        return await getStatus(freshContext);
      } finally {
        await browser.dispose();
      }
    }, { mode: 'visible', keepOpen: true });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Sign out of JanitorAI: clear the persisted browser session, then close it.
app.post('/api/logout', async (req, res) => {
  try {
    const data = await browser.withBrowser((ctx) => logout(ctx), { mode: 'background' });
    await browser.dispose();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- save outputs to disk (the standalone's stand-in for ST's import) ----
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
function ensureOutput(sub) {
  const dir = sub ? path.join(OUTPUT_DIR, sub) : OUTPUT_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function safeName(name, fallback) {
  return (String(name || '').trim() || fallback).replace(/[^\w.\- ]+/g, '_').slice(0, 80);
}

// Save a built World Info book as importable SillyTavern JSON.
app.post('/api/save-world', (req, res) => {
  try {
    const { worldInfo, name } = req.body || {};
    if (!worldInfo || !worldInfo.entries) return res.status(400).json({ error: 'missing worldInfo' });
    const dir = ensureOutput('worlds');
    const file = path.join(dir, `${safeName(name, 'Janitor Lorebook')}.json`);
    fs.writeFileSync(file, JSON.stringify(worldInfo, null, 2), 'utf8');
    res.json({ ok: true, path: file, entries: Object.keys(worldInfo.entries).length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Save a character as a SillyTavern v2 character card (JSON) + avatar PNG.
app.post('/api/save-character', (req, res) => {
  try {
    const c = req.body || {};
    if (!c.name) return res.status(400).json({ error: 'character name is required' });
    const dir = ensureOutput('characters');
    const base = safeName(c.name, 'character');
    const tags = Array.isArray(c.tags) ? c.tags
      : String(c.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
    const alternateGreetings = (Array.isArray(c.alternateGreetings) ? c.alternateGreetings
      : []).map((g) => String(g || '').trim()).filter(Boolean);

    const data = {
      name: c.name,
      description: c.description || '',
      personality: c.personality || '',
      scenario: c.scenario || '',
      first_mes: c.firstMessage || '',
      mes_example: c.exampleMessages || '',
      creator_notes: c.creatorNotes || '',
      tags,
      alternate_greetings: alternateGreetings,
      talkativeness: '0.5',
      fav: false,
      creator: 'janitor-lorebook-extractor',
      character_version: '1.0',
    };
    const card = { spec: 'chara_card_v2', spec_version: '2.0', data };
    const jsonFile = path.join(dir, `${base}.json`);
    fs.writeFileSync(jsonFile, JSON.stringify(card, null, 2), 'utf8');

    let avatarFile = '';
    if (typeof c.avatarBase64 === 'string' && c.avatarBase64.startsWith('data:image/')) {
      const b64 = c.avatarBase64.split(',')[1] || '';
      avatarFile = path.join(dir, `${base}.png`);
      fs.writeFileSync(avatarFile, Buffer.from(b64, 'base64'));
    }
    res.json({ ok: true, path: jsonFile, avatar: avatarFile || null });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/settings', (req, res) => {
  // Never expose the Saucepan bearer token to the client — status is reported
  // via /api/saucepan/status instead.
  const { saucepanToken, ...safe } = loadSettings();
  res.json(safe);
});
app.post('/api/settings', (req, res) => {
  const cur = loadSettings();
  // Spread `cur` first so unrelated persisted fields (e.g. saucepanToken) survive.
  const next = {
    ...cur,
    baseUrl: req.body.baseUrl ?? cur.baseUrl,
    apiKey: req.body.apiKey ?? cur.apiKey,
    model: req.body.model ?? cur.model,
    dontHideBrowserWindow: req.body.dontHideBrowserWindow ?? cur.dontHideBrowserWindow,
    defaultLoreTriggerText: req.body.defaultLoreTriggerText ?? cur.defaultLoreTriggerText,
  };
  saveSettings(next);
  const { saucepanToken, ...safe } = next;
  res.json(safe);
});

// ---- Saucepan (saucepan.ai) native extraction -----------------------------
// A separate source from JanitorAI: no browser needed. The companion definition
// comes straight from Saucepan's authed REST API and is reassembled from its
// obfuscated fragments (see src/saucepan.js). A bearer token is required —
// obtained via handle/password login or pasted directly — and persisted locally.

function persistSaucepanToken(tok) {
  saucepan.setToken(tok);
  saveSettings({ ...loadSettings(), saucepanToken: saucepan.getToken() });
}

app.get('/api/saucepan/status', (_req, res) => {
  res.json({ loggedIn: saucepan.hasToken() });
});

app.post('/api/saucepan/login', async (req, res) => {
  try {
    const { handle, password } = req.body || {};
    if (!handle || !password) return res.status(400).json({ error: 'handle and password are required' });
    const tok = await saucepan.login(handle, password);
    persistSaucepanToken(tok);
    res.json({ ok: true, loggedIn: true });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.post('/api/saucepan/set-token', (req, res) => {
  const tok = String((req.body && req.body.token) || '').trim();
  if (!tok) return res.status(400).json({ error: 'token is required' });
  persistSaucepanToken(tok);
  res.json({ ok: true, loggedIn: true });
});

app.post('/api/saucepan/logout', (_req, res) => {
  persistSaucepanToken('');
  res.json({ ok: true, loggedIn: false });
});

// Extract a Saucepan companion by URL and save it as an inspection record so it
// shows in the sidebar and populates the character-card form (same shape as
// /api/inspect). The card is complete — no follow-up capture needed.
app.post('/api/saucepan/extract', async (req, res) => {
  try {
    const url = String((req.body && req.body.url) || '').trim();
    if (!url) return res.status(400).json({ error: 'url is required' });
    const { companionId, character } = await saucepan.extractCompanion(url);
    const rec = store.saveInspection({
      url,
      characterId: companionId,
      characterName: character.name,
      character,
      avatarBase64: character.avatarBase64 || '',
      cardPublic: true,
      source: 'saucepan',
    });
    broadcast('capture', { id: rec.id });
    res.json({ id: rec.id, characterName: rec.characterName, character });
  } catch (e) {
    res.status(e.status || 500).json({ error: String(e.message || e) });
  }
});

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write(': connected\n\n');
  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
    // Safety net: if the UI is fully closed and the browser somehow lingers
    // (e.g. a login window left open), close it. Never interrupts a live run.
    if (sseClients.size === 0 && !browser.busy) browser.dispose();
  });
});

/** Open the UI in the user's default browser. */
function openInDefaultBrowser(url) {
  const { spawn } = require('child_process');
  try {
    if (process.platform === 'win32') {
      // `start` is a cmd builtin; the empty "" is the window title arg.
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (_) { /* non-fatal: the URL is printed below anyway */ }
}

if (require.main === module) {
  // Bind to loopback only: the server handles Saucepan credentials/token and has
  // no auth, so it must never be reachable from the LAN.
  app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`[JAR]  ${url}`);
    console.log('[JAR]  browser opens only for login (visible) / extraction (off-screen), closes after.');
    openInDefaultBrowser(url);
  });

  // Tear the browser down cleanly on exit.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { browser.dispose().finally(() => process.exit(0)); });
  }
}

module.exports = { app, assembleResult, buildLlmContext };
