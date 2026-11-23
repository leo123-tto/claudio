// 备用音源：网易云拿不到（灰掉、无版权、只有试听、搜索被限流）时，按插件去别的平台找同一首歌。
//
// 插件不在仓库里：放在 SOURCE_PLUGIN_DIR（默认数据目录下的 plugins/），启动时扫描 *.mjs / *.js。
// 目录不存在、插件加载失败、形状不对，都只是「没有备用音源」，网易云照常工作。
//
// 插件导出 default 对象：
//   name      日志里用的名字
//   prefix    2–4 个小写字母；这个源的歌在 Claudio 里的 id 是「前缀 + 源内数字 id」，和网易云的纯数字 id 分开
//   hosts     直链所在域名（后缀匹配），进 /proxy 和音频缓存的白名单
//   search(keywords, { limit, signal }) → [{ id, title, artist, album, duration(秒) }]
//   songUrl(id, { quality: 'standard' | 'exhigh' | 'lossless', signal }) → { url, format, bitrate(kbps), duration(秒) } | null
//   lyric?(id, { signal }) → LRC 文本
//
// 这里统一做：搜索排队（每个源单独的每分钟上限、间隔、冷却，老板优先，见 createPacer）、按歌名歌手时长认歌、
// 用一次小的 Range 请求核对整曲（文件太小就当试听丢掉）和音质（FLAC 读 STREAMINFO，按实际格式标无损）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';

const PREFIX_RE = /^[a-z]{2,4}$/;
const ALT_ID_RE = /^([a-z]{2,4})(\d{1,20})$/;
const MIN_BPS = 96_000;
const QUALITY_PLAN = {
  hires: ['lossless', 'exhigh'],
  lossless: ['lossless', 'exhigh'],
  exhigh: ['exhigh', 'standard'],
  higher: ['exhigh', 'standard'],
  standard: ['standard'],
};

export class SourceBusyError extends Error {
  constructor(message = '备用音源排队中') {
    super(message);
    this.code = 'SOURCE_BUSY';
  }
}

function validPlugin(plugin) {
  return plugin && typeof plugin === 'object'
    && typeof plugin.name === 'string' && PREFIX_RE.test(plugin.prefix || '')
    && Array.isArray(plugin.hosts) && plugin.hosts.every((h) => typeof h === 'string' && h)
    && typeof plugin.search === 'function' && typeof plugin.songUrl === 'function';
}

export async function loadPlugins(dir, { log = console.warn } = {}) {
  if (!dir) return [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.(mjs|js)$/.test(n)).sort(); } catch { return []; }
  const plugins = [];
  for (const name of names) {
    try {
      const mod = await import(pathToFileURL(path.join(dir, name)).href);
      const plugin = mod.default;
      if (!validPlugin(plugin)) { log(`[sources] ${name} 形状不对，跳过`); continue; }
      if (plugins.some((p) => p.prefix === plugin.prefix)) { log(`[sources] ${name} 前缀重复，跳过`); continue; }
      plugins.push(plugin);
    } catch (error) {
      log(`[sources] ${name} 加载失败，跳过：${error.message}`);
    }
  }
  return plugins;
}

// 每个源一列：老板点歌（chat）直接发但计数；老板后台（background）排队；
// 别人（guest）只在老板没人排队、且没用到 perMin − reserve 时才发，等不到就报忙。
export function createPacer({ perMin = 10, gapMs = 1000, reserve = 3, guestWaitMs = 8000, now = () => Date.now(), sleep } = {}) {
  const sentAt = [];
  let chain = Promise.resolve();
  let ownerWaiting = 0;
  let coolUntil = 0;
  const wait = sleep || ((ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    signal?.addEventListener('abort', stop, { once: true });
  }));
  function nextSlot(cap) {
    const t = now();
    while (sentAt.length && sentAt[0] <= t - 60_000) sentAt.shift();
    let at = gapMs > 0 && sentAt.length ? sentAt.at(-1) + gapMs : t;
    if (cap > 0 && sentAt.length >= cap) at = Math.max(at, sentAt[sentAt.length - cap] + 60_000);
    return Math.max(0, at - t);
  }
  const cooling = () => coolUntil > now();
  async function turn(kind = 'background', signal) {
    if (cooling()) throw new SourceBusyError('备用音源冷却中');
    if (kind === 'chat' || !(perMin > 0)) { sentAt.push(now()); return; }
    if (kind === 'guest') {
      const deadline = now() + guestWaitMs;
      for (;;) {
        if (cooling()) throw new SourceBusyError('备用音源冷却中');
        const ms = ownerWaiting > 0 ? 1000 : nextSlot(Math.max(1, perMin - reserve));
        if (ms <= 0) { sentAt.push(now()); return; }
        if (now() + ms > deadline) throw new SourceBusyError();
        await wait(ms, signal);
      }
    }
    ownerWaiting += 1;
    const mine = chain.then(async () => {
      signal?.throwIfAborted();
      for (let ms = nextSlot(perMin); ms > 0 && !cooling(); ms = nextSlot(perMin)) await wait(ms, signal);
      if (cooling()) throw new SourceBusyError('备用音源冷却中');
      sentAt.push(now());
    }).finally(() => { ownerWaiting = Math.max(0, ownerWaiting - 1); });
    chain = mine.catch(() => {});
    return mine;
  }
  function cool(ms) { coolUntil = Math.max(coolUntil, now() + Math.min(ms, 30 * 60_000)); }
  return { turn, cool, cooling };
}

