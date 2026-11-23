// 家里盒子大模型：OpenAI 兼容 POST {baseUrl}/chat/completions。
// 失败明确报错，绝不回退到其他供应商。
import { getSecret } from '../secrets.js';
import { getSettings } from '../settings.js';
import {
  createTimeoutSignal,
  openaiEndpoint,
  openaiErrorDetail,
  readOpenAiChatSse,
} from './openai-chat.js';

function currentLocal({ model } = {}) {
  const settings = getSettings();
  return {
    apiKey: getSecret('localLlmApiKey'),
    baseUrl: settings.llm.local.baseUrl,
    model: model || settings.llm.models.local,
  };
}

function localError(status, detail) {
  return new Error(`local llm ${status}: ${String(detail || '').slice(0, 300)}`);
}

export function buildLocalBody(prompt, { model, stream = false, thinking = false, maxTokens = 1600 } = {}) {
  return {
    model,
    messages: [
      { role: 'system', content: 'Return only one valid json object.' },
      { role: 'user', content: prompt },
    ],
    // 盒子推理引擎不认 response_format（2026-10-31 实测直连报 400），靠提示词约束 JSON。
    // 不给上限时盒子会按很长的输出预留显存；点曲风时 play 有 5 首，留到 1600 免得 JSON 被截断。
    max_tokens: maxTokens,
    chat_template_kwargs: { enable_thinking: Boolean(thinking) },
    ...(stream ? { stream: true } : {}),
  };
}

async function parseLocalResponse(res, signal) {
  const data = await res.json().catch(() => { signal.throwIfAborted(); return null; });
  signal.throwIfAborted();
  if (!res.ok) {
    throw localError(res.status, openaiErrorDetail(data));
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('local llm empty content');
  }
  return content;
}

export async function callLocalRaw(prompt, {
  timeout = 150000,
  signal: parentSignal,
  model,
  baseUrl,
  thinking = false,
  buildBody,
  fetchFn = fetch,
  getApiKey,
} = {}) {
  parentSignal?.throwIfAborted();
  const current = currentLocal({ model });
  const apiKey = getApiKey ? getApiKey() : current.apiKey;
  if (!apiKey) throw new Error('local llm api key missing');

  const { signal, clear } = createTimeoutSignal(timeout, parentSignal);
  signal.throwIfAborted();
  try {
    const res = await fetchFn(openaiEndpoint(baseUrl || current.baseUrl, 'chat/completions'), {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify((buildBody || buildLocalBody)(prompt, { model: current.model, thinking })),
    });
    return await parseLocalResponse(res, signal);
  } finally {
    clear();
  }
}

export async function callLocalStream(prompt, {
  onText,
  timeout = 150000,
  signal: parentSignal,
  model,
  baseUrl,
  thinking = false,
  maxTokens,
  buildBody,
  fetchFn = fetch,
  getApiKey,
} = {}) {
  parentSignal?.throwIfAborted();
  const current = currentLocal({ model });
  const apiKey = getApiKey ? getApiKey() : current.apiKey;
  if (!apiKey) throw new Error('local llm api key missing');

  const { signal, clear } = createTimeoutSignal(timeout, parentSignal);
  signal.throwIfAborted();
  try {
    const res = await fetchFn(openaiEndpoint(baseUrl || current.baseUrl, 'chat/completions'), {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify((buildBody || buildLocalBody)(prompt, { model: current.model, stream: true, thinking, ...(maxTokens ? { maxTokens } : {}) })),
    });
    signal.throwIfAborted();
    if (!res.ok) {
      const detail = await res.text().catch(() => { signal.throwIfAborted(); return ''; });
      signal.throwIfAborted();
      throw localError(res.status, detail);
    }
    if (!res.body) throw new Error('local llm stream body missing');
    return await readOpenAiChatSse(res.body, { onText, signal });
  } finally {
    clear();
  }
}
