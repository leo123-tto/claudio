import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRecommendationBrief,
  filterCandidates,
  laneOf,
  nextDiscoveryLane,
  orderByPlayOrder,
  parseFavoriteSongs,
  pickDiverse,
  rankCandidates,
  sampleDiscoveryPool,
  selectDiverseShortlist,
  selectOpeningFingerprint,
} from '../server/recommendation.js';

test('能把喜欢曲库解析成结构化歌曲，不受标题中的连字符影响', () => {
  const songs = parseFavoriteSongs('# 曲库\n- Meant To Be - 命中注定 — Arc North / Krista\n- 群青 — YOASOBI');
  assert.deepEqual(songs, [
    { title: 'Meant To Be - 命中注定', artist: 'Arc North / Krista' },
    { title: '群青', artist: 'YOASOBI' },
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

test('禁播挡住自动推荐，点名或撤销后仍可再放', () => {
  const banned = { title: '禁歌', artist: '戊' };
  const kept = { title: '新歌', artist: '己' };
  const blocked = filterCandidates([banned, kept], {
    bannedSongs: [banned],
    dislikedSongs: [],
    explicitRequest: false,
  });
  assert.deepEqual(blocked.map((item) => item.title), ['新歌']);

  const named = filterCandidates([banned], {
    bannedSongs: [banned],
    explicitRequest: true,
  });
  assert.equal(named.length, 1);

  const restored = filterCandidates([{ title: '曾经不喜欢', artist: '庚' }], {
    dislikedSongs: [],
    bannedSongs: [],
    explicitRequest: false,
  });
  assert.equal(restored.length, 1);
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

test('发现位按流行、新风格、老内容轮换', () => {
  assert.equal(nextDiscoveryLane([]), 'popular');
  assert.equal(nextDiscoveryLane(['popular']), 'fresh');
  assert.equal(nextDiscoveryLane(['popular', 'fresh']), 'classic');
  assert.equal(nextDiscoveryLane(['classic']), 'popular');
  assert.equal(buildRecommendationBrief({ recentLanes: ['fresh'] }).discoveryLane, 'classic');
});

test('可播结果里保留一首桥接，再留一首本期发现位', () => {
  const songs = [
    { title: '桥接甲', artist: '甲', discoveryType: 'adjacent' },
    { title: '桥接乙', artist: '乙', discoveryType: 'adjacent', score: 99 },
    { title: '老歌', artist: '丙', lane: 'classic', discoveryType: 'explore' },
    { title: '热歌', artist: '丁', lane: 'popular' },
  ];
  const picked = pickDiverse(songs, 'classic');
  assert.deepEqual(picked.map((item) => item.title), ['桥接甲', '老歌']);
  assert.equal(picked.filter((item) => laneOf(item) === 'bridge').length, 1);

  const fallback = pickDiverse([
    { title: '桥', artist: '甲' },
    { title: '热', artist: '乙', lane: 'popular' },
  ], 'classic');
  assert.equal(fallback[1].lane, 'popular');
});

test('排序靠前的桥接歌不会把发现位挤出待解析名单', () => {
  const bridges = Array.from({ length: 8 }, (_, index) => ({
    title: `桥${index}`, artist: '甲', discoveryType: 'adjacent',
  }));
  const classic = { title: '老歌', artist: '乙', lane: 'classic' };
  const list = selectDiverseShortlist([...bridges, classic], 'classic', 6);
  assert.equal(list.some((item) => item.title === '老歌'), true);
  assert.equal(list.some((item) => laneOf(item) === 'bridge'), true);
  assert.equal(list.length <= 6, true);
});

test('候选池按本期发现位抽样，而不是只拿列表开头', () => {
  const songs = [
    { title: '桥', artist: '甲' },
    { title: '热', artist: '乙', lane: 'popular' },
    { title: '新', artist: '丙', lane: 'fresh' },
    { title: '老', artist: '丁', lane: 'classic' },
  ];
  const sampled = sampleDiscoveryPool(songs, 'classic', { rng: () => 0 });
  assert.equal(sampled.some((item) => item.lane === 'classic'), true);
  assert.equal(sampled.some((item) => !item.lane), true);
});

test('按模型 play[] 的先后排播放顺序，没有位置的排最后且保持原顺序', () => {
  const songs = [
    { title: '池甲' },
    { title: '桥', playOrder: 2 },
    { title: '池乙' },
    { title: '发现', playOrder: 0 },
  ];
  assert.deepEqual(orderByPlayOrder(songs).map((item) => item.title), ['发现', '桥', '池甲', '池乙']);
  assert.deepEqual(songs.map((item) => item.title), ['池甲', '桥', '池乙', '发现']);
  assert.deepEqual(orderByPlayOrder([{ title: '乙' }, { title: '甲' }]).map((item) => item.title), ['乙', '甲']);
  assert.deepEqual(orderByPlayOrder([]), []);
});

test('桥接歌被 pickDiverse 排在前面时，播放顺序仍按口播先后', () => {
  const picked = pickDiverse([
    { title: '气质秋', artist: '某乐队', discoveryType: 'adjacent', playOrder: 1 },
    { title: '林忆莲老歌', artist: '林忆莲', lane: 'classic', discoveryType: 'explore', playOrder: 0 },
  ], 'classic');
  assert.deepEqual(picked.map((item) => item.title), ['气质秋', '林忆莲老歌']);
  assert.deepEqual(orderByPlayOrder(picked).map((item) => item.title), ['林忆莲老歌', '气质秋']);
});
