'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  selected: null, worldInfo: null, character: null, publicBooks: [], hasAdvanced: false,
  janitorChecked: false,
};

// A character has an "advanced" (Nine API) lorebook when any attached script is of
// type "advanced". Those inject entries the heuristic separator can't isolate, so
// the whole closed-lorebook extraction must go through the LLM (see selectCapture /
// buildExtractBody / runLoreExtract).
function recHasAdvanced(rec) {
  const scripts = rec && rec.meta && rec.meta.scripts;
  return Array.isArray(scripts) && scripts.some((s) => s && s.type === 'advanced');
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch (_) { /* */ }
    throw new Error(msg);
  }
  return res.json();
}

// Token counts (o200k_base) come from the server tokenizer — the same encoding
// GlazeFlutter uses. Cached per text; falls back to ~4 chars/token on failure.
const _tokCache = new Map();

// Count many texts in ONE round-trip, requesting only the not-yet-cached ones.
// Returns counts aligned to `texts`.
async function countTokensBatch(texts) {
  const list = texts.map((x) => String(x || ''));
  const missing = [...new Set(list.filter((x) => x && !_tokCache.has(x)))];
  if (missing.length) {
    try {
      const r = await api('/api/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: missing }),
      });
      const counts = r.counts || [];
      missing.forEach((x, i) => _tokCache.set(x, counts[i] | 0));
    } catch (_) {
      missing.forEach((x) => _tokCache.set(x, Math.ceil(x.length / 4)));
    }
  }
  return list.map((x) => (x ? (_tokCache.get(x) ?? Math.ceil(x.length / 4)) : 0));
}

async function countTokens(text) {
  return (await countTokensBatch([text]))[0];
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ---- capture list ----
async function loadList() {
  const ul = $('captureList');
  ul.innerHTML = `<li class="muted" style="padding:9px 11px;font-size:12px">${t('loading')}</li>`;
  const items = await api('/api/captures');
  ul.innerHTML = '';
  $('emptyHint').style.display = 'block';
  for (const it of items) {
    const li = document.createElement('li');
    if (state.selected === it.id) li.classList.add('active');
    li.dataset.id = it.id;
    li.innerHTML = `
      <div class="li-top">
        <span class="li-char">${escapeHtml(it.characterName || '(unknown)')}</span>
        <span class="li-time">${fmtTime(it.ts)}</span>
      </div>
      <div class="li-preview">${escapeHtml(it.preview || '')}</div>`;
    li.addEventListener('click', () => selectCapture(it.id));
    ul.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Strip HTML tags to plain text (lorebook/catalog descriptions can carry markup).
function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---- source-text blocks (trigger text and LLM key-inference context) ----
// The per-source text the build LLM will receive, derived from the selected
// record. Each is independently toggled AND now revealed in its own block so the
// user sees exactly what gets sent (the card prompt, catalog/scenario/greetings,
// the public lorebook descriptions). Card text is only recovered by the
// extraction itself, so it may be empty until then.
function contextPartsFromRec(rec) {
  const ctx = (rec && rec.context) || {};
  const ch = (rec && rec.character) || {};
  const greetings = [ch.firstMessage, ...(ch.alternateGreetings || [])]
    .map((text) => String(text || '').trim())
    .filter(Boolean)
    .join('\n\n');
  return {
    card: String(ch.description || '').trim(),
    catalog: String(ctx.description || '').trim(),
    scenario: String(ch.scenario || ctx.scenario || '').trim(),
    greetings: greetings || String(ctx.greetings || '').trim(),
    lorebookDescs: String(ctx.lorebooks || '').trim(),
  };
}

function lorebookNamesFromRec(rec) {
  const names = new Set();
  (rec.publicLorebooks || []).forEach((book) => {
    const title = String((book && book.title) || '').trim();
    if (title) names.add(title);
  });
  ((rec.meta && rec.meta.scripts) || []).forEach((script) => {
    const title = String((script && script.title) || '').trim();
    if (title) names.add(title);
  });
  return [...names].join('\n');
}

function triggerPartsFromRec(rec, settings) {
  const ctx = (rec && rec.context) || {};
  const ch = (rec && rec.character) || {};
  return {
    card: String(ch.description || '').trim(),
    catalog: String(ctx.description || '').trim(),
    scenario: String(ctx.scenario || '').trim(),
    greetings: String(ctx.greetings || '').trim(),
    lorebookNames: lorebookNamesFromRec(rec),
    savedDefault: String((settings && settings.defaultLoreTriggerText) || '').trim(),
  };
}

// Fill the content panes of every source block under `rootId`. A source with no content is shown disabled with a
// "Content is empty" hint and can't be selected or expanded. The character card
// is the exception — it's recovered during extraction, so it stays selectable
// and shows a placeholder until then.
function fillContextBlocks(rootId, parts) {
  const root = $(rootId);
  if (!root) return;
  const pending = []; // { len, content } — token counts filled in one batch below
  root.querySelectorAll('.ctx-block[data-ctx]').forEach((block) => {
    const key = block.dataset.ctx;
    if (key === 'extra' || key === 'custom') return; // editable custom text — handled by its checkbox
    const content = (parts && parts[key]) || '';
    const isCard = key === 'card';
    const disabled = !content && !isCard;
    const pre = block.querySelector('.ctx-content');
    const len = block.querySelector('.ctx-len');
    const cb = block.querySelector('input[type=checkbox]');

    block.classList.toggle('empty', disabled);
    if (cb) {
      cb.disabled = disabled;
      if (disabled) cb.checked = false;
    }
    if (len) {
      if (content) {
        len.textContent = '…';
        pending.push({ len, content });
      } else {
        len.textContent = (isCard ? '' : t('ctxContentEmpty'));
      }
    }
    if (pre) {
      pre.textContent = content || (isCard ? t('ctxCardPending') : '');
      if (disabled) { pre.classList.add('hidden'); block.classList.remove('open'); }
    }
  });
  if (pending.length) {
    countTokensBatch(pending.map((p) => p.content)).then((counts) => {
      pending.forEach((p, i) => { p.len.textContent = `${counts[i]} ${t('provTokens')}`; });
    });
  }
}

// One-time wiring: clicking a block header (but not its checkbox/label) expands
// or collapses that source's content pane.
function wireContextExpand(rootId) {
  const root = $(rootId);
  if (!root) return;
  root.addEventListener('click', (e) => {
    if (e.target.closest('label')) return; // checkbox/label → toggle inclusion only
    const head = e.target.closest('.ctx-head');
    if (!head) return;
    const block = head.closest('.ctx-block');
    if (!block || block.classList.contains('empty')) return; // nothing to reveal
    const pre = block.querySelector('.ctx-content');
    if (!pre) return; // e.g. the custom-text block has no content pane
    const nowHidden = pre.classList.toggle('hidden');
    block.classList.toggle('open', !nowHidden);
  });
}

function triggerSelection() {
  return {
    card: $('triggerCard').checked,
    siteDescription: $('triggerSiteDescription').checked,
    scenario: $('triggerScenario').checked,
    greetings: $('triggerGreetings').checked,
    lorebookNames: $('triggerLorebookNames').checked,
    savedDefault: $('triggerSavedDefault').checked,
    custom: $('triggerCustom').checked,
    customText: $('loreTriggerText').value,
  };
}

function previewTriggerText() {
  const selected = triggerSelection();
  const parts = state.triggerParts || {};
  const sources = [
    [selected.card, parts.card || `[${t('ctxCardPending')}]`],
    [selected.siteDescription, parts.catalog],
    [selected.scenario, parts.scenario],
    [selected.greetings, parts.greetings],
    [selected.lorebookNames, parts.lorebookNames],
    [selected.savedDefault, parts.savedDefault],
    [selected.custom, selected.customText.trim()],
  ];
  $('triggerPreviewPre').textContent = sources
    .filter(([enabled, text]) => enabled && text)
    .map(([, text]) => text)
    .join('\n\n');
  $('triggerPreview').classList.remove('hidden');
  $('triggerPreview').open = true;
}

// ---- inline SVG icons (sprite defined in index.html) ----
function iconSvg(name, cls) {
  return `<svg class="icon${cls ? ' ' + cls : ''}"><use href="#i-${name}"></use></svg>`;
}
// status line with a leading icon; text is escaped before injection
function setStatus(el, iconName, text, cls) {
  el.innerHTML = `${iconSvg(iconName, cls)} <span>${escapeHtml(text)}</span>`;
}

// ---- tabs ----
function switchTab(tabId) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tabId));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === tabId));
}

