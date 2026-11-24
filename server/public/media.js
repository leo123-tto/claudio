// 公用版的同源音频代理（退路）：/media/<歌 id>，直链由服务端按这个人的登录态去取。
//
// - 11-23 傍晚前音频全走这里（当时为了整站同源、接 Web Audio）；现在网页先用 https 直链，响度改用 audio.volume。
// - 不收 URL 参数，只收歌 id：没法拿它去代理别的地址。
// - 直链按「人 + 歌 + 档」记 10 分钟，浏览器分段（Range）来取时不再问网易云；上游说过期了就重取一次。
// - 网页优先直接从音乐 CDN 取（见 app.js 的 directUrl），这里是退路：直链失效、浏览器直连放不了时才走。
// - 先放 20 秒音频（至少 2 MB）让歌快点起来、攒够缓冲，之后按码率 4 倍限速（家里上行要分给所有人；
//   经 Cloudflare 隧道绕美国，带宽忽高忽低，2 倍时一掉速就卡）；每人同时最多 3 路，断开就停上游。
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isLevel, minLevel } from '../quality-levels.js';

const URL_TTL = 10 * 60_000;
const BURST = 2 * 1024 * 1024;
const BURST_SECONDS = 20;
const RATE_X = 4;
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

export function throttle(source, { bytesPerSec, burst = BURST, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  return Readable.from((async function* gen() {
    let sent = 0;
    let start = null;
    for await (const chunk of source) {
      yield chunk;
      sent += chunk.length;
      if (sent <= burst) continue;
      if (start === null) start = now();
      const due = start + ((sent - burst) / bytesPerSec) * 1000;
      const wait = due - now();
      if (wait > 0) await sleep(wait);
    }
  })());
}

// /media 是退路，音频经家里上行和隧道：最高到 CD 级无损（lossless 在 ncm-public.js 里封到 16 bit / 48 kHz），选了 Hi-Res 也一样
export const proxyLevel = (level) => minLevel(level, 'lossless');
const askedOf = (query) => (isLevel(query.q) ? query.q : '');

export function createMediaProxy({ ncm, members, qualityFor, fetchFn = fetch, maxStreams = 3, now = () => Date.now(), log = () => {} }) {
  const urls = new Map(); // `${memberId}|${id}|${level}` -> { url, bitrate, until }
  const streams = new Map(); // memberId -> 正在传的路数

  const key = (memberId, id, level) => `${memberId}|${id}|${level}`;

  function remember(memberId, level, song) {
    if (!song?.url || !song.id) return;
    urls.set(key(memberId, song.id, level), { url: song.url, bitrate: song.bitrate || 0, gain: song.gain ?? null, level: song.level || '', quality: song.quality || null, until: now() + URL_TTL });
    if (urls.size > 2000) urls.delete(urls.keys().next().value);
  }

  async function lookup(memberId, id, level, fresh) {
    const k = key(memberId, id, level);
    const hit = urls.get(k);
    if (hit && hit.until > now() && !fresh) return hit;
    const audio = await ncm.songUrl(id, { cookie: members.getCookie(memberId), memberId, level });
    if (!audio || audio.trial) { urls.delete(k); return null; }
    const entry = { url: audio.url, bitrate: audio.bitrate || 0, gain: audio.gain ?? null, level: audio.level || '', quality: audio.quality || null, until: now() + URL_TTL };
    urls.set(k, entry);
    return entry;
  }

  async function handle(req, res) {
    const id = String(req.params.id);
    if (!/^(\d{1,15}|[a-z]{2,4}\d{1,20})$/.test(id)) return res.status(400).end();
    const memberId = req.member.id;
    const level = proxyLevel(qualityFor(members.memory(memberId), members.getCookie(memberId), askedOf(req.query)));
    const open = streams.get(memberId) || 0;
    if (open >= maxStreams) return res.status(429).end();
    streams.set(memberId, open + 1);
    const controller = new AbortController();
    const done = () => {
      controller.abort();
      const left = (streams.get(memberId) || 1) - 1;
      if (left > 0) streams.set(memberId, left); else streams.delete(memberId);
    };
    res.once('close', done);
    try {
      const headers = req.headers.range ? { Range: String(req.headers.range) } : {};
      let entry = await lookup(memberId, id, level, req.query.fresh === '1');
      let upstream = entry && await fetchFn(entry.url, { headers, signal: controller.signal });
      // 直链过期（403 / 404）就重取一次
      if (entry && upstream && [403, 404, 410].includes(upstream.status)) {
        entry = await lookup(memberId, id, level, true);
        upstream = entry && await fetchFn(entry.url, { headers, signal: controller.signal });
      }
      if (!entry || !upstream || !(upstream.status === 200 || upstream.status === 206) || !upstream.body) {
        return res.status(entry ? 502 : 404).end();
      }
      res.status(upstream.status);
      for (const name of PASS_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      res.setHeader('Cache-Control', 'private, no-store');
      const audioBytesPerSec = (entry.bitrate || 320_000) / 8;
      const bytesPerSec = Math.max(128 * 1024, audioBytesPerSec * RATE_X);
      const burst = Math.max(BURST, audioBytesPerSec * BURST_SECONDS);
      await pipeline(throttle(Readable.fromWeb(upstream.body), { bytesPerSec, burst }), res);
    } catch (error) {
      if (controller.signal.aborted) return;
      log('media-failed', memberId, error.code || error.name);
      if (!res.headersSent) res.status(error.code === 'NCM_BUSY' ? 503 : 502).end();
      else res.destroy();
    }
  }

  // 从「最近听过」点回去放、直链过期重取、换音质 / 卡顿降档：先取一次直链（顺带拿到响度和档位），网页直连或从 /media 取。
  // proxied：网页要退到 /media 了，按 /media 那一档（封到 CD）取，页面标的就是 /media 实际给的
  async function meta(memberId, id, { asked = '', proxied = false, fresh = false } = {}) {
    const wanted = qualityFor(members.memory(memberId), members.getCookie(memberId), asked);
    const level = proxied ? proxyLevel(wanted) : wanted;
    const entry = await lookup(memberId, id, level, fresh);
    return entry && { gain: entry.gain, level: entry.level, bitrate: entry.bitrate, url: entry.url, ...(entry.quality ? { quality: entry.quality } : {}) };
  }

  return { remember, handle, meta, streams };
}
