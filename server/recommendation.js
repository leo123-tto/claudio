import { RECOMMENDATION_MIXES } from './settings.js';

export const DISCOVERY_LANES = Object.freeze(['popular', 'fresh', 'classic']);

const LANE_COPY = Object.freeze({
  popular: { name: '当下流行', hint: '从热歌榜里选他没听过的，不要把整期都放成榜单。' },
  fresh: { name: '新风格', hint: '选明显不同的语种或曲风，帮他听见没接触过的。' },
  classic: { name: '老内容', hint: '选 2016 年前的老歌或经典原唱，不要拿新歌充数。' },
});

export const OPENING_FINGERPRINTS = Object.freeze([
  { id: 'soft-zh-familiar', language: '华语', energy: '轻柔', familiarity: '熟悉的风格里找陌生歌' },
  { id: 'bright-en-adjacent', language: '英文', energy: '明亮', familiarity: '相邻风格冷门曲' },
  { id: 'night-jp-explore', language: '日韩', energy: '夜色', familiarity: '边界探索' },
  { id: 'instrumental-focus', language: '纯音乐', energy: '专注', familiarity: '跨出常听歌手圈' },
  { id: 'warm-indie', language: '不限', energy: '温暖', familiarity: '小众独立音乐' },
  { id: 'rhythmic-leftfield', language: '不限', energy: '有节奏', familiarity: '意外但不突兀' },
  { id: 'cinematic-deepcut', language: '原声', energy: '电影感', familiarity: '非热门深挖' },
  { id: 'female-vocal-haze', language: '不限', energy: '朦胧', familiarity: '冷门女声' },
]);

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function keyOf(song) {
  return `${clean(song?.title).toLocaleLowerCase()}|${clean(song?.artist).toLocaleLowerCase()}`;
}

function keySet(songs = []) {
  return new Set(songs.map(keyOf).filter((key) => key !== '|'));
}

export function parseFavoriteSongs(markdown = '') {
  return String(markdown)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ') && line.includes(' — '))
    .map((line) => {
      const body = line.slice(2);
      const splitAt = body.lastIndexOf(' — ');
      return {
        title: clean(body.slice(0, splitAt)),
        artist: clean(body.slice(splitAt + 3)),
      };
    })
    .filter((song) => song.title && song.artist);
}

export function nextDiscoveryLane(recent = []) {
  const last = [...recent].reverse().find((lane) => DISCOVERY_LANES.includes(lane));
  const index = last ? DISCOVERY_LANES.indexOf(last) : -1;
  return DISCOVERY_LANES[(index + 1) % DISCOVERY_LANES.length];
}

export function laneBrief(lane) {
  const key = DISCOVERY_LANES.includes(lane) ? lane : 'popular';
  return { lane: key, ...LANE_COPY[key] };
}

export function laneOf(song = {}) {
  if (DISCOVERY_LANES.includes(song.lane)) return song.lane;
  if (song.discoveryType === 'explore') return 'fresh';
  return 'bridge';
}

function takeFirst(songs, picked, count, limit) {
  for (const song of songs) {
    if (picked.length >= limit || count <= 0) return;
    if (picked.includes(song)) continue;
    picked.push(song);
    count -= 1;
  }
}

export function selectDiverseShortlist(songs = [], lane = 'popular', limit = 6) {
  const target = DISCOVERY_LANES.includes(lane) ? lane : 'popular';
  const bridges = [];
  const targets = [];
  const rest = [];
  for (const song of songs) {
    const kind = laneOf(song);
    if (kind === 'bridge') bridges.push(song);
    else if (kind === target) targets.push(song);
    else rest.push(song);
  }
  const picked = [];
  takeFirst(bridges, picked, 1, limit);
  takeFirst(targets, picked, 1, limit);
  takeFirst(targets.slice(1), picked, 2, limit);
  takeFirst([...bridges.slice(1), ...rest, ...songs], picked, limit, limit);
  return picked;
}