// ---- raw messages rendering ----
function renderMessages(msgs) {
  const container = $('rawMessages');
  container.innerHTML = '';
  for (const m of msgs) {
    const block = document.createElement('div');
    block.className = 'msg-block msg-' + (m.role || 'unknown');
    const header = document.createElement('div');
    header.className = 'msg-role';
    header.textContent = m.role || 'unknown';
    const body = document.createElement('pre');
    body.className = 'msg-body';
    body.textContent = typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2);
    block.appendChild(header);
    block.appendChild(body);
    container.appendChild(block);
  }
}

// ---- detail ----
async function selectCapture(id) {
  // Only a genuinely new selection should jump to the card tab. Reloads after an
  // in-place action (extract / build) keep whatever tab the user is on — pressing
  // a lorebook-tab button must not yank them back to the card.
  const isNewSelection = state.selected !== id;
  state.selected = id;
  state.worldInfo = null;
  document.querySelectorAll('#captureList li').forEach((li) =>
    li.classList.toggle('active', li.dataset.id === id));

  $('detailBody').classList.add('hidden');
  $('detailEmpty').classList.remove('hidden');
  $('detailEmpty').textContent = t('loading');

  const [rec, settings] = await Promise.all([
    api(`/api/captures/${id}`),
    api('/api/settings').catch(() => ({})),
  ]);
  $('detailEmpty').classList.add('hidden');
  $('detailBody').classList.remove('hidden');

  // Reveal separately what is sent to JanitorAI and what is later sent to the LLM.
  state.contextParts = contextPartsFromRec(rec);
  state.triggerParts = triggerPartsFromRec(rec, settings);
  fillContextBlocks('triggerSources', state.triggerParts);
  fillContextBlocks('useSources', state.contextParts);

  const charEl = $('metaChar');
  if (rec.characterId) {
    const charUrl = rec.source === 'saucepan'
      ? (rec.url || `https://saucepan.ai/companion/${rec.characterId}`)
      : `https://janitorai.com/characters/${rec.characterId}`;
    charEl.innerHTML = `${t('charLabel')}: <a href="${escapeHtml(charUrl)}" target="_blank" rel="noopener">${escapeHtml(rec.characterName || rec.characterId)}</a>`;
  } else {
    charEl.textContent = rec.characterName || '(unknown)';
  }
  $('metaTime').textContent = fmtTime(rec.ts);

  // A record is "captured" once the generateAlpha payload is attached. Before
  // that it is only an inspection (metadata + anything already public).
  const captured = !!rec.payload;
  state.captured = captured;
  state.cardPublic = !!rec.cardPublic;
  state.hasAdvanced = recHasAdvanced(rec);

  const msgs = (rec.payload && rec.payload.messages) || [];
  $('msgCount').textContent = msgs.length;
  renderMessages(msgs);
  // Full, unmodified generateAlpha response body — exactly what was received.
  $('rawJson').textContent = rec.payload ? JSON.stringify(rec.payload, null, 2) : '';
  $('provBody').innerHTML = '';
  $('rawBlock').classList.toggle('hidden', !captured);
  $('provBlock').classList.toggle('hidden', !captured);

  fillCharacter(rec.character || null, isNewSelection);

  // The card tab owns all refresh/re-extract actions. A catalog refresh is safe
  // for every record; a prompt capture is offered only when it can recover a
  // private definition or closed lorebook content.
  const hasClosed = (rec.publicLorebooks || []).some((book) => book && !book.accessible && !book.isJs);
  const canExtract = !captured && (!state.cardPublic || hasClosed);
  const canReextract = captured && (!state.cardPublic || hasClosed);
  $('cardExtractBtn').classList.toggle('hidden', !(canExtract || canReextract));
  const actionLabel = canReextract
    ? (state.cardPublic ? 'btnReextractLorebooks' : 'btnReextractPrivate')
    : (state.cardPublic ? 'btnExtractLorebooks' : (hasClosed ? 'btnExtractPrivateAndLorebooks' : 'btnExtractCard'));
  $('cardExtractBtn').querySelector('span').textContent = t(actionLabel);
  const actionHint = canReextract
    ? 'cardReextractHint'
    : (state.cardPublic ? 'cardExtractLoreHint' : (hasClosed ? 'cardExtractBothHint' : 'cardPrivateHint'));
  $('cardExtractHint').textContent = (canExtract || canReextract)
    ? t(actionHint)
    : t('cardRefreshHint');
  $('cardExtractStatus').textContent = '';

  // reset working areas
  $('lorebookText').value = '';
  $('lorebookEntries').innerHTML = '';
  $('worldInfoPre').textContent = '';
  $('buildStatus').textContent = '';
  $('buildTimer').textContent = '';
  $('buildResult').classList.add('hidden');
  $('promptPreview').classList.add('hidden');
  $('promptPre').textContent = '';
  $('linkChatStatus').textContent = '';
  renderPublicBooks(rec.publicLorebooks || []);
  renderConversations(rec);

  // auto-run separation only when there's a captured payload to separate.
  if (captured && state.hasAdvanced) {
    // "advanced" lorebook: the heuristic separator is unreliable, so the LLM does
    // the isolation. Feed it the full assembled system prompt (with the clean
    // card/scenario carried as context). The textarea holds that raw source.
    const sys = (msgs.find((m) => m && m.role === 'system') || {}).content || '';
    $('lorebookText').value = sys;
    renderExtractedContent('', t('advancedExtractedNotice'));
    $('provBody').innerHTML = `<div class="prov-note">${iconSvg('code')} ${escapeHtml(t('advancedBreakdownNotice'))}</div>`;
  } else if (captured) {
    try {
      const r = await api('/api/separate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: state.selected, knownCard: '' }),
      });
      $('lorebookText').value = r.lorebookText;
      renderExtractedContent(r.lorebookText || '');
      renderProvenance(rec, r);
    } catch (_) { /* */ }
  }
  updateLorebookEmpty();
}

