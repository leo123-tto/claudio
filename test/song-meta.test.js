import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createFactStore, parseSongFacts } from '../server/song-meta.js';

test('年份可从时间戳或四位年份来，曲风最多三个，没有就不编', () => {
  const dated = parseSongFacts({
    songs: [{ publishTime: 1143849600000, tags: ['流行', '华语', '抒情', '多余'] }],
  });
  assert.equal(dated.year, 2006);
  assert.equal(dated.genre, '流行 / 华语 / 抒情');

  const yearOnly = parseSongFacts({ songs: [{ publishTime: 1998 }] });
  assert.equal(yearOnly.year, 1998);
  assert.equal(yearOnly.genre, '');

  const wiki = parseSongFacts({ songs: [{}] }, { tags: [{ name: '爵士' }] });
  assert.equal(wiki.year, null);
  assert.equal(wiki.genre, '爵士');

  const blocks = parseSongFacts({ songs: [{ publishTime: 1143849600000 }] }, {
    data: {
      blocks: [{
        creatives: [
          {
            uiElement: { mainTitle: { title: '曲风' } },
            resources: [{ uiElement: { mainTitle: { title: '流行' } } }],
          },
          {
            uiElement: { mainTitle: { title: '语种' }, textLinks: [{ text: '华语' }] },
          },
        ],
      }],
    },
  });
  assert.equal(blocks.year, 2006);
  assert.equal(blocks.genre, '流行 / 华语');
});

test('曲风年份按歌曲记下，空的不写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-facts-'));
  const store = createFactStore(path.join(dir, 'facts.json'));
  store.remember({ id: 7, title: '七里香', artist: '周杰伦', year: 2004, genre: '流行' });
  store.remember({ title: '没有资料', artist: '佚名' });
  assert.deepEqual(store.lookup({ id: 7 }), {
    title: '七里香', artist: '周杰伦', year: 2004, genre: '流行',
  });
  assert.deepEqual(store.lookup({ title: '没有资料', artist: '佚名' }), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('合集精选的发行时间不能充当原曲年份，正常专辑仍可显示年份', () => {
  for (const album of [
    { name: '歌手精选' }, { name: 'Greatest Hits' }, { name: 'The Best of Singer' },
    { name: 'Collection 2020' }, { name: '原名', type: '精选集' }, { name: '经典合集' },
  ]) {
    const facts = parseSongFacts({ songs: [{ publishTime: 2020, al: album }] });
    assert.equal(facts.year, null, album.name);
  }
  assert.equal(parseSongFacts({ songs: [{ publishTime: 2004, al: { name: '七里香', type: '专辑' } }] }).year, 2004);
});
