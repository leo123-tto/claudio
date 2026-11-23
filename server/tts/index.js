// 声音管线：synthesize(text, { signal }) -> { url }，按 hash 缓存到 cache/tts/<hash>.<ext>。
// provider 可插拔，由 .env 的 TTS_PROVIDER 切换：
//   say  —— macOS 本地，开发期默认占位（离线、最稳）；不参与自动兜底
//   pc5090 —— 5090 台式机上的 Fish S2-Pro（默认）
//   fish —— Fish Audio 云端（需 key，手动备用）
// （edge provider 国内连不上微软端点，已于 2026-06-07 删除。）
// 每个 provider 模块导出 { synthesize(text, { signal })->Buffer, ext }。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { getSettings } from '../settings.js';
import * as say from './say.js';
import * as fish from './fish.js';
import * as pc5090 from './pc5090.js';
import { hashTtsText } from './live.js';
import { throwIfAborted, withAbort } from './abort.js';
import { textForProvider } from './tags.js';

const providers = { say, fish, pc5090 };

export function createTtsSynthesizer({
  cacheDir = config.paths.cacheTts,
  getTts = () => getSettings().tts,
  providerRegistry = providers,
  hashText = hashTtsText,
  totalTimeout = (providerName) => providerName === 'pc5090' ? 300000 : 45000,
} = {}) {
  const inflight = new Map();

  // 并发调用共用一次合成；最后一位调用者取消时才终止上游。
  return async function synthesize(text, { signal } = {}) {
    throwIfAborted(signal);
    const settings = getTts();
    const providerName = settings.provider;
    const clean = textForProvider(text, providerName);
    if (!clean) throw new Error('tts: 空文本');

    const provider = providerRegistry[providerName];
    if (!provider) throw new Error(`不支持的 TTS provider：${providerName}（不会自动切换到其他语音）`);
    const ext = provider.ext ?? 'mp3';
    const hash = hashText(clean, settings);
    const file = path.join(cacheDir, `${hash}.${ext}`);
    const url = `/tts/${hash}.${ext}`;

    if (fs.existsSync(file)) return { hash, file, url, cached: true };

    let job = inflight.get(file);
    const reused = Boolean(job && !job.controller.signal.aborted);
    if (!reused) {
      const budget = typeof totalTimeout === 'function' ? totalTimeout(providerName) : totalTimeout;
      if (!Number.isFinite(budget) || budget <= 0) throw new TypeError('tts: 合成总截止必须为正数毫秒');
      job = { controller: new AbortController(), users: 0, settled: false, promise: null };
      const current = job;
      const timer = setTimeout(() => current.controller.abort(
        Object.assign(new Error(`${providerName} 语音合成总超时`), { name: 'TimeoutError' }),
      ), budget);
      job.promise = (async () => {
        // 先登记调用者，再启动 provider，使同一轮取消不会启动多余的网络请求。
        await Promise.resolve();
        throwIfAborted(current.controller.signal);
        const buf = await withAbort(provider.synthesize(clean, { signal: current.controller.signal }), current.controller.signal);
        throwIfAborted(current.controller.signal);
        if (!buf?.length) throw new Error('tts: 没有返回音频数据');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${crypto.randomUUID()}.tmp`;
        try {
          fs.writeFileSync(tmp, buf);
          fs.renameSync(tmp, file);
        } finally { fs.rmSync(tmp, { force: true }); }
      })().finally(() => {
        clearTimeout(timer);
        current.settled = true;
        if (inflight.get(file) === current) inflight.delete(file);
      });
      job.promise.catch(() => {});
      inflight.set(file, job);
    }
    job.users += 1;
    try {
      await withAbort(job.promise, signal);
      throwIfAborted(signal);
    } finally {
      job.users -= 1;
      if (!job.users && !job.settled) {
        job.controller.abort(signal?.reason);
        if (inflight.get(file) === job) inflight.delete(file);
      }
    }
    return { hash, file, url, cached: reused };
  };
}

export const synthesize = createTtsSynthesizer();
