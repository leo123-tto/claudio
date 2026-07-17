import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as ncm from './ncm.js';
import { parseFavoriteSongs } from './recommendation.js';

const FILE = path.join(config.paths.cache, 'discovery-pool.json');
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
let refreshing = null;

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
    return Array.isArray(cache.songs) ? cache : { updatedAt: null, songs: [] };
  } catch { return { updatedAt: null, songs: [] }; }
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

async function refresh() {
  const favorites = readFavorites();
  if (!favorites.length) return [];
  const favoriteKeys = new Set(favorites.map(songKey));
  const seeds = pickSeeds(favorites);
  const groups = await Promise.all(seeds.map(async (seed) => {
    try {
      const hit = (await ncm.search(`${seed.title} ${seed.artist}`, 3))[0];
      if (!hit?.id) return [];
      return await ncm.similarSongs(hit.id);
    } catch (error) {
      console.warn(`[discovery] 种子失败 ${seed.title}:`, error.message);
      return [];
    }
  }));
  const unique = new Map();
  for (const song of groups.flat()) {
    const key = songKey(song);
    if (!key || key === '|' || favoriteKeys.has(key) || unique.has(key)) continue;
    unique.set(key, { title: song.title, artist: song.artist, source: 'netease-similar' });
  }
  const existing = readCache().songs;
  for (const song of existing) {
    const key = songKey(song);
    if (!favoriteKeys.has(key) && !unique.has(key)) unique.set(key, song);
  }
  const songs = [...unique.values()].slice(0, 200);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const temp = `${FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ updatedAt: new Date().toISOString(), seeds, songs }, null, 2));
  fs.renameSync(temp, FILE);
  console.log(`[discovery] 小众候选池已刷新：${songs.length} 首`);
  return songs;
}

export function ensureDiscoveryPool({ force = false } = {}) {
  const cache = readCache();
  const age = cache.updatedAt ? Date.now() - new Date(cache.updatedAt).getTime() : Infinity;
  if (!force && cache.songs.length >= 20 && age < MAX_AGE_MS) return Promise.resolve(cache.songs);
  if (!refreshing) refreshing = refresh().finally(() => { refreshing = null; });
  return refreshing;
}
