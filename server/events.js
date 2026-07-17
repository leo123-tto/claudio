import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { deriveProfile } from './profile.js';

const EVENT_TYPES = new Set([
  'play_started', 'play_progress', 'play_completed', 'skip', 'replay',
  'favorite', 'dislike', 'explicit_like', 'explicit_dislike', 'repeated_request',
  'memory_inferred', 'recommendation',
]);

function clean(value, max = 200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function finiteNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : undefined;
}

function sanitize(event) {
  const type = clean(event?.type, 40);
  if (!EVENT_TYPES.has(type)) throw new TypeError(`不支持的行为事件：${type || '空'}`);
  const songTitle = clean(event.song?.title);
  const songArtist = clean(event.song?.artist);
  const output = {
    id: randomUUID(),
    at: new Date().toISOString(),
    type,
  };
  if (songTitle || songArtist) output.song = { title: songTitle, artist: songArtist };
  const listenRatio = finiteNumber(event.listenRatio, { min: 0, max: 1 });
  const listenedSec = finiteNumber(event.listenedSec, { min: 0, max: 24 * 60 * 60 });
  const durationSec = finiteNumber(event.durationSec, { min: 0, max: 24 * 60 * 60 });
  if (listenRatio !== undefined) output.listenRatio = listenRatio;
  if (listenedSec !== undefined) output.listenedSec = listenedSec;
  if (durationSec !== undefined) output.durationSec = durationSec;
  if (clean(event.key, 80)) output.key = clean(event.key, 80);
  if (clean(event.value)) output.value = clean(event.value);
  if (clean(event.evidenceId, 100)) output.evidenceId = clean(event.evidenceId, 100);
  if (clean(event.discoveryType, 30)) output.discoveryType = clean(event.discoveryType, 30);
  if (clean(event.fingerprint, 80)) output.fingerprint = clean(event.fingerprint, 80);
  if (clean(event.source, 40)) output.source = clean(event.source, 40);
  return output;
}

export function createEventStore(file = path.join(config.paths.cache, 'listening-events.jsonl')) {
  return {
    file,
    append(event) {
      const safe = sanitize(event);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(safe)}\n`);
      return safe;
    },
    read(limit = 5000) {
      try {
        return fs.readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .slice(-Math.max(1, limit))
          .map((line) => { try { return JSON.parse(line); } catch { return null; } })
          .filter(Boolean);
      } catch (error) {
        if (error.code !== 'ENOENT') console.warn('[events] 读取失败：', error.message);
        return [];
      }
    },
  };
}

export const eventStore = createEventStore();

export function logEvent(event) {
  return eventStore.append(event);
}

export function readEvents(limit = 5000) {
  return eventStore.read(limit);
}

export function currentProfile() {
  return deriveProfile(readEvents());
}

export function inferExplicitFeedback(input, song) {
  const text = clean(input, 500);
  if (!text || !song?.title) return null;
  if (/(不喜欢|不好听|难听|听腻|腻了|别再放|不要再放|跳过这类)/i.test(text)) {
    return { type: 'explicit_dislike', song, source: 'chat' };
  }
  if (/(很喜欢|我喜欢|真好听|太好听|爱了|深得我心|收藏这首)/i.test(text)) {
    return { type: 'explicit_like', song, source: 'chat' };
  }
  return null;
}

export function recentListenedSongs(limit = 50) {
  const events = readEvents().filter((event) => ['play_started', 'play_completed'].includes(event.type) && event.song);
  const seen = new Set();
  const result = [];
  for (let index = events.length - 1; index >= 0 && result.length < limit; index -= 1) {
    const song = events[index].song;
    const key = `${song.title.toLocaleLowerCase()}|${song.artist.toLocaleLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(song);
  }
  return result;
}

export function dislikedSongs() {
  return readEvents()
    .filter((event) => ['dislike', 'explicit_dislike'].includes(event.type) && event.song)
    .map((event) => event.song);
}

export function recentFingerprints(limit = 6) {
  return readEvents()
    .filter((event) => event.type === 'recommendation' && event.fingerprint)
    .slice(-limit)
    .map((event) => event.fingerprint);
}
