// 多设备接力：服务端记一份「现在放到哪、哪台在响」。电脑上暂停，手机打开接着放；同一时刻只有一台在响。
// 存在 cache/playback.json，重启容器也不丢。只记歌，不记口播：换设备接着放时不重念。
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const MAX_QUEUE = 6;
// 在响的设备每 5 秒报一次；30 秒没报（关了页面、断网）就当它已经不响了。
const STALE_MS = 30_000;
const text = (value, max = 200) => String(value ?? '').slice(0, max);

function cleanSong(item) {
  if (!item || typeof item !== 'object') return null;
  const meta = item.meta && typeof item.meta === 'object' ? item.meta : {};
  const title = text(meta.title);
  if (!title) return null;
  const keep = {};
  for (const key of ['id', 'title', 'artist', 'album', 'cover', 'year', 'genre', 'discoveryType', 'remoteUrl']) {
    if (meta[key] != null && meta[key] !== '') keep[key] = text(meta[key], 1000);
  }
  return { type: 'song', url: text(item.url, 2000), meta: keep };
}

export function createHandoffStore(file = path.join(config.paths.cache, 'playback.json'), { now = () => Date.now() } = {}) {
  let state = null;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { state = null; }
  if (state) state.playing = false; // 重启后没有哪台还在响

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
      fs.renameSync(`${file}.tmp`, file);
    } catch { /* 写不下只影响重启后接着放 */ }
  }

  return {
    get() { return state ? structuredClone(state) : null; },
    // 设备上报。返回 { taken }：这台刚开始响、而原来在响的是另一台（要叫那台停）。
    report(body = {}) {
      const deviceId = text(body.deviceId, 80);
      if (!deviceId) return { ok: false };
      const playing = Boolean(body.playing);
      const song = cleanSong(body.song);
      // 别的设备正在响时，不在响的设备的上报（比如它刚打开、被叫停后的那一下）不改状态。
      const live = state?.playing && now() - state.updatedAt < STALE_MS;
      if (!playing && live && state.deviceId !== deviceId) return { ok: true, ignored: true };
      if (!song && !playing) return { ok: true, ignored: true };
      const previous = state;
      // 这台刚开始响（之前没有哪台在响，或在响的是另一台）：叫其他设备停。
      const taken = playing && (!live || previous.deviceId !== deviceId);
      state = {
        deviceId,
        deviceName: text(body.deviceName, 40) || '另一台设备',
        playing,
        song: song || previous?.song || null,
        position: Math.max(0, Number(body.position) || 0),
        queue: Array.isArray(body.queue) ? body.queue.map(cleanSong).filter(Boolean).slice(0, MAX_QUEUE)
          : previous?.queue || [],
        updatedAt: now(),
      };
      save();
      return { ok: true, taken, state: structuredClone(state) };
    },
    // 正在响的那台此刻放到哪：按上报后经过的时间往前推。
    position(at = now()) {
      if (!state) return 0;
      return state.playing ? state.position + Math.min(STALE_MS, Math.max(0, at - state.updatedAt)) / 1000 : state.position;
    },
  };
}

export const handoffStore = createHandoffStore();
