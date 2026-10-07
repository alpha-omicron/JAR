'use strict';

const { randomUUID } = require('crypto');

const DEFAULT_USER_AVATAR = '/thumbnail?type=persona&file=user-default.png';
const DEFAULT_CHARACTER_AVATAR = '/thumbnail?type=avatar&file=Jake.png';

/** Pull a numeric JanitorAI chat id from a chat URL or an id pasted by itself. */
function parseChatId(input) {
  const value = String(input || '').trim();
  // Message permalinks retain their parent /chats/<id> segment, so accepting
  // that segment also lets users paste either a chat URL or a message URL.
  const match = value.match(/janitorai\.com\/chats\/(\d+)(?:[/?#]|$)/i)
    || value.match(/^(\d+)$/);
  if (!match) throw new Error('paste a JanitorAI chat URL or numeric chat id');
  return match[1];
}

function text(value) {
  return typeof value === 'string' ? value : (value == null ? '' : String(value));
}

function isoDate(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function tokenCount(value) {
  return Math.ceil(text(value).length / 3.5);
}

function parseMetadata(value) {
  if (value == null || value === '') return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed : { janitor_metadata: parsed };
    } catch (_) { return { janitor_metadata: value }; }
  }
  return { janitor_metadata: value };
}

function chatNames(root, profile) {
  const character = root && root.character ? root.character : {};
  const personas = Array.isArray(root && root.personas) ? root.personas : [];
  const defaultPersona = personas.find((persona) => persona && persona.is_default) || personas[0] || {};
  const userName = text(root && root.persona_name || defaultPersona.name
    || profile && (profile.username || profile.user_name || profile.name) || 'User');
  return {
    characterName: text(character.name || character.chat_name || character.character_name || 'Character'),
    fullName: text(character.name || character.full_name || character.character_name || character.chat_name || 'Character'),
    userName,
  };
}

function botExtra(message) {
  const extra = {
    api: 'imported', model: 'janitorai-import', reasoning: '', reasoning_duration: 0,
    reasoning_signature: null, token_count: tokenCount(message.message), time_to_first_token: 0, reasoning_type: null,
  };
  const metadata = parseMetadata(message.metadata);
  if (Object.keys(metadata).length) extra.janitor_metadata = metadata;
  return extra;
}

function botRecord(messages, names) {
  const selected = messages.find((message) => message.is_main) || messages[messages.length - 1];
  const selectedText = text(selected.message).trim();
  const ordered = [selected, ...messages.filter((message) => message !== selected)];
  const sendDate = isoDate(selected.created_at);
  const extra = botExtra(selected);
  return {
    extra,
    name: names.characterName,
    is_user: false,
    is_system: false,
    send_date: sendDate,
    mes: selectedText,
    title: '',
    swipes: ordered.map((message) => text(message.message).trim()).filter(Boolean),
    swipe_id: 0,
    swipe_info: ordered.filter((message) => text(message.message).trim()).map((message) => ({
      send_date: isoDate(message.created_at),
      gen_started: isoDate(message.created_at),
      gen_finished: isoDate(message.created_at),
      extra: botExtra(message),
    })),
    gen_started: sendDate,
    gen_finished: sendDate,
    force_avatar: DEFAULT_CHARACTER_AVATAR,
  };
}

function userRecord(message, names) {
  return {
    name: names.userName,
    is_user: true,
    is_system: false,
    send_date: isoDate(message.created_at),
    mes: text(message.message).trim(),
    extra: { isSmallSys: false, token_count: tokenCount(message.message), reasoning: '' },
    force_avatar: DEFAULT_USER_AVATAR,
  };
}

/** Convert a JanitorAI raw archive into SillyTavern's current JSONL chat shape. */
function toSillyTavernMessages(root, profile) {
  const source = Array.isArray(root && root.chatMessages) ? root.chatMessages : [];
  const names = chatNames(root, profile);
  const messages = [...source].sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
  const records = [{
    chat_metadata: {
      integrity: randomUUID(), note_prompt: '', note_interval: 1, note_position: 1, note_depth: 4, note_role: 0,
      timedWorldInfo: { sticky: {}, cooldown: {} }, tainted: true, lastInContextMessageId: 0,
      STMemoryBooks: {}, world_info: '', imported_from: 'janitorai',
      janitor_chat_id: root && root.chat && root.chat.id,
      janitor_character_id: root && root.character && root.character.id,
    },
  }];
  let pendingBotMessages = [];
  const flushBots = () => {
    if (pendingBotMessages.length) records.push(botRecord(pendingBotMessages, names));
    pendingBotMessages = [];
  };
  for (const message of messages) {
    if (!message || !text(message.message).trim()) continue;
    if (message.is_bot) pendingBotMessages.push(message);
    else {
      flushBots();
      records.push(userRecord(message, names));
    }
  }
  flushBots();
  return { messages: records, names, sourceMessageCount: source.length };
}

function toJsonl(root, profile) {
  const converted = toSillyTavernMessages(root, profile);
  return { ...converted, jsonl: converted.messages.map((message) => JSON.stringify(message)).join('\n') };
}

module.exports = { parseChatId, toSillyTavernMessages, toJsonl };
