import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAnswer, ANSWER_MS, ANSWER_FALLBACK_MS } from '../web/rec-ask.js';

// 「听没听懂」只能是三档：听 / 不听 / 没回应。
// 拿不准一律当「没回应」——静默丢弃比误播一首可控，丢掉的那首还能问回来。
test('明确的答应算听', () => {
  for (const text of ['听', '要听', '好', '放吧', '可以', '行', '嗯', '要', '听听', '放上']) {
    assert.equal(readAnswer(text), 'yes', `「${text}」应该算答应`);
  }
});

test('明确的拒绝算不听', () => {
  for (const text of ['不听', '不要', '算了', '别放', '跳过', '下一首', '不用']) {
    assert.equal(readAnswer(text), 'no', `「${text}」应该算拒绝`);
  }
});

test('「不要」里有「要」，否定必须先判', () => {
  assert.equal(readAnswer('不要'), 'no');
  assert.equal(readAnswer('不听了'), 'no');
  assert.equal(readAnswer('我不要听这首'), 'no');
});

test('没识别出字、或者说了不相干的话，都当没回应', () => {
  assert.equal(readAnswer(''), 'none');
  assert.equal(readAnswer('   '), 'none');
  assert.equal(readAnswer('今天天气不错'), 'none');
  assert.equal(readAnswer('小王推荐了什么'), 'none');
});

test('等待窗口是 5 秒、兜底 15 秒', () => {
  assert.equal(ANSWER_MS, 5_000);
  assert.equal(ANSWER_FALLBACK_MS, 15_000);
});
