import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateStore } from '../server/state.js';

test('state爱心去重并可撤销，旧未知来源和其他来源保留', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ favs: [{ title: '旧歌', artist: '甲' }] }));
  const state = createStateStore(file);
  state.addFav({ title: 'A', artist: '乙' });
  state.addFav({ title: 'a', artist: '乙' });
  assert.equal(state.recentFavs().length, 2);
  state.addFav({ title: 'B', artist: '丙', source: 'chat' });
  state.addFav({ title: 'B', artist: '丙' });
  state.removeFav({ title: 'B', artist: '丙' });
  state.removeFav({ title: 'A', artist: '乙' });
  state.removeFav({ title: '旧歌', artist: '甲' });
  const remaining = createStateStore(file).recentFavs();
  assert.deepEqual(remaining.map((song) => song.title), ['旧歌', 'B']);
  assert.deepEqual(remaining.find((song) => song.title === 'B').sources, ['chat']);
});

test('旧空收藏字段可继续收藏，消息和播放历史仍能跨重启读取', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-state-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ favs: null }));
  const store = createStateStore(file);
  store.addFav({ title: 'A', artist: '甲' });
  store.addMessage('user', '虚构测试留言');
  store.addPlay({ title: 'B', artist: '乙' });
  const reloaded = createStateStore(file);
  assert.equal(reloaded.recentFavs().length, 1);
  assert.equal(reloaded.recentMessages()[0].content, '虚构测试留言');
  assert.equal(reloaded.recentPlays()[0].title, 'B');
});
