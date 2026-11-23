import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDeepSeekBody } from '../server/claude.js';
import { readOpenAiChatSse } from '../server/llm/openai-chat.js';

test('DeepSeek JSON 输出请求始终包含官方要求的小写 json 提示', () => {
  const body = buildDeepSeekBody('返回指定结构', {
    model: 'deepseek-flash',
    stream: true,
  });
  assert.equal(body.model, 'deepseek-flash');
  assert.equal(body.stream, true);
  assert.equal(body.response_format.type, 'json_object');
  assert.match(body.messages.map((message) => message.content).join('\n'), /json/);
});

test('抽出的 OpenAI SSE 解析保持 DeepSeek 原行为：拼接 delta.content、忽略 [DONE]', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"{\\"say\\":"}}]}\n\n'));
      controller.enqueue(encoder.encode('ignored\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"\\"ok\\"}"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  const seen = [];
  const text = await readOpenAiChatSse(stream, { onText: (value) => seen.push(value) });
  assert.equal(text, '{"say":"ok"}');
  assert.deepEqual(seen, ['{"say":', '{"say":"ok"}']);
});

