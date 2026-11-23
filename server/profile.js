const WEIGHTS = Object.freeze({
  explicit_like: 100,
  explicit_dislike: -100,
  favorite: 80,
  dislike: -80,
  repeated_request: 60,
  replay: 50,
  memory_inferred: 10,
});

const WEAK_SIGNALS = new Set(['play_completed', 'play_progress', 'skip', 'memory_inferred']);
const DAY_MS = 24 * 60 * 60 * 1000;

export function isFillerEvent(event = {}) {
  return event.source === 'filler' || event.discoveryType === 'filler' || event.filler === true
    || event.song?.discoveryType === 'filler' || event.song?.meta?.discoveryType === 'filler'
    || event.song?.filler === true || event.song?.meta?.filler === true;
}

// 朋友推荐的歌（好友互荐）：放了、听完、跳过、重听都不算老板的口味；只有他自己点的红心 / 不喜欢算
export function isFriendEvent(event = {}) {
  return event.discoveryType === 'friend' || event.song?.discoveryType === 'friend' || event.song?.meta?.discoveryType === 'friend';
}
const EXPLICIT_SIGNALS = new Set(['explicit_like', 'explicit_dislike', 'favorite', 'dislike']);

export function signalWeight(event = {}) {
  if (isFillerEvent(event)) return 0;
  if (isFriendEvent(event) && !EXPLICIT_SIGNALS.has(event.type)) return 0;
  if (Object.hasOwn(WEIGHTS, event.type)) return WEIGHTS[event.type];
  if (event.type === 'play_completed') return Number(event.listenRatio) >= 0.8 ? 20 : 0;
  if (event.type === 'play_progress') {
    const ratio = Number(event.listenRatio);
    return ratio >= 0.3 && ratio < 0.8 ? 5 : 0;
  }
  if (event.type === 'skip') {
    const listenedSec = Number(event.listenedSec);
    const ratio = Number(event.listenRatio);
    return listenedSec < 20 || ratio < 0.2 ? -25 : 0;
  }
  return 0;
}

function decayedWeight(event, now) {
  const base = signalWeight(event);
  if (!base || !WEAK_SIGNALS.has(event.type) || !event.at) return base;
  const at = new Date(event.at).getTime();
  if (!Number.isFinite(at)) return base;
  const ageDays = Math.max(0, (now.getTime() - at) / DAY_MS);
  return base * Math.pow(0.5, ageDays / 60);
}

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function songKey(song) {
  return `${text(song?.title).toLocaleLowerCase()}|${text(song?.artist).toLocaleLowerCase()}`;
}

// 爱心是当前状态。撤销只影响按钮，不会抹掉亲口表达或旧未知来源的喜欢。
export function activeTasteEvents(events = []) {
  const seenButtons = new Set();
  const active = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || isFillerEvent(event)) continue;
    if (['favorite', 'unfavorite'].includes(event.type) && event.source === 'button') {
      const key = songKey(event.song);
      if (seenButtons.has(key)) continue;
      seenButtons.add(key);
      if (event.type === 'unfavorite') continue;
    }
    active.push(event);
  }
  return active.reverse();
}

function pushScore(map, key, value, identity) {
  if (!key || key === '|') return;
  const old = map.get(key) || { ...identity, score: 0, evidence: 0 };
  old.score += value;
  old.evidence += 1;
  map.set(key, old);
}

export function deriveProfile(events = [], { now = new Date() } = {}) {
  const songs = new Map();
  const artists = new Map();
  const inferred = new Map();

  for (const event of activeTasteEvents(events)) {
    const title = text(event.song?.title);
    const artist = text(event.song?.artist);
    const weight = decayedWeight(event, now);
    if (title && artist && weight) pushScore(songs, songKey(event.song), weight, { title, artist });
    if (artist && weight) pushScore(artists, artist.toLocaleLowerCase(), weight, { artist });

    if (event.type === 'memory_inferred') {
      const key = text(event.key);
      const value = text(event.value);
      if (!key || !value) continue;
      const id = `${key.toLocaleLowerCase()}|${value.toLocaleLowerCase()}`;
      const item = inferred.get(id) || { key, value, evidenceIds: new Set(), score: 0 };
      item.evidenceIds.add(text(event.evidenceId) || text(event.at) || `event-${inferred.size}`);
      item.score += weight;
      inferred.set(id, item);
    }
  }

  const sortScores = (map) => [...map.values()]
    .map((item) => ({ ...item, score: Math.round(item.score * 10) / 10 }))
    .sort((a, b) => b.score - a.score);
  const memories = [...inferred.values()].map((item) => ({
    key: item.key,
    value: item.value,
    evidence: item.evidenceIds.size,
    score: Math.round(item.score * 10) / 10,
  }));

  return {
    generatedAt: now.toISOString(),
    songs: sortScores(songs),
    artists: sortScores(artists),
    memories: {
      stable: memories.filter((item) => item.evidence >= 2),
      pending: memories.filter((item) => item.evidence < 2),
    },
  };
}
