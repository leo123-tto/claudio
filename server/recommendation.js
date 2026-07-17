import { RECOMMENDATION_MIXES } from './settings.js';

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
  rng = Math.random,
} = {}) {
  const safeMode = RECOMMENDATION_MIXES[mode] ? mode : 'discovery';
  return {
    mode: safeMode,
    mix: { ...RECOMMENDATION_MIXES[safeMode] },
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
  explicitRequest = false,
} = {}) {
  const favorites = keySet(favoriteSongs);
  const recent = keySet(recentSongs);
  const disliked = keySet(dislikedSongs);
  const seen = new Set();

  return candidates.filter((candidate) => {
    const key = keyOf(candidate);
    if (key === '|' || seen.has(key) || disliked.has(key) || recent.has(key)) return false;
    if (!explicitRequest && favorites.has(key)) return false;
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
