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
