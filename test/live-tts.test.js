import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';

import { createLiveTtsManager, hashTtsText } from '../server/tts/live.js';

class AudioResponse extends Writable {
  constructor() {
    const chunks = [];
    super({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    this.chunks = chunks;
    this.headers = {};
    this.statusCode = 200;
  }
  setHeader(key, value) { this.headers[key.toLowerCase()] = value; }
  status(code) { this.statusCode = code; return this; }
}

test('实时语音在准备时就开始合成，浏览器一连上就能拿到已经生成的音频', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-live-tts-'));
  let calls = 0;
  const manager = createLiveTtsManager({
    cacheDir: dir,
    hashText: () => '0123456789abcdef',
    streamFactory: async function* () {
      calls += 1;
      yield Buffer.from('first');
      yield Buffer.from('second');
    },
    firstByteTimeout: 1000,
  });
  const prepared = manager.prepare('尽快开口');
  assert.equal(prepared.url, '/api/tts/stream/0123456789abcdef.mp3');
  await prepared.ready;
  assert.equal(calls, 1);
  manager.prepare('尽快开口');
  assert.equal(calls, 1);

  const response = new AudioResponse();
  await manager.handle('0123456789abcdef', response);
  assert.equal(response.writableEnded, true);
  assert.equal(calls, 1);
  assert.equal(Buffer.concat(response.chunks).toString(), 'firstsecond');
  assert.equal(fs.readFileSync(path.join(dir, '0123456789abcdef.mp3')).toString(), 'firstsecond');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('语音缓存键包含供应商与音色，切换后不会命中旧缓存', () => {
  const text = '尽快开口';
  const base = {
    fish: { referenceId: 'voice-a', model: 's1' },
    pc5090: { baseUrl: 'http://127.0.0.1:1', voice: 'claudio' },
  };
  const fish = hashTtsText(text, { ...base, provider: 'fish' });
  const pc = hashTtsText(text, { ...base, provider: 'pc5090' });
  const pcOtherVoice = hashTtsText(text, {
    ...base,
    provider: 'pc5090',
    pc5090: { baseUrl: 'http://127.0.0.1:1', voice: 'other' },
  });
  assert.match(fish, /^[a-f0-9]{16}$/);
  assert.notEqual(fish, pc);
  assert.notEqual(pc, pcOtherVoice);
});

function tempManager(t, options) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-live-errors-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  return createLiveTtsManager({
    cacheDir,
    hashText: () => '0123456789abcdef',
    getProvider: () => 'fish',
    ...options,
  });
}

test('失败的 live job 不复用；同一口播下一次可重新合成', async (t) => {
  let calls = 0;
  const errors = [];
  const manager = tempManager(t, {
    streamFactory: async function* () {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      yield Buffer.from('recovered');
    },
  });
  const failed = manager.prepare('再试一次', { onError: (error) => errors.push(error.message) });
  await assert.rejects(failed.ready, /offline/);
  const retry = manager.prepare('再试一次');
  await retry.ready;
  const response = new AudioResponse();
  await manager.handle(retry.hash, response);
  assert.equal(calls, 2);
  assert.deepEqual(errors, ['offline']);
  assert.equal(Buffer.concat(response.chunks).toString(), 'recovered');
});

test('首包后失败仍通知所有订阅者一次，并中断 HTTP 而不缓存半段音频', async (t) => {
  let fail;
  const wait = new Promise((_resolve, reject) => { fail = reject; });
  const errors = [];
  const manager = tempManager(t, {
    streamFactory: async function* () {
      yield Buffer.from('partial');
      await wait;
    },
  });
  const first = manager.prepare('未念完', { onError: (error) => errors.push(`first:${error.message}`) });
  await first.ready;
  manager.prepare('未念完', { onError: (error) => errors.push(`second:${error.message}`) });
  const response = new AudioResponse();
  const handled = manager.handle(first.hash, response);
  fail(new Error('stream disconnected'));
  await handled;
  assert.equal(response.destroyed, true);
  assert.equal(fs.existsSync(first.file), false);
  assert.deepEqual(errors, ['first:stream disconnected', 'second:stream disconnected']);
});

test('live 外部取消会终止 provider 并拒绝 ready，后续同文本可重试', async (t) => {
  let aborted = false;
  let calls = 0;
  const manager = tempManager(t, {
    streamFactory: async function* (_text, { signal }) {
      calls += 1;
      if (calls > 1) { yield Buffer.from('retry'); return; }
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true }));
    },
  });
  const controller = new AbortController();
  const first = manager.prepare('取消', { signal: controller.signal });
  controller.abort(new Error('episode cancelled'));
  await assert.rejects(first.ready, /episode cancelled/);
  assert.equal(aborted, true);
  assert.equal(fs.existsSync(first.file), false);
  const retry = manager.prepare('取消');
  await retry.ready;
  await manager.handle(retry.hash, new AudioResponse());
  assert.equal(calls, 2);
});

test('live 普通首包超时真取消 provider，超时不靠 provider 自己抛错', async (t) => {
  let providerSignal;
  const errors = [];
  const manager = tempManager(t, {
    firstByteTimeout: 10,
    totalTimeout: 1000,
    streamFactory: async function* (_text, { signal }) {
      providerSignal = signal;
      await new Promise(() => {});
    },
  });
  const first = manager.prepare('卡住', { onError: (error) => errors.push(error.message) });
  await assert.rejects(first.ready, /首段音频超时/);
  assert.equal(providerSignal.aborted, true);
  assert.equal(errors.length, 1);
});

test('5090 只有 starting 放宽首包预算，恢复 ready 后使用通常预算', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let state = 'starting';
  const statuses = new EventEmitter();
  let signal;
  const manager = tempManager(t, {
    getProvider: () => 'pc5090',
    getLaneState: () => state,
    laneStatusEvents: statuses,
    firstByteTimeout: 8000,
    streamFactory: async function* (_text, options) {
      signal = options.signal;
      await new Promise(() => {});
    },
  });
  const first = manager.prepare('冷启动');
  t.mock.timers.tick(239000);
  assert.equal(signal.aborted, false);
  state = 'ready';
  statuses.emit('status', { state });
  t.mock.timers.tick(7999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await assert.rejects(first.ready, /首段音频超时/);
  assert.equal(signal.aborted, true);
});

test('5090 冷却中当场报错、不开合成，缓存好的口播照样能用', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-live-tts-'));
  let calls = 0;
  const busy = Object.assign(new Error('5090 正被别的任务占着'), { code: 'PC5090_OCCUPIED' });
  const manager = createLiveTtsManager({
    cacheDir: dir,
    hashText: (text) => (text === '缓存过的' ? 'aaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbb'),
    streamFactory: async function* () { calls += 1; yield Buffer.from('x'); },
    getProvider: () => 'pc5090',
    laneCooldown: () => busy,
    laneStatusEvents: new EventEmitter(),
    getLaneState: () => 'busy',
  });
  assert.throws(() => manager.prepare('新口播'), /被别的任务占着/);
  assert.equal(calls, 0);
  fs.writeFileSync(path.join(dir, 'aaaaaaaaaaaaaaaa.mp3'), 'mp3');
  assert.equal(manager.prepare('缓存过的').cached, true);
});
