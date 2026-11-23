import test from 'node:test';
import assert from 'node:assert/strict';
import * as fish from '../server/tts/fish.js';

const cfg = { apiKey: 'fake-test-key', model: 's1', referenceId: 'fake-test-voice' };

test('Fish 完整合成的 signal 一直传到音频正文，取消会停止 reader', async () => {
  let requestSignal;
  let cancelled = false;
  let started;
  const bodyStarted = new Promise((resolve) => { started = resolve; });
  const fetchFn = async (_url, options) => {
    requestSignal = options.signal;
    const body = new ReadableStream({
      pull() { started(); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    return { ok: true, body };
  };
  const controller = new AbortController();
  const pending = fish.synthesize('取消正文', { cfg, fetchFn, signal: controller.signal });
  await bodyStarted;
  controller.abort(new Error('stop fish'));
  await assert.rejects(pending, /stop fish/);
  assert.equal(requestSignal.aborted, true);
  assert.equal(cancelled, true);
});
