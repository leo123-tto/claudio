import test from 'node:test';
import assert from 'node:assert/strict';
import { attachVoice, isLiveVoiceUrl, pickMediaSource } from '../web/voice-stream.js';

class FakeBuffer extends EventTarget {
  constructor(log) { super(); this.updating = false; this.log = log; }
  appendBuffer(chunk) {
    this.updating = true; this.log.push(chunk.byteLength);
    setTimeout(() => { this.updating = false; this.dispatchEvent(new Event('updateend')); }, 1);
  }
}
function scopeWith({ supported = true, managed = false, open = true, chunks = [[1, 2], [3]], failAfter = Infinity } = {}) {
  const log = { appended: [], ended: 0, revoked: 0 };
  class FakeSource extends EventTarget {
    constructor() { super(); this.readyState = 'closed'; }
    static isTypeSupported() { return supported; }
    addSourceBuffer() { this.readyState = 'open'; return new FakeBuffer(log.appended); }
    endOfStream() { this.readyState = 'ended'; log.ended += 1; }
  }
  let source;
  const scope = {
    [managed ? 'ManagedMediaSource' : 'MediaSource']: FakeSource,
    URL: { createObjectURL: (s) => { source = s; if (open) setTimeout(() => s.dispatchEvent(new Event('sourceopen')), 1); return 'blob:voice'; },
      revokeObjectURL: () => { log.revoked += 1; } },
    fetch: async () => {
      let i = 0;
      return { ok: true, body: { getReader: () => ({ read: async () => {
        if (i >= failAfter) throw new Error('reset');
        return i < chunks.length ? { done: false, value: new Uint8Array(chunks[i++]) } : { done: true };
      } }) } };
    },
  };
  return { scope, log, source: () => source };
}
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const live = '/api/tts/stream/abc.mp3';

test('只有边合成边推的口播走 MediaSource，缓存好的文件直接放', () => {
  assert.ok(isLiveVoiceUrl(live));
  assert.ok(!isLiveVoiceUrl('/tts/abc.mp3'));
  const { scope } = scopeWith();
  const audio = {};
  assert.equal(attachVoice(audio, '/tts/abc.mp3', { scope }).mode, 'direct');
  assert.equal(audio.src, '/tts/abc.mp3');
  assert.equal(pickMediaSource({}), null);
});

test('收到一块喂一块，收完才结束；iPhone 的 ManagedMediaSource 要关 remote playback', async () => {
  for (const managed of [false, true]) {
    const { scope, log } = scopeWith({ managed });
    const audio = {};
    assert.equal(attachVoice(audio, live, { scope }).mode, 'stream');
    assert.equal(audio.src, 'blob:voice');
    await settle();
    assert.deepEqual(log.appended, [2, 1]);
    assert.equal(log.ended, 1);
    assert.equal(audio.disableRemotePlayback, managed ? true : undefined);
  }
});

test('打不开或第一块前就断，改回直接设 src；收到一半断了放完已收到的', async () => {
  const unsupported = scopeWith({ supported: false });
  const a1 = {};
  assert.equal(attachVoice(a1, live, { scope: unsupported.scope }).mode, 'direct');
  assert.equal(a1.src, live);

  const early = scopeWith({ failAfter: 0 });
  const a2 = {};
  const why = [];
  attachVoice(a2, live, { scope: early.scope, onFallback: (w) => why.push(w) });
  await settle();
  assert.equal(a2.src, live);
  assert.deepEqual(why, ['reset']);

  const midway = scopeWith({ failAfter: 1 });
  const a3 = {};
  attachVoice(a3, live, { scope: midway.scope });
  await settle();
  assert.equal(a3.src, 'blob:voice');
  assert.deepEqual(midway.log.appended, [2]);
  assert.equal(midway.log.ended, 1);
});

test('sourceopen 两秒不来就改回直接设 src；中途换口播会停掉上一路', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stuck = scopeWith({ open: false });
  const audio = {};
  attachVoice(audio, live, { scope: stuck.scope });
  t.mock.timers.tick(2000);
  assert.equal(audio.src, live);
  t.mock.timers.reset();
  const { scope, log } = scopeWith();
  const a = {};
  attachVoice(a, live, { scope }).abort();
  await settle();
  assert.deepEqual(log.appended, []);
});
