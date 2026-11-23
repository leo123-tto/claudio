import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tts from '../server/tts/index.js';

function factory(t, provider, { providerName = 'fake', ...options } = {}) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-tts-cancel-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  return {
    cacheDir,
    synthesize: tts.createTtsSynthesizer({
      cacheDir,
      getTts: () => ({ provider: providerName }),
      providerRegistry: { [providerName]: { ext: 'mp3', synthesize: provider } },
      hashText: () => '0123456789abcdef',
      ...options,
    }),
  };
}

test('完整合成取消会传到 provider，迟到结果不会写缓存，同文本可重试', async (t) => {
  let signal;
  let finish;
  let started;
  const hasStarted = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  const { synthesize, cacheDir } = factory(t, async (_text, options) => {
    calls += 1;
    if (calls > 1) return Buffer.from('retry');
    signal = options.signal;
    started();
    return new Promise((resolve) => { finish = resolve; });
  });
  const controller = new AbortController();
  const first = synthesize('完整口播', { signal: controller.signal });
  await hasStarted;
  controller.abort(new Error('episode timeout'));
  await assert.rejects(first, /episode timeout/);
  assert.equal(signal.aborted, true);
  finish(Buffer.from('late'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fs.readdirSync(cacheDir), []);
  const retry = await synthesize('完整口播');
  assert.equal(fs.readFileSync(retry.file).toString(), 'retry');
  assert.equal(calls, 2);
});

test('并发完整合成只取消退出者，最后一名订阅者取消才终止共享 provider', async (t) => {
  let signal;
  let finish;
  let calls = 0;
  const { synthesize } = factory(t, (_text, options) => {
    calls += 1;
    signal = options.signal;
    return new Promise((resolve) => { finish = resolve; });
  });
  const firstController = new AbortController();
  const first = synthesize('并发口播', { signal: firstController.signal });
  const second = synthesize('并发口播');
  await new Promise((resolve) => setImmediate(resolve));
  firstController.abort(new Error('first leaves'));
  await assert.rejects(first, /first leaves/);
  assert.equal(signal.aborted, false);
  finish(Buffer.from('whole'));
  const result = await second;
  assert.equal(fs.readFileSync(result.file).toString(), 'whole');
  assert.equal(calls, 1);
});

test('已经取消的完整合成不使用缓存也不启动 provider', async (t) => {
  let calls = 0;
  const { synthesize } = factory(t, async () => { calls += 1; return Buffer.from('whole'); });
  await synthesize('已有缓存');
  const controller = new AbortController();
  controller.abort(new Error('cancelled before start'));
  await assert.rejects(synthesize('已有缓存', { signal: controller.signal }), /cancelled before start/);
  assert.equal(calls, 1);
});

for (const { providerName, budget } of [
  { providerName: 'fish', budget: 45000 },
  { providerName: 'pc5090', budget: 300000 },
]) {
  test(`${providerName} 完整合成超过默认总截止会真取消，迟到音频不缓存且同稿可重试`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const cleanup = new AbortController();
    t.after(() => cleanup.abort());
    let signal;
    let finish;
    let calls = 0;
    const { synthesize, cacheDir } = factory(t, async (_text, options) => {
      calls += 1;
      if (calls > 1) return Buffer.from('retry after timeout');
      signal = options.signal;
      return new Promise((resolve) => { finish = resolve; });
    }, { providerName });
    const first = synthesize('总截止', { signal: cleanup.signal });
    first.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(budget - 1);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(signal.aborted, true);
    await assert.rejects(first, /合成总超时/);
    finish(Buffer.from('late audio'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(fs.readdirSync(cacheDir), []);
    const retry = await synthesize('总截止');
    assert.equal(fs.readFileSync(retry.file).toString(), 'retry after timeout');
    assert.equal(calls, 2);
  });
}

test('完整合成总截止可由工厂单独配置', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cleanup = new AbortController();
  t.after(() => cleanup.abort());
  let signal;
  const { synthesize } = factory(t, async (_text, options) => {
    signal = options.signal;
    return new Promise(() => {});
  }, { totalTimeout: 1234 });
  const first = synthesize('自定义预算', { signal: cleanup.signal });
  first.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1234);
  assert.equal(signal.aborted, true);
  await assert.rejects(first, /合成总超时/);
});
