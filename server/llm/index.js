import {
  callClaudeRaw,
  callClaudeStream,
  callDeepSeekRaw,
  callDeepSeekStream,
} from '../claude.js';
import { getSettings } from '../settings.js';
import { codexAppServer } from './codex-app-server.js';
import { extractJson, extractSayValue, normalizeResult } from './normalize.js';

function selection() {
  const settings = getSettings();
  const provider = settings.llm.provider;
  return {
    provider,
    model: settings.llm.models[provider],
    effort: settings.llm.reasoningEffort,
  };
}

export async function callLlmRaw(prompt, { timeout = 20000 } = {}) {
  const { provider, model, effort } = selection();
  if (provider === 'codex') return codexAppServer.generate(prompt, { model, effort, timeout });
  if (provider === 'claude') return callClaudeRaw(prompt, { model, timeout, forceClaude: true });
  if (provider === 'deepseek') return callDeepSeekRaw(prompt, { model, timeout });
  throw new Error(`未知模型供应商：${provider}`);
}

export async function callLlmStream(prompt, { onText, timeout = 20000 } = {}) {
  const { provider, model, effort } = selection();
  if (provider === 'codex') return codexAppServer.generate(prompt, { model, effort, onText, timeout });
  if (provider === 'claude') return callClaudeStream(prompt, { model, onText, timeout, forceClaude: true });
  if (provider === 'deepseek') return callDeepSeekStream(prompt, { model, onText, timeout });
  throw new Error(`未知模型供应商：${provider}`);
}

export async function plan(prompt, { timeout = 20000 } = {}) {
  const raw = await callLlmRaw(prompt, { timeout });
  const obj = extractJson(raw);
  if (!obj || typeof obj.say !== 'string') {
    throw new Error(`无法从模型输出解析节目 JSON：${String(raw).slice(0, 200)}`);
  }
  return normalizeResult(obj);
}

export async function testCurrentModel({ timeout = 15000 } = {}) {
  const selected = selection();
  const startedAt = Date.now();
  let firstTextAt = null;
  const raw = await callLlmStream(
    '只做连接测试。返回 {"say":"连接正常","intent":"chat","action":"none","actionValue":0,"play":[],"reason":"测速","memoryCandidates":[]}。',
    { timeout, onText: () => { if (!firstTextAt) firstTextAt = Date.now(); } },
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

export { extractJson, extractSayValue, normalizeResult } from './normalize.js';
