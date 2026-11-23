import { stripTags } from '../tts/tags.js';

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

export function extractClosedString(text, key) {
  const source = String(text || '');
  const match = source.match(new RegExp(`"${key}"\\s*:\\s*"`));
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

// 流式里 play 还没写完时，取已经写完的那几首（每个 {...} 闭合就算），用来提前去找歌。
export function extractClosedPlayItems(text) {
  const source = String(text || '');
  const match = source.match(/"play"\s*:\s*\[/);
  if (!match) return [];
  const items = [];
  let depth = 1;
  let objectStart = -1;
  let inString = false;
  let escaped = false;
  for (let index = match.index + match[0].length; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') {
      if (depth === 1 && char === '{') objectStart = index;
      depth += 1;
    } else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) break;
      if (depth === 1 && char === '}' && objectStart >= 0) {
        try { items.push(JSON.parse(source.slice(objectStart, index + 1))); } catch { /* 半截的不要 */ }
        objectStart = -1;
      }
    }
  }
  return items;
}

export function extractPlayArray(text) {
  const source = String(text || '');
  const match = source.match(/"play"\s*:\s*/);
  if (!match || source[match.index + match[0].length] !== '[') return null;
  const start = match.index + match[0].length;
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
    else if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          const value = JSON.parse(source.slice(start, index + 1));
          return Array.isArray(value) ? value : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function extractSayValue(text) {
  return extractClosedString(text, 'say');
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

const PLAY_LANES = new Set(['popular', 'fresh', 'classic']);
const INTENTS = new Set(['chat', 'recommend', 'control']);
const ACTIONS = new Set([
  'none', 'pause', 'resume', 'next', 'previous', 'stop', 'favorite', 'dislike',
  'volume_up', 'volume_down', 'volume_set',
]);

// 模型偶尔把歌名写成 song / name、歌手写成 singer / artists（数组）。
// 2026-10-31 实测 DeepSeek 两次推荐都这样，原来按 title 过滤会把整期歌丢光。
function firstText(...values) {
  for (const value of values) {
    const text = Array.isArray(value)
      ? value.map((item) => clean(item?.name ?? item)).filter(Boolean).join(' / ')
      : clean(value?.name ?? value);
    if (text) return text;
  }
  return '';
}

export function normalizeResult(obj = {}) {
  let play = (Array.isArray(obj.play) ? obj.play : [])
    .filter((song) => song && typeof song === 'object')
    .map((song) => ({
      title: firstText(song.title, song.song, song.name, song.songName, song.track),
      artist: firstText(song.artist, song.singer, song.artists, song.by),
      ...(clean(song.genre) ? { genre: clean(song.genre) } : {}),
      ...(Array.isArray(song.tags) ? { tags: song.tags.map(clean).filter(Boolean).slice(0, 12) } : {}),
      ...(clean(song.discoveryType) ? { discoveryType: clean(song.discoveryType) } : {}),
      ...(PLAY_LANES.has(clean(song.lane)) ? { lane: clean(song.lane) } : {}),
      ...(clean(song.bridgeFrom) ? { bridgeFrom: clean(song.bridgeFrom) } : {}),
      ...(Number.isFinite(Number(song.score)) ? { score: Number(song.score) } : {}),
    }))
    .filter((song) => song.title && song.artist)
    .slice(0, 5);
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

  // say 里可以有演出标记（server/tts/tags.js）：页面、记录、校正都用去掉标记的 say，sayTagged 只给语音
  const sayTagged = clean(obj.say);
  return {
    say: stripTags(sayTagged),
    sayTagged,
    intent,
    action,
    actionValue,
    play,
    reason: clean(obj.reason),
    memory: legacyMemory || null,
    memoryCandidates,
    // 口播引用了「可提往事」里的哪一条；只收 id，是不是真允许由 notebook.validateMemoryRef 再判。
    memoryRef: /^n_[0-9a-z]{4,16}$/i.test(String(obj.memoryRef || '').trim()) ? String(obj.memoryRef).trim() : null,
  };
}
