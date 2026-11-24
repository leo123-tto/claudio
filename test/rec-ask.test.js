import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAnswer, withoutAsk, listenForAnswer, ANSWER_MS, ANSWER_FALLBACK_MS } from '../web/rec-ask.js';

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

test('拿不准的都不算答应：带否定字、推迟、太长、像歌词的', () => {
  for (const text of ['不太想听', '等会儿再听', '听不清', '你好', '对不起', '好像不对', '我要你陪着我看那海', '来一首别的', '那个谁']) {
    assert.notEqual(readAnswer(text), 'yes', `「${text}」不该算答应`);
  }
  for (const text of ['等会儿再听', '不太想听', '先不了']) assert.equal(readAnswer(text), 'no', `「${text}」算拒绝`);
});

test('带标点和语气词的短句照样算答应', () => {
  for (const text of ['好啊！', '嗯嗯。', '要听，', '放吧~', 'OK', '听一下', '我要听', '可以啊', '好阿放吧。', '要听。', '好的好的', '来吧']) {
    assert.equal(readAnswer(text), 'yes', `「${text}」应该算答应`);
  }
});

test('没念出来就不问：显示的字去掉问句', () => {
  assert.equal(withoutAsk('小王给你推荐了《晴天》。要听吗？'), '小王给你推荐了《晴天》。');
  assert.equal(withoutAsk('下一首，《晴天》。'), '下一首，《晴天》。');
});

// 浏览器听写的假实现：按脚本触发事件
function fakeRecognition(script) {
  return class {
    start() { script(this); }
    stop() { setTimeout(() => this.onend?.(), 0); }
    abort() {}
  };
}

test('浏览器听写：说了「听」算答应', async () => {
  const Recognition = fakeRecognition((r) => setTimeout(() => {
    r.onaudiostart();
    r.onresult({ results: [[{ transcript: '听' }]] });
    r.onend();
  }, 0));
  assert.deepEqual(await listenForAnswer({ engine: 'speech', Recognition, ms: 50 }), { answer: 'yes', text: '听' });
});

test('浏览器听写：没出声是 none；没有听写、不给权限、授权框一直不点是 unavailable', async () => {
  const silent = fakeRecognition((r) => setTimeout(() => { r.onaudiostart(); r.onerror({ error: 'no-speech' }); r.onend(); }, 0));
  assert.equal((await listenForAnswer({ engine: 'speech', Recognition: silent, ms: 50 })).answer, 'none');
  assert.equal((await listenForAnswer({ engine: 'speech', Recognition: undefined })).answer, 'unavailable');
  const denied = fakeRecognition((r) => setTimeout(() => { r.onerror({ error: 'not-allowed' }); r.onend(); }, 0));
  assert.equal((await listenForAnswer({ engine: 'speech', Recognition: denied })).answer, 'unavailable');
  const hanging = fakeRecognition(() => {});
  assert.equal((await listenForAnswer({ engine: 'speech', Recognition: hanging, startTimeoutMs: 30, ms: 50 })).answer, 'unavailable');
});

test('浏览器听写：换歌（abort）就不等了', async () => {
  const ac = new AbortController();
  const Recognition = fakeRecognition((r) => setTimeout(() => r.onaudiostart(), 0));
  const pending = listenForAnswer({ engine: 'speech', Recognition, ms: 10_000, signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  assert.equal((await pending).answer, 'none');
});

test('录音：授权框一直不点、或没有麦克风，都是 unavailable，不卡播放', async () => {
  const had = globalThis.MediaRecorder;
  globalThis.MediaRecorder = class {};
  try {
    const hanging = { getUserMedia: () => new Promise(() => {}) };
    assert.equal((await listenForAnswer({ mediaDevices: hanging, startTimeoutMs: 30 })).answer, 'unavailable');
    const denied = { getUserMedia: async () => { throw new DOMException('denied', 'NotAllowedError'); } };
    assert.equal((await listenForAnswer({ mediaDevices: denied })).answer, 'unavailable');
    assert.equal((await listenForAnswer({ mediaDevices: undefined })).answer, 'unavailable');
  } finally {
    globalThis.MediaRecorder = had;
  }
});
