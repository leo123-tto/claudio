import test from 'node:test';
import assert from 'node:assert/strict';

import { episodeCandidates } from '../server/episode-candidates.js';
import {
  filterCandidates,
  orderByPlayOrder,
  pickDiverse,
  rankCandidates,
  selectDiverseShortlist,
} from '../server/recommendation.js';

const pool = [{ title: '候选歌', artist: '候选歌手' }];

test('聊天和控制节目绝不从发现池补歌', () => {
  assert.deepEqual(episodeCandidates({ intent: 'chat', play: [] }, pool), []);
  assert.deepEqual(episodeCandidates({ intent: 'control', play: [] }, pool), []);
});

test('推荐节目才使用模型候选和发现池兜底', () => {
  const direct = { title: '模型歌', artist: '模型歌手' };
  const candidates = episodeCandidates({ intent: 'recommend', play: [direct] }, pool);
  assert.equal(candidates[0].title, '模型歌');
  assert.equal(candidates[0].playOrder, 0);
  assert.equal(candidates[1].title, '候选歌');
  assert.equal(candidates[1].discoveryType, 'adjacent');
});

test('发现池里的流行、新风格和老歌按发现位进入候选', () => {
  const mixed = [
    { title: '热歌', artist: '甲', lane: 'popular' },
    { title: '相似', artist: '乙' },
  ];
  const candidates = episodeCandidates({ intent: 'recommend', play: [] }, mixed);
  assert.equal(candidates[0].lane, 'popular');
  assert.equal(candidates[0].discoveryType, 'explore');
  assert.equal(candidates[0].score, 58);
  assert.equal(candidates[1].discoveryType, 'adjacent');
  assert.equal(candidates[1].lane, undefined);
});

test('模型候选记下自己在 play[] 里的位置，发现池兜底的没有位置，原数组不被改', () => {
  const play = [
    { title: '甲', artist: 'A' },
    { title: '乙', artist: 'B' },
    { title: '丙', artist: 'C' },
  ];
  const candidates = episodeCandidates({ intent: 'recommend', play }, pool);
  assert.deepEqual(candidates.slice(0, 3).map((item) => item.playOrder), [0, 1, 2]);
  assert.equal('playOrder' in candidates[3], false);
  assert.equal('playOrder' in play[0], false);
});

test('播放顺序跟口播提歌的先后一致，不被打分排序和桥接优先挤掉', () => {
  // 口播先提林忆莲的老歌，再提气质秋；打分把气质秋排前，pickDiverse 又把桥接歌放最前
  const play = [
    { title: '老歌', artist: '林忆莲', lane: 'classic', discoveryType: 'explore', score: 70 },
    { title: '气质秋', artist: '某乐队', discoveryType: 'adjacent', score: 90 },
    { title: '热歌', artist: '热门歌手', lane: 'popular', discoveryType: 'explore', score: 50 },
  ];
  const ranked = rankCandidates(filterCandidates(episodeCandidates({ intent: 'recommend', play }, [])));
  assert.equal(ranked[0].title, '气质秋');
  const shortlist = selectDiverseShortlist(ranked, 'classic', 6);
  // 解析直链后候选变成可播歌，位置跟着候选走（映射同 server/index.js 的 assemblePlayable）
  const playable = shortlist.map((candidate) => ({
    title: candidate.title,
    candidate,
    lane: candidate.lane,
    discoveryType: candidate.discoveryType,
    playOrder: candidate.playOrder,
  }));
  const picked = pickDiverse(playable, 'classic');
  assert.deepEqual(picked.map((item) => item.title), ['气质秋', '老歌']);
  assert.deepEqual(orderByPlayOrder(picked).map((item) => item.title), ['老歌', '气质秋']);
});
