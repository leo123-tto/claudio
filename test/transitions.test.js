import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';

import {
  envelopeValue, equalPower, crossfadeDuration, mediaDeadline,
  waitForPlaying, waitForCanPlay,
} from '../web/transitions.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} ≈ ${expected}`);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class FakeMedia extends EventTarget {
  src = '/media/song.mp3';
  currentSrc = '';
  readyState = 0;
  error = null;
  playCalls = 0;
  playback = deferred();
  listeners = new Map();

  addEventListener(type, listener, options) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    super.addEventListener(type, listener, options);
  }

  removeEventListener(type, listener, options) {
    this.listeners.get(type)?.delete(listener);
    super.removeEventListener(type, listener, options);
  }

  play() {
    this.playCalls += 1;
    return this.playback.promise;
  }

  emit(type) { this.dispatchEvent(new Event(type)); }
  listenerCount() { return [...this.listeners.values()].reduce((sum, entries) => sum + entries.size, 0); }
}

function fakeClock(t) {
  let now = 0, nextId = 0;
  const timers = new Map();
  t.mock.method(globalThis, 'setTimeout', (run, delay) => {
    const id = ++nextId;
    timers.set(id, { run, at: now + delay });
    return id;
  });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  return {
    size: () => timers.size,
    tick(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now || !timers.has(id)) continue;
        timers.delete(id);
        timer.run();
      }
    },
  };
}

const flushPromises = async () => { await Promise.resolve(); await Promise.resolve(); };
function assertClean(media, clock, signal) {
  assert.equal(media.listenerCount(), 0);
  assert.equal(clock.size(), 0);
  if (signal) assert.equal(getEventListeners(signal, 'abort').length, 0);
}

test('包络按给定时间求值，raised cosine 的两端平缓且钳住边界', () => {
  const envelope = { from: 0.2, to: 1, start: 100, duration: 1000 };
  assert.equal(envelopeValue(envelope, -100), 0.2);
  assert.equal(envelopeValue(envelope, 1100), 1);
  assert.equal(envelopeValue(envelope, 2000), 1);
  near(envelopeValue(envelope, 350), 0.317157287525381);
  near(envelopeValue(envelope, 600), 0.6);
  near(envelopeValue(envelope, 850), 0.882842712474619);
  near(envelopeValue({ ...envelope, from: 1, to: 0.2 }, 350), 0.882842712474619);
});

test('线性包络与零时长包络按约定求值', () => {
  near(envelopeValue({ from: 0.2, to: 1, start: 100, duration: 1000, curve: 'linear' }, 350), 0.4);
  assert.equal(envelopeValue({ from: 1, to: 0, start: 100, duration: 0 }, 99), 1);
  assert.equal(envelopeValue({ from: 1, to: 0, start: 100, duration: 0 }, 100), 0);
});

test('等功率交叉淡入的端点准确，中点没有能量凹陷', () => {
  assert.deepEqual(equalPower(-1), { old: 1, new: 0 });
  assert.deepEqual(equalPower(2), { old: 0, new: 1 });
  near(equalPower(0.5).old, 0.7071067811865476);
  near(equalPower(0.5).new, 0.7071067811865476);
  for (const k of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    const gains = equalPower(k);
    near(gains.old ** 2 + gains.new ** 2, 1);
  }
});

test('任一首的纯音乐曲风会缩短过渡，不从歌名猜曲风', () => {
  for (const genre of ['PIANO', 'classical', 'jazz', 'ambient', 'acoustic', '纯音乐', '钢琴', '古典', '轻音乐']) {
    assert.equal(crossfadeDuration({ genre }, {}), 1200);
    assert.equal(crossfadeDuration({}, { tags: ['pop', genre] }), 1200);
  }
  assert.equal(crossfadeDuration({ genre: 'pop' }, { genre: 'rock' }), 3000);
  assert.equal(crossfadeDuration({ title: '钢琴曲' }, null), 3000);
  assert.equal(crossfadeDuration(), 3000);
});

test('只给本地媒体和口播短超时，外链与代理仍有较长超时', () => {
  for (const url of ['/media/song.mp3', '/tts/voice.mp3?x=1', '/media', '/tts#voice']) {
    assert.equal(mediaDeadline(url), 10000);
  }
  for (const url of ['/proxy?url=music', 'https://music.example/song.mp3', 'https://music.example/tts/voice.mp3', '/media-other/song.mp3', '']) {
    assert.equal(mediaDeadline(url), 20000);
  }
});

test('浏览器展开的本机完整媒体 URL 仍使用短超时', () => {
  for (const url of ['http://[::1]:8080/tts/voice.mp3', 'http://127.0.0.1:8080/media/song.mp3', 'http://localhost:8080/tts/voice.mp3']) {
    assert.equal(mediaDeadline(url), 10000);
  }
  assert.equal(mediaDeadline('https://other.example/tts/voice.mp3'), 20000);
});

