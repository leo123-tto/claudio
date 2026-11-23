import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-discovery-'));
process.env.CLAUDIO_DATA_DIR = fixture;
process.env.CLAUDIO_RESOURCE_ROOT = fixture;
after(() => fs.rmSync(fixture, { recursive: true, force: true }));
const file = path.join(fixture, 'cache', 'discovery-pool.json');
let moduleId = 0;

function freshCache(lanes = true) {
  return {
    version: 2,
    updatedAt: new Date(Date.now() - 1000).toISOString(),
    songs: Array.from({ length: 38 }, (_, i) => ({
      title: `旧歌${i}`, artist: '旧歌手', source: 'netease-similar',
      ...(lanes ? { lane: 'popular' } : {}),
    })),
  };
}

function fakeTimers() {
  const pending = new Set();
  const scheduled = [];
  const options = {
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, unrefCount: 0, unref() { this.unrefCount++; } };
      pending.add(timer);
      scheduled.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) { pending.delete(timer); },
  };
  return {
    options, pending, scheduled,
    async fire() {
      assert.equal(pending.size, 1);
      const [timer] = pending;
      pending.delete(timer);
      await timer.callback();
    },
  };
}

async function setup(t, { cache, favorites = [] } = {}) {
  fs.rmSync(path.join(fixture, 'cache'), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'user'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'user', 'favorites.md'), favorites.map((title) => `- ${title} — 收藏歌手`).join('\n'));
  if (cache) fs.writeFileSync(file, JSON.stringify(cache));
  const warnings = t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', () => assert.fail('测试不得联网'));
  // 每例独立保存刷新与重试状态，配置始终指向临时目录。
  const discovery = await import(`../server/discovery.js?test=${++moduleId}`);
  const timers = fakeTimers();
  const calls = { search: 0, similar: 0, charts: 0 };
  const state = { offline: false };
  const client = {
    async search() {
      calls.search++;
      if (state.offline) throw new Error('fake offline');
      return [{ id: 'seed' }];
    },
    async similarSongs() {
      calls.similar++;
      if (state.offline) throw new Error('fake offline');
      return [{ title: '相似新歌', artist: '新歌手' }];
    },
    async playlistTracks(id) {
      calls.charts++;
      if (state.offline) throw new Error('fake offline');
      return Array.from({ length: 10 }, (_, i) => ({ title: `${id} 新歌${i}`, artist: '榜单歌手' }));
    },
  };
  return {
    ...discovery, timers, calls, state, client, warnings,
    options: { client, ...timers.options },
    read: () => JSON.parse(fs.readFileSync(file, 'utf8')),
  };
}

