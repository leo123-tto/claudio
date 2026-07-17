import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { CodexAppServer } from '../server/llm/codex-app-server.js';

function fakeCodexProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('close', 0);
  let turnNumber = 0;
  let written = '';

  const reply = (message) => setImmediate(() => child.stdout.write(`${JSON.stringify(message)}\n`));
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      written += chunk.toString();
      let newline;
      while ((newline = written.indexOf('\n')) >= 0) {
        const line = written.slice(0, newline);
        written = written.slice(newline + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        if (request.method === 'initialize') reply({ id: request.id, result: {} });
        if (request.method === 'thread/start') reply({ id: request.id, result: { thread: { id: `thread-${turnNumber + 1}` } } });
        if (request.method === 'turn/start') {
          turnNumber += 1;
          const threadId = `thread-${turnNumber}`;
          const turnId = `turn-${turnNumber}`;
          reply({ id: request.id, result: { turn: { id: turnId } } });
          reply({ method: 'item/agentMessage/delta', params: { threadId, turnId, delta: '{"say":"两' } });
          reply({ method: 'item/agentMessage/delta', params: { threadId, turnId, delta: '秒开口","play":[],"reason":"","memoryCandidates":[]}' } });
          reply({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
        }
      }
      done();
    },
  });
  return child;
}

test('Codex app-server 常驻复用，并把流式 delta 合成为完整模型文本', async () => {
  let spawnCount = 0;
  const client = new CodexAppServer({
    spawnFn: () => { spawnCount += 1; return fakeCodexProcess(); },
    requestTimeout: 1000,
  });
  const snapshots = [];

  const first = await client.generate('生成一期', {
    model: 'gpt-5.6-luna',
    effort: 'low',
    timeout: 1000,
    onText: (text) => snapshots.push(text),
  });
  const second = await client.generate('再来一期', {
    model: 'gpt-5.6-luna',
    effort: 'low',
    timeout: 1000,
  });

  assert.equal(spawnCount, 1);
  assert.match(first, /两秒开口/);
  assert.equal(second, first);
  assert.equal(snapshots.at(-1), first);
  client.close();
});
