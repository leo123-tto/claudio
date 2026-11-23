import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as ncm from './ncm.js';
import { DISCOVERY_LANES, parseFavoriteSongs } from './recommendation.js';

const FILE = path.join(config.paths.cache, 'discovery-pool.json');
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CACHE_VERSION = 2;
const CHART_FETCH_LIMIT = 20;
const CHART_KEEP = 15;
const RETRY_MIN_MS = 30 * 1000;
const RETRY_MAX_MS = 10 * 60 * 1000;
let refreshing = null;
let retry = null;
let retryDelay = RETRY_MIN_MS;

export const DISCOVERY_CHARTS = Object.freeze({
  popular: [{ id: '3778678', source: 'netease-hot', lane: 'popular' }],
  fresh: [
    { id: '745956260', source: 'netease-korean', lane: 'fresh' },
    { id: '5059661515', source: 'netease-japanese', lane: 'fresh' },
    { id: '2809513713', source: 'netease-western', lane: 'fresh' },
  ],
  classic: [
    { id: '112504', source: 'netease-hk-tw', lane: 'classic' },
    { id: '4395559', source: 'netease-classic-zh', lane: 'classic' },
  ],
});

export function chartsForRefresh(date = new Date()) {
  const day = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
  return [
    DISCOVERY_CHARTS.popular[0],
    DISCOVERY_CHARTS.fresh[((day % DISCOVERY_CHARTS.fresh.length) + DISCOVERY_CHARTS.fresh.length) % DISCOVERY_CHARTS.fresh.length],
    DISCOVERY_CHARTS.classic[((day % DISCOVERY_CHARTS.classic.length) + DISCOVERY_CHARTS.classic.length) % DISCOVERY_CHARTS.classic.length],
  ];
}

function songKey(song) {
  return `${String(song?.title || '').trim().toLocaleLowerCase()}|${String(song?.artist || '').trim().toLocaleLowerCase()}`;
}

function readFavorites() {
  try { return parseFavoriteSongs(fs.readFileSync(path.join(config.paths.user, 'favorites.md'), 'utf8')); }
  catch { return []; }
}

function readCache() {
  try {
    const cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(cache.songs) ? cache : { updatedAt: null, songs: [], version: CACHE_VERSION };
  } catch { return { updatedAt: null, songs: [], version: CACHE_VERSION }; }
}

export function collectPoolSongs({ similar = [], charts = [], favorites = [], existing = [] } = {}) {
  const favoriteKeys = new Set(favorites.map(songKey));
  const unique = new Map();
  const add = (song, { source, lane } = {}) => {
    const title = String(song?.title || '').trim();
    const artist = String(song?.artist || '').trim();
    const key = songKey({ title, artist });
    if (!key || key === '|' || favoriteKeys.has(key) || unique.has(key)) return;
    const safeLane = DISCOVERY_LANES.includes(lane) ? lane : (DISCOVERY_LANES.includes(song?.lane) ? song.lane : '');
    unique.set(key, {
      title,
      artist,
      source: source || song?.source || 'netease-similar',
      ...(safeLane ? { lane: safeLane } : {}),
    });
  };
  for (const song of similar) add(song, { source: 'netease-similar' });
  for (const group of charts) {
    for (const song of (group.songs || []).slice(0, CHART_KEEP)) add(song, { source: group.source, lane: group.lane });
  }
  for (const song of existing) add(song, { source: song.source, lane: song.lane });
  return [...unique.values()].slice(0, 200);
}

export function getDiscoveryPool(limit = 40) {
  return readCache().songs.slice(0, limit);
}

function pickSeeds(favorites, count = 4) {
  const pool = favorites.slice();
  const picked = [];
  while (pool.length && picked.length < count) {
    picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return picked;
}

async function loadCharts(favorites, client, onSuccess) {
  const favoriteKeys = new Set(favorites.map(songKey));
  const charts = chartsForRefresh();
  return Promise.all(charts.map(async (chart) => {
    try {
      const tracks = await client.playlistTracks(chart.id, { limit: CHART_FETCH_LIMIT });
      onSuccess();
      const songs = [];
      for (const song of tracks) {
        const key = songKey(song);
        if (!key || key === '|' || favoriteKeys.has(key)) continue;
        songs.push({ title: song.title, artist: song.artist });
        if (songs.length >= CHART_KEEP) break;
      }
      return { ...chart, songs };
    } catch (error) {
      console.warn(`[discovery] 榜单失败 ${chart.id}:`, error.message);
      return { ...chart, songs: [] };
    }
  }));
}

function scheduleRetry(options) {
  if (retry) return;
  const delay = retryDelay;
  const timer = options.setTimeoutFn(() => {
    retry = null;
    // 后台恢复只更新池，不丢掉已经备好的节目。
    return ensureDiscoveryPool({ ...options, force: true }).catch(() => {});
  }, delay);
  timer.unref();
  retry = { timer, clearTimeoutFn: options.clearTimeoutFn };
  retryDelay = Math.min(delay * 2, RETRY_MAX_MS);
  console.warn(`[discovery] 刷新全部失败，${delay / 1000} 秒后重试`);
}

async function refresh(options) {
  const { client } = options;
  let successfulCalls = 0;
  const onSuccess = () => { successfulCalls += 1; };
  const favorites = readFavorites();
  const seeds = pickSeeds(favorites);
  const groups = await Promise.all(seeds.map(async (seed) => {
    try {
      const hits = await client.search(`${seed.title} ${seed.artist}`, 3);
      onSuccess();
      const hit = hits[0];
      if (!hit?.id) return [];
      const songs = await client.similarSongs(hit.id);
      onSuccess();
      return songs;
    } catch (error) {
      console.warn(`[discovery] 种子失败 ${seed.title}:`, error.message);
      return [];
    }
  }));
  const charts = await loadCharts(favorites, client, onSuccess);
  if (!successfulCalls) {
    scheduleRetry(options);
    throw new Error('发现池刷新失败：网易云暂不可用');
  }
  const songs = collectPoolSongs({
    similar: groups.flat(),
    charts,
    favorites,
    existing: readCache().songs,
  });
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const temp = `${FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({
    version: CACHE_VERSION,
    updatedAt: new Date().toISOString(),
    seeds,
    charts: charts.map(({ id, source, lane }) => ({ id, source, lane })),
    songs,
  }, null, 2));
  fs.renameSync(temp, FILE);
  console.log(`[discovery] 候选池已刷新：${songs.length} 首（相似 + 流行/新风格/老歌）`);
  return songs;
}

export function ensureDiscoveryPool({ force = false, client = ncm, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  if (refreshing) return refreshing;
  const cache = readCache();
  const age = cache.updatedAt ? Date.now() - new Date(cache.updatedAt).getTime() : Infinity;
  const current = cache.version === CACHE_VERSION;
  const hasLanes = cache.songs.some((song) => song.lane);
  if (!force && current && hasLanes && cache.songs.length >= 20 && age < MAX_AGE_MS) {
    return Promise.resolve({ songs: cache.songs, refreshed: false });
  }
  refreshing = refresh({ client, setTimeoutFn, clearTimeoutFn })
    .then((songs) => {
      if (retry) retry.clearTimeoutFn(retry.timer);
      retry = null;
      retryDelay = RETRY_MIN_MS;
      return { songs, refreshed: true };
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}