// Closed lorebooks always show both their trigger controls and LLM configuration.
// Building itself remains disabled until a prompt has been captured.
function updateLorebookEmpty() {
  const books = state.publicBooks || [];
  const openCount = books.filter((b) => b.accessible).length;
  const closedCount = books.filter((b) => !b.accessible).length;
  const hasEntries = $('lorebookEntries').children.length > 0;
  const captured = state.captured;
  const hasClosed = closedCount > 0;
  const empty = !books.length && !hasEntries && !captured;
  $('noLorebook').classList.toggle('hidden', !empty);

  // "advanced" (JS) lorebooks: explain that the content must be built via the LLM,
  // and drop the heuristic "extracted content" preview + "download txt" path —
  // there's nothing meaningful to show or download before the LLM build.
  const adv = state.hasAdvanced === true;
  $('advancedNotice').classList.toggle('hidden', !adv);
  $('dlExtractedRow').classList.toggle('hidden', adv);
  $('extractedDivider').classList.toggle('hidden', adv);

  // Prompt capture belongs to the character-card tab because it can also replace
  // the private definition. This tab only configures its lorebook trigger text.
  $('loreExtractBlock').classList.toggle('hidden', !hasClosed);
  // With only public lorebooks (and nothing extracted) there's nothing to build.
  const onlyPublic = openCount > 0 && closedCount === 0 && !hasEntries;
  $('buildBlock').classList.toggle('hidden', onlyPublic);
  $('buildPendingHint').classList.toggle('hidden', captured);
  syncBuildActions();
}

function syncBuildActions() {
  $('buildBtn').disabled = !state.captured;
  $('previewBtn').disabled = !state.captured;
}

// ---- extraction breakdown (what was pulled from which request, what was cut) ----
const RM_KEY = {
  jailbreak: 'rmJailbreak', card: 'rmCard', userPersona: 'rmUserPersona',
  scenario: 'rmScenario', example: 'rmExample', knownCard: 'rmKnownCard',
  publicLorebook: 'rmPublicLorebook',
  injectedPersona: 'rmInjectedPersona', injectedScenario: 'rmInjectedScenario',
  injectedExample: 'rmInjectedExample', injectedFirstMessage: 'rmInjectedFirstMessage',
};

async function renderProvenance(rec, sep) {
  const removed = sep.removed || [];
  const entries = sep.entries || [];

  // One batch for the lorebook text + every removed fragment.
  const counts = await countTokensBatch([
    sep.lorebookText || '',
    ...removed.map((r) => r.text || ''),
  ]);
  const kept = counts[0];

  const parts = [];

  if (entries.length) {
    parts.push('<details class="prov-item">'
      + `<summary>${t('provLorebookLbl')} <span class="muted">(${entries.length} ${t('provEntries')} · ${kept} ${t('provTokens')})</span></summary>`
      + `<pre class="msg-body">${escapeHtml(sep.lorebookText || '')}</pre></details>`);
  }

  if (!removed.length && !entries.length) {
    parts.push(`<div class="prov-warn">${iconSvg('warn')} ${t('provNothing')}</div>`);
  }
  removed.forEach((r, i) => {
    const label = t(RM_KEY[r.label] || r.label);
    const len = counts[i + 1];
    parts.push('<details class="prov-item">'
      + `<summary>${escapeHtml(label)} <span class="muted">(${len} ${t('provTokens')})</span></summary>`
      + `<pre class="msg-body">${escapeHtml(r.text || '')}</pre></details>`);
  });
  $('provBody').innerHTML = parts.join('');
}

// ---- lorebooks (public blocks + closed-lorebook hint) ----
// `books` is every lorebook attached to the character, each flagged `accessible`
// (a downloadable PUBLIC lorebook) or not (a CLOSED lorebook, rebuilt via the LLM).
function renderPublicBooks(books) {
  state.publicBooks = Array.isArray(books) ? books : [];

  const typeBadge = (b) => {
    const advanced = b && (b.isJs || b.type === 'advanced');
    const key = advanced ? 'scriptTypeAdvanced' : 'scriptTypeLorebook';
    const cls = advanced ? 'script-type-advanced' : 'script-type-lorebook';
    return `<span class="tag script-type ${cls}">${escapeHtml(t(key))}</span>`;
  };

  // A public lorebook page may carry a description — show it under the title.
  const descHtml = (b) => {
    const d = stripHtml(b && b.description);
    return d ? `<span class="pb-desc">${escapeHtml(d)}</span>` : '';
  };

  // Public lorebooks — downloadable JSON books, plus "advanced" JS books that
  // are public but must be rebuilt into entries with the LLM (fromJs).
  const pubBlock = $('publicBlock');
  const pubContainer = $('publicBooks');
  pubContainer.innerHTML = '';
  const open = state.publicBooks.filter((b) => b.accessible && !b.isJs);
  const jsBooks = state.publicBooks.filter((b) => b.isJs);
  if (!open.length && !jsBooks.length) {
    pubBlock.classList.add('hidden');
  } else {
    pubBlock.classList.remove('hidden');
    const closedCount = state.publicBooks.filter((b) => !b.accessible && !b.isJs).length;
    $('publicHint').textContent = closedCount > 0 ? t('publicHint') : t('publicHintOnly');
    open.forEach((b) => {
      const i = state.publicBooks.indexOf(b);
      const row = document.createElement('div');
      row.className = 'public-book';
      const title = escapeHtml(b.title || t('publicUntitled'));
      row.innerHTML = `<div class="pb-meta"><span class="pb-title">${iconSvg('book')} ${title}</span>`
        + `<span class="muted">${b.entryCount} ${t('provEntries')}</span>${descHtml(b)}</div>`;
      const actions = document.createElement('div');
      actions.className = 'book-actions';
      actions.innerHTML = typeBadge(b);
      const btn = document.createElement('button');
      btn.className = 'ghost small';
      btn.innerHTML = `${iconSvg('download')} .json`;
      btn.addEventListener('click', () => downloadPublicBook(i));
      actions.appendChild(btn);
      row.appendChild(actions);
      pubContainer.appendChild(row);
    });
    jsBooks.forEach((b) => {
      const i = state.publicBooks.indexOf(b);
      const row = document.createElement('div');
      row.className = 'public-book';
      const title = escapeHtml(b.title || t('publicUntitled'));
      row.innerHTML = `<div class="pb-meta"><span class="pb-title">${iconSvg('book')} ${title}</span>`
        + `${descHtml(b)}</div>`;
      const actions = document.createElement('div');
      actions.className = 'book-actions';
      actions.innerHTML = typeBadge(b);
      const btn = document.createElement('button');
      btn.className = 'ghost small';
      btn.innerHTML = `${iconSvg('download')} Build .json`;
      btn.addEventListener('click', () => buildJsBook(i, btn));
      actions.appendChild(btn);
      row.appendChild(actions);
      pubContainer.appendChild(row);
    });
  }

  // Private lorebooks
  const privBlock = $('privateBlock');
  const privContainer = $('privateBooks');
  privContainer.innerHTML = '';
  const closed = state.publicBooks.filter((b) => !b.accessible && !b.isJs);
  if (!closed.length) {
    privBlock.classList.add('hidden');
  } else {
    privBlock.classList.remove('hidden');
    $('privateHint').textContent = t('privateHint').replace('{n}', closed.length);
    closed.forEach((b) => {
      const row = document.createElement('div');
      row.className = 'public-book';
      const title = escapeHtml(b.title || t('publicUntitled'));
      row.innerHTML = `<div class="pb-meta"><span class="pb-title">${iconSvg('lock')} ${title}</span>`
        + `<span class="muted">${t('private')}</span>${descHtml(b)}</div>`;
      const actions = document.createElement('div');
      actions.className = 'book-actions';
      actions.innerHTML = typeBadge(b);
      row.appendChild(actions);
      privContainer.appendChild(row);
    });
  }
}

