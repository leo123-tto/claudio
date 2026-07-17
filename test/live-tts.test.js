import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import { createLiveTtsManager } from '../server/tts/live.js';

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

test('Fish 实时语音在浏览器请求后才启动，并边生成边写缓存', async () => {
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
  assert.equal(calls, 0);
  assert.equal(prepared.url, '/api/tts/stream/0123456789abcdef.mp3');

  const response = new AudioResponse();
  await manager.handle('0123456789abcdef', response);
  assert.equal(response.writableEnded, true);
  assert.equal(calls, 1);
  assert.equal(Buffer.concat(response.chunks).toString(), 'firstsecond');
  assert.equal(fs.readFileSync(path.join(dir, '0123456789abcdef.mp3')).toString(), 'firstsecond');
  fs.rmSync(dir, { recursive: true, force: true });
});
