import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePlaylistTracks } from '../server/ncm.js';

test('把网易云歌单歌曲整理成口味曲库需要的歌名和歌手', () => {
  const songs = normalizePlaylistTracks({
    songs: [
      { id: 1, name: 'Moonlit Demo', ar: [{ name: 'Artist One' }] },
      { id: 2, name: 'Second Signal', ar: [{ name: 'Artist Two' }, { name: 'Artist Three' }] },
      { id: 3, name: '', ar: [{ name: '无效项' }] },
    ],
  });
  assert.deepEqual(songs, [
    { id: 1, title: 'Moonlit Demo', artist: 'Artist One' },
    { id: 2, title: 'Second Signal', artist: 'Artist Two / Artist Three' },
  ]);
});
