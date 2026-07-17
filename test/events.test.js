import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createEventStore, inferExplicitFeedback } from '../server/events.js';

test('行为日志只追加、可回读，并丢弃多余敏感字段', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-events-'));
  const store = createEventStore(path.join(dir, 'events.jsonl'));
  const saved = store.append({
    type: 'favorite',
    song: { title: 'A', artist: '甲', url: 'https://secret.example/audio' },
    apiKey: 'should-not-be-written',
  });

  assert.equal(saved.type, 'favorite');
  assert.deepEqual(saved.song, { title: 'A', artist: '甲' });
  assert.equal(store.read().length, 1);
  assert.doesNotMatch(fs.readFileSync(store.file, 'utf8'), /secret|apiKey/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('用户评价当前歌曲时能识别明确喜欢或明确反感', () => {
  const song = { title: 'A', artist: '甲' };
  assert.equal(inferExplicitFeedback('这首真好听，我很喜欢', song)?.type, 'explicit_like');
  assert.equal(inferExplicitFeedback('这首不喜欢，以后别放了', song)?.type, 'explicit_dislike');
  assert.equal(inferExplicitFeedback('今天有点累', song), null);
});
