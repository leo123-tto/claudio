import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHandoffStore } from '../server/handoff.js';
import { deviceIdentity, deviceName } from '../web/handoff.js';

const song = (title) => ({ url: `https://m.126.net/${title}.mp3`, meta: { id: title, title, artist: '甲' } });
const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-handoff-')), 'playback.json');

test('设备名按浏览器和系统自动认，设备号记在本机', () => {
  assert.equal(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'), 'Mac Chrome');
  assert.equal(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'), 'iPhone Safari');
  assert.equal(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'), 'Mac Safari');
  assert.equal(deviceName(''), '另一台设备');
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const a = deviceIdentity({ storage, makeId: () => 'dev-1' });
  const b = deviceIdentity({ storage, makeId: () => 'dev-2' });
  assert.equal(a.id, 'dev-1');
  assert.equal(b.id, 'dev-1');
});

test('一台开始响就叫别的停；被叫停那台的暂停上报不改进度', () => {
  let t = 1_000_000;
  const store = createHandoffStore(file(), { now: () => t });
  const mac = { deviceId: 'mac', deviceName: 'Mac Chrome' };
  const phone = { deviceId: 'phone', deviceName: 'iPhone Safari' };
  assert.equal(store.report({ ...mac, playing: true, song: song('A'), position: 10, queue: [song('B')] }).taken, true);
  t += 5000;
  assert.equal(store.report({ ...mac, playing: true, song: song('A'), position: 15 }).taken, false);
  t += 2000;
  assert.equal(Math.round(store.position()), 17);
  assert.equal(store.report({ ...phone, playing: true, song: song('A'), position: 17 }).taken, true);
  t += 300;
  assert.equal(store.report({ ...mac, playing: false, song: song('A'), position: 17.3 }).ignored, true);
  assert.equal(store.get().deviceId, 'phone');
  assert.equal(store.get().playing, true);
});

test('暂停后进度留着，重启（重新读文件）也不丢，接着放时不当在响', () => {
  let t = 2_000_000;
  const f = file();
  const store = createHandoffStore(f, { now: () => t });
  store.report({ deviceId: 'mac', deviceName: 'Mac Chrome', playing: true, song: song('A'), position: 50, queue: [song('B'), song('C')] });
  t += 10_000;
  store.report({ deviceId: 'mac', deviceName: 'Mac Chrome', playing: false, song: song('A'), position: 60 });
  t += 3_600_000;
  assert.equal(store.position(), 60);
  const reopened = createHandoffStore(f, { now: () => t });
  const state = reopened.get();
  assert.equal(state.song.meta.title, 'A');
  assert.equal(state.position, 60);
  assert.equal(state.playing, false);
  assert.deepEqual(state.queue.map((q) => q.meta.title), ['B', 'C']);
});

test('在响的设备 30 秒没报就当它停了：别的设备暂停上报能更新，进度也不再往前推', () => {
  let t = 3_000_000;
  const store = createHandoffStore(file(), { now: () => t });
  store.report({ deviceId: 'mac', playing: true, song: song('A'), position: 0 });
  t += 120_000;
  assert.equal(store.position(), 30);
  assert.equal(store.report({ deviceId: 'phone', playing: false, song: song('B'), position: 5 }).ignored, undefined);
  assert.equal(store.get().song.meta.title, 'B');
});
