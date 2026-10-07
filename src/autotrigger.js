'use strict';

/**
 * Drive the JanitorAI chat UI from Playwright: pick the open chat tab and send a
 * message. Used to auto-trigger the closed lorebook (send ".", read the card from
 * the capture, then send the card text so as many entries as possible fire).
 *
 * JanitorAI's DOM is not stable across releases, so selectors are best-effort.
 */

const INPUT_CANDIDATES = [
  'textarea[placeholder]',
  'form textarea',
  'textarea',
  'div[contenteditable="true"]',
];

/** Choose the page that has a JanitorAI chat open (prefer a /chats/ URL). */
async function pickChatPage(context) {
  let fallback = null;
  for (const p of context.pages()) {
    const url = p.url();
    if (!url.includes('janitorai.com')) continue;
    if (/\/chats?\//i.test(url)) return p;
    fallback = fallback || p;
  }
  return fallback;
}

async function findInput(page, override, timeout = 12000) {
  const candidates = override ? [override] : INPUT_CANDIDATES;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of candidates) {
      const loc = page.locator(sel).last();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        return { loc, sel };
      }
    }
    await page.waitForTimeout(300);
  }
  return null;
}

/**
 * JanitorAI occasionally throws a modal over the chat (persona picker, content
 * disclaimer, "what's new" popup…). Its backdrop (`_modalOverlay_…`) intercepts
 * pointer events, so a click on the composer never lands and Playwright times out.
 * Best-effort dismiss: click an explicit close control inside the dialog, else
 * press Escape, and wait for the overlay to detach. No-op when nothing is open.
 * @param {import('playwright').Page} page
 */
async function dismissModals(page, { timeout = 4000 } = {}) {
  const overlay = page.locator('[class*="modalOverlay" i], [class*="ModalOverlay"]').last();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await overlay.count()) === 0) return;
    if (!(await overlay.isVisible().catch(() => false))) return;
    // Prefer an explicit close button inside the dialog over dismissing blindly.
    const close = page.locator(
      '[class*="modal" i] button[aria-label*="close" i], '
      + '[role="dialog"] button[aria-label*="close" i]').first();
    if ((await close.count()) > 0 && (await close.isVisible().catch(() => false))) {
      await close.click().catch(() => {});
    } else {
      await page.keyboard.press('Escape').catch(() => {});
    }
    await page.waitForTimeout(300);
  }
}

/** Extract a character UUID from a JanitorAI character URL (or a bare UUID). */
function parseCharacterId(input) {
  const s = String(input || '').trim();
  const m = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!m) throw new Error('no character id found in: ' + s);
  return m[0];
}

/**
 * Run a fetch INSIDE the page so it shares the logged-in cookie jar, Cloudflare
 * clearance and TLS fingerprint, attaching the Supabase bearer token (found in
 * cookies / localStorage). Returns the raw status + text body.
 */
async function authedFetch(page, url, init = {}) {
  return page.evaluate(async ({ u, i }) => {
    function findToken() {
      const b64 = (s) => {
        try { return atob(s); } catch (e) { /* */ }
        try { return atob(s.replace(/-/g, '+').replace(/_/g, '/')); } catch (e) { /* */ }
        return null;
      };
      const extract = (rawIn) => {
        let raw = rawIn;
        if (!raw) return null;
        try { raw = decodeURIComponent(raw); } catch (e) { /* */ }
        if (raw.indexOf('base64-') === 0) raw = raw.slice(7);
        if (raw.indexOf('eyJ') === 0 && raw.split('.').length === 3) return raw;
        for (const s of [b64(raw), raw]) {
          if (!s) continue;
          const mm = s.match(/"access_token":"(eyJ[^"]+)"/);
          if (mm) return mm[1];
          try {
            const o = JSON.parse(s);
            const c = o && (o.access_token || o.accessToken || o.token
              || (o.currentSession && o.currentSession.access_token));
            if (typeof c === 'string' && c.indexOf('eyJ') === 0) return c;
          } catch (e) { /* */ }
        }
        return null;
      };
      try {
        const parts = {};
        for (const c of (document.cookie || '').split('; ')) {
          const eq = c.indexOf('=');
          if (eq < 0) continue;
          const mm = c.slice(0, eq).match(/^(sb-.*-auth-token)(?:\.(\d+))?$/);
          if (!mm) continue;
          const base = mm[1];
          const idx = mm[2] ? parseInt(mm[2], 10) : 0;
          (parts[base] = parts[base] || {})[idx] = c.slice(eq + 1);
        }
        for (const base in parts) {
          const idxs = Object.keys(parts[base]).map(Number).sort((a, b) => a - b);
          let joined = '';
          for (const j of idxs) joined += parts[base][j];
          const t = extract(joined);
          if (t) return t;
        }
      } catch (e) { /* */ }
      try {
        for (let k = 0; k < localStorage.length; k += 1) {
          const t = extract(localStorage.getItem(localStorage.key(k)));
          if (t) return t;
        }
      } catch (e) { /* */ }
      return null;
    }

    const token = findToken();
    const headers = Object.assign(
      { accept: 'application/json, text/plain, */*' },
      (i && i.headers) || {},
    );
    if (token) headers.authorization = 'Bearer ' + token;
    const r = await fetch(u, Object.assign({ credentials: 'include' }, i, { headers }));
    return { status: r.status, body: await r.text() };
  }, { u: url, i: init });
}

