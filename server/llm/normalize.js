export function extractJson(text) {
  const source = String(text || '');
  const start = source.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(source.slice(start, index + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

export function extractSayValue(text) {
  const source = String(text || '');
  const match = source.match(/"say"\s*:\s*"/);
  if (!match) return null;
  let value = '';
  let escaped = false;
  for (let index = match.index + match[0].length; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      value += char === 'n' ? '\n' : char === 't' ? '\t' : char;
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '"') {
      return value;
    } else {
      value += char;
    }
  }
  return null;
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeMemory(item) {
  if (!item || typeof item !== 'object') return null;
  const key = clean(item.key) || 'general';
  const value = clean(item.value);
  if (value.length < 4) return null;
  return { key, value, evidence: clean(item.evidence) || null };
}

const INTENTS = new Set(['chat', 'recommend', 'control']);
const ACTIONS = new Set([
  'none', 'pause', 'resume', 'next', 'previous', 'stop', 'favorite', 'dislike',
  'volume_up', 'volume_down', 'volume_set',
]);

export function normalizeResult(obj = {}) {
  let play = (Array.isArray(obj.play) ? obj.play : [])
    .filter((song) => song && typeof song === 'object')
    .map((song) => ({
      title: clean(song.title),
      artist: clean(song.artist),
      ...(clean(song.discoveryType) ? { discoveryType: clean(song.discoveryType) } : {}),
      ...(clean(song.bridgeFrom) ? { bridgeFrom: clean(song.bridgeFrom) } : {}),
      ...(Number.isFinite(Number(song.score)) ? { score: Number(song.score) } : {}),
    }))
    .filter((song) => song.title && song.artist)
    .slice(0, 3);
  const memoryCandidates = (Array.isArray(obj.memoryCandidates) ? obj.memoryCandidates : [])
    .map(normalizeMemory)
    .filter(Boolean);
  const legacyMemory = clean(obj.memory);
  if (legacyMemory) memoryCandidates.push({ key: 'general', value: legacyMemory, evidence: null });

  let intent = clean(obj.intent);
  let action = clean(obj.action);
  if (!ACTIONS.has(action)) action = 'none';
  if (!INTENTS.has(intent)) intent = action !== 'none' ? 'control' : play.length ? 'recommend' : 'chat';
  let actionValue = Number(obj.actionValue);
  if (!Number.isFinite(actionValue)) actionValue = 0;
  actionValue = Math.max(0, Math.min(100, actionValue));

  // 意图是唯一事实源：聊天和控制绝不能夹带歌曲；推荐也不能顺手操控播放器。
  if (intent === 'chat') { play = []; action = 'none'; actionValue = 0; }
  else if (intent === 'control') play = [];
  else { action = 'none'; actionValue = 0; }

  return {
    say: clean(obj.say),
    intent,
    action,
    actionValue,
    play,
    reason: clean(obj.reason),
    memory: legacyMemory || null,
    memoryCandidates,
  };
}

export const PROGRAM_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['say', 'intent', 'action', 'actionValue', 'play', 'reason', 'memoryCandidates'],
  properties: {
    say: { type: 'string' },
    intent: { type: 'string', enum: ['chat', 'recommend', 'control'] },
    action: {
      type: 'string',
      enum: ['none', 'pause', 'resume', 'next', 'previous', 'stop', 'favorite', 'dislike', 'volume_up', 'volume_down', 'volume_set'],
    },
    actionValue: { type: 'number' },
    play: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'artist', 'discoveryType', 'bridgeFrom', 'score'],
        properties: {
          title: { type: 'string' },
          artist: { type: 'string' },
          discoveryType: { type: 'string', enum: ['familiar', 'adjacent', 'explore'] },
          bridgeFrom: { type: 'string' },
          score: { type: 'number' },
        },
      },
    },
    reason: { type: 'string' },
    memoryCandidates: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'value', 'evidence'],
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
  },
});
