import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-llm-deadline-'));
process.env.CLAUDIO_DATA_DIR = fixture;
process.env.CLAUDIO_RESOURCE_ROOT = fixture;
after(() => fs.rmSync(fixture, { recursive: true, force: true }));
const { callLocalRaw, callLocalStream } = await import('../server/llm/local.js');
const { callDeepSeekRaw, callDeepSeekStream, callClaudeRaw, callClaudeStream } = await import('../server/claude.js');
const { callLlmRaw, callLlmStream, plan } = await import('../server/llm/index.js');
const { createTimeoutSignal } = await import('../server/llm/openai-chat.js');
const { updateSettings } = await import('../server/settings.js');

function pendingFetch(calls) {
  return (_url, { signal }) => new Promise((_resolve, reject) => {
    calls.push(signal);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = (prompt) => { child.prompt = prompt; };
  child.stdin.end = () => {};
  child.kills = [];
  child.kill = (signal) => { child.kills.push(signal); child.emit('close', null); };
  return child;
}

const httpProviders = [
  ['local raw', callLocalRaw, 150000],
  ['local stream', callLocalStream, 150000],
  ['deepseek raw', callDeepSeekRaw, 60000],
  ['deepseek stream', callDeepSeekStream, 60000],
];

for (const [label, call, deadline] of httpProviders) {
  test(`${label} reaches fetch with external cancellation and keeps the original reason`, async () => {
    const controller = new AbortController();
    const reason = new Error('superseded');
    const calls = [];
    const pending = call('fake prompt', {
      signal: controller.signal,
      getApiKey: () => 'fake-key',
      fetchFn: pendingFetch(calls),
    });
    const rejected = assert.rejects(pending, (error) => error === reason);
    assert.equal(calls.length, 1);
    controller.abort(reason);
    await rejected;
    assert.equal(calls[0].aborted, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  test(`${label} actively aborts fetch at its default ${deadline}ms deadline`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const calls = [];
    const pending = call('fake prompt', { getApiKey: () => 'fake-key', fetchFn: pendingFetch(calls) });
    const rejected = assert.rejects(pending, { name: 'TimeoutError' });
    t.mock.timers.tick(deadline - 1);
    assert.equal(calls[0].aborted, false);
    t.mock.timers.tick(1);
    await rejected;
    assert.equal(calls[0].aborted, true);
  });
}

test('HTTP streams cancel an already open reader, including an upstream that never ends', async () => {
  for (const call of [callLocalStream, callDeepSeekStream]) {
    const controller = new AbortController();
    const reason = new Error('obsolete program');
    let cancelled;
    const body = new ReadableStream({ cancel(value) { cancelled = value; } });
    const pending = call('fake prompt', {
      signal: controller.signal,
      getApiKey: () => 'fake-key',
      fetchFn: async () => ({ ok: true, body }),
    });
    const rejected = assert.rejects(pending, (error) => error === reason);
    await Promise.resolve();
    controller.abort(reason);
    await rejected;
    assert.equal(cancelled, reason);
    assert.equal(body.locked, false);
  }
});

test('pre-aborted calls do not fetch or spawn', async () => {
  const controller = new AbortController();
  controller.abort();
  const forbidden = () => { assert.fail('cancelled work must never start'); };
  for (const call of [...httpProviders.map((item) => item[1]), callClaudeRaw, callClaudeStream]) {
    await assert.rejects(() => call('fake', {
      signal: controller.signal,
      getApiKey: forbidden,
      fetchFn: forbidden,
      spawnFn: forbidden,
    }), { name: 'AbortError' });
  }
});

for (const [label, call] of [['raw', callClaudeRaw], ['stream', callClaudeStream]]) {
  test(`Claude ${label} external abort kills the CLI and ignores late output`, async () => {
    const child = fakeChild();
    const controller = new AbortController();
    const reason = new Error('cancel current show');
    const seen = [];
    const pending = call('fake prompt', {
      signal: controller.signal,
      spawnFn: () => child,
      onText: (value) => seen.push(value),
    });
    const rejected = assert.rejects(pending, (error) => error === reason);
    controller.abort(reason);
    await rejected;
    assert.deepEqual(child.kills, ['SIGKILL']);
    assert.equal(child.prompt, 'fake prompt');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    child.stdout.emit('data', JSON.stringify({ result: 'late result' }) + '\n');
    child.emit('close', 0);
    assert.deepEqual(seen, []);
  });

  test(`Claude ${label} kills the CLI at 60 seconds`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    const pending = call('fake', { spawnFn: () => child });
    const rejected = assert.rejects(pending, { name: 'TimeoutError' });
    t.mock.timers.tick(59999);
    assert.deepEqual(child.kills, []);
    t.mock.timers.tick(1);
    await rejected;
    assert.deepEqual(child.kills, ['SIGKILL']);
  });
}

test('Claude CLI succeeds and clears the deadline and parent listener', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const child = fakeChild();
  const pending = callClaudeRaw('fake', { signal: controller.signal, spawnFn: () => child });
  child.stdout.emit('data', '{"result":"{\\"say\\":\\"ok\\"}"}');
  child.emit('close', 0);
  assert.equal(await pending, '{"say":"ok"}');
  t.mock.timers.tick(60000);
  controller.abort();
  assert.deepEqual(child.kills, []);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('Claude stream still reports cumulative text and prefers the final result', async () => {
  const child = fakeChild();
  const seen = [];
  const pending = callClaudeStream('fake', { spawnFn: () => child, onText: (value) => seen.push(value) });
  const delta = (text) => JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  }) + '\n';
  child.stdout.emit('data', delta('{"say":'));
  child.stdout.emit('data', delta('"ok"}'));
  child.stdout.emit('data', JSON.stringify({ type: 'result', result: '{"say":"final"}' }) + '\n');
  child.emit('close', 0);
  assert.equal(await pending, '{"say":"final"}');
  assert.deepEqual(seen, ['{"say":', '{"say":"ok"}']);
});

test('dispatcher and plan forward cancellation to every selected provider', async () => {
  for (const provider of ['local', 'deepseek', 'claude']) {
    updateSettings({ llm: { provider } });
    for (const call of [callLlmRaw, callLlmStream, plan]) {
      const controller = new AbortController();
      const reason = new Error(`${provider} superseded`);
      const calls = [];
      const child = fakeChild();
      const pending = call('fake', {
        signal: controller.signal,
        getApiKey: () => 'fake-key',
        fetchFn: pendingFetch(calls),
        spawnFn: () => child,
      });
      const rejected = assert.rejects(pending, (error) => error === reason);
      controller.abort(reason);
      await rejected;
      if (provider === 'claude') assert.deepEqual(child.kills, ['SIGKILL']);
      else assert.equal(calls[0].aborted, true);
    }
  }
});

test('composed deadline preserves an earlier parent abort and removes listeners on clear', () => {
  const parent = new AbortController();
  const reason = new Error('obsolete');
  parent.abort(reason);
  const deadline = createTimeoutSignal(60000, parent.signal);
  assert.equal(deadline.signal.reason, reason);
  deadline.clear();
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});
