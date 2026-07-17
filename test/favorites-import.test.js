import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createFavoritesStore,
  mergeFavoriteSongs,
  parsePlaylistId,
  renderFavoritesMarkdown,
} from '../server/favorites.js';

test('只从网易云歌单链接或纯数字中提取歌单 ID', () => {
  assert.equal(parsePlaylistId('123456789'), '123456789');
  assert.equal(parsePlaylistId('https://music.163.com/playlist?id=123456789'), '123456789');
  assert.equal(parsePlaylistId('https://music.163.com/#/playlist?id=123456789&userid=1'), '123456789');
  assert.throws(() => parsePlaylistId('https://example.com/playlist?id=123456789'), /网易云/);
  assert.throws(() => parsePlaylistId('123abc'), /歌单/);
});

test('合并歌单时按歌名和歌手去重，同时保留原有顺序', () => {
  const merged = mergeFavoriteSongs(
    [
      { title: '星图', artist: 'Example Duo' },
      { title: '晨雾', artist: 'Sample Singer' },
    ],
    [
      { title: ' 星图 ', artist: 'example duo' },
      { title: '未知海岸', artist: 'Demo Bird' },
    ],
  );

  assert.deepEqual(merged.songs, [
    { title: '星图', artist: 'Example Duo' },
    { title: '晨雾', artist: 'Sample Singer' },
    { title: '未知海岸', artist: 'Demo Bird' },
  ]);
  assert.equal(merged.added, 1);
  assert.equal(merged.duplicates, 1);
});

test('喜欢曲库 Markdown 包含可读说明和准确曲数', () => {
  const markdown = renderFavoritesMarkdown([
    { title: '星图', artist: 'Example Duo' },
    { title: '未知海岸', artist: 'Demo Bird' },
  ]);
  assert.match(markdown, /共 2 首/);
  assert.match(markdown, /- 星图 — Example Duo/);
  assert.match(markdown, /- 未知海岸 — Demo Bird/);
});

test('导入歌单会合并到用户自己的文件并返回统计', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-favorites-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'user', 'favorites.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderFavoritesMarkdown([{ title: '星图', artist: 'Example Duo' }]));

  const store = createFavoritesStore({
    file,
    fetchPlaylistTracks: async (playlistId) => {
      assert.equal(playlistId, '9988');
      return [
        { title: '星图', artist: 'Example Duo' },
        { title: '晨雾', artist: 'Sample Singer' },
      ];
    },
  });
  const result = await store.importPlaylist('https://music.163.com/#/playlist?id=9988');

  assert.deepEqual(result, {
    playlistId: '9988',
    received: 2,
    added: 1,
    duplicates: 1,
    total: 2,
  });
  assert.match(fs.readFileSync(file, 'utf8'), /- 晨雾 — Sample Singer/);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});
