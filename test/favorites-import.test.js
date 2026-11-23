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
      { title: '群青', artist: 'YOASOBI' },
      { title: 'Monday', artist: '窦靖童' },
    ],
    [
      { title: ' 群青 ', artist: 'yoasobi' },
      { title: 'Are You Lost', artist: 'Park Bird' },
    ],
  );

  assert.deepEqual(merged.songs, [
    { title: '群青', artist: 'YOASOBI' },
    { title: 'Monday', artist: '窦靖童' },
    { title: 'Are You Lost', artist: 'Park Bird' },
  ]);
  assert.equal(merged.added, 1);
  assert.equal(merged.duplicates, 1);
});

test('喜欢曲库 Markdown 包含可读说明和准确曲数', () => {
  const markdown = renderFavoritesMarkdown([
    { title: '群青', artist: 'YOASOBI' },
    { title: 'Are You Lost', artist: 'Park Bird' },
  ]);
  assert.match(markdown, /共 2 首/);
  assert.match(markdown, /- 群青 — YOASOBI/);
  assert.match(markdown, /- Are You Lost — Park Bird/);
});

test('导入歌单会合并到用户自己的文件并返回统计', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-favorites-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'user', 'favorites.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderFavoritesMarkdown([{ title: '群青', artist: 'YOASOBI' }]));

  const store = createFavoritesStore({
    file,
    fetchPlaylistTracks: async (playlistId) => {
      assert.equal(playlistId, '9988');
      return [
        { title: '群青', artist: 'YOASOBI' },
        { title: 'Monday', artist: '窦靖童' },
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
  assert.match(fs.readFileSync(file, 'utf8'), /- Monday — 窦靖童/);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('单首喜欢会写进曲库，重复再说不会追加', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-favorites-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'user', 'favorites.md');
  const store = createFavoritesStore({ file, fetchPlaylistTracks: async () => [] });

  const first = store.rememberSong({ title: ' 群青 ', artist: 'YOASOBI' });
  const second = store.rememberSong({ title: '群青', artist: 'yoasobi' });

  assert.equal(first.added, 1);
  assert.equal(first.total, 1);
  assert.equal(second.added, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(store.summary().total, 1);
  assert.match(fs.readFileSync(file, 'utf8'), /- 群青 — YOASOBI/);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('取消爱心只移除按钮来源，导入和聊天来源跨重启保留', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-fav-sources-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'favorites.md');
  const options = { file, fetchPlaylistTracks: async () => [{ title: 'A', artist: '甲' }] };
  const store = createFavoritesStore(options);
  await store.importPlaylist('123');
  store.rememberSong({ title: 'A', artist: '甲' }, { source: 'button' });
  store.rememberSong({ title: 'B', artist: '乙' }, { source: 'chat' });
  store.rememberSong({ title: 'B', artist: '乙' }, { source: 'button' });
  store.rememberSong({ title: 'C', artist: '丙' }, { source: 'button' });
  const reloaded = createFavoritesStore(options);
  assert.equal(reloaded.isFavorite({ title: 'A', artist: '甲' }), true);
  assert.equal(reloaded.forgetSong({ title: 'A', artist: '甲' }).removed, 1);
  assert.equal(reloaded.forgetSong({ title: 'B', artist: '乙' }).removed, 1);
  assert.equal(reloaded.forgetSong({ title: 'C', artist: '丙' }).deleted, 1);
  assert.equal(reloaded.isFavorite({ title: 'A', artist: '甲' }), false);
  assert.deepEqual(reloaded.list(), [
    { title: 'A', artist: '甲', sources: ['import'] },
    { title: 'B', artist: '乙', sources: ['chat'] },
  ]);
  assert.equal(createFavoritesStore(options).summary().total, 2);
});

test('旧曲库来源未知，取消新点的爱心也不会误删旧资料', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-fav-legacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'favorites.md');
  fs.writeFileSync(file, '- 旧歌 — 旧歌手\n');
  const store = createFavoritesStore({ file, fetchPlaylistTracks: async () => [] });
  store.rememberSong({ title: '旧歌', artist: '旧歌手' });
  store.forgetSong({ title: '旧歌', artist: '旧歌手' });
  assert.deepEqual(store.read(), [{ title: '旧歌', artist: '旧歌手', sources: ['unknown'] }]);
  assert.match(fs.readFileSync(file, 'utf8'), /旧歌 — 旧歌手/);
});

