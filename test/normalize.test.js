import test from 'node:test';
import assert from 'node:assert/strict';

import { extractJson, extractSayValue, normalizeResult } from '../server/llm/normalize.js';

test('能从围栏和解释文字中抽出第一个完整 JSON', () => {
  const obj = extractJson('说明：```json\n{"say":"好","play":[]}\n```');
  assert.deepEqual(obj, { say: '好', play: [] });
});

test('统一契约清洗候选歌和记忆候选，并兼容旧 memory 字段', () => {
  const result = normalizeResult({
    say: ' 来听点新鲜的。 ',
    intent: 'recommend',
    action: 'none',
    actionValue: 0,
    play: [
      { title: 'A', artist: '甲', discoveryType: 'adjacent', score: 90 },
      { title: '', artist: '无效' },
      null,
    ],
    reason: '测试',
    memory: 'ta 喜欢冷门女声',
    memoryCandidates: [{ key: 'style', value: '偏爱 dream pop', evidence: '用户明确说' }],
  });

  assert.equal(result.say, '来听点新鲜的。');
  assert.equal(result.intent, 'recommend');
  assert.equal(result.action, 'none');
  assert.equal(result.play.length, 1);
  assert.equal(result.play[0].discoveryType, 'adjacent');
  assert.equal(result.memoryCandidates.length, 2);
  assert.equal(result.memoryCandidates[1].value, 'ta 喜欢冷门女声');
});

test('聊天和控制意图都强制清空歌曲，避免误切歌', () => {
  const song = [{ title: '不该播放', artist: '测试歌手' }];
  const chat = normalizeResult({ say: '我们聊聊。', intent: 'chat', action: 'next', play: song });
  assert.equal(chat.intent, 'chat');
  assert.equal(chat.action, 'none');
  assert.deepEqual(chat.play, []);

  const control = normalizeResult({ say: '好，下一首。', intent: 'control', action: 'next', play: song });
  assert.equal(control.intent, 'control');
  assert.equal(control.action, 'next');
  assert.deepEqual(control.play, []);
});

test('旧模型输出按是否有歌曲推断意图', () => {
  assert.equal(normalizeResult({ say: '聊聊', play: [] }).intent, 'chat');
  assert.equal(normalizeResult({ say: '来听歌', play: [{ title: 'A', artist: 'B' }] }).intent, 'recommend');
});

test('流式 JSON 的 say 一闭合就能提前抽取', () => {
  assert.equal(extractSayValue('{"say":"先来一首'), null);
  assert.equal(extractSayValue('{"say":"先来一首\\n冷门好歌","play":['), '先来一首\n冷门好歌');
});
