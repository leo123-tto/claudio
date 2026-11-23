import {
  callClaudeRaw,
  callClaudeStream,
  callDeepSeekRaw,
  callDeepSeekStream,
} from '../claude.js';
import { getSettings } from '../settings.js';
import { callLocalRaw, callLocalStream } from './local.js';
import { extractJson, normalizeResult } from './normalize.js';

function selection() {
  const settings = getSettings();
  const provider = settings.llm.provider;
  return { provider, model: settings.llm.models[provider] };
}

export async function callLlmRaw(prompt, { signal, timeout, ...options } = {}) {
  signal?.throwIfAborted();
  const { provider, model } = selection();
  if (provider === 'local') return callLocalRaw(prompt, { ...options, model, signal, timeout });
  if (provider === 'claude') return callClaudeRaw(prompt, { ...options, model, signal, timeout });
  if (provider === 'deepseek') return callDeepSeekRaw(prompt, { ...options, model, signal, timeout });
  throw new Error(`未知模型供应商：${provider}`);
}

export async function callLlmStream(prompt, { onText, signal, timeout, ...options } = {}) {
  signal?.throwIfAborted();
  const { provider, model } = selection();
  if (provider === 'local') return callLocalStream(prompt, { ...options, model, onText, signal, timeout });
  if (provider === 'claude') return callClaudeStream(prompt, { ...options, model, onText, signal, timeout });
  if (provider === 'deepseek') return callDeepSeekStream(prompt, { ...options, model, onText, signal, timeout });
  throw new Error(`未知模型供应商：${provider}`);
}

export async function plan(prompt, options = {}) {
  const raw = await callLlmRaw(prompt, options);
  options.signal?.throwIfAborted();
  const obj = extractJson(raw);
  if (!obj || typeof obj.say !== 'string') {
    throw new Error(`无法从模型输出解析节目 JSON：${String(raw).slice(0, 200)}`);
  }
  return normalizeResult(obj);
}

export async function testCurrentModel({ signal, timeout = 15000 } = {}) {
  const selected = selection();
  const startedAt = Date.now();
  let firstTextAt = null;
  const raw = await callLlmStream(
    '只做连接测试。返回 {"say":"连接正常","intent":"chat","action":"none","actionValue":0,"play":[],"reason":"测速","memoryCandidates":[]}。',
    { signal, timeout, onText: () => { if (!firstTextAt) firstTextAt = Date.now(); } },
  );
  const result = normalizeResult(extractJson(raw) || {});
  if (!result.say) throw new Error('模型连接成功但返回格式不正确');
  const finishedAt = Date.now();
  return {
    ...selected,
    firstTextMs: firstTextAt ? firstTextAt - startedAt : finishedAt - startedAt,
    totalMs: finishedAt - startedAt,
  };
}

export { extractClosedPlayItems, extractClosedString, extractJson, extractPlayArray, extractSayValue, normalizeResult } from './normalize.js';
