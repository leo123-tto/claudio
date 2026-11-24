// 推荐问完之后的那一句回答。
//
// Vera 念完「小王给你推荐了《晴天》，要听吗？」，网页自动开麦听 5 秒：
// 说了「听」就放；说了「不听」或者没出声就先存着（drop，好友面板里还能点「听」找回来）。
// 根本听不了（没麦克风、不给权限、识别服务不通、授权框一直没点）不算「没出声」：照旧直接放，免得推荐全被吞掉。
//
// 两种听法：
// - 'speech'：浏览器自带听写（公用版用；和驾驶模式的「说话」同一套，不经老板家里的机器）
// - 'record'：录一段交给服务端 /api/voice 转写（个人版用；只走短句识别，不去拉起 5090 的识别档）
// 录音这条要开回声消除：上一首的尾巴还在小声放，不处理的话歌词会被当成回答。
//
// 这个模块只管「听 + 判断」，放不放歌由调用方决定（web/public.js、web/app.js 各一份播放器）。

/** 问句播完再等多久。5 秒够一句「听」或「算了」，再长就变成干等了。 */
export const ANSWER_MS = 5_000;
/** 拿不到「口播播完」的时刻（没语效、TTS 失败）时的兜底：从开始念起算。 */
export const ANSWER_FALLBACK_MS = 15_000;
/** 授权框 / 麦克风多久没起来就算听不了（不然授权框没人点，播放就一直卡着）。 */
export const START_TIMEOUT_MS = 8_000;
/** 转写最多等多久。 */
const TRANSCRIBE_MS = 8_000;
/** 录音短于这个字节数按「没出声」处理。 */
const MIN_BYTES = 800;
/** 问句的尾巴；不问的时候（没念出来）从显示的字里去掉。和 server/public/voice.js 的 REC_ASK_TAIL 一致。 */
export const REC_ASK_TAIL = '要听吗？';
/** 先存着时显示的一句。和 server/public/voice.js 的 REC_STASHED_LINE 一致。 */
export const REC_STASHED_LINE = '那先给你存着，想听在好友里点「听」。';

// 回答只认短句：「好啊」「要听」「放吧」。长句多半是别的话或者漏进来的歌词。
const MAX_ANSWER_CHARS = 8;
const PUNCT = /[\s\p{P}\p{S}]+/gu;
// 明确的拒绝 / 推迟
const NO = /(不听|不要|不放|别放|别播|不用|算了|跳过|下一首|换一?[首个]|没兴趣|不想|不太想|不了|免了|先不|以后再|等会|等一会|待会|回头再|下次|改天)/;
// 带否定字但不是上面那些（「听不清」「对不起」「不错」）：拿不准
const NEGATION = /[不别没甭]/;
// 整句都由这些词组成才算答应（「你好」「对面那个」都不算）
// 语气词含识别常写出来的别字（短句识别会把「好啊」写成「好阿」）
const YES = /^(?:我|那|就|先)*(?:(?:要|想)?(?:听|放|播)(?:一下|上|听看|听|看)?|要的?|好的?|行|可以|嗯|对|是的?|来|开始|走起|当然|ok|okay|yes|yeah)(?:(?:(?:要|想)?(?:听|放|播)(?:一下|上|听看|听|看)?|要的?|好的?|行|可以|嗯|对|是的?|来|开始|走起|当然|ok|okay|yes|yeah)|[啊阿吧呀呗哦嘛的了哈喽咯])*$/;

/**
 * 这句话是想听还是不想听。
 *
 * 先判否定：「不要」里也有「要」，顺序反了就永远听不出拒绝。
 * 拿不准（带否定字、太长、不是答应的话、没识别出字）一律当「没回应」——
 * 先存着比误播一首更可控，存着的还能找回来。
 *
 * @param {string} text
 * @returns {'yes'|'no'|'none'}
 */
export function readAnswer(text = '') {
  const value = String(text || '').toLowerCase().replace(PUNCT, '');
  if (!value) return 'none';
  if (NO.test(value)) return 'no';
  if (value.length > MAX_ANSWER_CHARS || NEGATION.test(value)) return 'none';
  return YES.test(value) ? 'yes' : 'none';
}

/** 不问的时候显示的字：去掉结尾的「要听吗？」。 */
export function withoutAsk(text = '') {
  const value = String(text || '');
  return value.endsWith(REC_ASK_TAIL) ? value.slice(0, -REC_ASK_TAIL.length).replace(/[，,]$/, '。') : value;
}

const result = (answer, text = '') => ({ answer, text });

// ---- 浏览器听写 ----
const SPEECH_UNAVAILABLE = new Set(['not-allowed', 'service-not-allowed', 'audio-capture', 'network', 'language-not-supported', 'bad-grammar']);