test('全部失败不改旧池，30 秒后恢复并写入发现轨', async (t) => {
  const cache = freshCache(false);
  const r = await setup(t, { cache, favorites: ['种子甲', '种子乙', '种子丙', '种子丁'] });
  const original = fs.readFileSync(file, 'utf8');
  r.state.offline = true;
  await assert.rejects(r.ensureDiscoveryPool(r.options), /发现池刷新失败/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  assert.deepEqual(r.calls, { search: 4, similar: 0, charts: 3 });
  assert.equal(r.timers.pending.size, 1);
  assert.equal(r.timers.scheduled[0].delay, 30000);
  assert.equal(r.timers.scheduled[0].unrefCount, 1);
  const warnings = r.warnings.mock.calls.map(call => call.arguments.join(' '));
  assert.equal(warnings.filter(line => line.includes('种子失败')).length, 4);
  assert.equal(warnings.filter(line => line.includes('榜单失败')).length, 3);
  assert.equal(warnings.filter(line => line.includes('30 秒后重试')).length, 1);

  r.state.offline = false;
  await r.timers.fire();
  const healed = r.read();
  assert.equal(healed.version, cache.version);
  assert.notEqual(healed.updatedAt, cache.updatedAt);
  assert.deepEqual([...new Set(healed.songs.map(song => song.lane).filter(Boolean))], ['popular', 'fresh', 'classic']);
  assert.ok(healed.songs.some(song => song.title === cache.songs[0].title));
  assert.equal(r.calls.similar, 4);
  assert.equal(r.timers.pending.size, 0);
});

test('没有旧池时全部失败也不创建缓存', async (t) => {
  const r = await setup(t);
  r.state.offline = true;
  await assert.rejects(r.ensureDiscoveryPool(r.options), /发现池刷新失败/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(r.timers.pending.size, 1);
});

test('部分榜单失败仍写池，并保留失败榜单的旧发现轨', async (t) => {
  const cache = freshCache();
  const r = await setup(t, { cache });
  const failedChart = r.chartsForRefresh().find(chart => chart.lane === 'fresh');
  const oldSong = { title: '失败榜旧歌', artist: '旧歌手', source: failedChart.source, lane: failedChart.lane };
  cache.songs.push(oldSong);
  fs.writeFileSync(file, JSON.stringify(cache));
  const playlistTracks = r.client.playlistTracks;
  r.client.playlistTracks = async (id, options) => {
    if (id === failedChart.id) throw new Error('fake chart failure');
    return playlistTracks(id, options);
  };
  assert.equal((await r.ensureDiscoveryPool({ ...r.options, force: true })).refreshed, true);
  const updated = r.read();
  assert.notEqual(updated.updatedAt, cache.updatedAt);
  assert.deepEqual(updated.songs.find(song => song.title === oldSong.title), oldSong);
  assert.ok(updated.songs.some(song => song.source === 'netease-hot' && song.title.includes('新歌')));
  assert.equal(r.timers.pending.size, 0);
});

for (const hasHit of [false, true]) {
  test(`种子搜索可达（命中=${hasHit}）即算部分成功，相似接口失败不误报全失败`, async (t) => {
    const r = await setup(t, { favorites: ['种子'] });
    r.client.search = async () => hasHit ? [{ id: 'hit' }] : [];
    r.client.similarSongs = async () => { throw new Error('fake similar failure'); };
    r.client.playlistTracks = async () => { throw new Error('fake chart failure'); };
    assert.equal((await r.ensureDiscoveryPool(r.options)).refreshed, true);
    assert.equal(fs.existsSync(file), true);
    assert.equal(r.timers.pending.size, 0);
  });
}

for (const lanes of [false, true]) {
  test(`日期新鲜的池${lanes ? '有发现轨时跳过' : '无发现轨时仍刷新'}`, async (t) => {
    const cache = freshCache(lanes);
    const r = await setup(t, { cache });
    const result = await r.ensureDiscoveryPool(r.options);
    assert.equal(result.refreshed, !lanes);
    assert.equal(r.calls.charts, lanes ? 0 : 3);
    if (lanes) assert.deepEqual(r.read(), cache);
    else assert.ok(r.read().songs.some(song => song.lane));
    assert.equal(r.timers.pending.size, 0);
  });
}

test('并发调用共用在途刷新，即使旧池仍新鲜', async (t) => {
  const r = await setup(t, { cache: freshCache() });
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { reached = resolve; });
  const playlistTracks = r.client.playlistTracks;
  r.client.playlistTracks = async (...args) => {
    reached();
    await gate;
    return playlistTracks(...args);
  };
  const first = r.ensureDiscoveryPool({ ...r.options, force: true });
  const second = r.ensureDiscoveryPool(r.options);
  const third = r.ensureDiscoveryPool({ ...r.options, force: true });
  assert.equal(first, second);
  assert.equal(first, third);
  await started;
  release();
  const results = await Promise.all([first, second, third]);
  assert.equal(results[0], results[1]);
  assert.equal(r.calls.charts, 3);
  assert.equal(r.timers.pending.size, 0);
});

test('只留一个重试，退避翻倍至 10 分钟，成功后回到 30 秒', async (t) => {
  const r = await setup(t);
  r.state.offline = true;
  await assert.rejects(r.ensureDiscoveryPool(r.options));
  await assert.rejects(r.ensureDiscoveryPool({ ...r.options, force: true }));
  assert.equal(r.timers.pending.size, 1);
  assert.equal(r.timers.scheduled.length, 1);
  for (const delay of [60000, 120000, 240000, 480000, 600000, 600000]) {
    await r.timers.fire();
    assert.equal(r.timers.pending.size, 1);
    assert.equal(r.timers.scheduled.at(-1).delay, delay);
    assert.equal(r.timers.scheduled.at(-1).unrefCount, 1);
  }
  r.state.offline = false;
  await r.timers.fire();
  assert.equal(r.timers.pending.size, 0);
  r.state.offline = true;
  await assert.rejects(r.ensureDiscoveryPool({ ...r.options, force: true }));
  assert.equal(r.timers.scheduled.at(-1).delay, 30000);
});

test('主动刷新恢复后取消尚未执行的重试', async (t) => {
  const r = await setup(t);
  r.state.offline = true;
  await assert.rejects(r.ensureDiscoveryPool(r.options));
  assert.equal(r.timers.pending.size, 1);
  r.state.offline = false;
  await r.ensureDiscoveryPool({ ...r.options, force: true });
  assert.equal(r.timers.pending.size, 0);
  assert.equal(r.timers.scheduled.length, 1);
});