function downloadPublicBook(i) {
  const b = state.publicBooks[i];
  if (!b || !b.worldInfo) return;
  const blob = new Blob([JSON.stringify(b.worldInfo, null, 2)], { type: 'application/json' });
  triggerDownload(blob, `${safeName(b.title || 'Public Lorebook')}.json`);
}

// Rebuild a public "advanced" JS lorebook into a SillyTavern World Info via the
// build LLM (fromJs), then download the resulting .json. Reuses the same
// /api/extract pipeline and per-source context as the closed-lorebook build.
async function buildJsBook(i, btn) {
  const b = state.publicBooks[i];
  if (!b || !b.scriptSource) return;
  const cfg = await api('/api/settings').catch(() => null);
  if (!cfg || !cfg.baseUrl || !cfg.model) {
    openSettings();
    return;
  }
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = t('building');
  try {
    const body = { ...buildExtractBody(), lorebookText: b.scriptSource, fromJs: true };
    const r = await api('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const blob = new Blob([JSON.stringify(r.worldInfo, null, 2)], { type: 'application/json' });
    triggerDownload(blob, `${safeName(b.title || 'Lorebook')}.json`);
    btn.innerHTML = orig;
  } catch (e) {
    btn.textContent = t('buildFailed');
    console.error('[buildJsBook]', e);
    setTimeout(() => { btn.innerHTML = orig; }, 2500);
  } finally {
    btn.disabled = false;
  }
}

// Show the isolated lorebook text as a single "Extracted content" block. The
// naive blank-line split into per-entry blocks was misleading: a single logical
// entry usually spans several paragraphs, so it over-segmented. Without an LLM we
// can't recover real entry boundaries or keys, so we present the raw text as-is.
function renderExtractedContent(text, emptyNote = '') {
  const container = $('lorebookEntries');
  container.innerHTML = '';
  if (!text || !text.trim()) {
    if (!emptyNote) return;
    const details = document.createElement('details');
    details.className = 'msg-block msg-lorebook';
    details.open = true;
    const summary = document.createElement('summary');
    summary.className = 'msg-role';
    summary.textContent = t('extractedContent');
    const body = document.createElement('div');
    body.className = 'msg-body empty-extracted';
    body.textContent = emptyNote;
    details.append(summary, body);
    container.appendChild(details);
    return;
  }
  const details = document.createElement('details');
  details.className = 'msg-block msg-lorebook';
  details.open = true;
  const summary = document.createElement('summary');
  summary.className = 'msg-role';
  summary.textContent = t('extractedContent');
  const body = document.createElement('pre');
  body.className = 'msg-body';
  body.textContent = text.trim();
  details.appendChild(summary);
  details.appendChild(body);
  container.appendChild(details);
}

// Shared request body for /api/extract and /api/extract-preview — the build-with-LLM
// context selection plus the (possibly hand-edited) raw lorebook text.
function buildExtractBody() {
  return {
    id: state.selected,
    lorebookText: $('lorebookText').value,
    useCard: $('useCard').checked,
    useCatalog: $('useCatalog').checked,
    useScenario: $('useScenario').checked,
    useGreetings: $('useGreetings').checked,
    useLorebookDescs: $('useLorebookDescs').checked,
    extraContext: $('useExtra').checked ? $('extraContext').value : '',
    // "advanced" lorebooks: lorebookText is the full system prompt; let the LLM
    // isolate the lore from it (instead of building from pre-separated text).
    fromRaw: state.hasAdvanced === true,
  };
}

// Render the exact prompt sent to (or about to be sent to) the build LLM.
function showPromptPreview(messages) {
  const text = (messages || [])
    .map((m) => `### ${String(m.role || '').toUpperCase()}\n${m.content || ''}`)
    .join('\n\n');
  $('promptPre').textContent = text;
  $('promptPreview').classList.remove('hidden');
}

// ---- build generation timer (proves the request is still alive) ----
let buildTimerHandle = null;
let buildStartTs = 0;
function startBuildTimer() {
  buildStartTs = Date.now();
  $('buildTimer').textContent = '0s';
  buildTimerHandle = setInterval(() => {
    const s = Math.round((Date.now() - buildStartTs) / 1000);
    // After a minute, reassure the user it hasn't died — just a slow model.
    $('buildTimer').textContent = s >= 60 ? `${s}s · ${t('buildStillRunning')}` : `${s}s`;
  }, 1000);
}
function stopBuildTimer(label) {
  if (buildTimerHandle) { clearInterval(buildTimerHandle); buildTimerHandle = null; }
  const s = Math.round((Date.now() - buildStartTs) / 1000);
  $('buildTimer').textContent = label != null ? `${s}s · ${label}` : `${s}s`;
}

async function previewPrompt() {
  if (!state.selected || !state.captured) return;
  $('previewBtn').disabled = true;
  try {
    const r = await api('/api/extract-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildExtractBody()),
    });
    showPromptPreview(r.messages || []);
    $('promptPreview').open = true;
  } catch (e) {
    setStatus($('buildStatus'), 'x', e.message);
  } finally {
    syncBuildActions();
  }
}

async function runBuild() {
  if (!state.selected || !state.captured) return;
  // The lorebook build needs an OpenAI-compatible LLM. If it isn't configured,
  // don't fail with a cryptic server error — poke the user into settings.
  const cfg = await api('/api/settings').catch(() => null);
  if (!cfg || !cfg.baseUrl || !cfg.model) {
    setStatus($('buildStatus'), 'warn', t('llmNotConfigured'));
    openSettings();
    return;
  }
  $('buildStatus').textContent = t('building');
  $('buildBtn').disabled = true;
  $('previewBtn').disabled = true;
  startBuildTimer();
  try {
    const r = await api('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildExtractBody()),
    });
    state.worldInfo = r.worldInfo;
    const count = Object.keys(r.worldInfo.entries).length;
    $('worldInfoPre').textContent = JSON.stringify(r.worldInfo, null, 2);
    $('buildStatus').textContent = `${count} ${t('provEntries')}`;
    $('buildResult').classList.remove('hidden');
    if (r.messages) showPromptPreview(r.messages);
    stopBuildTimer();
  } catch (e) {
    setStatus($('buildStatus'), 'x', e.message);
    stopBuildTimer(t('buildFailed'));
  } finally {
    syncBuildActions();
  }
}

