// OpenAI 兼容 chat/completions 的共用小工具。
// DeepSeek 与本地大模型都走同一套 SSE 形状；抽出来避免两处漂移，行为与原 DeepSeek 解析保持一致。
import { extractJson } from './normalize.js';

export function createTimeoutSignal(timeout, parentSignal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) onAbort();
  else parentSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = controller.signal.aborted ? null : setTimeout(() => {
    controller.abort(new DOMException(`请求超时（${timeout}ms）`, 'TimeoutError'));
  }, timeout);
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onAbort);
    },
  };
}

export function openaiEndpoint(baseUrl, pathname) {
  const base = `${String(baseUrl).replace(/\/+$/, '')}/`;
  return new URL(String(pathname).replace(/^\/+/, ''), base).href;
}

export function openaiErrorDetail(payload) {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  return payload?.error?.message || payload?.message || JSON.stringify(payload || {});
}

export async function readOpenAiChatSse(body, { onText, signal } = {}) {
  signal?.throwIfAborted();
  const reader = body.getReader();
  const onAbort = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const decoder = new TextDecoder();
  let raw = '';
  let text = '';

  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) {
        break;
      }
      raw += decoder.decode(value, { stream: true });

      let boundary;
      while ((boundary = raw.indexOf('\n\n')) >= 0) {
        const chunk = raw.slice(0, boundary);
        raw = raw.slice(boundary + 2);
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) {
            continue;
          }
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') {
            continue;
          }
          let event;
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }
          const delta = event?.choices?.[0]?.delta;
          if (typeof delta?.content === 'string' && delta.content.length > 0) {
            text += delta.content;
            try { onText && onText(text); } catch {}
            signal?.throwIfAborted();
            // 只要一个 JSON 对象，闭合就收线。盒子偶尔在 } 之后空转到 max_tokens（2026-10-31 实测拖到 69 秒）。
            if (delta.content.includes('}') && extractJson(text)) {
              reader.cancel().catch(() => {});
              return text;
            }
          }
        }
      }
    }

    return text;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
