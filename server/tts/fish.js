// Fish Audio 实现（目标方案）。需要 .env 配 FISH_API_KEY。
// 音色：口播已固定中文（context.js 强制中文女声念），恒用中文音色 voiceZh，缺省回退 referenceId / voiceEn。
// 文档：https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech
import { config } from '../config.js';
import { getSecret } from '../secrets.js';
import { getSettings } from '../settings.js';

export const ext = 'mp3';

// 口播固定中文 → 恒用中文音色 voiceZh，缺省回退 referenceId / voiceEn。
// （旧版按 text 是否含中文分流中/英音色，因口播已固定中文而成死分支，已简化；将来要多语言口播可在此再分流。）
export function pickReferenceId() {
  const runtime = getSettings().tts.fish.referenceId;
  const fallback = config.tts.fish;
  return runtime || fallback.voiceZh || fallback.referenceId || fallback.voiceEn;
}

export function currentFishConfig() {
  return {
    apiKey: getSecret('fishApiKey'),
    model: getSettings().tts.fish.model,
    referenceId: pickReferenceId(),
  };
}

export async function openStream(text, { signal } = {}) {
  const { apiKey, model, referenceId } = currentFishConfig();
  if (!apiKey) throw new Error('Fish API Key 未配置，语音不可用');
  const res = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      model,
    },
    body: JSON.stringify({
      text,
      reference_id: referenceId || undefined,
      format: 'mp3',
    }),
  });
  if (!res.ok) throw new Error(`fish tts ${res.status}: ${await res.text().catch(() => '')}`);
  if (!res.body) throw new Error('fish tts 返回空音频流');
  return res.body;
}

export async function* stream(text, { signal } = {}) {
  const body = await openStream(text, { signal });
  const reader = body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value?.length) yield Buffer.from(value);
  }
}

export async function synthesize(text) {
  const chunks = [];
  for await (const chunk of stream(text)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function testConnection(text = 'Claudio 语音连接正常。') {
  const startedAt = Date.now();
  let firstByteAt = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Fish 语音测试超时')), 15000);
  const chunks = [];
  try {
    for await (const chunk of stream(text, { signal: controller.signal })) {
      if (!firstByteAt) firstByteAt = Date.now();
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(timer);
  }
  if (!chunks.length) throw new Error('Fish 连接成功但没有返回音频');
  const finishedAt = Date.now();
  const current = currentFishConfig();
  return {
    audio: Buffer.concat(chunks),
    model: current.model,
    hasVoice: Boolean(current.referenceId),
    firstAudioMs: (firstByteAt || finishedAt) - startedAt,
    totalMs: finishedAt - startedAt,
  };
}