function lorebookFileName() {
  const custom = $('worldName').value.trim();
  if (custom) return safeName(custom);
  const charName = state.character && state.character.name;
  if (charName) return safeName(`Lorebook - ${charName}`);
  return 'Lorebook';
}

// Download the isolated lorebook text verbatim as a plain .txt file. This is the
// no-LLM path: keys and real entry boundaries can't be recovered without a model,
// so we just hand back the extracted content for manual use.
function downloadExtracted() {
  const text = $('lorebookText').value.trim();
  if (!text) return;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  triggerDownload(blob, `${lorebookFileName()}.txt`);
}

  // ---- character card ----
function fillCharacter(ch, autoTab = true) {
  state.character = ch || null;
  const set = (id, v) => { $(id).value = v || ''; };
  set('charName', ch && ch.name);
  set('charDesc', ch && ch.description);
  set('charPersonality', ch && ch.personality);
  set('charScenario', ch && ch.scenario);
  set('charFirst', ch && ch.firstMessage);
  renderAltGreetings(ch && ch.alternateGreetings);
  set('charExample', ch && ch.exampleMessages);
  set('charTags', ch && (Array.isArray(ch.tags) ? ch.tags.join(', ') : ch.tags));
  set('charNotes', ch && ch.creatorNotes);
  renderCardSource(ch && ch.definitionSource);
  const avatar = $('metaAvatar');
  if (ch && ch.avatarBase64) {
    avatar.src = ch.avatarBase64; avatar.classList.remove('hidden');
  } else {
    avatar.removeAttribute('src'); avatar.classList.add('hidden');
  }
  const cardPrivate = !state.cardPublic && !state.captured;
  $('cardFormBlock').classList.toggle('hidden', cardPrivate);
  if (autoTab && ch && (ch.name || ch.description)) switchTab('tabCard');
}

// Show where the card came from: pulled straight from JanitorAI (open
// definition) or reconstructed from the leaked generateAlpha prompt.
function renderCardSource(source) {
  const el = $('charSource');
  if (!el) return;
  if (source === 'janitor') {
    el.textContent = t('cardSrcJanitor');
    el.className = 'card-source src-janitor';
  } else if (source === 'reconstructed') {
    el.textContent = t('cardSrcReconstructed');
    el.className = 'card-source src-reconstructed';
  } else if (source === 'chat') {
    el.textContent = t('cardSrcChat');
    el.className = 'card-source src-janitor';
  } else {
    el.textContent = '';
    el.className = 'card-source hidden';
  }
}

// Render one editable textarea per alternate greeting (everything past the first
// message). Hidden entirely when a character ships only a single greeting.
function renderAltGreetings(greetings) {
  const block = $('charAltGreetingsBlock');
  const host = $('charAltGreetings');
  const list = Array.isArray(greetings) ? greetings.filter(g => g && String(g).trim()) : [];
  host.innerHTML = '';
  list.forEach((g) => {
    const ta = document.createElement('textarea');
    ta.className = 'alt-greeting';
    ta.rows = 3;
    ta.value = g;
    host.appendChild(ta);
  });
  if (block) block.classList.toggle('hidden', list.length === 0);
  const count = $('charAltCount');
  if (count) count.textContent = list.length ? `(${list.length})` : '';
}

function readAltGreetings() {
  return Array.from($('charAltGreetings').querySelectorAll('textarea.alt-greeting'))
    .map(ta => ta.value)
    .filter(v => v && v.trim());
}

function readCardFields() {
  const name = $('charName').value.trim();
  const tags = $('charTags').value.trim();
  return {
    name: name || 'character',
    description: $('charDesc').value,
    personality: $('charPersonality').value,
    scenario: $('charScenario').value,
    first_mes: $('charFirst').value,
    mes_example: $('charExample').value,
    creator_notes: $('charNotes').value,
    tags: tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [],
    alternate_greetings: readAltGreetings(),
  };
}

function buildCardV2(fields) {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      ...fields,
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: fields.alternate_greetings || [],
      creator: '',
      character_version: '',
      extensions: {},
    },
  };
}

function triggerDownload(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 200);
}

function safeName(name) {
  return (name || 'character').replace(/[^a-zA-Z0-9_\- ]/g, '_').slice(0, 60);
}

function downloadJson() {
  const fields = readCardFields();
  const card = buildCardV2(fields);
  const blob = new Blob([JSON.stringify(card, null, 2)], { type: 'application/json' });
  triggerDownload(blob, `${safeName(fields.name)}.json`);
  $('charStatus').textContent = t('jsonDl');
}

async function downloadPng() {
  const fields = readCardFields();
  const card = buildCardV2(fields);
  const avatarB64 = state.character && state.character.avatarBase64;
  if (!avatarB64) { $('charStatus').textContent = t('noAvatarEmbed'); return; }

  $('charStatus').textContent = t('buildingPng');
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = avatarB64;
    });

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);

    const json = JSON.stringify(card);
    const encoder = new TextEncoder();
    const jsonBytes = encoder.encode(json);
    const keyword = encoder.encode('chara');

    // get the raw PNG bytes
    const pngBlob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    const pngBuf = new Uint8Array(await pngBlob.arrayBuffer());

    // build a tEXt chunk: keyword + \0 + text (base64-encoded JSON)
    const b64 = btoa(String.fromCharCode(...jsonBytes));
    const textBytes = encoder.encode(b64);
    const chunkData = new Uint8Array(keyword.length + 1 + textBytes.length);
    chunkData.set(keyword, 0);
    chunkData[keyword.length] = 0;
    chunkData.set(textBytes, keyword.length + 1);

    const crc32 = computeCrc32(new Uint8Array([...encoder.encode('tEXt'), ...chunkData]));

    const chunk = new Uint8Array(12 + chunkData.length);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, chunkData.length);
    chunk.set(encoder.encode('tEXt'), 4);
    chunk.set(chunkData, 8);
    view.setUint32(8 + chunkData.length, crc32);

    // insert before IEND (last 12 bytes)
    const out = new Uint8Array(pngBuf.length + chunk.length);
    out.set(pngBuf.subarray(0, pngBuf.length - 12), 0);
    out.set(chunk, pngBuf.length - 12);
    out.set(pngBuf.subarray(pngBuf.length - 12), pngBuf.length - 12 + chunk.length);

    triggerDownload(new Blob([out], { type: 'image/png' }), `${safeName(fields.name)}.png`);
    $('charStatus').textContent = t('pngDl');
  } catch (e) {
    setStatus($('charStatus'), 'x', e.message);
  }
}

