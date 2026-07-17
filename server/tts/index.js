// 声音管线：synthesize(text) -> { url }，按 hash 缓存到 cache/tts/<hash>.<ext>。
// provider 可插拔，由 .env 的 TTS_PROVIDER 切换：
//   say  —— macOS 本地，开发期默认占位（离线、最稳）
//   fish —— Fish Audio（当前默认，需 key）
// （edge provider 国内连不上微软端点，已于 2026-06-07 删除。）
// 每个 provider 模块导出 { synthesize(text)->Buffer, ext }。
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getSettings } from '../settings.js';
import * as say from './say.js';
import * as fish from './fish.js';
import { hashTtsText } from './live.js';

const providers = { say, fish };

// in-flight 去重：同一文本的并发合成只跑一次（流式路径会对同一 say 调两次 synthesize）。
const inflight = new Map();

// 返回 { hash, file, url, cached }；url 给前端走 /tts/<hash>.<ext>
export async function synthesize(text) {
  const clean = (text ?? '').trim();
  if (!clean) throw new Error('tts: 空文本');

  const providerName = getSettings().tts.provider;
  const provider = providers[providerName];
  if (!provider) throw new Error(`不支持的 TTS provider：${providerName}（不会自动切换到 macOS 语音）`);
  const ext = provider.ext ?? 'mp3';
  const hash = hashTtsText(clean);
  const file = path.join(config.paths.cacheTts, `${hash}.${ext}`);
  const url = `/tts/${hash}.${ext}`;

  if (fs.existsSync(file)) return { hash, file, url, cached: true };

  // 并发去重：同一目标文件正在合成时，复用同一个 job，避免两次 spawn + 交错写坏文件。
  if (inflight.has(file)) {
    await inflight.get(file);
    return { hash, file, url, cached: true };
  }

  const job = (async () => {
    const buf = await provider.synthesize(clean);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`; // 原子落盘：先写临时文件再 rename，避免半截文件
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  })();
  inflight.set(file, job);
  try {
    await job;
  } finally {
    inflight.delete(file);
  }
  return { hash, file, url, cached: false };
}
