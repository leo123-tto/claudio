import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { getSettings } from '../settings.js';
import * as fish from './fish.js';
import * as pc5090 from './pc5090.js';
import { abortReason, throwIfAborted, withAbort } from './abort.js';
import { textForProvider } from './tags.js';

// 念法变了（整段 / 逐句、语气提示）缓存要跟着换，不然会放出旧念法的录音
function pc5090Variant() {
  const env = config.tts.pc5090;
  return `${env.split ? '' : ':whole'}${env.style ? `:${env.style}` : ''}`;
}

export function hashTtsText(text, tts = getSettings().tts) {
  const pcCfg = tts.pc5090 || {};
  const fishCfg = tts.fish || {};
  const extra = tts.provider === 'pc5090'
    ? `${pcCfg.baseUrl || ''}:${pcCfg.voice || ''}${pc5090Variant()}`
    : `${fishCfg.referenceId || ''}:${fishCfg.model || ''}`;
  const key = `${tts.provider}:${extra}:${text}`;
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

function ttsProviderLabel(provider = getSettings().tts.provider) {
  if (provider === 'pc5090') return '5090 语音';
  if (provider === 'fish') return 'Fish';
  return provider || '语音';
}

async function* currentTtsStream(text, options) {
  const provider = getSettings().tts.provider;
  if (provider === 'pc5090') {
    yield* pc5090.stream(text, options);
    return;
  }
  if (provider === 'fish') {
    yield* fish.stream(text, options);
    return;
  }
  throw new Error(`实时语音不支持 ${provider}，不会自动切换`);
}

export function createLiveTtsManager({
  cacheDir,
  streamFactory,
  hashText,
  firstByteTimeout = 8000,
  totalTimeout = 45000,
  getProvider = () => getSettings().tts.provider,
  getLaneState = () => pc5090.getLaneStatus().state,
  laneStatusEvents = pc5090.laneEvents,
  laneCooldown = () => pc5090.cooldownError(),
} = {}) {
  const jobs = new Map();

  function prepare(text, { signal, onError, onFirstByte } = {}) {
    throwIfAborted(signal);
    const clean = textForProvider(text, getProvider());
    if (!clean) throw new Error('tts: 空文本');
    const hash = hashText(clean);
    const file = path.join(cacheDir, `${hash}.mp3`);
    if (fs.existsSync(file)) {
      return { hash, file, url: `/tts/${hash}.mp3`, cached: true, ready: Promise.resolve() };
    }
    // 5090 冷却中（被占 10 分钟 / 连不上 45 秒）：当场报错。异步失败会晚于回复，网页要白等 8 秒才放歌。
    const cooling = getProvider() === 'pc5090' ? laneCooldown() : null;
    if (cooling) throw cooling;
    const old = jobs.get(hash);
    if (old && !old.error && !old.controller.signal.aborted) {
      subscribe(old, { signal, onError, onFirstByte });
      return { hash, file, url: `/api/tts/stream/${hash}.mp3`, cached: false, live: true, ready: old.ready };
    }
    let resolveReady = () => {};
    let rejectReady = () => {};
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    ready.catch(() => {});
    const job = {
      hash, file, text: clean, chunks: [], listeners: new Set(),
      controller: new AbortController(), errorCallbacks: new Set(), firstByteCallbacks: new Set(), cleanups: [],
      started: false, done: false, error: null, promise: null, ready,
      resolveReady, rejectReady, readySettled: false,
    };
    jobs.set(hash, job);
    subscribe(job, { signal, onError, onFirstByte });
    // 稿子一到就开合成，不等浏览器来取。本地语音不按次计费，少等一个来回。
    job.promise = run(job);
    job.promise.catch(() => {});
    return { hash, file, url: `/api/tts/stream/${hash}.mp3`, cached: false, live: true, ready };
  }

  function subscribe(job, { signal, onError, onFirstByte }) {
    if (onError) job.errorCallbacks.add(onError);
    if (onFirstByte) {
      if (job.readySettled && !job.error) { try { onFirstByte(); } catch {} }
      else job.firstByteCallbacks.add(onFirstByte);
    }
    if (signal) {
      const abort = () => job.controller.abort(abortReason(signal));
      signal.addEventListener('abort', abort, { once: true });
      job.cleanups.push(() => signal.removeEventListener('abort', abort));
    }
  }

  async function run(job) {
    job.started = true;
    const controller = job.controller;
    let gotFirstByte = false;
    const provider = getProvider();
    const label = ttsProviderLabel(provider);
    // 只有真的在启动时才等冷启动；热通道卡住仍按通常预算失败。
    let firstTimer;
    let totalTimer;
    let coldStart = false;
    const armFirst = (state) => {
      if (gotFirstByte) return;
      clearTimeout(firstTimer);
      const starting = provider === 'pc5090' && state === 'starting';
      if (starting && !coldStart) {
        coldStart = true;
        clearTimeout(totalTimer);
        totalTimer = setTimeout(() => controller.abort(new Error(`${label} 合成总超时`)), Math.max(totalTimeout, 300000));
      }
      firstTimer = setTimeout(() => controller.abort(new Error(`${label} 首段音频超时`)),
        starting ? Math.max(firstByteTimeout, 240000) : firstByteTimeout);
    };
    totalTimer = setTimeout(() => controller.abort(new Error(`${label} 合成总超时`)), totalTimeout);
    const laneChanged = ({ state }) => armFirst(state);
    if (provider === 'pc5090') laneStatusEvents.on('status', laneChanged);
    armFirst(provider === 'pc5090' ? getLaneState() : 'ready');
    let iterator;
    try {
      throwIfAborted(controller.signal);
      iterator = streamFactory(job.text, { signal: controller.signal })[Symbol.asyncIterator]();
      while (true) {
        const { value, done } = await withAbort(iterator.next(), controller.signal);
        throwIfAborted(controller.signal);
        if (done) break;
        const chunk = Buffer.from(value);
        if (!chunk.length) continue;
        if (!gotFirstByte) {
          gotFirstByte = true;
          clearTimeout(firstTimer);
          for (const callback of job.firstByteCallbacks) { try { callback(); } catch {} }
          job.firstByteCallbacks.clear();
          throwIfAborted(controller.signal);
          if (!job.readySettled) {
            job.readySettled = true;
            try { job.resolveReady?.(); } catch {}
          }
        }
        job.chunks.push(chunk);
        for (const response of job.listeners) {
          if (!response.destroyed && !response.writableEnded) response.write(chunk);
        }
      }
      throwIfAborted(controller.signal);
      if (!job.chunks.length) throw new Error(`${label} 没有返回音频数据`);
      fs.mkdirSync(path.dirname(job.file), { recursive: true });
      const temp = `${job.file}.tmp`;
      const audio = Buffer.concat(job.chunks);
      // 5090 是逐句拼的流，落盘时补上整段的 Xing 帧，重播时时长才对。
      try {
        fs.writeFileSync(temp, provider === 'pc5090' ? pc5090.withXing(audio) : audio);
        fs.renameSync(temp, job.file);
      } finally { fs.rmSync(temp, { force: true }); }
      job.done = true;
      for (const response of job.listeners) {
        if (!response.destroyed && !response.writableEnded) response.end();
      }
    } catch (error) {
      controller.abort(error);
      job.error = error;
      if (jobs.get(job.hash) === job) jobs.delete(job.hash);
      if (!job.readySettled) {
        job.readySettled = true;
        try { job.rejectReady?.(error); } catch {}
      }
      for (const callback of job.errorCallbacks) { try { callback(error); } catch {} }
      for (const response of job.listeners) {
        if (response.destroyed || response.writableEnded) continue;
        if (job.chunks.length || response.headersSent) response.destroy?.();
        else { response.status?.(502); response.end('tts synthesis failed'); }
      }
      throw error;
    } finally {
      clearTimeout(firstTimer);
      clearTimeout(totalTimer);
      if (provider === 'pc5090') laneStatusEvents.off('status', laneChanged);
      for (const cleanup of job.cleanups) cleanup();
      if (jobs.get(job.hash) === job) jobs.delete(job.hash);
      // 不等待一个已经卡住的 next()；实际 provider 会收到同一个 abort signal。
      if (job.error && iterator?.return) Promise.resolve(iterator.return()).catch(() => {});
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
    if (job.done) {
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
  streamFactory: currentTtsStream,
  hashText: hashTtsText,
});

export function prepareLiveTts(text, options) {
  return liveTtsManager.prepare(text, options);
}
