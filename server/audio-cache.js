// 只公开完整音频。歌曲 ID 是唯一的媒体路径，远端签名地址不会写入缓存索引。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { sources } from './sources.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const MAX_ENTRY_BYTES = 80 * 1024 * 1024;

function mediaId(value) {
  const raw = String(value ?? '');
  const id = raw.startsWith('/media/') ? raw.slice(7) : raw;
  return SAFE_ID.test(id) ? id : '';
}

export function allowedAudioUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol)
      && !url.username && !url.password && !url.port
      && (/(^|\.)(126\.net|netease\.com)$/.test(url.hostname) || sources.allowsHost(url.hostname));
  } catch { return false; }
}

export function createAudioCache({
  root = path.join(config.paths.cache, 'audio'),
  fetch: fetchAudio = globalThis.fetch,
  maxBytes = 400 * 1024 * 1024,
  now = Date.now,
} = {}) {
  const directory = path.resolve(root);
  const pinned = new Set();
  const pending = new Map();
  const fileFor = (id) => path.join(directory, `${id}.audio`);
  const metaFor = (id) => path.join(directory, `${id}.json`);

  function info(value, touch = false) {
    const id = mediaId(value);
    if (!id) return null;
    const file = fileFor(id);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1000 || stat.size > MAX_ENTRY_BYTES) return null;
      const metadata = JSON.parse(fs.readFileSync(metaFor(id), 'utf8'));
      if (metadata.size !== stat.size) return null;
      if (touch) {
        const at = new Date(now());
        fs.utimesSync(file, at, at);
      }
      return { id, url: `/media/${id}`, file, size: stat.size, contentType: metadata.contentType || 'audio/mpeg' };
    } catch { return null; }
  }

  function prune({ keep = '' } = {}) {
    let names;
    try { names = fs.readdirSync(directory); } catch { return; }
    const entries = names.filter((name) => name.endsWith('.audio')).flatMap((name) => {
      const id = mediaId(name.slice(0, -6));
      const entry = id && info(id);
      return entry ? [{ ...entry, at: fs.statSync(entry.file).mtimeMs }] : [];
    });
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries.sort((a, b) => a.at - b.at)) {
      if (total <= maxBytes) break;
      if (pinned.has(entry.id) || entry.id === keep || pending.has(entry.id)) continue;
      fs.rmSync(entry.file, { force: true });
      fs.rmSync(metaFor(entry.id), { force: true });
      total -= entry.size;
    }
  }

  async function download(song, signal) {
    const id = mediaId(song?.id);
    if (!id || String(song.id) !== id) throw new TypeError('音频 ID 无效');
    signal?.throwIfAborted();
    const cached = info(id, true);
    if (cached) return cached;
    let url = String(song?.url || '');
    let response;
    for (let hop = 0; hop <= 3; hop += 1) {
      if (!allowedAudioUrl(url)) throw new TypeError('不允许的音频地址');
      response = await fetchAudio(url, { redirect: 'manual', signal });
      signal?.throwIfAborted();
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || hop === 3) throw new Error('音频重定向过多或没有目标地址');
        url = new URL(location, url).href;
        continue;
      }
      break;
    }
    if (!response?.ok) throw new Error([401, 403, 410].includes(response?.status) ? '这首的播放链接失效了' : '这首音频下载失败');
    const contentType = (response.headers.get('content-type') || 'audio/mpeg').split(';')[0].trim();
    if (!/^audio\//i.test(contentType) && contentType !== 'application/octet-stream') {
      await response.body?.cancel();
      throw new Error('这首音频格式异常');
    }
    const lengthHeader = response.headers.get('content-length');
    const expected = lengthHeader === null ? null : Number(lengthHeader);
    if (expected !== null && (!Number.isFinite(expected) || expected < 1000 || expected > MAX_ENTRY_BYTES)) {
      await response.body?.cancel();
      throw new Error('这首音频大小异常');
    }
    fs.mkdirSync(directory, { recursive: true });
    const temp = path.join(directory, `${id}.${randomUUID()}.tmp`);
    const metaTemp = `${temp}.json`;
    let handle;
    let reader;
    const cancelReader = () => { reader?.cancel(signal?.reason).catch(() => {}); };
    let size = 0;
    try {
      handle = await fs.promises.open(temp, 'wx');
      reader = response.body?.getReader();
      signal?.addEventListener('abort', cancelReader, { once: true });
      signal?.throwIfAborted();
      async function writeChunk(chunk) {
        signal?.throwIfAborted();
        size += chunk.length;
        if (size > MAX_ENTRY_BYTES) throw new Error('这首音频大小异常');
        await handle.writeFile(chunk);
      }
      if (reader) {
        while (true) {
          const { value, done } = await reader.read();
          signal?.throwIfAborted();
          if (done) break;
          await writeChunk(value);
        }
      } else {
        await writeChunk(new Uint8Array(await response.arrayBuffer()));
      }
      signal?.throwIfAborted();
      if (size < 1000 || (expected !== null && expected !== size)) throw new Error('这首音频下载不完整');
      await handle.close();
      handle = null;
      fs.writeFileSync(metaTemp, JSON.stringify({ size, contentType }));
      fs.renameSync(temp, fileFor(id));
      fs.renameSync(metaTemp, metaFor(id));
      const result = info(id, true);
      prune({ keep: id });
      return result;
    } finally {
      signal?.removeEventListener('abort', cancelReader);
      if (reader) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      await handle?.close().catch(() => {});
      fs.rmSync(temp, { force: true });
      fs.rmSync(metaTemp, { force: true });
    }
  }

  return {
    ensure(song, { signal } = {}) {
      const id = mediaId(song?.id);
      if (signal?.aborted) return Promise.reject(signal.reason);
      let entry = pending.get(id);
      if (!entry) {
        const controller = new AbortController();
        entry = { controller, users: 0, promise: download(song, controller.signal) };
        pending.set(id, entry);
        entry.promise.finally(() => { if (pending.get(id) === entry) pending.delete(id); }).catch(() => {});
      }
      entry.users += 1;
      return new Promise((resolve, reject) => {
        let settled = false;
        function finish(callback, value) {
          if (settled) return;
          settled = true;
          entry.users -= 1;
          signal?.removeEventListener('abort', abort);
          callback(value);
        }
        function abort() {
          if (settled) return;
          settled = true;
          entry.users -= 1;
          signal.removeEventListener('abort', abort);
          if (entry.users) { reject(signal.reason); return; }
          if (pending.get(id) === entry) pending.delete(id);
          entry.controller.abort(signal.reason);
          // 最后一位退出后先关文件和读取流，避免重试撞上半成品。
          entry.promise.then(() => reject(signal.reason), () => reject(signal.reason));
        }
        signal?.addEventListener('abort', abort, { once: true });
        entry.promise.then((result) => finish(resolve, result), (error) => finish(reject, error));
      });
    },
    info(value) { return info(value); },
    resolve(value) { return info(value, true)?.file || null; },
    has(value) { return Boolean(info(value)); },
    pin(ids = []) {
      pinned.clear();
      for (const value of ids) { const id = mediaId(value); if (id) pinned.add(id); }
      prune();
    },
    prune,
  };
}

export const audioCache = createAudioCache();
