import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { getSettings } from '../settings.js';
import * as fish from './fish.js';

export function hashTtsText(text) {
  const tts = getSettings().tts;
  const key = `${tts.provider}:${tts.fish.referenceId}:${tts.fish.model}:${text}`;
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

export function createLiveTtsManager({
  cacheDir,
  streamFactory,
  hashText,
  firstByteTimeout = 8000,
  totalTimeout = 45000,
} = {}) {
  const jobs = new Map();

  function prepare(text, { onError, onFirstByte } = {}) {
    const clean = String(text || '').trim();
    if (!clean) throw new Error('tts: 空文本');
    const hash = hashText(clean);
    const file = path.join(cacheDir, `${hash}.mp3`);
    if (fs.existsSync(file)) return { hash, file, url: `/tts/${hash}.mp3`, cached: true };
    const old = jobs.get(hash);
    if (old) {
      if (onError) old.onError = onError;
      if (onFirstByte) old.onFirstByte = onFirstByte;
      return { hash, file, url: `/api/tts/stream/${hash}.mp3`, cached: false, live: true };
    }
    jobs.set(hash, {
      hash, file, text: clean, onError, onFirstByte, chunks: [], listeners: new Set(),
      started: false, done: false, error: null, promise: null,
    });
    return { hash, file, url: `/api/tts/stream/${hash}.mp3`, cached: false, live: true };
  }

  async function run(job) {
    job.started = true;
    const controller = new AbortController();
    let gotFirstByte = false;
    const firstTimer = setTimeout(() => controller.abort(new Error('Fish 首段音频超时')), firstByteTimeout);
    const totalTimer = setTimeout(() => controller.abort(new Error('Fish 合成总超时')), totalTimeout);
    try {
      for await (const value of streamFactory(job.text, { signal: controller.signal })) {
        const chunk = Buffer.from(value);
        if (!chunk.length) continue;
        if (!gotFirstByte) {
          gotFirstByte = true;
          clearTimeout(firstTimer);
          try { job.onFirstByte?.(); } catch {}
        }
        job.chunks.push(chunk);
        for (const response of job.listeners) {
          if (!response.destroyed && !response.writableEnded) response.write(chunk);
        }
      }
      if (!job.chunks.length) throw new Error('Fish 没有返回音频数据');
      fs.mkdirSync(path.dirname(job.file), { recursive: true });
      const temp = `${job.file}.tmp`;
      fs.writeFileSync(temp, Buffer.concat(job.chunks));
      fs.renameSync(temp, job.file);
      job.done = true;
      for (const response of job.listeners) {
        if (!response.destroyed && !response.writableEnded) response.end();
      }
    } catch (error) {
      job.error = error;
      try { job.onError?.(error); } catch {}
      for (const response of job.listeners) {
        if (!response.destroyed && !response.writableEnded) response.end();
      }
      throw error;
    } finally {
      clearTimeout(firstTimer);
      clearTimeout(totalTimer);
      job.listeners.clear();
    }
  }

  async function handle(hash, response) {
    if (!/^[a-f0-9]{16}$/.test(hash)) {
      response.status?.(400);
      response.end('bad tts id');
      return;
    }
    const file = path.join(cacheDir, `${hash}.mp3`);
    response.setHeader('Content-Type', 'audio/mpeg');
    response.setHeader('Cache-Control', 'no-store');
    if (fs.existsSync(file)) {
      response.setHeader('Content-Length', fs.statSync(file).size);
      response.end(fs.readFileSync(file));
      return;
    }
    const job = jobs.get(hash);
    if (!job) {
      response.status?.(404);
      response.end('tts job not found');
      return;
    }
    for (const chunk of job.chunks) response.write(chunk);
    if (job.done || job.error) {
      response.end();
      return;
    }
    job.listeners.add(response);
    const detach = () => job.listeners.delete(response);
    response.once?.('close', detach);
    if (!job.promise) job.promise = run(job);
    try { await job.promise; } catch { /* onError + 结束音频流已处理 */ }
  }

  return { prepare, handle };
}

export const liveTtsManager = createLiveTtsManager({
  cacheDir: config.paths.cacheTts,
  streamFactory: fish.stream,
  hashText: hashTtsText,
});

export function prepareLiveTts(text, options) {
  if (getSettings().tts.provider !== 'fish') throw new Error('实时语音仅支持 Fish provider');
  return liveTtsManager.prepare(text, options);
}