/**
 * Create a new chat for a character via JanitorAI's API. The chat inherits the
 * account's selected persona automatically (the create payload is just the
 * character id).
 * @returns {Promise<string>} the new chat id
 */
async function createChat(page, characterId) {
  const result = await authedFetch(page, 'https://janitorai.com/hampter/chats', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: characterId }),
  });
  if (result.status >= 400) {
    throw new Error(`create chat failed: HTTP ${result.status} ${result.body.slice(0, 200)}`);
  }
  let data;
  try { data = JSON.parse(result.body); } catch (e) {
    throw new Error('create chat: response was not JSON');
  }
  if (!data || data.id == null) throw new Error('create chat: no id in response');
  return String(data.id);
}

/** Fetch full character metadata from the catalog API (description, scenario…). */
async function fetchCharacter(page, characterId) {
  const result = await authedFetch(page, `https://janitorai.com/hampter/characters/${characterId}`);
  if (result.status >= 400) throw new Error(`fetch character failed: HTTP ${result.status}`);
  try { return JSON.parse(result.body); } catch (e) {
    throw new Error('fetch character: response was not JSON');
  }
}

/** Fetch one of the signed-in user's full conversations, including chatMessages. */
async function fetchChat(page, chatId) {
  const result = await authedFetch(page, `https://janitorai.com/hampter/chats/${chatId}`);
  if (result.status >= 400) throw new Error(`fetch chat failed: HTTP ${result.status}`);
  try { return JSON.parse(result.body); } catch (e) {
    throw new Error('fetch chat: response was not JSON');
  }
}

/** Normalize JanitorAI's chat-message envelope across API versions. */
function chatMessages(chat) {
  if (!chat || typeof chat !== 'object') return [];
  for (const key of ['chatMessages', 'chat_messages', 'messages']) {
    if (Array.isArray(chat[key])) return chat[key];
  }
  return [];
}

/**
 * Return the opening-message IDs only when this is an untouched new chat.
 *
 * JanitorAI creates a bot greeting in the POST /chats response. It is prior
 * conversation history, not a generated prompt; leaving it there lets its
 * keywords trigger lore during JAR's supposedly neutral `.` probe. Never
 * delete a chat which contains a user message: it is no longer a fresh,
 * JAR-owned extraction chat.
 */
function freshGreetingMessageIds(chat) {
  const messages = chatMessages(chat);
  if (!messages.length || messages.some((message) => !message || message.is_bot !== true)) return [];
  return messages.map((message) => message.id).filter((id) => id != null);
}

/**
 * List the signed-in account's chats for one character. JanitorAI has used a
 * few response envelopes over time, so normalize the documented chat-list
 * fields while keeping the request character-scoped and paginated.
 */
function chatListItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  // Current JanitorAI character history endpoint returns this compact form:
  // `{ chat_ids: [3050086571, 3050076328] }`.
  if (Array.isArray(payload.chat_ids)) return payload.chat_ids.map((id) => ({ id }));
  for (const key of ['chats', 'chat_history', 'conversations', 'items', 'data', 'results']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  // Some versions wrap the actual array one level further inside `data`.
  for (const key of ['chats', 'chat_history', 'conversations', 'data', 'results']) {
    if (payload[key] && typeof payload[key] === 'object') {
      const nested = chatListItems(payload[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}

function chatSummaryCharacterId(chat) {
  if (!chat || typeof chat !== 'object') return '';
  return String(chat.character_id || chat.characterId || (chat.character && chat.character.id) || '');
}

function chatItemsFromPayload(payload) {
  const listed = chatListItems(payload);
  if (listed.length) return listed;
  // A chat page sometimes returns a complete archive as `{ chat, character,
  // chatMessages }` rather than a collection envelope.
  if (payload && payload.chat && (payload.chat.id || payload.chat.chat_id)) return [payload.chat];
  return [];
}

/**
 * Let JanitorAI's own character page reveal its current internal request(s).
 * This is a fallback for deployments that do not publish a stable chat-list
 * endpoint. It only reads same-session responses from an otherwise untouched
 * temporary page, and never creates, changes, or sends a chat.
 */
async function discoverCharacterChatsFromPage(page, characterId) {
  const probe = await page.context().newPage();
  const bodies = [];
  probe.on('response', (response) => {
    const url = response.url();
    if (!/janitorai\.com\/hampter\//i.test(url) || !/(?:chats?|conversations)/i.test(url)) return;
    bodies.push(response.text().then((body) => {
      try { return JSON.parse(body); } catch (_) { return null; }
    }).catch(() => null));
  });
  try {
    await probe.goto(`https://janitorai.com/characters/${encodeURIComponent(characterId)}`, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    }).catch(() => {});
    await probe.waitForTimeout(3500);
    const payloads = await Promise.all(bodies);
    return {
      observed: payloads.some((payload) => payload != null),
      items: payloads.flatMap((payload) => chatItemsFromPayload(payload)),
    };
  } finally {
    await probe.close().catch(() => {});
  }
}

async function fetchCharacterChats(page, characterId) {
  const wanted = String(characterId || '');
  if (!wanted) throw new Error('character id is required');
  const found = new Map();
  let listWasAvailable = false;
  let source = '';
  const profile = await fetchMyProfile(page);
  const userId = profile && (profile.id || profile.user_id);
  const addItems = (items) => {
    for (const chat of items) {
      const id = chat && (chat.id || chat.chat_id);
      if (id == null) continue;
      const itemCharacterId = chatSummaryCharacterId(chat);
      if (itemCharacterId && itemCharacterId !== wanted) continue;
      found.set(String(id), chat);
    }
  };

  // The collection route `/hampter/chats` no longer exists (it returns 404).
  // Current deployments expose the list as a character subresource; older ones
  // include it in the character response. Try both without surfacing a 404.
  const character = await fetchCharacter(page, wanted).catch(() => null);
  if (character && typeof character === 'object') {
    // Do not treat a generic `data` array as chats here: on some character
    // routes it is a similar-character catalog whose IDs are not chat IDs.
    const embedded = character.chats || character.chat_history || character.conversations;
    if (embedded) {
      listWasAvailable = true;
      source = 'character metadata';
      addItems(chatListItems({ chats: embedded }));
    }
  }

  // A page size of 100 keeps normal accounts to one request. Stop if a server
  // ignores `page` (the IDs then stop changing) or returns its final page.
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const params = new URLSearchParams({ limit: '100', page: String(pageNumber) });
    if (userId) params.set('user_id', String(userId));
    const routes = [
      `https://janitorai.com/hampter/characters/${encodeURIComponent(wanted)}/chats?${params}`,
      `https://janitorai.com/hampter/characters/${encodeURIComponent(wanted)}/conversations?${params}`,
    ];
    let payload = null;
    for (const url of routes) {
      const result = await authedFetch(page, url);
      if (result.status === 404) continue;
      if (result.status >= 400) throw new Error(`list chats failed: HTTP ${result.status}`);
      try { payload = JSON.parse(result.body); } catch (_) {
        throw new Error('list chats: response was not JSON');
      }
      listWasAvailable = true;
      source = new URL(url).pathname;
      break;
    }
    // Not every JanitorAI deployment exposes an account-history endpoint.
    // The character response may still have supplied chats above.
    if (!payload) break;
    const items = chatListItems(payload);
    const before = found.size;
    addItems(items);
    const added = found.size - before;
    const next = payload && (payload.next_page || payload.nextPage || payload.next);
    if (!items.length || !added || (items.length < 100 && !next)) break;
  }
  if (!listWasAvailable) {
    const discovered = await discoverCharacterChatsFromPage(page, wanted);
    // The request observer itself is evidence that this site version exposes a
    // chat list; a genuinely empty array is therefore a valid zero result.
    listWasAvailable = discovered.observed;
    if (discovered.observed) source = 'character page';
    addItems(discovered.items);
  }
  if (!listWasAvailable) {
    throw new Error('JanitorAI did not expose this account’s conversation list. Open the character in JanitorAI once, then try again.');
  }
  return { chats: [...found.values()], source };
}

/** Get the account profile only to resolve the name for {{user}} substitutions. */
async function fetchMyProfile(page) {
  const result = await authedFetch(page, 'https://janitorai.com/hampter/profiles/mine');
  if (result.status >= 400) return null;
  try { return JSON.parse(result.body); } catch (_) { return null; }
}

/**
 * Type `text` into the chat composer and send it.
 * @param {import('playwright').Page} page
 * @param {string} text
 * @param {{inputSelector?:string, sendSelector?:string}} [opts]
 */
async function sendMessage(page, text, opts = {}) {
  const found = await findInput(page, opts.inputSelector);
  if (!found) {
    throw new Error('chat input not found');
  }
  const { loc, sel } = found;
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  // A modal overlay (persona picker, disclaimer…) can sit over the composer and
  // swallow the click; clear it first, then retry the click once more if a new
  // overlay slipped in between the dismiss and the click.
  await dismissModals(page);
  try {
    await loc.click({ timeout: 8000 });
  } catch (e) {
    await dismissModals(page);
    await loc.click({ timeout: 8000 });
  }

  if (sel.includes('contenteditable')) {
    await loc.evaluate((el) => { el.textContent = ''; });
    await page.keyboard.insertText(text);
  } else {
    await loc.fill(text); // sets multi-line value in one shot (no premature send)
  }

  if (opts.sendSelector) {
    await page.locator(opts.sendSelector).first().click();
    return;
  }
  // A previous send may still be streaming / hanging against the unreachable
  // dummy proxy, which keeps the composer disabled so the next message can't go
  // out. Abort it first (we already captured the generateAlpha payload, which
  // fires BEFORE the proxy POST), then click the send button. JanitorAI's
  // composer no longer submits on a bare Enter in every layout (text just sits
  // unsent), so Enter is only a last resort.
  await abortGeneration(page);
  const clicked = await clickSendButton(page, loc);
  if (!clicked) {
    await loc.press('Enter');
  }
}

/**
 * Abort an in-progress generation by clicking the composer's stop/cancel button,
 * so the send button re-enables. No-op when nothing is generating.
 * @param {import('playwright').Page} page
 */
async function abortGeneration(page, { timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const stop = page.locator(
      'button[aria-label*="stop" i], button[aria-label*="cancel" i]').first();
    if ((await stop.count()) === 0) return;
    if (!(await stop.isVisible().catch(() => false))) return;
    await stop.click().catch(() => {});
    await page.waitForTimeout(300);
  }
}

/**
 * Click the composer's send button relative to the chat input. The button
 * enables a few frames after the value changes (and only once the composer is
 * idle), so poll for it. Matches `<button aria-label="Send" class="_sendButton_…">`
 * (not a submit, not inside a <form>), excluding any stop/cancel control, then
 * falls back to the last live button in the container holding the input. Returns
 * true if a button was clicked.
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} loc  the chat input locator
 */
async function clickSendButton(page, loc) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const clicked = await loc.evaluate((el) => {
      const isSend = (b) => {
        if (!b || b.offsetParent === null || b.disabled) return false;
        const label = (b.getAttribute('aria-label') || '').toLowerCase();
        return label.indexOf('stop') < 0 && label.indexOf('cancel') < 0;
      };
      const cands = document.querySelectorAll(
        'button[aria-label*="send" i], '
        + 'button[class*="sendButton" i], '
        + 'button[type="submit"]');
      for (let i = 0; i < cands.length; i += 1) {
        if (isSend(cands[i])) { cands[i].click(); return true; }
      }
      const scope = el.closest('form') || el.parentElement;
      if (scope) {
        const btns = Array.prototype.slice
          .call(scope.querySelectorAll('button')).filter(isSend);
        if (btns.length) { btns[btns.length - 1].click(); return true; }
      }
      return false;
    }).catch(() => false);
    if (clicked) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

/**
 * Delete a chat by id via JanitorAI's API.
 * @returns {Promise<boolean>} true if deleted (HTTP 200)
 */
async function deleteChat(page, chatId) {
  if (!chatId) return false;
  const result = await authedFetch(page, `https://janitorai.com/hampter/chats/${chatId}`, {
    method: 'DELETE',
  });
  if (result.status >= 400) {
    console.warn(`[chat] delete chat ${chatId} failed: HTTP ${result.status}`);
    return false;
  }
  console.log(`[chat] deleted chat ${chatId}`);
  return true;
}

/** Probe whether the in-browser session is really authenticated (cookies + CF). */
async function checkLogin(page) {
  try {
    const r = await authedFetch(page, 'https://janitorai.com/hampter/profiles/mine');
    return r.status === 200;
  } catch (_) { return false; }
}

module.exports = {
  sendMessage, pickChatPage, parseCharacterId, createChat, deleteChat, fetchCharacter,
  fetchChat, chatMessages, freshGreetingMessageIds,
  fetchCharacterChats, chatListItems, fetchMyProfile, authedFetch, checkLogin, dismissModals,
};
