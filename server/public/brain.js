// 公用版的大脑：拼一段短提示词 → 本地盒子大模型 → {say, intent, play[], memoryCandidates}。
//
// 老板优先：盒子推理引擎不分调用方，所以由公用版自己让路——
//   1. 整个公用实例同一时间只跑 1 个大模型请求，排队超过上限直接说「人多」；
//   2. 发之前看一眼引擎 /metrics，有人在排队或已占满阈值就等，等不到就降级（不叫大模型，按听众原话直接搜歌）。
import { DRIVE_PROMPT } from '../drive.js';
import fs from 'node:fs';
import { callLocalRaw, buildLocalBody } from '../llm/local.js';
import { extractJson } from '../llm/normalize.js';

export class BrainBusyError extends Error {
  constructor(message = 'DJ 这会儿有点忙') {
    super(message);
    this.code = 'BRAIN_BUSY';
  }
}

export function createGate({ maxQueue = 4 } = {}) {
  let running = false;
  const waiters = [];
  return {
    async run(fn) {
      if (running) {
        if (waiters.length >= maxQueue) throw Object.assign(new BrainBusyError('现在点歌的人有点多，过一会儿再试'), { queueFull: true });
        await new Promise((resolve) => waiters.push(resolve));
      }
      running = true;
      try {
        return await fn();
      } finally {
        running = false;
        waiters.shift()?.();
      }
    },
    get queued() { return waiters.length; },
    get full() { return running && waiters.length >= maxQueue; },
  };
}

// 解析 Prometheus 文本里 running / waiting 两个数
export function parseEngineLoad(text) {
  const pick = (name) => {
    const m = String(text || '').match(new RegExp(`^[\\w:]*(?:num_)?requests_${name}(?:\\{[^}]*\\})?\\s+([0-9.]+)`, 'm'));
    return m ? Number(m[1]) : 0;
  };
  return { running: pick('running'), waiting: pick('waiting') };
}

export function buildPrompt({ persona, text, auto, memory, bound, hour, drive = false }) {
  const lines = [persona.trim(), '', '## 此刻', `北京时间 ${hour} 点。`];
  const taste = memory.taste;
  if (taste?.likes?.length) {
    lines.push('', '## 听众网易云里喜欢的歌（抽样）', taste.likes.slice(0, 30).map((s) => `- ${s.title} / ${s.artist}`).join('\n'));
  }
  if (taste?.playlists?.length) lines.push('', '## 听众自建歌单名', taste.playlists.join('、'));
  if (memory.prefs?.length) lines.push('', '## 听众说过的偏好', memory.prefs.map((p) => `- ${p}`).join('\n'));
  if (memory.recent?.length) {
    lines.push('', '## 最近放过（别重复）', memory.recent.slice(-15).map((s) => `- ${s.title} / ${s.artist}`).join('\n'));
  }
  if (!bound) lines.push('', '## 注意', '听众没登录网易云：VIP 歌只能听 30 秒试听，会被跳过。多挑免费能完整播放的歌（独立、民谣、纯音乐、老歌里常有）。');
  if (memory.turns?.length) {
    lines.push('', '## 最近对话', memory.turns.map((t) => `${t.role === 'user' ? '听众' : 'DJ'}：${t.text}`).join('\n'));
  }
  if (drive) lines.push('', DRIVE_PROMPT);
  lines.push('', '## 听众刚说', auto ? '（没说话，上一段放完了，接着放两首）' : String(text).slice(0, 200));
  return lines.join('\n');
}

export function normalizeReply(obj) {
  const play = (Array.isArray(obj?.play) ? obj.play : [])
    .map((s) => ({ title: String(s?.title || '').trim().slice(0, 80), artist: String(s?.artist || '').trim().slice(0, 80) }))
    .filter((s) => s.title)
    .slice(0, 4);
  const intent = obj?.intent === 'chat' && !play.length ? 'chat' : (play.length ? 'recommend' : 'chat');
  return {
    say: String(obj?.say || '').trim().slice(0, 120),
    intent,
    play: intent === 'chat' ? [] : play,
    memoryCandidates: (Array.isArray(obj?.memoryCandidates) ? obj.memoryCandidates : [])
      .map((m) => String(m?.value || m || '').trim().slice(0, 40))
      .filter(Boolean)
      .slice(0, 2),
  };
}

export function createBrain({
  baseUrl,
  model,
  apiKey = 'local',
  metricsUrl = '',
  busyAt = 3,
  waitMs = 20_000,
  personaFile,
  fetchFn = fetch,
  call = callLocalRaw,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const gate = createGate();
  const persona = fs.readFileSync(personaFile, 'utf8');

  async function engineBusy() {
    if (!metricsUrl) return false;
    try {
      const res = await fetchFn(metricsUrl, { signal: AbortSignal.timeout(2000) });
      const load = parseEngineLoad(await res.text());
      return load.waiting > 0 || load.running >= busyAt;
    } catch {
      return false;
    }
  }

  async function waitForRoom() {
    const deadline = Date.now() + waitMs;
    while (await engineBusy()) {
      if (Date.now() >= deadline) return false;
      await sleep(2000);
    }
    return true;
  }

  async function ask(input) {
    return gate.run(async () => {
      if (!(await waitForRoom())) throw new BrainBusyError();
      const prompt = buildPrompt({ persona, ...input });
      const raw = await call(prompt, {
        baseUrl,
        model,
        timeout: 60_000,
        getApiKey: () => apiKey,
        buildBody: (p, opts) => buildLocalBody(p, { ...opts, maxTokens: 700 }),
      });
      const obj = extractJson(raw);
      if (!obj) throw new Error('DJ 回复格式不对');
      return normalizeReply(obj);
    });
  }

  return { ask, engineBusy, gate };
}
