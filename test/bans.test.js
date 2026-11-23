import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { addBan, createBanStore, removeBan, songIdentity } from '../server/bans.js';

test('禁播按歌名和歌手去重，撤掉后就不再挡住', () => {
  const song = { title: ' 七里香 ', artist: '周杰伦' };
  const added = addBan([], song);
  assert.equal(added.length, 1);
  assert.equal(addBan(added, { title: '七里香', artist: '周杰伦' }).length, 1);
  assert.equal(removeBan(added, song).length, 0);
  assert.equal(songIdentity(song), '七里香|周杰伦');
});

test('历史不喜欢只播种一次，之后可以单条恢复', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-bans-'));
  const store = createBanStore(path.join(dir, 'bans.json'));
  const seeded = store.ensureSeeded([
    { title: '旧歌', artist: '甲' },
    { title: '旧歌', artist: '甲' },
  ]);
  assert.deepEqual(seeded.map((item) => item.title), ['旧歌']);
  store.ensureSeeded([{ title: '不该再种', artist: '乙' }]);
  assert.deepEqual(store.list().map((item) => item.title), ['旧歌']);
  store.remove({ title: '旧歌', artist: '甲' });
  assert.equal(store.list().length, 0);
  store.add({ title: '新禁', artist: '丙' });
  assert.equal(store.list()[0].title, '新禁');
  fs.rmSync(dir, { recursive: true, force: true });
});