function computeCrc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function downloadImage() {
  const avatarB64 = state.character && state.character.avatarBase64;
  if (!avatarB64) { $('charStatus').textContent = t('noAvatarAvail'); return; }
  const name = safeName($('charName').value.trim());
  const m = avatarB64.match(/^data:image\/(\w+);/);
  const ext = m ? m[1].replace('jpeg', 'jpg') : 'png';
  const arr = avatarB64.split(',');
  const bstr = atob(arr[1]);
  const u8 = new Uint8Array(bstr.length);
  for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
  triggerDownload(new Blob([u8], { type: m ? `image/${m[1]}` : 'image/png' }), `${name}.${ext}`);
  $('charStatus').textContent = t('imgDl');
}

function download() {
  if (!state.worldInfo) return;
  const blob = new Blob([JSON.stringify(state.worldInfo, null, 2)], { type: 'application/json' });
  triggerDownload(blob, `${lorebookFileName()}.json`);
}

async function fetchConversationExport(chat) {
  return api('/api/chat-export', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat }),
  });
}

function downloadConversation(result, format) {
  const name = safeName(`A Chat with ${result.characterName || 'Character'}`);
  if (format === 'raw') {
    triggerDownload(
      new Blob([JSON.stringify(result.raw, null, 2)], { type: 'application/json' }),
      `${name}.json`,
    );
  } else {
    triggerDownload(
      new Blob([result.jsonl], { type: 'application/x-ndjson;charset=utf-8' }),
      `${name}.jsonl`,
    );
  }
}

// Fetch a single chat through the signed-in browser session and immediately
// download either JanitorAI's untouched archive or its SillyTavern conversion.
async function exportConversation(format) {
  const chat = $('chatUrl').value.trim();
  const status = $('chatExportStatus');
  if (!chat) { status.textContent = t('chatUrlPh'); return; }
  const rawBtn = $('exportChatJsonBtn');
  const jsonlBtn = $('exportChatJsonlBtn');
  rawBtn.disabled = true;
  jsonlBtn.disabled = true;
  status.innerHTML = `<span class="extracting">${escapeHtml(t('chatExporting'))}</span>`;
  try {
    const result = await fetchConversationExport(chat);
    downloadConversation(result, format);
    status.textContent = t('chatExportDone').replace('{n}', result.messageCount);
    state.janitorReady = true;
    state.janitorChecked = true;
    refreshHeaderStatus();
  } catch (e) {
    setStatus(status, 'x', e.message);
  } finally {
    rawBtn.disabled = false;
    jsonlBtn.disabled = false;
  }
}

function conversationIconButton(icon, label) {
  const button = document.createElement('button');
  button.className = 'ghost small icon-only';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = `<svg class="icon"><use href="#${icon}"/></svg>`;
  return button;
}

function renderConversations(rec) {
  const container = $('conversationList');
  const conversations = Array.isArray(rec && rec.conversations) ? rec.conversations : [];
  container.innerHTML = '';
  if (!conversations.length) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = t('noConversations');
    container.appendChild(hint);
    return;
  }
  conversations.forEach((conversation) => {
    const row = document.createElement('div');
    row.className = 'conversation-row';
    const meta = document.createElement('div');
    meta.className = 'conversation-meta';
    const id = document.createElement('input');
    id.className = 'conversation-id';
    id.type = 'text';
    id.value = conversation.label || conversation.title || `Chat ${conversation.chatId}`;
    id.placeholder = t('conversationTitlePh');
    id.title = `Chat ${conversation.chatId}`;
    id.addEventListener('change', async () => {
      try {
        await api('/api/conversation-label', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recordId: state.selected, chatId: conversation.chatId, title: id.value }),
        });
      } catch (e) { setStatus($('linkChatStatus'), 'x', e.message); }
    });
    const details = document.createElement('div');
    details.className = 'muted';
    const lastUsed = conversation.updatedAt ? ` · ${new Date(conversation.updatedAt).toLocaleString()}` : '';
    details.textContent = `${conversation.messageCount || 0} messages${lastUsed}`;
    meta.append(id, details);
    row.appendChild(meta);
    const downloads = document.createElement('div');
    downloads.className = 'conversation-download-menu';
    const download = conversationIconButton('i-download', t('downloadConversation'));
    const menu = document.createElement('div');
    menu.className = 'conversation-download-choices hidden';
    [['raw', 'downloadRaw'], ['jsonl', 'downloadJsonl']].forEach(([format, label]) => {
      const button = document.createElement('button');
      button.className = 'ghost small';
      button.textContent = t(label);
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { downloadConversation(await fetchConversationExport(conversation.chatId), format); }
        catch (e) { setStatus($('linkChatStatus'), 'x', e.message); }
        finally { button.disabled = false; menu.classList.add('hidden'); }
      });
      menu.appendChild(button);
    });
    download.addEventListener('click', () => menu.classList.toggle('hidden'));
    downloads.append(download, menu);
    row.appendChild(downloads);
    const manage = document.createElement('div');
    manage.className = 'conversation-manage';
    const open = conversationIconButton('i-external', t('openConversationBtn'));
    open.addEventListener('click', () => {
      window.open(conversation.url || `https://janitorai.com/chats/${conversation.chatId}`, '_blank', 'noopener');
    });
    manage.appendChild(open);
    const refresh = conversationIconButton('i-refresh', t('refreshConversationBtn'));
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      $('linkChatStatus').textContent = t('conversationRefreshing');
      try {
        const result = await api('/api/conversation-refresh', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recordId: state.selected, chatId: conversation.chatId }),
        });
        await selectCapture(result.id);
      } catch (e) { setStatus($('linkChatStatus'), 'x', e.message); }
      finally { refresh.disabled = false; }
    });
    manage.appendChild(refresh);
    const remove = conversationIconButton('i-trash', t('removeConversationBtn'));
    remove.addEventListener('click', async () => {
      if (!confirm(`Remove Chat ${conversation.chatId} from this character?`)) return;
      try {
        const result = await api('/api/conversation-delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recordId: state.selected, chatId: conversation.chatId }),
        });
        await selectCapture(result.id);
      } catch (e) { setStatus($('linkChatStatus'), 'x', e.message); }
    });
    manage.appendChild(remove);
    row.appendChild(manage);
    container.appendChild(row);
  });
}

async function importConversationCharacter(chat, recordId, status, labels = {}) {
  const value = String(chat || '').trim();
  if (!value) { status.textContent = t('chatUrlPh'); return; }
  const busyLabel = labels.busy || 'chatImporting';
  const doneLabel = labels.done || 'chatImportDone';
  status.innerHTML = `<span class="extracting">${escapeHtml(t(busyLabel))}</span>`;
  try {
    const result = await api('/api/chat-import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat: value, recordId }),
    });
    await loadList();
    await selectCapture(result.id);
    status.textContent = t(doneLabel);
    state.janitorReady = true;
    state.janitorChecked = true;
    refreshHeaderStatus();
  } catch (e) {
    setStatus(status, 'x', e.message);
  }
}

function importSidebarConversation() {
  return importConversationCharacter($('chatUrl').value, null, $('chatExportStatus'));
}

