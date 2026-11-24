import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recAsk, recIntro, REC_ASK_TAIL, VOICE_MAX } from '../server/public/voice.js';

// 推荐的那句问话：附言在前、问句收尾。
// 顺序错了听起来像「听不听？还有句话说……」——先报人和歌，再说附言，最后才问。
const song = { title: '晴天（Live）', artist: '周杰伦 / 某' };

test('显示的那行带歌手、附言和问句', () => {
  const { say } = recAsk({ from: '小王', song, note: '下雨天听这个' });
  assert.equal(say, '小王给你推荐了周杰伦的《晴天》：「下雨天听这个」要听吗？');
});

test('没有附言时只报歌再问', () => {
  const { say } = recAsk({ from: '小王', song });
  assert.equal(say, '小王给你推荐了周杰伦的《晴天》。要听吗？');
});

test('口播稿：报幕 → 附言 → 问句', () => {
  const { speak } = recAsk({ from: '小王', song, note: '下雨天听这个' });
  assert.ok(speak.startsWith('小王给你推荐了《晴天》。'), `实际：${speak}`);
  assert.ok(speak.includes('小王留了句话：下雨天听这个'), `实际：${speak}`);
  assert.ok(speak.endsWith(REC_ASK_TAIL), `问句必须收尾：${speak}`);
});

test('口播稿不带歌手，也不出现会被念成字母的「ta」', () => {
  const { speak } = recAsk({ from: '小王', song, note: '好听' });
  assert.ok(!speak.includes('周杰伦'), `口播不念歌手：${speak}`);
  assert.ok(!/ta/.test(speak));
});

test('附言太长放不下：退回不带附言的短句，但问句还在', () => {
  const { speak } = recAsk({ from: '小王', song, note: '好'.repeat(60) });
  assert.ok(speak.endsWith(REC_ASK_TAIL), `实际：${speak}`);
  assert.ok([...speak].length <= VOICE_MAX, `超长：${[...speak].length}`);
});

test('和 recIntro 是两套：旧的照旧说「我这就放上」，不承诺会停', () => {
  assert.equal(typeof recIntro, 'function');
  assert.ok(!recIntro({ from: '小王', song }, () => 0).speak.includes(REC_ASK_TAIL));
});
