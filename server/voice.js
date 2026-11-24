// 短语音交给家里盒子转写成文字。转写结果再走原来的暂停、换歌、点歌。
import { config } from './config.js';

export function transcriptText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return String(payload.text || payload.transcript || '').replace(/\s+/g, ' ').trim();
}

// 识别服务在、只是没听出字（网页的推荐问答把它当「没出声」，别的错当「听不了」）
function unclear() {
  return Object.assign(new Error('没听清，再说一次'), { unclear: true });
}

export function decodeVoiceAudio(audioBase64) {
  const raw = String(audioBase64 || '');
  if (!raw) throw unclear();
  if (raw.length > 6_000_000) throw new Error('这句话太长了，说短一点');
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length < 800 || bytes.length > 4_000_000) throw unclear();
  return bytes;
}

// Mac mini 上的短句识别：几百毫秒出字。不通、超时或没听出字都返回 null，交给 5090 网关。
export async function transcribeFast(bytes, mime = 'audio/webm', { fetchImpl = fetch, base = config.asr.fastUrl, timeoutMs = 5000 } = {}) {
  const root = String(base || '').replace(/\/+$/, '');
  if (!root) return null;
  try {
    const form = new FormData();
    form.set('file', new Blob([bytes], { type: mime || 'application/octet-stream' }), 'speech.webm');
    const response = await fetchImpl(`${root}/v1/audio/transcriptions`, { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status >= 500) return null;
    if (!response.ok) return '';
    const text = transcriptText(await response.json().catch(() => ({})));
    return /[\p{L}\p{N}]/u.test(text) ? text : '';
  } catch {
    return null;
  }
}

export async function transcribeAudio(bytes, mime = 'audio/webm', { fetchImpl = fetch, base = config.asr.baseUrl, fastBase = config.asr.fastUrl } = {}) {
  // Mac mini 连得上就以它为准：没听出字直接说没听清，不去叫 5090（会拉起 ASR 档、把口播的 TTS 挤下卡）。
  const fast = await transcribeFast(bytes, mime, { fetchImpl, base: fastBase });
  if (fast) return fast;
  if (fast === '') throw unclear();
  const root = String(base || '').replace(/\/+$/, '');
  let health;
  try {
    health = await fetchImpl(`${root}/health`, { signal: AbortSignal.timeout(2000) });
  } catch {
    throw new Error('家里的语音识别这会儿连不上');
  }
  const state = await health.json().catch(() => ({}));
  if (state.engine && !['ready', 'busy'].includes(state.engine)) {
    fetchImpl(`${root}/warmup`, { method: 'POST' }).catch(() => {});
    throw new Error('语音识别正在启动，约 3 到 5 分钟后再说');
  }
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: mime || 'application/octet-stream' }), 'speech.webm');
  form.set('model', 'moss-mtd');
  form.set('response_format', 'json');
  form.set('prompt', 'Claudio, 暂停, 继续播放, 换一首, 下一首, 上一首, 音量, 客厅, 书房');
  const response = await fetchImpl(`${root}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) throw new Error('没听清，再说一次');
  const text = transcriptText(await response.json());
  if (!text) throw unclear();
  return text;
}
