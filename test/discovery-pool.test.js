import test from 'node:test';
import assert from 'node:assert/strict';

import { chartsForRefresh, collectPoolSongs } from '../server/discovery.js';

test('每天只轮换一个新风格榜和一个老歌榜，热歌榜保持不动', () => {
  const first = chartsForRefresh(new Date(2026, 0, 1));
  const second = chartsForRefresh(new Date(2026, 0, 2));
  assert.equal(first.find((item) => item.lane === 'popular').id, '3778678');
  assert.equal(second.find((item) => item.lane === 'popular').id, '3778678');
  assert.notEqual(
    first.find((item) => item.lane === 'fresh').id,
    second.find((item) => item.lane === 'fresh').id,
  );
  assert.equal(first.length, 3);
});

test('发现池合并时排除收藏原曲，并给榜单标上发现轨', () => {
  const songs = collectPoolSongs({
    similar: [
      { title: '相似', artist: '甲' },
      { title: '收藏', artist: '乙' },
    ],
    charts: [
      { lane: 'popular', source: 'netease-hot', songs: [{ title: '热歌', artist: '丙' }, { title: '收藏', artist: '乙' }] },
      { lane: 'classic', source: 'netease-classic-zh', songs: [{ title: '老歌', artist: '丁' }] },
    ],
    favorites: [{ title: '收藏', artist: '乙' }],
    existing: [{ title: '旧池', artist: '戊', source: 'netease-similar' }],
  });

  assert.deepEqual(songs.map((item) => item.title), ['相似', '热歌', '老歌', '旧池']);
  assert.equal(songs[0].lane, undefined);
  assert.equal(songs[0].source, 'netease-similar');
  assert.equal(songs[1].lane, 'popular');
  assert.equal(songs[1].source, 'netease-hot');
  assert.equal(songs[2].lane, 'classic');
  assert.equal(songs[3].lane, undefined);
});
