import { grokAuth } from '../grok-auth.js';

export const GROK_API_BASE = 'https://cli-chat-proxy.grok.com/v1';
export const GROK_CLIENT_HEADERS = Object.freeze({
  'x-xai-token-auth': 'xai-grok-cli',
  'x-grok-client-identifier': 'grok-shell',
  'x-grok-client-version': '0.2.93',
});

const REASONING_MODELS = new Set(['grok-4.6', 'grok-4.5']);

function createTimeoutSignal(timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

function grokEndpoint(pathname) {
  return new URL(pathname, `${GROK_API_BASE}/`).href;
}

export function buildGrokBody(prompt, { model, stream = false, effort } = {}) {
  const body = {
    model,
    input: [
      { role: 'system', content: 'Return only one valid json object.' },
      { role: 'user', content: prompt },
    ],
    store: false,
    max_output_tokens: 1200,
  };
  if (stream) body.stream = true;
  if (effort && REASONING_MODELS.has(model)) body.reasoning = { effort };
  return body;
}

export function extractGrokText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text;
  }
  const texts = [];
  for (const item of payload?.output || []) {
    for (const part of item?.content || []) {
      if (typeof part?.text === 'string' && part.text) texts.push(part.text);
    }
  }
  const joined = texts.join('');
  if (joined.trim()) return joined;
  const chat = payload?.choices?.[0]?.message?.content;
  if (typeof chat === 'string') return chat;
  return '';
}

export function extractGrokStreamDelta(event) {
  if (!event || typeof event !== 'object') return '';
  if (event.type === 'response.output_text.delta') {
    if (typeof event.delta === 'string') return event.delta;
    if (typeof event.delta?.text === 'string') return event.delta.text;
  }
  const chat = event?.choices?.[0]?.delta?.content;
  return typeof chat === 'string' ? chat : '';
}

function grokErrorMessage(status, payload) {
  const detail = payload?.error?.message || payload?.message || payload?.error || JSON.stringify(payload || {});
  if (status === 401) return 'Grok 登录已失效，请重新在浏览器中验证';
  if (status === 402 || status === 403) {
    return 'Grok 订阅已登录，但当前档位未开通编程接口。请升级 SuperGrok，或改用其他模型通道。';
  }
  return `grok ${status}: ${String(detail).slice(0, 300)}`;
}

async function parseGrokResponse(res) {
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(grokErrorMessage(res.status, payload));
  const text = extractGrokText(payload);
  if (!text.trim()) throw new Error('grok empty content');
  return text;
}

function authHeaders(token, { stream = false } = {}) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    ...GROK_CLIENT_HEADERS,
    Accept: stream ? 'text/event-stream' : 'application/json',
  };
}

export async function callGrokRaw(prompt, {
  timeout = 120000,
  model,
  effort,
  getAccessToken = () => grokAuth.getAccessToken(),
  fetchFn = fetch,
} = {}) {
  const token = await getAccessToken();
  const { signal, clear } = createTimeoutSignal(timeout);
  try {
    const res = await fetchFn(grokEndpoint('responses'), {
      method: 'POST',
      signal,
      headers: authHeaders(token),
      body: JSON.stringify(buildGrokBody(prompt, { model, effort })),
    });
    return await parseGrokResponse(res);
  } finally {
    clear();
  }
}

export async function callGrokStream(prompt, {
  onText,
  timeout = 120000,
  model,
  effort,
  getAccessToken = () => grokAuth.getAccessToken(),
  fetchFn = fetch,
} = {}) {
  const token = await getAccessToken();
  const { signal, clear } = createTimeoutSignal(timeout);
  try {
    const res = await fetchFn(grokEndpoint('responses'), {
      method: 'POST',
      signal,
      headers: authHeaders(token, { stream: true }),
      body: JSON.stringify(buildGrokBody(prompt, { model, effort, stream: true })),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      throw new Error(grokErrorMessage(res.status, payload));
    }
    if (!res.body) throw new Error('grok stream body missing');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    let text = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = raw.indexOf('\n\n')) >= 0) {
        const chunk = raw.slice(0, boundary);
        raw = raw.slice(boundary + 2);
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let event;
          try { event = JSON.parse(payload); } catch { continue; }
          const delta = extractGrokStreamDelta(event);
          if (delta) {
            text += delta;
            try { onText?.(text); } catch {}
          }
        }
      }
    }
    return text;
  } finally {
    clear();
  }
}
