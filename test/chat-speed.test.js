import test from 'node:test';
import assert from 'node:assert/strict';
import { extractClosedPlayItems } from '../server/llm/normalize.js';
import { buildLocalBody } from '../server/llm/local.js';

test('流式中只取 play 里已经写完的歌，半截的不算', () => {
  const text = '{"say":"好","intent":"recommend","action":"none","actionValue":0,"play":[{"title":"晴天","artist":"甲 {x}"},{"title":"雨天","artist":"乙"},{"title":"半截';
  assert.deepEqual(extractClosedPlayItems(text), [{ title: '晴天', artist: '甲 {x}' }, { title: '雨天', artist: '乙' }]);
  assert.deepEqual(extractClosedPlayItems('{"say":"还没到"'), []);
  assert.deepEqual(extractClosedPlayItems('{"play":[]}'), []);
});

test('点歌请求可以把输出上限调小，默认仍是 1600', () => {
  assert.equal(buildLocalBody('x', { model: 'm' }).max_tokens, 1600);
  assert.equal(buildLocalBody('x', { model: 'm', maxTokens: 800 }).max_tokens, 800);
});