function baseTitle(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[(\[（【].*?[)\]）】]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
}
function artistNames(value) {
  return String(value || '').normalize('NFKC').toLowerCase().split(/[/&,、;；]|\s+feat\.?\s+/)
    .map((n) => n.trim()).filter((n) => n.length >= 2);
}

// 认歌：歌名去掉括号后要相同；给了歌手就要有一位对得上；两边都有时长时差不超过 8 秒（防翻唱 / Live / 剪辑版）。
export function matchHit(hits = [], { title = '', artist = '', duration = 0 } = {}) {
  const want = baseTitle(title);
  const wantArtists = artistNames(artist);
  return hits.find((hit) => {
    if (!want || baseTitle(hit.title) !== want) return false;
    if (wantArtists.length) {
      const got = artistNames(hit.artist);
      if (!got.some((g) => wantArtists.some((w) => g.includes(w) || w.includes(g)))) return false;
    }
    if (duration > 0 && hit.duration > 0 && Math.abs(duration - hit.duration) > 8) return false;
    return true;
  }) || null;
}

// FLAC 文件头：fLaC + 4 字节块头 + STREAMINFO（采样率 20 位、声道 3 位、位深 5 位）
export function flacInfo(buf) {
  if (!buf || buf.length < 26 || buf.toString('latin1', 0, 4) !== 'fLaC') return null;
  const s = 8;
  const sampleRate = (buf[s + 10] << 12) | (buf[s + 11] << 4) | (buf[s + 12] >> 4);
  const bits = (((buf[s + 12] & 0x01) << 4) | (buf[s + 13] >> 4)) + 1;
  return { sampleRate, bits };
}

// 不支持 Range 的服务器会回整个文件：只读到够用就断开。
async function firstBytes(body, n) {
  if (!body?.getReader) return null;
  const reader = body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (size < n) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value));
      size += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(parts).subarray(0, n);
}

