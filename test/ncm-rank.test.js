import test from 'node:test';
import assert from 'node:assert/strict';

import { rankHits } from '../server/ncm.js';
import { parseSongFacts } from '../server/song-meta.js';

test('只认点名歌手的版本：原版排第一，Live、DJ 版往后，翻唱和别人的歌不要', () => {
  const hits = [
    { id: 1, title: '晴天 (翻自 周杰伦)', artist: '某翻唱' },
    { id: 2, title: '晴天 (Live)', artist: '周杰伦', album: '地表最强演唱会' },
    { id: 3, title: '晴天DJ版', artist: '周杰伦' },
    { id: 4, title: '晴天', artist: '周杰伦', album: '叶惠美' },
    { id: 5, title: '晴天娃娃', artist: '别人' },
  ];
  assert.deepEqual(rankHits(hits, { title: '晴天', artist: '周杰伦' }).map((hit) => hit.id), [4, 2, 3]);
});

test('网易云没有原唱时一首都不给，不拿翻唱顶替', () => {
  const hits = [
    { id: 1, title: '晴天(深情版)', artist: 'Lucky小爱' },
    { id: 2, title: '晴天', artist: 'Jay' },
    { id: 3, title: '晴天 (原唱 周杰伦)', artist: 'RyaVocal' },
  ];
  assert.deepEqual(rankHits(hits, { title: '晴天', artist: '周杰伦' }), []);
});

test('合唱的歌手写全写半都认；各种「xx版」没点名就往后排', () => {
  const hits = [
    { id: 1, title: '甲乙丙丁 (合唱版)', artist: '李佳薇 / 张新成' },
    { id: 2, title: 'Believer', artist: 'Imagine Dragons / Lil Wayne' },
    { id: 3, title: '甲乙丙丁 (粤语版)', artist: '李佳薇' },
    { id: 4, title: '甲乙丙丁', artist: '李佳薇' },
  ];
  assert.deepEqual(rankHits(hits, { title: '甲乙丙丁', artist: '李佳薇' }).map((hit) => hit.id), [4, 1, 3]);
  assert.equal(rankHits(hits, { title: 'Believer', artist: 'Imagine Dragons' })[0].id, 2);
});

test('全角括号、大小写不影响歌名匹配；没点名的 Live 往后排', () => {
  const hits = [
    { id: 1, title: '别的歌', artist: '李佳薇' },
    { id: 2, title: '甲乙丙丁（你我怎么两清）', artist: '李佳薇' },
  ];
  assert.equal(rankHits(hits, { title: '甲乙丙丁 (你我怎么两清)', artist: '李佳薇' })[0].id, 2);
  const live = [
    { id: 1, title: 'Believer', artist: 'Imagine Dragons' },
    { id: 2, title: 'Believer (Live)', artist: 'Imagine Dragons' },
  ];
  assert.deepEqual(rankHits(live, { title: 'Believer', artist: 'Imagine Dragons' }).map((hit) => hit.id), [1, 2]);
});

test('同分时保持网易云原顺序', () => {
  const hits = [{ id: 1, title: 'A', artist: 'x' }, { id: 2, title: 'B', artist: 'y' }];
  assert.deepEqual(rankHits(hits, { title: '', artist: '' }).map((hit) => hit.id), [1, 2]);
});

test('详情里带封面就转 https 并要 600 方图，没有就留空', () => {
  const facts = parseSongFacts({ songs: [{ al: { picUrl: 'http://p1.music.126.net/abc/123.jpg' } }] });
  assert.equal(facts.cover, 'https://p1.music.126.net/abc/123.jpg?param=600y600');
  assert.equal(parseSongFacts({ songs: [{}] }).cover, '');
});