test('播放 Promise 先完成时仍须等 playing，完成后清理全部资源', async t => {
  const clock = fakeClock(t), media = new FakeMedia(), controller = new AbortController();
  let done = false;
  const waiting = waitForPlaying(media, { signal: controller.signal }).then(() => { done = true; });
  assert.equal(media.playCalls, 1);
  media.playback.resolve();
  await flushPromises();
  assert.equal(done, false);
  media.emit('playing');
  await waiting;
  assert.equal(done, true);
  assertClean(media, clock, controller.signal);
});

test('playing 先到时仍须等播放 Promise，监听必须在调用 play 前装好', async t => {
  const clock = fakeClock(t), media = new FakeMedia();
  media.play = function () { this.emit('playing'); return this.playback.promise; };
  let done = false;
  const waiting = waitForPlaying(media).then(() => { done = true; });
  await flushPromises();
  assert.equal(done, false);
  media.playback.resolve();
  await waiting;
  assertClean(media, clock);
});

test('浏览器拒绝播放或同步抛错时立即报中文错误并清理', async t => {
  const clock = fakeClock(t);
  for (const syncThrow of [false, true]) {
    const media = new FakeMedia();
    if (syncThrow) media.play = () => { throw new Error('NotAllowedError'); };
    const waiting = waitForPlaying(media);
    const rejected = assert.rejects(waiting, /播放失败/);
    if (!syncThrow) media.playback.reject(new Error('NotAllowedError'));
    await rejected;
    assertClean(media, clock);
  }
});

test('媒体错误与超时均终止等待，晚到的播放结果不会留下资源', async t => {
  const clock = fakeClock(t);
  for (const reason of ['error', 'timeout']) {
    const media = new FakeMedia(), controller = new AbortController();
    const waiting = waitForPlaying(media, { signal: controller.signal, timeoutMs: 250 });
    const rejected = assert.rejects(waiting, reason === 'error' ? /播放失败/ : /播放超时/);
    if (reason === 'error') media.emit('error');
    else clock.tick(250);
    await rejected;
    media.playback.reject(new Error('late failure'));
    media.emit('playing');
    await flushPromises();
    assertClean(media, clock, controller.signal);
  }
});

test('取消等待立即拒绝；已取消信号不会再调用播放', async t => {
  const clock = fakeClock(t);
  for (const cancelledBeforeStart of [false, true]) {
    const media = new FakeMedia(), controller = new AbortController();
    if (cancelledBeforeStart) controller.abort();
    const waiting = waitForPlaying(media, { signal: controller.signal });
    const rejected = assert.rejects(waiting, error => error.name === 'AbortError' && /取消/.test(error.message));
    if (!cancelledBeforeStart) controller.abort();
    await rejected;
    assert.equal(media.playCalls, cancelledBeforeStart ? 0 : 1);
    assertClean(media, clock, controller.signal);
  }
});

test('默认超时按媒体路径选择，播放 Promise 或 playing 单独完成均不能绕过超时', async t => {
  const clock = fakeClock(t);
  for (const [src, deadline, first] of [['/tts/voice.mp3', 10000, 'promise'], ['/proxy?url=track', 20000, 'playing']]) {
    const media = new FakeMedia();
    media.src = src;
    const waiting = waitForPlaying(media);
    const rejected = assert.rejects(waiting, /播放超时/);
    if (first === 'promise') media.playback.resolve();
    else media.emit('playing');
    await flushPromises();
    clock.tick(deadline - 1);
    assert.equal(clock.size(), 1);
    clock.tick(1);
    await rejected;
    assertClean(media, clock);
  }
});

test('可播放等待支持已有缓冲和 canplay，并且不会提前调用 play', async t => {
  const clock = fakeClock(t);
  for (const ready of [false, true]) {
    const media = new FakeMedia();
    if (ready) media.readyState = 3;
    let done = false;
    const waiting = waitForCanPlay(media).then(() => { done = true; });
    await flushPromises();
    assert.equal(done, ready);
    if (!ready) media.emit('canplay');
    await waiting;
    assert.equal(media.playCalls, 0);
    assertClean(media, clock);
  }
});

test('可播放等待的错误、取消和超时都拒绝且清理', async t => {
  const clock = fakeClock(t);
  for (const reason of ['error', 'abort', 'timeout']) {
    const media = new FakeMedia(), controller = new AbortController();
    const waiting = waitForCanPlay(media, { signal: controller.signal, timeoutMs: 100 });
    const rejected = assert.rejects(waiting, reason === 'error' ? /加载失败/ : reason === 'abort' ? /取消/ : /加载超时/);
    if (reason === 'error') media.emit('error');
    else if (reason === 'abort') controller.abort();
    else clock.tick(100);
    await rejected;
    assertClean(media, clock, controller.signal);
  }
});
