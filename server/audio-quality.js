// 这首歌实际拿到的音质：格式、码率、采样率、位深。只放真拿到的数，拿不到的字段就不带，网页也就不显示。
//
// 网易云 /song/url/v1 每条给 type（MP3 / FLAC…）、br（bps）、sr（采样率）；位深它不给，
// FLAC 就用一次 64 字节的 Range 请求读文件头（STREAMINFO）补上，顺带核对采样率。音源插件的歌在 sources.js 里同样读头。

// FLAC 文件头：fLaC + 4 字节块头 + STREAMINFO（采样率 20 位、声道 3 位、位深 5 位）
export function flacInfo(buf) {
  if (!buf || buf.length < 26 || buf.toString('latin1', 0, 4) !== 'fLaC') return null;
  const s = 8;
  const sampleRate = (buf[s + 10] << 12) | (buf[s + 11] << 4) | (buf[s + 12] >> 4);
  const bits = (((buf[s + 12] & 0x01) << 4) | (buf[s + 13] >> 4)) + 1;
  return { sampleRate, bits };
}

const FORMATS = new Set(['flac', 'mp3', 'aac', 'm4a', 'ogg', 'opus', 'wav', 'ape', 'alac']);
export function cleanFormat(value) {
  const f = String(value || '').trim().toLowerCase();
  return FORMATS.has(f) ? f : '';
}

// 只留有效字段：{ format?, bitrate?(bps), sampleRate?(Hz), bits? }；一个都没有就回 null
export function makeQuality({ format, bitrate, sampleRate, bits } = {}) {
  const q = {};
  const f = cleanFormat(format);
  if (f) q.format = f;
  const br = Math.round(Number(bitrate) || 0);
  if (br >= 8000 && br <= 20_000_000) q.bitrate = br;
  const sr = Math.round(Number(sampleRate) || 0);
  if (sr >= 8000 && sr <= 768_000) q.sampleRate = sr;
  const b = Math.round(Number(bits) || 0);
  if (b >= 8 && b <= 32) q.bits = b;
  return Object.keys(q).length ? q : null;
}

// 网易云 song/url/v1 的一条
export function ncmQuality(item) {
  return makeQuality({ format: item?.type || item?.encodeType, bitrate: item?.br, sampleRate: item?.sr });
}

// 不支持 Range 的服务器会回整个文件：只读到够用就断开。
export async function firstBytes(body, n) {
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

// FLAC 补位深 / 采样率：读不到（超时、CDN 拒绝）就原样返回，不猜。
export async function withFlacHeader(quality, url, { fetchFn = (...a) => globalThis.fetch(...a), signal, timeout = 2500 } = {}) {
  if (quality?.format !== 'flac' || !url) return quality;
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, timeout);
  try {
    const res = await fetchFn(url, { headers: { Range: 'bytes=0-63' }, signal: controller.signal, redirect: 'follow' });
    if (!(res?.status === 200 || res?.status === 206)) return quality;
    const info = flacInfo(await firstBytes(res.body, 64));
    return info ? makeQuality({ ...quality, sampleRate: info.sampleRate, bits: info.bits }) : quality;
  } catch {
    signal?.throwIfAborted();
    return quality;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}
