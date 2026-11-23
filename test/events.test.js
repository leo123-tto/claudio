import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createEventStore, inferExplicitFeedback, songsPlayedSince, recentFingerprints, recentLanes } from '../server/events.js';

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
  assert.equal(inferExplicitFeedback('好听', song)?.type, 'explicit_like');
  assert.equal(inferExplicitFeedback('记下', song)?.type, 'explicit_like');
  assert.equal(inferExplicitFeedback('这首不错', song)?.type, 'explicit_like');
  assert.equal(inferExplicitFeedback('这首不喜欢，以后别放了', song)?.type, 'explicit_dislike');
  assert.equal(inferExplicitFeedback('今天有点累', song), null);
  assert.equal(inferExplicitFeedback('好听吗', song), null);
  assert.equal(inferExplicitFeedback('我不喜欢别人催我', song), null);
});

test('推荐事件可以记下发现轨，其余多余字段仍丢掉', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-events-'));
  const store = createEventStore(path.join(dir, 'events.jsonl'));
  const saved = store.append({ type: 'recommendation', lane: 'classic', fingerprint: 'warm-indie', source: 'discovery' });
  store.append({ type: 'recommendation', lane: 'billboard', fingerprint: 'warm-indie' });
  assert.equal(saved.lane, 'classic');
  assert.equal(store.read()[1].lane, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('今天播过的歌可以收成一份去重清单，播放失败也记原因', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-events-'));
  const store = createEventStore(path.join(dir, 'events.jsonl'));
  store.append({ type: 'play_started', song: { title: '晨歌', artist: '甲' } });
  store.append({ type: 'play_completed', song: { title: '晨歌', artist: '甲' } });
  store.append({ type: 'play_started', song: { title: '夜歌', artist: '乙' } });
  const failed = store.append({
    type: 'play_failed',
    song: { title: '夜歌', artist: '乙' },
    value: 'link_expired',
    source: 'player',
  });
  assert.equal(failed.value, 'link_expired');
  const titles = songsPlayedSince(store.read(), 0).map((song) => song.title);
  assert.deepEqual(titles, ['晨歌', '夜歌']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('取消收藏事件可记账，垫歌不占下一期发现轨和开头统计', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-unfavorite-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createEventStore(path.join(dir, 'events.jsonl'));
  const saved = store.append({ type: 'unfavorite', source: 'button', song: { title: 'A', artist: '甲' } });
  assert.equal(saved.type, 'unfavorite');
  const events = [
    { type: 'recommendation', lane: 'classic', fingerprint: 'real' },
    { type: 'recommendation', lane: 'fresh', fingerprint: 'filler', source: 'filler' },
  ];
  assert.deepEqual(recentLanes(6, events), ['classic']);
  assert.deepEqual(recentFingerprints(6, events), ['real']);
});

test('播放器传来的歌曲垫歌标记归一化后仍不影响口味', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-filler-event-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createEventStore(path.join(dir, 'events.jsonl'));
  const event = store.append({ type: 'play_completed', listenRatio: 1, song: { title: 'A', artist: '甲', discoveryType: 'filler' } });
  assert.equal(event.discoveryType, 'filler');
});
