// 公用版的大脑：拼一段短提示词 → 本地盒子大模型 → {say, intent, play[], memoryCandidates}。
//
// 老板优先：盒子推理引擎不分调用方，所以由公用版自己让路——
//   1. 整个公用实例同一时间只跑 1 个大模型请求，排队超过上限直接说「人多」；
//   2. 发之前看一眼引擎 /metrics，有人在排队或已占满阈值就等，等不到就降级（不叫大模型，按听众原话直接搜歌）。
import { DRIVE_PROMPT } from '../drive.js';
import fs from 'node:fs';
import { config } from '../config.js';
import { toneFor, toneKey, tonePrompt } from '../tone.js';
import { loadPersona, personaMode, personaNow } from '../persona.js';
import { stripTags } from '../tts/tags.js';
import { wholeSentences } from './voice.js';
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
    get busy() { return running; },
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

// 北京时间的这一刻，做成「本地字段」的 Date（年月日、星期、钟点都是北京的，不看容器的时区）。给 hour 就按整点算。
export function beijingClock(at = Date.now(), hour = null) {
  const bj = new Date(at + 8 * 3600_000);
  return new Date(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate(), hour ?? bj.getUTCHours(), hour == null ? bj.getUTCMinutes() : 0);
}

// 此刻的口播语气档（北京时间；公用版默认降一档）。给 hour 就按整点算，否则按 at（毫秒）
export function publicTone({ at = Date.now(), hour = null, drive = false } = {}) {
  return toneFor(toneKey({ now: beijingClock(at, hour), drive }), { mild: config.tone.publicLevel === 'mild' });
}

// 这位朋友和 Vera 的交情，只看 ta 自己的听歌记录（最近听过 100 首封顶；没有就看最近放过 40 首）：
// 不到 8 首是新朋友，不到 40 首聊过几次，再多就是老朋友。清空记忆后从头算。
export function familiarity(memory = {}) {
  const n = Math.max((memory.history || []).length, (memory.recent || []).length);
  return n < 8 ? 'new' : n < 40 ? 'some' : 'old';
}
const FAMILIARITY_TEXT = {
  new: '新朋友：刚认识，客气里带点俏皮，别装熟，不翻旧账，也别假装记得 ta 的事。',
  some: '聊过几次：渐渐熟了，可以松一点、开点小玩笑，偶尔提一句 ta 最近放过的歌。',
  old: '老朋友：很熟了，随口损两句也行，可以翻翻 ta 说过的话和放过的歌（只用下面写着的，别编）。',
};
// 这位朋友的称呼：来自 hub 的名字，进提示词前去掉换行和标记符号、截短
export const friendName = (name) => String(name || '').replace(/[#<>`{}[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 12);

// 这份提示词只含这一位朋友自己的数据（memory 是 ta 的）：不带老板的任何信息，也不带别的朋友的。
// name：hub 里 ta 的名字；extension：这位朋友自己打开了本地语气扩展才传 readToneExtension() 的结果（驾驶模式永远不用）。
// intro：{title, artist} 给已经选好的这首写开场口播（后台报幕），不选歌、不聊天
export function buildPrompt({ persona, text, auto, memory, bound, hour, drive = false, tone = null, intro = null, name = '', extension = null, at = Date.now() }) {
  const theTone = tone || publicTone({ at, hour, drive });
  const mode = personaMode({ toneKey: theTone.key, now: beijingClock(at, hour), text: intro ? '' : text });
  const who = friendName(name);
  const lines = [persona.trim(), '', '## 此刻', `北京时间 ${hour} 点。`, '', personaNow(mode), '',
    tonePrompt(theTone, { extension: drive ? null : extension, now: beijingClock(at, hour) }), '',
    '## 这位朋友', [who ? `称呼：${who}（偶尔叫一声，别每句都叫）。` : '', `交情：${FAMILIARITY_TEXT[familiarity(memory)]}`].filter(Boolean).join('\n')];
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
  if (intro) {
    const song = `《${String(intro.title || '').slice(0, 80)}》 / ${String(intro.artist || '').slice(0, 80)}`;
    lines.push('', '## 这次的任务', `不选歌，也不聊天。下一首已经定了：${song}。只给它写一段开场口播，输出 {"say":"…"} 一个字段，其余字段都不要。`);
  } else {
    lines.push('', '## 听众刚说', auto ? '（没说话，上一段放完了，接着放两首）' : String(text).slice(0, 200));
  }
  return lines.join('\n');
}

// say 带演出标记的原稿 → 页面和记录用的干净文字：整句取，不在半句处切断
const SAY_MAX = 120;
export function cleanSay(tagged) {
  const clean = stripTags(tagged);
  return wholeSentences(clean, SAY_MAX) || clean.slice(0, SAY_MAX);
}

export function normalizeReply(obj) {
  const play = (Array.isArray(obj?.play) ? obj.play : [])
    .map((s) => ({ title: String(s?.title || '').trim().slice(0, 80), artist: String(s?.artist || '').trim().slice(0, 80) }))
    .filter((s) => s.title)
    .slice(0, 4);
  const intent = obj?.intent === 'chat' && !play.length ? 'chat' : (play.length ? 'recommend' : 'chat');
  const sayTagged = String(obj?.say || '').trim().slice(0, 600);
  return {
    say: cleanSay(sayTagged),
    sayTagged,
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
  // 开头是两版共用的 Vera 人格核心（永远不读个人版的 user/persona.md），后面是公用版规则和输出契约
  const persona = `${loadPersona({ file: null }).body}\n\n${fs.readFileSync(personaFile, 'utf8').trim()}`;

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

  // 后台报幕：不排队、不抢用户——闸门有人在跑或排着、引擎在忙就等（最多 waitMs，0 = 不等），等不到返回 null。
  // 只在空闲时开一次小请求，不扣朋友的次数；写出来的是 { say, sayTagged }。
  async function askIdle(input, { waitMs = 0 } = {}) {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const free = () => !gate.busy && gate.queued === 0;
      if (free() && !(await engineBusy()) && free()) break;
      if (Date.now() >= deadline) return null;
      await sleep(2000);
    }
    return gate.run(async () => {
      const prompt = buildPrompt({ persona, ...input, auto: true });
      const raw = await call(prompt, {
        baseUrl,
        model,
        timeout: 30_000,
        getApiKey: () => apiKey,
        buildBody: (p, opts) => buildLocalBody(p, { ...opts, maxTokens: 300 }),
      });
      const sayTagged = String(extractJson(raw)?.say || '').trim().slice(0, 600);
      const say = cleanSay(sayTagged);
      return say ? { say, sayTagged } : null;
    });
  }

  return { ask, askIdle, engineBusy, gate };
}
