import { resolveEpisodeSongs } from './episode-audio.js';
import { songIdentity } from './bans.js';
import { withAbort } from './tts/abort.js';
import { genreEvidence } from './style-request.js';

const HUNT_SIZE = 4;
const evidenceRank = { '': 0, match: 0, unknown: 1, conflict: 2 };

export function fillerCandidates({ favorites = [], recent = [], played = [], banned = [], held = [], exclude = [], cached = () => false } = {}) {
  const uniquePlayed = [...new Map(played.slice().reverse().map((song) => [songIdentity(song), song])).values()].slice(0, 30);
  const blocked = new Set([...uniquePlayed, ...banned, ...held].map(songIdentity));
  const ids = new Set([...exclude, ...uniquePlayed.map((s) => s.id), ...banned.map((s) => s.id), ...held.map((s) => s.id)].filter(Boolean).map(String));
  const unique = new Map();
  for (const song of [...recent.slice().reverse(), ...favorites]) {
    const key = songIdentity(song);
    if (key === '|' || unique.has(key) || blocked.has(key) || (song.id && ids.has(String(song.id)))) continue;
    unique.set(key, song);
  }
  return [...unique.values()].sort((a, b) => Number(cached(b.id)) - Number(cached(a.id)));
}

export function createFillerService({ candidates, resolve, lyric = async () => '', cache, style = () => [], limited = () => false, changed = () => {}, timeout = 6000, lyricTimeout = 3000 } = {}) {
  const reserve = new Map();
  let prepared = null;
  let filling = null;
  let version = 0;
  let nextCandidate = '';
  let huntAvailable = true;
  const controllers = new Set();
  function eligible(exclude = []) {
    return candidates(exclude).filter((song) => !exclude.map(String).includes(String(song.id)));
  }
  function itemFor(song) {
    return { type: 'song', url: cache.has(song.id) ? `/media/${song.id}` : song.url,
      meta: { ...song, remoteUrl: song.url, discoveryType: 'filler' } };
  }
  async function loadLyric(song, signal, deadline) {
    const budget = Math.min(lyricTimeout, deadline - Date.now());
    if (!song.id || signal.aborted || budget <= 0) return '';
    const controller = new AbortController();
    const lyricSignal = AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      const text = await withAbort(lyric(song.id, { signal: lyricSignal }), lyricSignal);
      lyricSignal.throwIfAborted();
      return typeof text === 'string' ? text : '';
    } catch { return ''; }
    finally { clearTimeout(timer); controller.abort(); }
  }
  function fill() {
    if (filling) return filling;
    const token = version;
    const taskController = new AbortController();
    const signal = taskController.signal;
    controllers.add(taskController);
    filling = (async () => {
      const constraints = style();
      const styleKey = JSON.stringify(constraints);
      const songs = eligible();
      const allowed = new Set(songs.map(songIdentity));
      for (const key of reserve.keys()) if (!allowed.has(key)) reserve.delete(key);
      const start = Math.max(0, songs.findIndex((song) => songIdentity(song) === nextCandidate));
      const rotated = [...songs.slice(start), ...songs.slice(0, start)];
      const pending = songs.filter((song) => {
        const entry = reserve.get(songIdentity(song));
        return entry && !cache.has(entry.song.id);
      });
      // 先刷新已有未缓存项，只有空位才补新歌。
      const ordered = [...pending, ...rotated.filter((song) => !reserve.has(songIdentity(song)))];
      const deadline = Date.now() + timeout;
      const fresh = new Set();
      const downloads = [];
      const servable = (entry) => cache.has(entry.song.id) || fresh.has(entry);
      const readyCount = () => [...reserve.values()].filter(servable).length;
      const playable = ({ resolved: song }) => song && (cache.has(song.id) || (song.url && song.playable !== false));
      const resolveCandidate = (candidate, options) => {
        const local = reserve.get(songIdentity(candidate))?.song || candidate;
        return cache.has(local.id) ? Promise.resolve(local) : resolve(candidate, options);
      };
      const loadLyrics = (results) => Promise.all(results.map(async ({ candidate, resolved: song }) => ({ candidate,
        resolved: { ...song, lyric: await loadLyric(song, signal, deadline) } })));
      function addEntry(candidate, song) {
        const key = songIdentity(candidate);
        // 解析可能修正歌名和歌手；资格始终看原候选。
        const entry = { candidate, song };
        reserve.set(key, entry);
        fresh.add(entry);
        downloads.push((async () => {
          try { await cache.ensure(song, { signal }); }
          catch {
            if (signal.aborted || reserve.get(key) !== entry) return;
            reserve.delete(key);
            changed();
          }
        })());
      }
      let offset = 0;
      let huntThisRound = false;
      let sawRateLimited = false;
      const dispatched = new Set();
      for (; offset < ordered.length && Date.now() < deadline;) {
        const slots = 8 - readyCount();
        if (slots <= 0) break;
        const batch = ordered.slice(offset, offset + slots);
        offset += batch.length;
        // 本轮耗尽预算也记住进度，不能永远重试前八首。
        nextCandidate = songIdentity(ordered[offset % ordered.length]);
        for (const candidate of batch) dispatched.add(songIdentity(candidate));
        // 只有实际补库才消耗机会；定时空转不另起寻找。
        if (huntAvailable) { huntThisRound = true; huntAvailable = false; }
        const results = await resolveEpisodeSongs(batch, {
          signal, timeout: Math.max(1, deadline - Date.now()),
          resolve: resolveCandidate,
        });
        if (version !== token || signal.aborted) { controllers.delete(taskController); return new Set(); }
        sawRateLimited ||= results.some(({ resolved: song }) => song?.rateLimited);
        // 入库前并行补歌词；缺词不挡播放，等待也不能超出本轮剩余预算。
        const ready = await loadLyrics(results.filter(playable));
        if (version !== token || signal.aborted) { controllers.delete(taskController); return new Set(); }
        // 失败和超时的旧直链不再占位，下轮继续后面的候选。
        for (const candidate of batch) {
          const key = songIdentity(candidate);
          if (reserve.has(key) && !cache.has(reserve.get(key).song.id)) reserve.delete(key);
        }
        // 整批被网易云限流就停，别把整个曲库都打过去；普通不可播仍在本轮预算内往后找。
        if (!ready.length && results.some(({ resolved: song }) => song?.rateLimited)) break;
        for (const { candidate, resolved: song } of ready) addEntry(candidate, song);
      }
      // 点了曲风而这轮没有对得上的：同一预算里再解析四首，只留曲风对得上的；每次 invalidate 最多找一次。
      if (huntThisRound && genreEvidence({}, constraints) && JSON.stringify(style()) === styleKey
        && !sawRateLimited && !limited() && Date.now() < deadline
        && ![...reserve.values()].some((entry) => servable(entry) && genreEvidence(entry.song, constraints) === 'match')) {
        const batch = [];
        while (offset < ordered.length && batch.length < HUNT_SIZE) {
          const candidate = ordered[offset++];
          const key = songIdentity(candidate);
          if (!reserve.has(key) && !dispatched.has(key)) { batch.push(candidate); dispatched.add(key); }
        }
        if (batch.length) {
          nextCandidate = songIdentity(ordered[offset % ordered.length]);
          const results = await resolveEpisodeSongs(batch, {
            signal, timeout: Math.max(1, deadline - Date.now()), resolve: resolveCandidate,
          });
          if (version !== token || signal.aborted) { controllers.delete(taskController); return new Set(); }
          if (JSON.stringify(style()) === styleKey) {
            const ready = await loadLyrics(results.filter(playable)
              .filter(({ resolved: song }) => genreEvidence(song, constraints) === 'match'));
            if (version !== token || signal.aborted) { controllers.delete(taskController); return new Set(); }
            if (JSON.stringify(style()) === styleKey) for (const { candidate, resolved: song } of ready) {
              if (reserve.size >= 8) {
                const others = [...reserve.entries()].filter(([, entry]) => servable(entry) && genreEvidence(entry.song, constraints) !== 'match');
                if (others.length <= 1) continue;
                others.sort(([, a], [, b]) => evidenceRank[genreEvidence(b.song, constraints)] - evidenceRank[genreEvidence(a.song, constraints)]
                  || Number(cache.has(a.song.id)) - Number(cache.has(b.song.id)));
                reserve.delete(others[0][0]);
              }
              addEntry(candidate, song);
            }
          }
        }
      }
      void Promise.allSettled(downloads).finally(() => controllers.delete(taskController));
      changed();
      return fresh;
    })().catch(() => { taskController.abort(); controllers.delete(taskController); return new Set(); }).finally(() => {
      if (token === version) filling = null;
    });
    return filling;
  }
  async function take(exclude = []) {
    const choose = (fresh = new Set()) => {
      const constraints = style();
      const allowed = new Set(eligible(exclude).map(songIdentity));
      const excluded = new Set(exclude.map(String));
      return [...reserve.values()]
      .filter(({ candidate, song }) => allowed.has(songIdentity(candidate)) && !excluded.has(String(song.id)))
      // 未完整落盘的直链只能使用本轮刷新结果。
      .filter((entry) => cache.has(entry.song.id) || fresh.has(entry))
      .sort((a, b) => evidenceRank[genreEvidence(a.song, constraints)] - evidenceRank[genreEvidence(b.song, constraints)]
        || Number(cache.has(b.song.id)) - Number(cache.has(a.song.id)))[0]?.song;
    };
    let song = choose();
    if (!song) song = choose(await fill());
    if (!song) return null;
    prepared = itemFor(song);
    changed();
    return prepared;
  }
  return {
    take, fill,
    pins: () => prepared?.meta.id ? [prepared.meta.id] : [],
    invalidate() { version += 1; for (const task of controllers) task.abort(); controllers.clear(); filling = null; reserve.clear(); prepared = null; nextCandidate = ''; huntAvailable = true; changed(); },
  };
}
