import test from 'node:test';
import assert from 'node:assert/strict';

import { extractClosedString, extractJson, extractPlayArray, extractSayValue, normalizeResult } from '../server/llm/normalize.js';

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

test('发现轨只保留流行、新风格和老内容', () => {
  const result = normalizeResult({
    say: '来一首老的。',
    intent: 'recommend',
    play: [
      { title: '老歌', artist: '甲', discoveryType: 'explore', lane: 'classic', bridgeFrom: '老歌', score: 70 },
      { title: '新歌', artist: '乙', discoveryType: 'adjacent', lane: 'billboard', score: 10 },
    ],
  });
  assert.equal(result.play[0].lane, 'classic');
  assert.equal(result.play[1].lane, undefined);
});

test('旧模型输出按是否有歌曲推断意图', () => {
  assert.equal(normalizeResult({ say: '聊聊', play: [] }).intent, 'chat');
  assert.equal(normalizeResult({ say: '来听歌', play: [{ title: 'A', artist: 'B' }] }).intent, 'recommend');
});

test('流式 JSON 的 say 一闭合就能提前抽取', () => {
  assert.equal(extractSayValue('{"say":"先来一首'), null);
  assert.equal(extractSayValue('{"say":"先来一首\\n冷门好歌","play":['), '先来一首\n冷门好歌');
});

test('歌单数组和意图都闭合后才能提前找歌，没写完则继续等', () => {
  const partial = '{"say":"放两首","intent":"recommend","action":"none","actionValue":0,"play":[{"title":"水星记","artist":"郭顶"';
  assert.equal(extractClosedString(partial, 'intent'), 'recommend');
  assert.equal(extractPlayArray(partial), null);

  const closed = `${partial},"discoveryType":"adjacent","bridgeFrom":"口味","score":80}]}`;
  assert.deepEqual(extractPlayArray(closed), [
    { title: '水星记', artist: '郭顶', discoveryType: 'adjacent', bridgeFrom: '口味', score: 80 },
  ]);
  assert.deepEqual(extractPlayArray('{"say":"只聊聊","intent":"chat","play":[]}'), []);
  const bracketed = '{"say":"歌名里有 ] 也不截断","play":[{"title":"a]b","artist":"甲"}]}';
  assert.deepEqual(extractPlayArray(bracketed), [{ title: 'a]b', artist: '甲' }]);
  assert.equal(extractPlayArray('{"say":"还没写完","play":[{"title":"a]b","artist":"甲"}'), null);
});

test('推荐保留五首有序候选，过滤无效项后才限制数量', () => {
  const songs = Array.from({ length: 6 }, (_, index) => ({ title: `候选${index + 1}`, artist: `歌手${index + 1}` }));
  const result = normalizeResult({ intent: 'recommend', play: [null, { title: '', artist: '无效' }, ...songs] });
  assert.deepEqual(result.play.map((song) => song.title), ['候选1', '候选2', '候选3', '候选4', '候选5']);
});