function linkConversation() {
  return importConversationCharacter($('linkedChatUrl').value, state.selected, $('linkChatStatus'), {
    busy: 'chatLinking', done: 'chatLinkDone',
  });
}

async function findCharacterConversations() {
  const button = $('findConversationsBtn');
  const status = $('linkChatStatus');
  if (!state.selected) return;
  button.disabled = true;
  status.innerHTML = `<span class="extracting">${escapeHtml(t('findConversationsBusy'))}</span>`;
  try {
    const result = await api('/api/character-conversations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recordId: state.selected }),
    });
    await loadList();
    await selectCapture(result.id);
    status.textContent = `${t('findConversationsDone').replace('{n}', result.found)}${result.source ? ` (${result.source})` : ''}`;
    state.janitorReady = true;
    state.janitorChecked = true;
    refreshHeaderStatus();
  } catch (e) {
    setStatus(status, 'x', e.message);
  } finally {
    button.disabled = false;
  }
}

// "extract" button → INSPECT only: read the character's name, avatar, card
// visibility and lorebooks. Nothing public triggers a generateAlpha run; the
// private card / closed lorebooks are extracted later, on demand.
function isSaucepanUrl(url) {
  return /saucepan\.ai\/companion\//i.test(url);
}

async function runFromUrl() {
  const url = $('charUrl').value.trim();
  if (!url) { $('autoStatus').textContent = t('pasteFirst'); return; }

  // Saucepan URLs take a different path: a token-authed API extract, no browser.
  const saucepan = isSaucepanUrl(url);
  if (saucepan && !state.saucepanReady) {
    setStatus($('autoStatus'), 'warn', t('saucepanNeedLogin'));
    openSettings();
    return;
  }
  const busyLabel = saucepan ? t('extracting') : t('inspecting');

  $('runBtn').disabled = true;
  $('autoStatus').textContent = busyLabel;

  // Add a pending entry to the sidebar immediately
  const pendingId = '_pending_' + Date.now();
  state.selected = pendingId;
  const ul = $('captureList');
  const li = document.createElement('li');
  li.dataset.id = pendingId;
  li.classList.add('active');
  li.innerHTML = `
    <div class="li-top">
      <span class="li-char extracting">${busyLabel}</span>
      <span class="li-time">${fmtTime(Date.now())}</span>
    </div>
    <div class="li-preview">${escapeHtml(url)}</div>`;
  ul.prepend(li);
  document.querySelectorAll('#captureList li').forEach((el) =>
    el.classList.toggle('active', el.dataset.id === pendingId));

  // Show working state in the detail panel
  $('detailBody').classList.add('hidden');
  $('detailEmpty').classList.remove('hidden');
  $('detailEmpty').innerHTML = `<span class="extracting">${busyLabel}</span>`;

  try {
    const r = await api(saucepan ? '/api/saucepan/extract' : '/api/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    // Remove the pending entry and load real data
    li.remove();
    await loadList();
    await selectCapture(r.id);
    if (!saucepan) {
      state.janitorReady = true;
      state.janitorChecked = true;
      refreshHeaderStatus();
    }
    $('autoStatus').textContent = saucepan ? t('extractDone') : t('inspectDone');
  } catch (e) {
    li.remove();
    await loadList();
    setStatus($('autoStatus'), 'x', e.message);
    $('detailBody').classList.add('hidden');
    $('detailEmpty').classList.remove('hidden');
    $('detailEmpty').textContent = t('detailEmpty');
  } finally {
    $('runBtn').disabled = false;
  }
}

// Card tab "extract": run the generateAlpha capture and reconstruct the private
// card. The same capture also yields the closed lorebook (reused if present).
async function runCardExtract() {
  if (!state.selected) return;
  $('cardExtractBtn').disabled = true;
  $('cardExtractStatus').innerHTML = `<span class="extracting">${t('extracting')}</span>`;
  try {
    await api('/api/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.selected, force: state.captured, trigger: triggerSelection() }),
    });
    await selectCapture(state.selected);
  } catch (e) {
    setStatus($('cardExtractStatus'), 'x', e.message);
  } finally {
    $('cardExtractBtn').disabled = false;
  }
}

async function refreshCharacter() {
  if (!state.selected) return;
  $('cardRefreshBtn').disabled = true;
  $('cardExtractStatus').innerHTML = `<span class="extracting">${t('inspecting')}</span>`;
  try {
    await api(`/api/captures/${state.selected}/refresh`, { method: 'POST' });
    await selectCapture(state.selected);
  } catch (e) {
    setStatus($('cardExtractStatus'), 'x', e.message);
  } finally {
    $('cardRefreshBtn').disabled = false;
  }
}

async function deleteCapture() {
  if (!state.selected) return;
  if (!confirm(t('deleteConfirm'))) return;
  await api(`/api/captures/${state.selected}`, { method: 'DELETE' });
  state.selected = null;
  $('detailBody').classList.add('hidden');
  $('detailEmpty').classList.remove('hidden');
  await loadList();
}

// ---- login window ----
function renderJanitorStatus() {
  // The auth button doubles as log in / log out depending on session state.
  const btn = $('janitorLoginBtn');
  const span = btn && btn.querySelector('span');
  if (span) span.textContent = state.janitorReady ? t('janitorLogoutBtn') : t('janitorLoginBtn');
  const el = $('janitorStatus');
  if (!el) return;
  if (state.janitorReady) setStatus(el, 'check', t('loggedIn'));
  else el.textContent = state.janitorChecked ? t('notLoggedIn') : t('sessionUnchecked');
}

function renderSaucepanStatus() {
  const el = $('saucepanStatus');
  if (!el) return;
  if (state.saucepanReady) setStatus(el, 'check', t('saucepanLoggedIn'));
  else el.textContent = t('saucepanNotLoggedIn');
}

// Header shows each source's session state separately (JanitorAI + Saucepan).
function setHeaderChip(el, label, ready, checked = true) {
  if (!el) return;
  if (ready) el.innerHTML = `${escapeHtml(label)}: ${iconSvg('check')} <span>${escapeHtml(t('loggedIn'))}</span>`;
  else if (!checked) el.textContent = `${label}: ${t('sessionUnchecked')}`;
  else el.textContent = `${label}: ${t('notLoggedIn')}`;
}
function refreshHeaderStatus() {
  setHeaderChip($('janitorHeaderStatus'), t('janitorTitle'), state.janitorReady, state.janitorChecked);
  setHeaderChip($('saucepanHeaderStatus'), t('saucepanTitle'), state.saucepanReady);
}

function openLoginDialog() {
  renderJanitorStatus();
  renderSaucepanStatus();
  $('loginDialog').showModal();
}

// ---- settings ----
async function openSettings() {
  const s = await api('/api/settings');
  $('setBaseUrl').value = s.baseUrl || '';
  $('setApiKey').value = s.apiKey || '';
  $('setModel').value = s.model || '';
  $('setDefaultLoreTrigger').value = s.defaultLoreTriggerText || '';
  $('setDontHideWindow').checked = !!s.dontHideBrowserWindow;
  $('settingsDialog').showModal();
}