export function createSourceRegistry({
  plugins = [],
  fetchFn = (...args) => globalThis.fetch(...args),
  pacing = {},
  log = console.warn,
  now = () => Date.now(),
} = {}) {
  let list = plugins.filter(validPlugin);
  const pacers = new Map();
  const altOf = new Map(); // 网易云 id → 备用音源 id（认过一次就不再搜）
  const pacer = (plugin) => {
    if (!pacers.has(plugin.prefix)) pacers.set(plugin.prefix, createPacer({ ...pacing, now }));
    return pacers.get(plugin.prefix);
  };
  const byPrefix = (prefix) => list.find((p) => p.prefix === prefix);

  function parseId(altId) {
    const m = ALT_ID_RE.exec(String(altId || ''));
    const plugin = m && byPrefix(m[1]);
    return plugin ? { plugin, id: m[2] } : null;
  }

  function allowsHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    return list.some((p) => p.hosts.some((h) => host === h || host.endsWith(`.${h}`)));
  }

  // 只读头 64 字节：Content-Range 给出整个文件多大，FLAC 顺带读出位深和采样率。
  async function probe(url, signal) {
    try {
      const res = await fetchFn(url, { headers: { Range: 'bytes=0-63' }, signal, redirect: 'follow' });
      const total = Number(/\/(\d+)\s*$/.exec(res.headers.get('content-range') || '')?.[1])
        || (res.status === 200 ? Number(res.headers.get('content-length')) : 0) || 0;
      const head = await firstBytes(res.body, 64);
      return { ok: res.status === 200 || res.status === 206, total, flac: flacInfo(head) };
    } catch (error) {
      signal?.throwIfAborted();
      return { ok: false, total: 0, flac: null, error: error.message };
    }
  }

  // 返回 { url, level, bitrate(bps), size, source } 或 null。level 按实际拿到的格式标，不按要的标。
  async function audioFor(plugin, id, { level = 'exhigh', duration = 0, signal } = {}) {
    for (const quality of QUALITY_PLAN[level] || QUALITY_PLAN.exhigh) {
      let got;
      try { got = await plugin.songUrl(id, { quality, signal }); } catch (error) { signal?.throwIfAborted(); got = null; }
      if (!got?.url) continue;
      let url = String(got.url);
      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'http:') parsed.protocol = 'https:';
        if (parsed.protocol !== 'https:' || !allowsHost(parsed.hostname)) continue;
        url = parsed.href;
      } catch { continue; }
      const seconds = Number(got.duration) || duration || 0;
      const info = await probe(url, signal);
      if (!info.ok) continue;
      // 试听片段（30–60 秒）远小于按 64 kbps 估的整曲下限
      if (seconds > 0 && info.total > 0 && info.total < seconds * 8000) continue;
      const bps = seconds > 0 && info.total > 0 ? Math.round((info.total * 8) / seconds) : (Number(got.bitrate) || 0) * 1000;
      const format = String(got.format || '').toLowerCase();
      let label;
      if (info.flac || format === 'flac') {
        const hires = info.flac && (info.flac.bits > 16 || info.flac.sampleRate > 48_000);
        label = hires && level === 'hires' ? 'hires' : 'lossless';
      } else if (format !== 'mp3' || bps < MIN_BPS) {
        continue;
      } else {
        label = bps >= 250_000 ? 'exhigh' : bps >= 160_000 ? 'higher' : 'standard';
      }
      return { url, level: label, bitrate: bps, size: info.total, source: plugin.name };
    }
    return null;
  }

  async function search(plugin, keywords, { kind, signal, limit = 8 } = {}) {
    await pacer(plugin).turn(kind, signal);
    try {
      return await plugin.search(keywords, { limit, signal });
    } catch (error) {
      signal?.throwIfAborted();
      if (/429|频繁|limit/i.test(error.message || '')) pacer(plugin).cool(5 * 60_000);
      throw error;
    }
  }

  return {
    get size() { return list.length; },
    setPlugins(next) { list = next.filter(validPlugin); pacers.clear(); altOf.clear(); },
    isAltId: (id) => Boolean(parseId(id)),
    allowsHost,

    // 按备用音源 id 取直链（开播前刷新、公用版 /media 重取）
    async songUrl(altId, options = {}) {
      const parsed = parseId(altId);
      return parsed ? audioFor(parsed.plugin, parsed.id, options) : null;
    },

    // 网易云 id 认过的备用音源 id
    altFor: (ncmId) => altOf.get(String(ncmId)) || '',

    // 找同一首歌：{ title, artist, duration, ncmId? } → { id, title, artist, album, duration, url, level, bitrate, source } | null
    // 带 ncmId 时记下对应关系；调用方决定保留网易云的 id / 封面 / 歌词，只换音频。
    async find(song, { level = 'exhigh', kind = 'background', signal } = {}) {
      if (!list.length || !song?.title) return null;
      const known = song.ncmId && altOf.get(String(song.ncmId));
      if (known) {
        const parsed = parseId(known);
        const audio = parsed && await audioFor(parsed.plugin, parsed.id, { level, duration: song.duration, signal });
        if (audio) return { id: known, title: song.title, artist: song.artist, album: song.album || '', duration: song.duration || 0, ...audio };
      }
      let lastError = null;
      for (const plugin of list) {
        let hits;
        try {
          hits = await search(plugin, [song.title, song.artist].filter(Boolean).join(' '), { kind, signal });
        } catch (error) {
          signal?.throwIfAborted();
          lastError = error;
          continue;
        }
        const hit = matchHit(hits, song);
        if (!hit) continue;
        const audio = await audioFor(plugin, hit.id, { level, duration: hit.duration || song.duration, signal });
        if (!audio) continue;
        const id = `${plugin.prefix}${hit.id}`;
        if (song.ncmId) {
          altOf.set(String(song.ncmId), id);
          if (altOf.size > 5000) altOf.delete(altOf.keys().next().value);
        }
        return { id, title: hit.title, artist: hit.artist, album: hit.album || '', duration: hit.duration || 0, ...audio };
      }
      if (lastError?.code === 'SOURCE_BUSY') throw lastError;
      return null;
    },

    async lyric(altId, { signal } = {}) {
      const parsed = parseId(altId);
      if (!parsed?.plugin.lyric) return '';
      try { return String(await parsed.plugin.lyric(parsed.id, { signal }) || ''); } catch (error) { signal?.throwIfAborted(); return ''; }
    },
  };
}

// 个人版和公用版各自的单例：第一次用到时才扫描插件目录（目录由调用方给，公开代码里不写死）。
export function createLazySources(dirFn, options = {}) {
  const registry = createSourceRegistry(options);
  const setPlugins = registry.setPlugins;
  let loading = null;
  // 直接给插件（测试）就不再扫目录
  registry.setPlugins = (plugins) => { setPlugins(plugins); loading = Promise.resolve(registry); };
  registry.ready = () => {
    loading ||= loadPlugins(dirFn(), options).then((plugins) => {
      setPlugins(plugins);
      if (plugins.length) console.log(`[sources] 备用音源：${plugins.map((p) => p.name).join('、')}`);
      return registry;
    });
    return loading;
  };
  return registry;
}

// 本实例用的那一份（个人版；公用版的进程里没有插件目录，就是空的）
export const sources = createLazySources(() => config.sources.pluginDir, {
  pacing: { perMin: config.sources.searchPerMin, gapMs: config.sources.searchGapMs, reserve: config.sources.guestReserve },
});
