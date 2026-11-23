import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePlaylistTracks } from '../server/ncm.js';

test('把网易云歌单歌曲整理成口味曲库需要的歌名和歌手', () => {
  const songs = normalizePlaylistTracks({
    songs: [
      { id: 1, name: '群青', ar: [{ name: 'YOASOBI' }] },
      { id: 2, name: 'superlit', ar: [{ name: 'gnash' }, { name: 'Imad Royal' }] },
      { id: 3, name: '', ar: [{ name: '无效项' }] },
    ],
  });
  assert.deepEqual(songs, [
    { id: 1, title: '群青', artist: 'YOASOBI' },
    { id: 2, title: 'superlit', artist: 'gnash / Imad Royal' },
  ]);
});
