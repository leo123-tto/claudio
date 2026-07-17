import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDeepSeekBody } from '../server/claude.js';

test('DeepSeek JSON 输出请求始终包含官方要求的小写 json 提示', () => {
  const body = buildDeepSeekBody('返回指定结构', {
    model: 'deepseek-v4-flash',
    stream: true,
  });
  assert.equal(body.model, 'deepseek-v4-flash');
  assert.equal(body.stream, true);
  assert.equal(body.response_format.type, 'json_object');
  assert.match(body.messages.map((message) => message.content).join('\n'), /json/);
});
