// 大脑适配器：claude CLI（订阅）与 DeepSeek 官方 API。只负责拿到模型原文，解析统一在 llm/normalize.js。
// prompt 走 stdin 或 HTTP body，避免超长参数 / 转义问题。
import { spawn } from 'node:child_process';
import os from 'node:os';
import { config } from './config.js';
import { getSecret } from './secrets.js';
import { createTimeoutSignal, openaiEndpoint, readOpenAiChatSse } from './llm/openai-chat.js';

function deepseekEndpoint(pathname) {
  return openaiEndpoint(config.llm.deepseek.baseUrl, pathname);
}

async function parseDeepSeekResponse(res, signal) {
  const data = await res.json().catch(() => { signal.throwIfAborted(); return null; });
  signal.throwIfAborted();
  if (!res.ok) {
    const detail = data?.error?.message || data?.message || JSON.stringify(data || {});
    throw new Error(`deepseek ${res.status}: ${detail}`);
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('deepseek empty content');
  }
  return content;
}

export function buildDeepSeekBody(prompt, { model, stream = false } = {}) {
  return {
    model,
    messages: [
      { role: 'system', content: 'Return only one valid json object.' },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_object' },
    max_tokens: config.llm.deepseek.maxTokens,
    temperature: config.llm.deepseek.temperature,
    thinking: { type: config.llm.deepseek.thinking },
    ...(stream ? { stream: true } : {}),
  };
}

export async function callDeepSeekRaw(prompt, {
  timeout = 60000,
  signal: parentSignal,
  model = config.llm.deepseek.model,
  fetchFn = fetch,
  getApiKey = () => getSecret('deepseekApiKey'),
} = {}) {
  parentSignal?.throwIfAborted();
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('deepseek api key missing');
  }

  const { signal, clear } = createTimeoutSignal(timeout, parentSignal);
  signal.throwIfAborted();
  try {
    const res = await fetchFn(deepseekEndpoint('chat/completions'), {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildDeepSeekBody(prompt, { model })),
    });
    return await parseDeepSeekResponse(res, signal);
  } finally {
    clear();
  }
}

export async function callDeepSeekStream(prompt, {
  onText,
  timeout = 60000,
  signal: parentSignal,
  model = config.llm.deepseek.model,
  fetchFn = fetch,
  getApiKey = () => getSecret('deepseekApiKey'),
} = {}) {
  parentSignal?.throwIfAborted();
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('deepseek api key missing');
  }

  const { signal, clear } = createTimeoutSignal(timeout, parentSignal);
  signal.throwIfAborted();
  try {
    const res = await fetchFn(deepseekEndpoint('chat/completions'), {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildDeepSeekBody(prompt, { model, stream: true })),
    });
    signal.throwIfAborted();
    if (!res.ok) {
      const detail = await res.text().catch(() => { signal.throwIfAborted(); return ''; });
      signal.throwIfAborted();
      throw new Error(`deepseek ${res.status}: ${detail}`);
    }
    if (!res.body) {
      throw new Error('deepseek stream body missing');
    }

    return await readOpenAiChatSse(res.body, { onText, signal });
  } finally {
    clear();
  }
}

// Claude 订阅走本机 claude CLI。每次都是新进程，所以尽量把它变「轻」：
// --safe-mode 不读 CLAUDE.md / 技能 / 插件（登录照常），不给工具、不存会话，
// 系统提示只留一句；关掉思考、effort 设 low。2.1.314 起 MAX_THINKING_TOKENS=0 已不生效，
// 2026-10-31 实测要靠 alwaysThinkingEnabled=false：sonnet 首字 18.4s → 6.4s。
const CLAUDE_SYSTEM_PROMPT = 'You are Claudio, a Chinese radio DJ. Return only one valid JSON object. No prose, no code fences.';

export function claudeArgs({ model, stream = false } = {}) {
  const args = ['-p', '--output-format', stream ? 'stream-json' : 'json'];
  if (stream) args.push('--include-partial-messages', '--verbose');
  args.push(
    '--strict-mcp-config',
    '--safe-mode',
    '--tools', '',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--effort', 'low',
    '--settings', '{"alwaysThinkingEnabled":false}',
    '--system-prompt', CLAUDE_SYSTEM_PROMPT,
  );
  if (model) args.push('--model', model);
  return args;
}

function spawnClaude(args) {
  return spawn(config.claude.bin, args, {
    cwd: os.tmpdir(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MAX_THINKING_TOKENS: '0' },
  });
}

// 从 --output-format json 的信封里取出模型文本；解析不出来就原样返回。
function pickResultText(stdout) {
  try {
    const env = JSON.parse(stdout);
    return env.result ?? env.text ?? stdout;
  } catch {
    return stdout;
  }
}

function runClaude(prompt, {
  onText,
  timeout = 60000,
  signal: parentSignal,
  model = config.claude.model,
  stream = false,
  spawnFn = spawnClaude,
} = {}) {
  return new Promise((resolve, reject) => {
    const { signal, clear } = createTimeoutSignal(timeout, parentSignal);
    let child;
    let settled = false;
    let out = '', buf = '', text = '', err = '', resultText = null;

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clear();
      signal.removeEventListener('abort', onAbort);
      child?.stdout.removeListener('data', onData);
      child?.stderr.removeListener('data', onStderr);
      if (error !== undefined) reject(error);
      else resolve(value);
    }
    function stop(error) {
      if (settled) return;
      finish(error);
      try { child?.kill('SIGKILL'); } catch {}
    }
    function onAbort() { stop(signal.reason); }
    function onStderr(data) { err += data; }
    function onData(data) {
      if (!stream) { out += data; return; }
      buf += data;
      let nl;
      while (!settled && (nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta'
            && ev.event.delta?.type === 'text_delta') {
          text += ev.event.delta.text;
          try { onText && onText(text); } catch { /* 回调自身错误不应中断流 */ }
        } else if (ev.type === 'result' && typeof ev.result === 'string') {
          resultText = ev.result;
        }
      }
    }

    try {
      signal.throwIfAborted();
      child = spawnFn(claudeArgs({ model, stream }));
      child.stdout.on('data', onData);
      child.stderr.on('data', onStderr);
      child.on('error', stop);
      child.stdin.on('error', stop);
      child.on('close', (code) => {
        if (signal.aborted) return onAbort();
        if (code !== 0) return finish(new Error(`claude exit ${code}: ${err.slice(0, 300)}`));
        finish(undefined, stream ? (resultText ?? text) : pickResultText(out));
      });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) return onAbort();
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (error) {
      stop(error);
    }
  });
}

// 普通与流式调用共用进程生命周期，外部取消或 deadline 都立即杀掉 CLI。
export function callClaudeRaw(prompt, options = {}) {
  return runClaude(prompt, options);
}

export function callClaudeStream(prompt, options = {}) {
  return runClaude(prompt, { ...options, stream: true });
}
