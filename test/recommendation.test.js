import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRecommendationBrief,
  filterCandidates,
  rankCandidates,
  parseFavoriteSongs,
  selectOpeningFingerprint,
} from '../server/recommendation.js';

test('能把喜欢曲库解析成结构化歌曲，不受标题中的连字符影响', () => {
  const songs = parseFavoriteSongs('# 曲库\n- Demo Track - Alternate Title — Example Artist / Guest\n- 星河样本 — Sample Duo');
  assert.deepEqual(songs, [
    { title: 'Demo Track - Alternate Title', artist: 'Example Artist / Guest' },
    { title: '星河样本', artist: 'Sample Duo' },
  ]);
});

test('自动推荐默认是 10/65/25 的发现模式，且只带用户最近表达', () => {
  const brief = buildRecommendationBrief({
    mode: 'discovery',
    messages: [
      { role: 'assistant', content: '固定套话' },
      { role: 'user', content: '今晚想听松弛一点的' },
    ],
    recentFingerprints: [],
    rng: () => 0,
  });

  assert.deepEqual(brief.mix, { familiar: 10, adjacent: 65, explore: 25 });
  assert.deepEqual(brief.recentUserMessages, ['今晚想听松弛一点的']);
  assert.ok(brief.openingFingerprint.id);
});

test('起手指纹避开最近用过的模板', () => {
  const picked = selectOpeningFingerprint(['soft-zh-familiar'], () => 0);
  assert.notEqual(picked.id, 'soft-zh-familiar');
});

test('连续 30 次启动不会复用最近 6 次的起手指纹', () => {
  let seed = 17;
  const rng = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  const history = [];
  for (let index = 0; index < 30; index += 1) {
    const picked = selectOpeningFingerprint(history.slice(-6), rng);
    assert.equal(history.slice(-6).includes(picked.id), false);
    history.push(picked.id);
  }
  assert.ok(new Set(history).size >= 7);
});

test('自动推荐硬过滤收藏原曲、近期曲目、不喜欢曲目', () => {
  const candidates = [
    { title: '收藏歌', artist: '甲' },
    { title: '刚放过', artist: '乙' },
    { title: '不喜欢', artist: '丙' },
    { title: '新发现', artist: '丁' },
  ];
  const result = filterCandidates(candidates, {
    favoriteSongs: [{ title: '收藏歌', artist: '甲' }],
    recentSongs: [{ title: '刚放过', artist: '乙' }],
    dislikedSongs: [{ title: '不喜欢', artist: '丙' }],
    explicitRequest: false,
  });

  assert.deepEqual(result.map((item) => item.title), ['新发现']);
});

test('最近五位歌手受到强降权，但明确点歌仍可播放收藏曲', () => {
  const candidates = [
    { title: '同歌手新歌', artist: '甲', score: 80 },
    { title: '冷门新人', artist: '丁', score: 60 },
  ];
  const ranked = rankCandidates(candidates, { recentArtists: ['甲', '乙', '丙'] });
  assert.equal(ranked[0].title, '冷门新人');

  const explicit = filterCandidates([{ title: '收藏歌', artist: '甲' }], {
    favoriteSongs: [{ title: '收藏歌', artist: '甲' }],
    explicitRequest: true,
  });
  assert.equal(explicit.length, 1);
});
