import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveProfile, signalWeight } from '../server/profile.js';

test('显式和行为信号按约定权重计分', () => {
  assert.equal(signalWeight({ type: 'explicit_like' }), 100);
  assert.equal(signalWeight({ type: 'explicit_dislike' }), -100);
  assert.equal(signalWeight({ type: 'favorite' }), 80);
  assert.equal(signalWeight({ type: 'dislike' }), -80);
  assert.equal(signalWeight({ type: 'repeated_request' }), 60);
  assert.equal(signalWeight({ type: 'replay' }), 50);
  assert.equal(signalWeight({ type: 'play_completed', listenRatio: 0.9 }), 20);
  assert.equal(signalWeight({ type: 'play_progress', listenRatio: 0.5 }), 5);
  assert.equal(signalWeight({ type: 'skip', listenedSec: 12 }), -25);
  assert.equal(signalWeight({ type: 'memory_inferred' }), 10);
});

test('画像聚合同一歌曲和歌手，弱行为会随时间衰减', () => {
  const now = new Date('2026-07-17T12:00:00Z');
  const events = [
    { type: 'favorite', at: '2026-07-16T12:00:00Z', song: { title: 'A', artist: '甲' } },
    { type: 'play_completed', listenRatio: 0.95, at: '2026-07-16T12:00:00Z', song: { title: 'A', artist: '甲' } },
    { type: 'play_completed', listenRatio: 0.95, at: '2025-07-16T12:00:00Z', song: { title: 'B', artist: '乙' } },
  ];

  const profile = deriveProfile(events, { now });
  assert.equal(profile.songs[0].title, 'A');
  assert.equal(profile.artists[0].artist, '甲');
  assert.ok(profile.artists.find((item) => item.artist === '甲').score > 90);
  assert.ok(profile.artists.find((item) => item.artist === '乙').score < 2);
});

test('模型推断至少被两条独立证据支持才进入稳定记忆', () => {
  const once = deriveProfile([
    { type: 'memory_inferred', key: 'scene', value: '夜晚偏爱安静女声', evidenceId: 'm1' },
  ]);
  assert.equal(once.memories.stable.length, 0);
  assert.equal(once.memories.pending.length, 1);

  const twice = deriveProfile([
    { type: 'memory_inferred', key: 'scene', value: '夜晚偏爱安静女声', evidenceId: 'm1' },
    { type: 'memory_inferred', key: 'scene', value: '夜晚偏爱安静女声', evidenceId: 'm2' },
  ]);
  assert.equal(twice.memories.stable.length, 1);
  assert.equal(twice.memories.stable[0].value, '夜晚偏爱安静女声');
});

test('取消爱心撤掉按钮加分，重复点击不重复计分，聊天喜欢保留', () => {
  const song = { title: 'A', artist: '甲' };
  const liked = [
    { type: 'favorite', song, source: 'button' },
    { type: 'favorite', song, source: 'button' },
    { type: 'explicit_like', song, source: 'chat' },
  ];
  assert.equal(deriveProfile(liked).songs[0].score, 180);
  assert.equal(deriveProfile([...liked, { type: 'unfavorite', song, source: 'button' }]).songs[0].score, 100);
  assert.equal(deriveProfile([{ type: 'favorite', song, source: 'button' }, { type: 'unfavorite', song, source: 'button' }]).songs.length, 0);
});

test('等待时的垫歌行为不改变画像或稳定记忆', () => {
  const song = { title: '垫歌', artist: '垫歌者' };
  const events = [
    { type: 'play_completed', song, source: 'filler', listenRatio: 1 },
    { type: 'skip', song, source: 'filler', listenedSec: 2 },
    { type: 'favorite', song, source: 'filler' },
    { type: 'memory_inferred', source: 'filler', key: 'genre', value: '爵士', evidenceId: '1' },
    { type: 'memory_inferred', source: 'filler', key: 'genre', value: '爵士', evidenceId: '2' },
  ];
  assert.equal(signalWeight(events[0]), 0);
  const profile = deriveProfile(events);
  assert.deepEqual(profile.songs, []);
  assert.deepEqual(profile.artists, []);
  assert.deepEqual(profile.memories, { stable: [], pending: [] });
});

test('朋友推荐的歌：放了、听完、跳过、重听都不进画像，只有自己点的红心 / 不喜欢算', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createEventStore } = await import('../server/events.js');
  const store = createEventStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-')), 'e.jsonl'), { scene: () => 'work' });
  const song = { title: '朋友的歌', artist: '朋友的歌手' };
  for (const event of [
    { type: 'play_started', song, discoveryType: 'friend', source: 'player' },
    { type: 'play_completed', song, discoveryType: 'friend', listenRatio: 1, source: 'player' },
    { type: 'replay', song, discoveryType: 'friend', source: 'player' },
    { type: 'skip', song: { title: '另一首', artist: '另一位' }, discoveryType: 'friend', listenedSec: 2, source: 'player' },
  ]) store.append(event);
  const passive = store.read();
  assert.ok(passive.every((e) => e.discoveryType === 'friend'), '事件落盘时带着来源');
  assert.deepEqual(deriveProfile(passive).songs, []);
  assert.deepEqual(deriveProfile(passive).artists, []);
  store.append({ type: 'favorite', song, discoveryType: 'friend', source: 'button' });
  assert.equal(deriveProfile(store.read()).songs[0].score, 80);
});
