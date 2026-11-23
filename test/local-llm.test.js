import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLocalBody, callLocalRaw, callLocalStream } from '../server/llm/local.js';
import { openaiEndpoint } from '../server/llm/openai-chat.js';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

test('OpenAI 兼容地址拼接会保留 /v1', () => {
  assert.equal(openaiEndpoint('http://127.0.0.1:9/v1', 'chat/completions'), 'http://127.0.0.1:9/v1/chat/completions');
  assert.equal(openaiEndpoint('http://127.0.0.1:9/v1/', '/chat/completions'), 'http://127.0.0.1:9/v1/chat/completions');
  assert.equal(openaiEndpoint('https://api.deepseek.com', 'chat/completions'), 'https://api.deepseek.com/chat/completions');
});

test('本地模型请求关闭思考，用提示词要求 JSON，不带盒子不认的 response_format', () => {
  const body = buildLocalBody('返回指定结构', {
    model: 'DeepSeek-V4.1-Flash-1017',
    stream: true,
  });
  assert.equal(body.model, 'DeepSeek-V4.1-Flash-1017');
  assert.equal(body.stream, true);
  assert.equal(body.response_format, undefined);
  assert.equal(body.max_tokens, 1600);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  assert.match(body.messages.map((message) => message.content).join('\n'), /json/i);
});

test('本地模型非流式调用走 chat/completions 并抽出 content', async () => {
  const calls = [];
  const text = await callLocalRaw('只做连接测试', {
    model: 'qwen3.8-flash-next-unc',
    baseUrl: 'http://127.0.0.1:9/v1',
    getApiKey: () => 'mock-local-llm-key',
    fetchFn: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body), auth: options.headers.Authorization });
      return jsonResponse(200, {
        choices: [{ message: { content: '{"say":"连接正常","play":[]}' } }],
      });
    },
  });
  assert.equal(calls[0].url, 'http://127.0.0.1:9/v1/chat/completions');
  assert.equal(calls[0].auth, 'Bearer mock-local-llm-key');
  assert.equal(calls[0].body.chat_template_kwargs.enable_thinking, false);
  assert.equal(text, '{"say":"连接正常","play":[]}');
});

test('本地模型流式调用拼接 SSE delta.content', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"{\\"say\\":"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"\\"ok\\"}"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  const seen = [];
  const text = await callLocalStream('返回指定结构', {
    model: 'qwen3.8-flash-next-unc',
    baseUrl: 'http://127.0.0.1:9/v1/',
    getApiKey: () => 'mock-local-llm-key',
    onText: (value) => seen.push(value),
    fetchFn: async () => ({ ok: true, status: 200, body: stream }),
  });
  assert.equal(text, '{"say":"ok"}');
  assert.deepEqual(seen, ['{"say":', '{"say":"ok"}']);
});

test('流式拿到完整 JSON 就收线，不等盒子在 } 后空转', async () => {
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"{\\"say\\":\\"好\\",\\"play\\":[]}"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"\\n\\n"}}]}\n\n'));
      // 不 close：模拟盒子一直空转到 max_tokens。
    },
    cancel() { cancelled = true; },
  });
  const text = await callLocalStream('返回指定结构', {
    baseUrl: 'http://127.0.0.1:9/v1',
    getApiKey: () => 'mock-local-llm-key',
    fetchFn: async () => ({ ok: true, status: 200, body: stream }),
  });
  assert.equal(text, '{"say":"好","play":[]}');
  assert.equal(cancelled, true);
});

test('本地模型失败以 local llm 开头并带状态码，缺 key 直接报错', async () => {
  await assert.rejects(
    () => callLocalRaw('hi', { getApiKey: () => '', fetchFn: async () => jsonResponse(200, {}) }),
    /local llm api key missing/,
  );
  await assert.rejects(
    () => callLocalRaw('hi', {
      getApiKey: () => 'mock-local-llm-key',
      baseUrl: 'http://127.0.0.1:9/v1',
      fetchFn: async () => jsonResponse(502, { error: { message: 'box down' } }),
    }),
    (error) => {
      assert.match(error.message, /^local llm 502:/);
      assert.match(error.message, /box down/);
      return true;
    },
  );
});
