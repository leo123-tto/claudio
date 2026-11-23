// 状态 · 记忆：messages / plays / favs，落盘到 cache/state.json，跨重启持久。
// MVP 用 JSON 文件；全功能阶段可换 sqlite（保持同样的函数签名即可）。
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const MAX_MESSAGES = 200;
const MAX_PLAYS = 500;
const defaultState = { messages: [], plays: [], favs: [] };
const sourcesOf = (fav) => Array.isArray(fav.sources) ? fav.sources : [fav.source || 'unknown'];
const songKey = (song) => [song?.title, song?.artist].map((part) => String(part || '').replace(/\s+/g, ' ').trim().toLowerCase()).join('|');

export function createStateStore(file = config.paths.state) {
  let state;
  try {
    state = { ...structuredClone(defaultState), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[state] 读档失败，重置为空档：', error.message);
    state = structuredClone(defaultState);
  }
  for (const key of Object.keys(defaultState)) {
    if (!Array.isArray(state[key])) state[key] = [];
  }
  function persist() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(state, null, 2));
      fs.renameSync(temp, file);
    } catch (error) { console.warn('[state] 持久化失败：', error.message); }
  }
  return {
    addMessage(role, content) {
      state.messages.push({ role, content, at: Date.now() });
      if (state.messages.length > MAX_MESSAGES) state.messages = state.messages.slice(-MAX_MESSAGES);
      persist();
    },
    recentMessages(n = 10) { return state.messages.slice(-n); },
    addPlay(song) {
      state.plays.push({ ...song, at: Date.now() });
      if (state.plays.length > MAX_PLAYS) state.plays = state.plays.slice(-MAX_PLAYS);
      persist();
    },
    recentPlays(n = 20) { return state.plays.slice(-n); },
    addFav(fav) {
      const source = fav.source || 'button';
      const existing = state.favs.find((entry) => songKey(entry) === songKey(fav));
      if (existing) existing.sources = [...new Set([...sourcesOf(existing), source])];
      else state.favs.push({ ...fav, sources: [source], at: Date.now() });
      if (state.favs.length > 500) state.favs = state.favs.slice(-500);
      persist();
      return state.favs.length;
    },
    removeFav(song) {
      state.favs = state.favs.flatMap((entry) => {
        if (songKey(entry) !== songKey(song)) return [entry];
        const sources = sourcesOf(entry).filter((source) => source !== 'button');
        return sources.length ? [{ ...entry, sources }] : [];
      });
      persist();
      return state.favs.length;
    },
    recentFavs(n = 10) { return state.favs.slice(-n); },
  };
}

export const { addMessage, recentMessages, addPlay, recentPlays, addFav, removeFav, recentFavs } = createStateStore();
