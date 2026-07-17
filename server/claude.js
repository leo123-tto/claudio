// 大脑适配器：支持 claude CLI / DeepSeek API，两边都统一产出 {say, play[], reason, memory}。
// prompt 走 stdin 或 HTTP body，避免超长参数 / 转义问题。
//
// ⚠️ 信封形状（外层 JSON 的哪个字段装着模型文本）以 scripts/spike-claude.mjs 实测为准；
//    若实测字段不是 .result，改 pickResultText() 即可。
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { getSecret } from './secrets.js';

function createTimeoutSignal(timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

function deepseekEndpoint(pathname) {
  return new URL(pathname, config.llm.deepseek.baseUrl.replace(/\/+$/, '/') ).href;
}

async function parseDeepSeekResponse(res) {
  const data = await res.json().catch(() => null);
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

export async function callDeepSeekRaw(prompt, { timeout = 120000, model = config.llm.deepseek.model } = {}) {
  const apiKey = getSecret('deepseekApiKey');
  if (!apiKey) {
    throw new Error('deepseek api key missing');
  }

  const { signal, clear } = createTimeoutSignal(timeout);
  try {
    const res = await fetch(deepseekEndpoint('chat/completions'), {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildDeepSeekBody(prompt, { model })),
    });
    return await parseDeepSeekResponse(res);
  } finally {
    clear();
  }
}

export async function callDeepSeekStream(prompt, { onText, timeout = 120000, model = config.llm.deepseek.model } = {}) {
  const apiKey = getSecret('deepseekApiKey');
  if (!apiKey) {
    throw new Error('deepseek api key missing');
  }

  const { signal, clear } = createTimeoutSignal(timeout);
  try {
    const res = await fetch(deepseekEndpoint('chat/completions'), {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildDeepSeekBody(prompt, { model, stream: true })),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`deepseek ${res.status}: ${detail}`);
    }
    if (!res.body) {
      throw new Error('deepseek stream body missing');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    let text = '';

    while (true) {
      const { value, done } = await reader.read();
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
          }
        }
      }
    }

    return text;
  } finally {
    clear();
  }
}

// 调一次 claude，返回模型产出的「文本」（已尽量从 json 信封里取出）
export function callClaudeRaw(prompt, {
  timeout = 120000,
  model = config.claude.model,
  forceClaude = false,
} = {}) {
  if (!forceClaude && config.llm.provider === 'deepseek') {
    return callDeepSeekRaw(prompt, { timeout });
  }

  return new Promise((resolve, reject) => {
    // --strict-mcp-config：不加载任何 MCP server，省启动开销（基线 ~10s → ~6s）。
    // ⚠️ 不能用 --bare —— 它绕过 Max 订阅认证、强制要 ANTHROPIC_API_KEY，会 "Not logged in"。
    const args = ['-p', '--output-format', 'json', '--strict-mcp-config'];
    if (model) args.push('--model', model);
    if (config.claude.disallowedTools?.length) {
      args.push('--disallowed-tools', ...config.claude.disallowedTools);
    }
    const child = spawn(config.claude.bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MAX_THINKING_TOKENS: config.claude.maxThinkingTokens }, // 关扩展思考求快（实测 66s→7s）
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('claude 超时'));
    }, timeout);

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exit ${code}: ${err.slice(0, 300)}`));
      resolve(pickResultText(out));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// 从 --output-format json 的信封里取出模型文本；解析不出来就原样返回
function pickResultText(stdout) {
  try {
    const env = JSON.parse(stdout);
    return env.result ?? env.text ?? stdout;
  } catch {
    return stdout;
  }
}

// 从一段文本里抽出第一个完整 JSON 对象（容错：模型可能包裹解释/```json 围栏）
export function extractJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// 把模型产出的原始对象规整成单一契约 {say, play[], reason, memory}。
// 这是全项目唯一的契约真相：plan()（非流式）与 index.js 流式路径都调它，杜绝两处解析漂移。
// 注：已砍掉 action —— 自然语言控制回归「play 为空=只聊天保持当前歌、非空=换歌」，由前端按 play 分支；
//     也删了早已废弃的 segue（过渡口播，为省 Fish 额度去掉，无任何消费者）。
export function normalizeResult(obj) {
  return {
    say: typeof obj?.say === 'string' ? obj.say : '',
    play: Array.isArray(obj?.play) ? obj.play : [],
    reason: typeof obj?.reason === 'string' ? obj.reason : '',
    memory: typeof obj?.memory === 'string' && obj.memory.trim() ? obj.memory.trim() : null,
  };
}

// 高层：给完整 prompt，拿到规整后的节目对象
export async function plan(prompt) {
  const raw = await callClaudeRaw(prompt);
  const obj = extractJson(raw);
  if (!obj || typeof obj.say !== 'string') {
    throw new Error(`无法从 claude 输出解析出节目 JSON：${String(raw).slice(0, 200)}`);
  }
  return normalizeResult(obj);
}

// 流式调用：边生成边把累积文本喂给 onText（只取模型正文 text_delta，跳过 thinking_delta）。
// 解析完成后 resolve 完整文本（优先用 result 事件的最终串）。用于「say 先出口播」。
export function callClaudeStream(prompt, {
  onText,
  timeout = 120000,
  model = config.claude.model,
  forceClaude = false,
} = {}) {
  if (!forceClaude && config.llm.provider === 'deepseek') {
    return callDeepSeekStream(prompt, { onText, timeout });
  }

  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--strict-mcp-config'];
    if (model) args.push('--model', model);
    if (config.claude.disallowedTools?.length) args.push('--disallowed-tools', ...config.claude.disallowedTools);
    const child = spawn(config.claude.bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MAX_THINKING_TOKENS: config.claude.maxThinkingTokens }, // 关扩展思考求快（实测 66s→7s）
    });

    let buf = '', text = '', err = '', resultText = null;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('claude 超时')); }, timeout);

    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
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
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exit ${code}: ${err.slice(0, 200)}`));
      resolve(resultText ?? text);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// 从流式累积文本里尝试取出已闭合的 say 字符串值；还没闭合返回 null。
// 用于在 play/reason 还没生成完时就拿到口播稿先合成。
export function extractSayValue(text) {
  const m = text.match(/"say"\s*:\s*"/);
  if (!m) return null;
  let out = '', esc = false;
  for (let i = m.index + m[0].length; i < text.length; i++) {
    const ch = text[i];
    if (esc) { out += ch === 'n' ? '\n' : ch === 't' ? '\t' : ch; esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') return out; // 字符串闭合 = say 完整
    out += ch;
  }
  return null; // 尚未闭合
}
