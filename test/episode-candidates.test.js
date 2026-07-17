import test from 'node:test';
import assert from 'node:assert/strict';

import { episodeCandidates } from '../server/episode-candidates.js';

const pool = [{ title: '候选歌', artist: '候选歌手' }];

test('聊天和控制节目绝不从发现池补歌', () => {
  assert.deepEqual(episodeCandidates({ intent: 'chat', play: [] }, pool), []);
  assert.deepEqual(episodeCandidates({ intent: 'control', play: [] }, pool), []);
});

test('推荐节目才使用模型候选和发现池兜底', () => {
  const direct = { title: '模型歌', artist: '模型歌手' };
  const candidates = episodeCandidates({ intent: 'recommend', play: [direct] }, pool);
  assert.equal(candidates[0], direct);
  assert.equal(candidates[1].title, '候选歌');
  assert.equal(candidates[1].discoveryType, 'adjacent');
});
