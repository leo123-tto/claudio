// 状态 · 记忆：messages / plays / favs，落盘到 cache/state.json，跨重启持久。
// MVP 用 JSON 文件；全功能阶段可换 sqlite（保持同样的函数签名即可）。
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const FILE = config.paths.state;
const MAX_MESSAGES = 200;
const MAX_PLAYS = 500;

const defaultState = { messages: [], plays: [], favs: [] };

let state = load();

function load() {
  try {
    return { ...structuredClone(defaultState), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch (e) {
    // 文件不存在是首次启动的正常情况；存在却解析失败要告警（历史可能丢失）
    if (e.code !== 'ENOENT') console.warn('[state] 读档失败，重置为空档：', e.message);
    return structuredClone(defaultState);
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`; // 原子写：先写临时文件再 rename，避免写一半崩溃截断成非法 JSON
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.warn('[state] 持久化失败：', e.message);
  }
}

export function addMessage(role, content) {
  state.messages.push({ role, content, at: Date.now() });
  if (state.messages.length > MAX_MESSAGES) state.messages = state.messages.slice(-MAX_MESSAGES);
  persist();
}

export function recentMessages(n = 10) {
  return state.messages.slice(-n);
}

export function addPlay(song) {
  state.plays.push({ ...song, at: Date.now() });
  if (state.plays.length > MAX_PLAYS) state.plays = state.plays.slice(-MAX_PLAYS);
  persist();
}

export function recentPlays(n = 20) {
  return state.plays.slice(-n);
}

// 收藏：记录时间 + 当时的情况（mode/mood），慢慢沉淀进品味
export function addFav(fav) {
  if (!state.favs) state.favs = [];
  state.favs.push({ ...fav, at: Date.now() });
  if (state.favs.length > 500) state.favs = state.favs.slice(-500);
  persist();
  return state.favs.length;
}

export function recentFavs(n = 10) {
  return (state.favs || []).slice(-n);
}