function listenBySpeech({ ms, signal, Recognition, startTimeoutMs }) {
  if (!Recognition) return Promise.resolve(result('unavailable'));
  return new Promise((resolve) => {
    let rec;
    try { rec = new Recognition(); } catch { resolve(result('unavailable')); return; }
    let text = '';
    let started = false;
    let failure = null;
    let settled = false;
    const timers = [];
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      signal?.removeEventListener('abort', onAbort);
      try { rec.abort(); } catch { /* 已经停了 */ }
      resolve(result(answer || readAnswer(text), text));
    };
    const onAbort = () => finish('none');
    rec.lang = 'zh-CN';
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onaudiostart = () => {
      if (started) return;
      started = true;
      timers.push(setTimeout(() => { try { rec.stop(); } catch { finish(); } }, ms));
    };
    rec.onresult = (event) => {
      text = Array.from(event.results || []).map((r) => r?.[0]?.transcript || '').join('');
    };
    rec.onerror = (event) => { if (SPEECH_UNAVAILABLE.has(event?.error)) failure = 'unavailable'; };
    rec.onend = () => finish(failure || (started ? null : 'unavailable'));
    timers.push(setTimeout(() => { if (!started) finish('unavailable'); }, startTimeoutMs));
    timers.push(setTimeout(() => finish(), startTimeoutMs + ms + TRANSCRIBE_MS));
    if (signal?.aborted) { finish('none'); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    try { rec.start(); } catch { finish('unavailable'); }
  });
}

// ---- 录音 + 服务端转写 ----
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })])
    .finally(() => clearTimeout(timer));
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

async function record(stream, ms, signal) {
  const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
    .find((type) => MediaRecorder.isTypeSupported?.(type)) || '';
  const chunks = [];
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 16000 } : { audioBitsPerSecond: 16000 });
  const done = new Promise((resolve) => { recorder.addEventListener('stop', resolve, { once: true }); });
  recorder.addEventListener('dataavailable', (event) => { if (event.data?.size) chunks.push(event.data); });
  recorder.start();
  await sleep(ms, signal);
  if (recorder.state === 'recording') recorder.stop();
  await done;
  return new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' });
}

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function listenByRecord({ ms, signal, mediaDevices, fetchFn, startTimeoutMs }) {
  if (typeof MediaRecorder === 'undefined' || !mediaDevices?.getUserMedia) return result('unavailable');
  let stream;
  const asking = mediaDevices.getUserMedia({
    // 回声消除是关键：上一首还在小声放，不处理的话会把歌词听成回答
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  try {
    stream = await withTimeout(asking, startTimeoutMs);
  } catch {
    // 授权框没人点：等它以后真给了也要把麦克风关掉
    asking.then((late) => late.getTracks?.().forEach((track) => track.stop()), () => {});
    return result('unavailable');
  }
  try {
    if (signal?.aborted) return result('none');
    const blob = await record(stream, ms, signal);
    if (signal?.aborted) return result('none');
    if (blob.size < MIN_BYTES) return result('none');
    const audioBase64 = await toBase64(blob);
    if (!audioBase64) return result('none');
    const res = await fetchFn('/api/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioBase64, mime: blob.type, fast: true }),
      signal: AbortSignal.timeout(TRANSCRIBE_MS),
    });
    const data = await res.json().catch(() => null);
    if (data?.ok) return result(readAnswer(data.text), String(data.text || ''));
    // 识别服务在、只是没听出字：算没出声；服务不通算听不了
    return result(data?.unclear ? 'none' : 'unavailable');
  } catch {
    return result('unavailable');
  } finally {
    stream.getTracks?.().forEach((track) => track.stop());
  }
}

/**
 * 开麦听一句回答。
 *
 * @param {{ engine?: 'speech'|'record', ms?: number, signal?: AbortSignal, startTimeoutMs?: number,
 *   Recognition?: any, mediaDevices?: MediaDevices, fetchFn?: typeof fetch }} options
 * @returns {Promise<{answer: 'yes'|'no'|'none'|'unavailable', text: string}>}
 *   unavailable = 根本听不了（调用方照旧放歌）；none = 听了但没听出答应或拒绝
 */
export async function listenForAnswer({
  engine = 'record',
  ms = ANSWER_MS,
  signal,
  startTimeoutMs = START_TIMEOUT_MS,
  Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition,
  mediaDevices = globalThis.navigator?.mediaDevices,
  fetchFn = globalThis.fetch,
} = {}) {
  try {
    return engine === 'speech'
      ? await listenBySpeech({ ms, signal, Recognition, startTimeoutMs })
      : await listenByRecord({ ms, signal, mediaDevices, fetchFn, startTimeoutMs });
  } catch {
    return result('unavailable');
  }
}
