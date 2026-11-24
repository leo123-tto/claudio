// 推荐问完之后的那一句回答。
//
// Vera 念完「小王给你推荐了《晴天》，要听吗？」，网页自动开麦听 5 秒：
// 说了「听」就立刻放，说了「不听」或者没出声就当没听（drop，之后还能问回来）。
//
// 为什么不是按钮：问句是语音，回答也应该是语音。代价是第一次要用户授权麦克风，
// 而且音乐正在放——所以录音这里必须带回声消除，不然 Vera 自己的歌会被当成回答。
//
// 这个模块只管「听 + 判断」，放不放歌由调用方决定（web/public.js、web/app.js 各一份播放器）。

/** 问句播完再等多久。5 秒够一句「听」或「算了」，再长就变成干等了。 */
export const ANSWER_MS = 5_000;
/** 拿不到「口播播完」的时刻（没语效、TTS 失败）时的兜底：从开始念起算。 */
export const ANSWER_FALLBACK_MS = 15_000;
/** 录音短于这个字节数按「没出声」处理。 */
const MIN_BYTES = 800;

const YES = /(^|[^不别没])(听|要|放|来|可以|行|好|嗯|对|听听|放上|开始|走起)/;
// 否定要用完整的词，不能只认一个「不」——「今天天气不错」里也有个「不」，
// 但那是在夸天气。宁可漏判成「没回应」（丢的那首能找回），也别把人夸你的话当拒绝。
const NO = /(不听|不要|不放|别放|别播|不用了?|算了|跳过|下一首|换一[首个]|没兴趣|不想听|不了|免了)/;

/**
 * 这句话是想听还是不想听。
 *
 * 先判否定：「不要」里也有「要」，顺序反了就永远听不出拒绝。
 * 拿不准（既没肯定也没否定、或者根本没识别出来）一律当「没回应」——
 * 推荐被静默丢弃比误播一首更可控，而且丢弃后还能问回来。
 *
 * @param {string} text
 * @returns {'yes'|'no'|'none'}
 */
export function readAnswer(text = '') {
  const value = String(text || '').replace(/\s+/g, '');
  if (!value) return 'none';
  if (NO.test(value)) return 'no';
  if (YES.test(value)) return 'yes';
  return 'none';
}

/** 录一段音并交给服务端识别；拿不到音频或识别失败都返回 ''。 */
async function transcribe(stream, ms, { mime, fetchFn }) {
  const chunks = [];
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 16000 } : { audioBitsPerSecond: 16000 });
  const done = new Promise((resolve) => { recorder.addEventListener('stop', resolve, { once: true }); });
  recorder.addEventListener('dataavailable', (event) => { if (event.data?.size) chunks.push(event.data); });
  recorder.start();
  await new Promise((resolve) => { setTimeout(resolve, ms); });
  if (recorder.state === 'recording') recorder.stop();
  await done;
  const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' });
  if (blob.size < MIN_BYTES) return '';
  const audioBase64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  if (!audioBase64) return '';
  const res = await fetchFn('/api/voice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audioBase64, mime: blob.type }),
  });
  const data = await res.json().catch(() => null);
  return data?.ok && data.text ? String(data.text) : '';
}

/**
 * 开麦听一句回答。
 *
 * @param {{ ms?: number, stream?: MediaStream, fetchFn?: typeof fetch, mediaDevices?: MediaDevices }} options
 * @returns {Promise<{answer: 'yes'|'no'|'none', text: string}>} 拿不到麦克风时是 none
 */
export async function listenForAnswer({
  ms = ANSWER_MS,
  stream: given,
  fetchFn = fetch,
  mediaDevices = globalThis.navigator?.mediaDevices,
} = {}) {
  if (typeof MediaRecorder === 'undefined' || !mediaDevices?.getUserMedia) return { answer: 'none', text: '' };
  let stream = given;
  let owned = false;
  try {
    if (!stream) {
      // 回声消除是关键：歌在放，不处理的话 Vera 会把歌词听成回答
      stream = await mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      owned = true;
    }
    const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
      .find((type) => MediaRecorder.isTypeSupported?.(type)) || '';
    const text = await transcribe(stream, ms, { mime, fetchFn });
    return { answer: readAnswer(text), text };
  } catch {
    // 没授权 / 录不了：按「没回应」处理，推荐照样能找回
    return { answer: 'none', text: '' };
  } finally {
    if (owned) stream.getTracks?.().forEach((track) => track.stop());
  }
}