// Log in to Saucepan from the login window (handle + password → stored token).
async function saucepanLogin() {
  const handle = $('setSaucepanHandle').value.trim();
  const password = $('setSaucepanPassword').value;
  if (!handle || !password) { setStatus($('saucepanStatus'), 'warn', t('saucepanNeedCreds')); return; }
  $('saucepanLoginBtn').disabled = true;
  setStatus($('saucepanStatus'), 'unlock', t('saucepanLoggingIn'));
  try {
    const r = await api('/api/saucepan/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, password }),
    });
    state.saucepanReady = !!r.loggedIn;
    $('setSaucepanPassword').value = '';
    renderSaucepanStatus();
    refreshHeaderStatus();
    unlockUI();
  } catch (e) {
    setStatus($('saucepanStatus'), 'x', e.message);
  } finally {
    $('saucepanLoginBtn').disabled = false;
  }
}

async function saucepanLogout() {
  try {
    await api('/api/saucepan/logout', { method: 'POST' });
  } catch (_) { /* clear locally regardless */ }
  state.saucepanReady = false;
  renderSaucepanStatus();
  refreshHeaderStatus();
}
async function saveSettings(e) {
  e.preventDefault();
  await api('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl: $('setBaseUrl').value.trim(),
      apiKey: $('setApiKey').value.trim(),
      model: $('setModel').value.trim(),
      dontHideBrowserWindow: $('setDontHideWindow').checked,
      defaultLoreTriggerText: $('setDefaultLoreTrigger').value.trim(),
    }),
  });
  $('settingsDialog').close();
}

// ---- auth gate ----
function unlockUI() {
  $('mainContent').classList.remove('hidden');
  $('detail').classList.remove('hidden');
  loadList();
}

async function checkStatus() {
  // Do not launch Chromium merely to populate the initial JanitorAI badge.
  // Login and extraction validate the persisted session when the user asks to use it.
  state.janitorReady = false;
  state.janitorChecked = false;
  $('janitorHeaderStatus').textContent = `${t('janitorTitle')}: ${t('sessionUnchecked')}`;
  $('saucepanHeaderStatus').textContent = '';
  const sauce = await api('/api/saucepan/status').catch(() => ({ loggedIn: false }));
  state.saucepanReady = !!sauce.loggedIn;
  refreshHeaderStatus();
  unlockUI();
}

// ---- JanitorAI login (browser session; runs from the login window) ----
// The one button in the JanitorAI category logs in when signed out, logs out
// when signed in.
function onJanitorAuth() {
  if (state.janitorReady) janitorLogout();
  else login();
}

async function login() {
  $('janitorLoginBtn').disabled = true;
  setStatus($('janitorStatus'), 'unlock', t('openingJanitor'));
  try {
    const data = await api('/api/login', { method: 'POST' });
    state.janitorChecked = true;
    if (data.loggedIn) {
      state.janitorReady = true;
      renderJanitorStatus();
      refreshHeaderStatus();
      unlockUI();
    } else {
      state.janitorReady = false;
      renderJanitorStatus();
      refreshHeaderStatus();
      setStatus($('janitorStatus'), 'x', t('notSignedIn'));
    }
  } catch (e) {
    setStatus($('janitorStatus'), 'x', e.message);
  } finally {
    $('janitorLoginBtn').disabled = false;
  }
}

async function janitorLogout() {
  $('janitorLoginBtn').disabled = true;
  setStatus($('janitorStatus'), 'unlock', t('loggingOut'));
  try {
    await api('/api/logout', { method: 'POST' });
  } catch (_) { /* clear locally regardless */ }
  state.janitorReady = false;
  state.janitorChecked = true;
  renderJanitorStatus();
  refreshHeaderStatus();
  $('janitorLoginBtn').disabled = false;
}

// ---- live updates ----
function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('capture', () => loadList());
}

// ---- wire up ----
$('runBtn').addEventListener('click', runFromUrl);
$('charUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') runFromUrl(); });
$('exportChatJsonBtn').addEventListener('click', () => exportConversation('raw'));
$('exportChatJsonlBtn').addEventListener('click', () => exportConversation('jsonl'));
$('importChatBtn').addEventListener('click', importSidebarConversation);
$('chatUrl').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') exportConversation('jsonl');
});
$('linkChatBtn').addEventListener('click', linkConversation);
$('findConversationsBtn').addEventListener('click', findCharacterConversations);
$('linkedChatUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') linkConversation(); });
$('dlExtractedBtn').addEventListener('click', downloadExtracted);
$('buildBtn').addEventListener('click', runBuild);
$('previewBtn').addEventListener('click', previewPrompt);
$('cardExtractBtn').addEventListener('click', runCardExtract);
$('cardRefreshBtn').addEventListener('click', refreshCharacter);
$('useExtra').addEventListener('change', () => {
  $('extraContext').classList.toggle('hidden', !$('useExtra').checked);
});
$('triggerCustom').addEventListener('change', () => {
  $('loreTriggerText').classList.toggle('hidden', !$('triggerCustom').checked);
});
$('previewTriggerBtn').addEventListener('click', previewTriggerText);
wireContextExpand('triggerSources');
wireContextExpand('useSources');
$('rawJsonToggle').addEventListener('change', () => {
  const raw = $('rawJsonToggle').checked;
  $('rawJson').classList.toggle('hidden', !raw);
  $('rawMessages').classList.toggle('hidden', raw);
});
$('downloadBtn').addEventListener('click', download);
$('deleteBtn').addEventListener('click', deleteCapture);
$('settingsBtn').addEventListener('click', openSettings);
$('saveSettings').addEventListener('click', saveSettings);
$('saucepanLoginBtn').addEventListener('click', saucepanLogin);
$('saucepanLogoutBtn').addEventListener('click', saucepanLogout);
$('loginBtn').addEventListener('click', openLoginDialog);
$('janitorLoginBtn').addEventListener('click', onJanitorAuth);
$('howBtn').addEventListener('click', () => { $('howDialog').showModal(); $('howDialog').scrollTop = 0; });
$('howClose').addEventListener('click', () => $('howDialog').close());
$('dlPngBtn').addEventListener('click', downloadPng);
$('dlJsonBtn').addEventListener('click', downloadJson);
$('dlImgBtn').addEventListener('click', downloadImage);

// Main detail tabs (character card / lorebook) — scoped so the how-dialog tabs
// below don't get caught by the same handler.
document.querySelectorAll('.tabs:not(.how-tabs) .tab').forEach((t) => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});

// "How it works" dialog tabs (JanitorAI / Saucepan).
document.querySelectorAll('.how-tabs .tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.how-tabs .tab').forEach((x) => x.classList.toggle('active', x === tab));
    document.querySelectorAll('.how-tab-panel').forEach((p) => p.classList.toggle('active', p.id === tab.dataset.howtab));
  });
});

checkStatus();
connectEvents();
api('/api/version').then((d) => { $('appVersion').textContent = `v${d.version}`; }).catch(() => {});