export function pickDiverse(songs = [], lane = 'popular') {
  const target = DISCOVERY_LANES.includes(lane) ? lane : 'popular';
  const bridge = songs.find((song) => laneOf(song) === 'bridge');
  const discovery = songs.find((song) => laneOf(song) === target)
    || songs.find((song) => laneOf(song) !== 'bridge');
  const picked = [];
  if (bridge) picked.push(bridge);
  if (discovery && discovery !== bridge) picked.push(discovery);
  for (const song of songs) {
    if (picked.length >= 2) break;
    if (!picked.includes(song)) picked.push(song);
  }
  return picked.slice(0, 2);
}

// 挑歌时桥接歌排前面，但口播是按模型 play[] 的先后提歌的：挑完按这个先后放。没有位置的（发现池兜底）排最后，彼此保持原顺序。
export function orderByPlayOrder(songs = []) {
  const slot = (song) => (Number.isInteger(song?.playOrder) ? song.playOrder : Number.MAX_SAFE_INTEGER);
  return songs.slice().sort((a, b) => slot(a) - slot(b));
}

function sampleGroup(items, count, rng) {
  const pool = items.slice();
  const picked = [];
  while (pool.length && picked.length < count) {
    picked.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  return picked;
}

export function sampleDiscoveryPool(songs = [], lane = 'popular', { perGroup = 4, rng = Math.random } = {}) {
  const groups = { bridge: [], popular: [], fresh: [], classic: [] };
  for (const song of songs) {
    const key = DISCOVERY_LANES.includes(song.lane) ? song.lane : 'bridge';
    groups[key].push(song);
  }
  const target = DISCOVERY_LANES.includes(lane) ? lane : 'popular';
  return [
    ...sampleGroup(groups.bridge, perGroup, rng),
    ...sampleGroup(groups[target], perGroup, rng),
    ...DISCOVERY_LANES.filter((item) => item !== target).flatMap((item) => sampleGroup(groups[item], 2, rng)),
  ];
}

export function selectOpeningFingerprint(recentIds = [], rng = Math.random) {
  const recent = new Set(recentIds);
  const available = OPENING_FINGERPRINTS.filter((item) => !recent.has(item.id));
  const pool = available.length ? available : OPENING_FINGERPRINTS;
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)));
  return pool[index];
}

export function buildRecommendationBrief({
  mode = 'discovery',
  messages = [],
  recentFingerprints = [],
  recentLanes = [],
  rng = Math.random,
} = {}) {
  const safeMode = RECOMMENDATION_MIXES[mode] ? mode : 'discovery';
  return {
    mode: safeMode,
    mix: { ...RECOMMENDATION_MIXES[safeMode] },
    discoveryLane: nextDiscoveryLane(recentLanes),
    openingFingerprint: selectOpeningFingerprint(recentFingerprints, rng),
    recentUserMessages: messages
      .filter((item) => item?.role === 'user' && clean(item.content))
      .slice(-6)
      .map((item) => clean(item.content)),
  };
}

export function filterCandidates(candidates = [], {
  favoriteSongs = [],
  recentSongs = [],
  dislikedSongs = [],
  bannedSongs = [],
  explicitRequest = false,
  onDrop = () => {},
} = {}) {
  const favorites = keySet(favoriteSongs);
  const recent = keySet(recentSongs);
  const disliked = keySet(dislikedSongs);
  const banned = keySet(bannedSongs);
  const seen = new Set();

  return candidates.filter((candidate) => {
    const key = keyOf(candidate);
    const reason = key === '|' || seen.has(key) ? 'duplicate'
      : disliked.has(key) ? 'disliked' : recent.has(key) ? 'recent'
        : !explicitRequest && favorites.has(key) ? 'favorite'
          : !explicitRequest && banned.has(key) ? 'banned' : '';
    if (reason) { onDrop(candidate, reason); return false; }
    seen.add(key);
    return true;
  });
}

export function rankCandidates(candidates = [], { recentArtists = [] } = {}) {
  const recent = new Set(recentArtists.slice(0, 5).map((artist) => clean(artist).toLocaleLowerCase()));
  return candidates
    .map((item, index) => ({
      ...item,
      _rank: Number(item.score || 50) - (recent.has(clean(item.artist).toLocaleLowerCase()) ? 30 : 0),
      _order: index,
    }))
    .sort((a, b) => b._rank - a._rank || a._order - b._order)
    .map(({ _rank, _order, ...item }) => item);
}
