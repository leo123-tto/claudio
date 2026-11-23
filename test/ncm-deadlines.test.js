import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-ncm-deadline-'));
process.env.CLAUDIO_DATA_DIR = fixture;
process.env.CLAUDIO_RESOURCE_ROOT = fixture;
process.env.NCM_COOKIE = 'fake-test-cookie';
after(() => fs.rmSync(fixture, { recursive: true, force: true }));
const ncm = await import('../server/ncm.js');
test.beforeEach(() => ncm.resetRateLimitsForTests());

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}
function hang(signal) {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
const hit = { id: 1, name: 'Test Song', artists: [{ name: 'Test Artist' }] };
const song = { title: hit.name, artist: 'Test Artist' };

const endpoints = [
  ['search', (options) => ncm.search('test', 5, options)],
  ['song URL', (options) => ncm.songUrl(1, 'standard', options)],
  ['song detail', (options) => ncm.songFacts(1, options)],
  ['lyric', (options) => ncm.lyric(1, options)],
  ['similar songs', (options) => ncm.similarSongs(1, options)],
  ['playlist', (options) => ncm.playlistTracks(1, options)],
];
for (const [label, call] of endpoints) {
  test(`NCM ${label} cancels its actual request at 8 seconds`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let requestSignal;
    const pending = call({ fetchFn: (_url, { signal }) => {
      requestSignal = signal;
      return hang(signal);
    } });
    const rejected = assert.rejects(pending, { name: 'TimeoutError' });
    t.mock.timers.tick(7999);
    assert.equal(requestSignal.aborted, false);
    t.mock.timers.tick(1);
    await rejected;
    assert.equal(requestSignal.aborted, true);
  });
}

for (const phase of ['/search', '/song/url/v1', '/song/detail', '/song/wiki/summary']) {
  test(`resolve cancellation during ${phase} is rethrown instead of returning an unplayable song`, async () => {
    const controller = new AbortController();
    const reason = new Error('new program replaces this one');
    const reached = deferred();
    const calls = [];
    const pending = ncm.resolve(song, {
      signal: controller.signal,
      fetchFn: (url, { signal }) => {
        calls.push({ path: url.pathname, signal });
        if (url.pathname === phase) { reached.resolve(); return hang(signal); }
        if (url.pathname === '/search') return json({ result: { songs: [hit] } });
        if (url.pathname === '/song/url/v1') return json({ data: [{ url: 'https://example.test/song.mp3' }] });
        if (url.pathname === '/song/detail') return json({ songs: [{}] });
        assert.fail(`unexpected path ${url.pathname}`);
      },
    });
    const rejected = assert.rejects(pending, (error) => error === reason);
    await reached.promise;
    controller.abort(reason);
    await rejected;
    assert.equal(calls.at(-1).path, phase);
    assert.equal(calls.at(-1).signal.aborted, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
}

test('resolve can skip a failed song while another song remains playable', async () => {
  const failed = ncm.resolve({ title: 'Failed Song', artist: '' }, {
    fetchFn: async () => json({}, 502),
  });
  const playable = ncm.resolve(song, {
    fetchFn: async (url) => {
      if (url.pathname === '/search') return json({ result: { songs: [hit] } });
      if (url.pathname === '/song/url/v1') return json({ data: [{ url: 'https://example.test/song.mp3' }] });
      // 元数据失败不妨碍已找到的歌曲继续。
      return json({}, 502);
    },
  });
  const results = await Promise.all([failed, playable]);
  assert.equal(results[0].playable, false);
  assert.equal(results[1].playable, true);
  assert.equal(results.filter((item) => item.playable).length, 1);
});

test('request timeout can fail one song without turning it into an episode cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal;
  const result = ncm.resolve(song, {
    fetchFn: (_url, { signal }) => { requestSignal = signal; return hang(signal); },
  });
  t.mock.timers.tick(8000);
  assert.equal((await result).playable, false);
  assert.equal(requestSignal.aborted, true);
});

test('wiki best-effort limit aborts the request at 4 seconds and keeps available detail', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reached = deferred();
  let wikiSignal;
  const pending = ncm.songFacts(1, {
    fetchFn: (url, { signal }) => {
      if (url.pathname === '/song/detail') return json({ songs: [{ publishTime: 2001 }] });
      wikiSignal = signal;
      reached.resolve();
      return hang(signal);
    },
  });
  await reached.promise;
  t.mock.timers.tick(3999);
  assert.equal(wikiSignal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal((await pending).year, 2001);
  assert.equal(wikiSignal.aborted, true);
});

test('resolveNext forwards cancellation to its search', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel next search');
  const pending = ncm.resolveNext({ query: 'fake' }, {
    signal: controller.signal,
    fetchFn: (_url, { signal }) => hang(signal),
  });
  const rejected = assert.rejects(pending, (error) => error === reason);
  controller.abort(reason);
  await rejected;
});

test('pre-cancelled NCM operations never start a request', async () => {
  const controller = new AbortController();
  controller.abort();
  const options = {
    signal: controller.signal,
    fetchFn: () => assert.fail('cancelled work must never request'),
  };
  for (const [, call] of endpoints) await assert.rejects(() => call(options), { name: 'AbortError' });
  await assert.rejects(() => ncm.resolve(song, options), { name: 'AbortError' });
  await assert.rejects(() => ncm.resolveNext({ query: 'fake' }, options), { name: 'AbortError' });
});

test('a successful request clears its timer and parent listener', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  let requestSignal;
  await ncm.lyric(1, {
    signal: controller.signal,
    fetchFn: async (_url, { signal }) => { requestSignal = signal; return json({ lrc: { lyric: 'test' } }); },
  });
  t.mock.timers.tick(8000);
  controller.abort();
  assert.equal(requestSignal.aborted, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

function assertRateLimited(error) {
  assert.equal(error.code, 'NCM_RATE_LIMITED');
  assert.match(error.message, /405|操作频繁|busy/);
  return true;
}

test('coolingDown只读检查所有接口的冷却，过期或重置后恢复', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 });
  assert.equal(ncm.coolingDown(), false);
  await assert.rejects(ncm.search('test', 5, { fetchFn: async () => json({}, 405) }), assertRateLimited);
  assert.equal(ncm.coolingDown(), true);
  await ncm.lyric(1, { fetchFn: async () => json({}) });
  assert.equal(ncm.coolingDown(), true, '其他接口成功不清除search冷却');
  t.mock.timers.tick(60000);
  assert.equal(ncm.coolingDown(), false);
  await assert.rejects(ncm.lyric(1, { fetchFn: async () => json({}, 405) }), assertRateLimited);
  assert.equal(ncm.coolingDown(), true);
  ncm.resetRateLimitsForTests();
  assert.equal(ncm.coolingDown(), false);
});

test('NCM keeps the cookie in the header and out of the URL', async () => {
  await ncm.songUrl(1, 'exhigh', { fetchFn: async (url, { headers }) => {
    assert.equal(headers.Cookie, 'fake-test-cookie');
    assert.equal(url.searchParams.has('cookie'), false);
    assert.equal(url.href.includes('fake-test-cookie'), false);
    return json({ data: [] });
  } });
});

test('搜索带登录 cookie：盒子上匿名搜索一律 405（2026-11-23 实测）', async () => {
  await ncm.search('test-with-cookie', 5, { fetchFn: async (url, { headers }) => {
    assert.equal(headers.Cookie, 'fake-test-cookie');
    return json({});
  } });
});

test('405 cools only its pathname and backs off to ten minutes, then success resets it', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  let status = 405;
  const options = { fetchFn: async (url) => {
    calls.push(url.pathname);
    return json({}, url.pathname === '/search' ? status : 200);
  } };
  for (const delay of [60_000, 120_000, 240_000, 480_000, 600_000, 600_000]) {
    await assert.rejects(ncm.search('test', 5, options), assertRateLimited);
    const count = calls.length;
    now += delay - 1;
    await assert.rejects(ncm.search('different query', 1, options), assertRateLimited);
    assert.equal(calls.length, count);
    await ncm.songUrl(1, 'standard', options);
    assert.equal(calls.at(-1), '/song/url/v1');
    assert.equal(calls.length, count + 1);
    now += 1;
  }
  status = 200;
  await ncm.search('test', 5, options);
  status = 405;
  await assert.rejects(ncm.search('test', 5, options), assertRateLimited);
  const count = calls.length;
  now += 59_999;
  await assert.rejects(ncm.search('test', 5, options), assertRateLimited);
  assert.equal(calls.length, count);
  now += 1;
  status = 200;
  await ncm.search('test', 5, options);
  assert.equal(calls.length, count + 1);
});

test('concurrent 405 responses open one sixty-second cooldown', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const gate = deferred();
  const options = { fetchFn: async () => { calls += 1; await gate.promise; return json({}, 405); } };
  const results = Promise.all(Array.from({ length: 8 }, () => assert.rejects(ncm.search('test', 5, options), assertRateLimited)));
  assert.equal(calls, 8);
  gate.resolve();
  await results;
  now += 59_999;
  await assert.rejects(ncm.search('test', 5, options), assertRateLimited);
  assert.equal(calls, 8);
  now += 1;
  await ncm.search('test', 5, { fetchFn: async () => { calls += 1; return json({}); } });
  assert.equal(calls, 9);
});

for (const failure of [404, 502, 'network']) {
  test(`NCM ${failure} failure does not open a cooldown`, async () => {
    let calls = 0;
    const options = { fetchFn: async () => {
      calls += 1;
      if (calls > 1) return json({});
      if (failure === 'network') throw new Error('NCM is down');
      return json({}, failure);
    } };
    await assert.rejects(ncm.search('test', 5, options), (error) => {
      assert.notEqual(error.code, 'NCM_RATE_LIMITED');
      return true;
    });
    await ncm.search('test', 5, options);
    assert.equal(calls, 2);
  });
}

test('resolve exposes both a search 405 and local cooldown as rate limited', async () => {
  let calls = 0;
  const options = { fetchFn: async () => { calls += 1; return json({}, 405); } };
  for (let i = 0; i < 2; i += 1) {
    const result = await ncm.resolve(song, options);
    assert.deepEqual({ ...result, error: '' }, { ...song, url: null, playable: false, error: '', rateLimited: true });
    assert.match(result.error, /405|操作频繁|busy/);
  }
  assert.equal(calls, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(ncm.resolve(song, { ...options, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('resolve exposes a song-URL 405 and its cooldown without retrying other hits or qualities', async () => {
  const calls = [];
  const options = { fetchFn: async (url) => {
    calls.push(url.pathname);
    if (url.pathname === '/search') return json({ result: { songs: [hit, { ...hit, id: 2 }] } });
    assert.equal(url.pathname, '/song/url/v1');
    return json({}, 405);
  } };
  for (let i = 0; i < 2; i += 1) {
    const result = await ncm.resolve(song, options);
    assert.equal(result.playable, false);
    assert.equal(result.url, null);
    assert.equal(result.rateLimited, true);
    assert.match(result.error, /405|操作频繁|busy/);
  }
  assert.deepEqual(calls, ['/search', '/song/url/v1']); // 第二次搜索走缓存，直链在冷却中不再请求
});

test('歌曲直链走 weapi：网易云对默认 eapi 回 -460', async () => {
  let requested;
  const result = await ncm.songUrl(1, 'exhigh', {
    fetchFn: async (url) => {
      requested = new URL(url);
      return json({ data: [{ url: 'https://m.example/1.mp3', level: 'exhigh', br: 320000 }] });
    },
  });
  assert.equal(requested.pathname, '/song/url/v1');
  assert.equal(requested.searchParams.get('crypto'), 'weapi');
  assert.equal(result.bitrate, 320000);
});

test('同一关键词六小时内只搜一次，空结果不缓存', async () => {
  let calls = 0;
  const fetchFn = async (url) => {
    calls += 1;
    const empty = new URL(url).searchParams.get('keywords') === '没有';
    return json({ result: { songs: empty ? [] : [{ id: 7, name: '晴天', artists: [{ name: '周杰伦' }] }] } });
  };
  assert.equal((await ncm.search('晴天 周杰伦', 8, { fetchFn }))[0].id, 7);
  assert.equal((await ncm.search('晴天 周杰伦', 8, { fetchFn }))[0].id, 7);
  await ncm.search('没有', 8, { fetchFn });
  await ncm.search('没有', 8, { fetchFn });
  assert.equal(calls, 3);
});

test('后台搜索排队隔开发，点歌不排队', async () => {
  const { config } = await import('../server/config.js');
  const saved = config.ncm.searchGapMs;
  config.ncm.searchGapMs = 200;
  try {
    const at = [];
    const fetchFn = async () => { at.push(Date.now()); return json({ result: { songs: [] } }); };
    const t0 = Date.now();
    await Promise.all(['a', 'b', 'c'].map((q) => ncm.withNcmSource('background', () => ncm.search(`gap-${q}`, 5, { fetchFn }))));
    const gaps = at.slice(1).map((v, i) => v - at[i]);
    assert.ok(gaps.every((g) => g >= 180), `gaps ${gaps}`);
    const before = Date.now();
    await ncm.withNcmSource('chat', () => ncm.search('gap-chat', 5, { fetchFn }));
    assert.ok(Date.now() - before < 100);
    assert.ok(Date.now() - t0 >= 380);
  } finally { config.ncm.searchGapMs = saved; }
});

test('后台搜索每分钟有上限（点歌也算数），满了就等，点歌照发', async () => {
  const { config } = await import('../server/config.js');
  const saved = config.ncm.searchPerMin;
  config.ncm.searchPerMin = 2;
  ncm.resetRateLimitsForTests();
  try {
    const sent = [];
    const fetchFn = async (url) => { sent.push(new URL(url).searchParams.get('keywords')); return json({ result: { songs: [] } }); };
    await ncm.withNcmSource('chat', () => ncm.search('cap-chat', 5, { fetchFn }));
    await ncm.withNcmSource('background', () => ncm.search('cap-a', 5, { fetchFn }));
    const ctrl = new AbortController();
    const third = ncm.withNcmSource('background', () => ncm.search('cap-b', 5, { fetchFn, signal: ctrl.signal }));
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(sent, ['cap-chat', 'cap-a']);
    await ncm.withNcmSource('chat', () => ncm.search('cap-chat-2', 5, { fetchFn }));
    assert.deepEqual(sent, ['cap-chat', 'cap-a', 'cap-chat-2']);
    ctrl.abort(new Error('deadline'));
    await assert.rejects(third, /deadline/);
    assert.equal(sent.length, 3);
  } finally { config.ncm.searchPerMin = saved; ncm.resetRateLimitsForTests(); }
});

test('搜索冷却中不占每分钟名额，排队的也立刻报忙不干等', async () => {
  const { config } = await import('../server/config.js');
  const saved = config.ncm.searchPerMin;
  config.ncm.searchPerMin = 1;
  ncm.resetRateLimitsForTests();
  try {
    let n = 0;
    const fetchFn = async () => { n += 1; return new Response('{"code":405,"message":"操作频繁"}', { status: 405, headers: { 'content-type': 'application/json' } }); };
    await assert.rejects(ncm.withNcmSource('background', () => ncm.search('cool-a', 5, { fetchFn })));
    const started = Date.now();
    await assert.rejects(ncm.withNcmSource('background', () => ncm.search('cool-b', 5, { fetchFn })), /405/);
    await assert.rejects(ncm.withNcmSource('background', () => ncm.search('cool-c', 5, { fetchFn })), /405/);
    assert.ok(Date.now() - started < 200);
    assert.equal(n, 1);
  } finally { config.ncm.searchPerMin = saved; ncm.resetRateLimitsForTests(); }
});

test('排队中调用方已放弃的搜索直接让出，不空等、不占名额', async () => {
  const { config } = await import('../server/config.js');
  const saved = [config.ncm.searchGapMs, config.ncm.searchPerMin];
  config.ncm.searchGapMs = 100;
  config.ncm.searchPerMin = 2;
  ncm.resetRateLimitsForTests();
  try {
    const sent = [];
    const fetchFn = async (url) => { sent.push(new URL(url).searchParams.get('keywords')); return json({ result: { songs: [] } }); };
    const gone = new AbortController();
    const first = ncm.withNcmSource('filler', () => ncm.search('give-up-a', 5, { fetchFn }));
    const stale = [1, 2, 3].map((i) => ncm.withNcmSource('filler', () => ncm.search(`give-up-stale-${i}`, 5, { fetchFn, signal: gone.signal })));
    gone.abort(new Error('filler budget'));
    for (const p of stale) await assert.rejects(p, /filler budget/);
    await first;
    const started = Date.now();
    await ncm.withNcmSource('background', () => ncm.search('give-up-b', 5, { fetchFn }));
    assert.ok(Date.now() - started < 400, `waited ${Date.now() - started}`);
    assert.deepEqual(sent, ['give-up-a', 'give-up-b']);
  } finally { [config.ncm.searchGapMs, config.ncm.searchPerMin] = saved; ncm.resetRateLimitsForTests(); }
});

test('跨实例共享名额：老板实例在排队时不给别人，别的实例（点歌也算）只能用到上限减预留', async () => {
  const { config } = await import('../server/config.js');
  const saved = [config.ncm.searchGapMs, config.ncm.searchPerMin, config.ncm.sharedReserve];
  config.ncm.searchGapMs = 0;
  config.ncm.searchPerMin = 4;
  config.ncm.sharedReserve = 2;
  ncm.resetRateLimitsForTests();
  try {
    assert.deepEqual(ncm.grantRemoteForTests('background'), { ok: true });
    assert.deepEqual(ncm.grantRemoteForTests('background'), { ok: true });
    assert.equal(ncm.grantRemoteForTests('background').ok, false);
    assert.equal(ncm.grantRemoteForTests('chat').ok, false);
    const fetchFn = async () => json({ result: { songs: [] } });
    await ncm.withNcmSource('background', () => ncm.search('own-a', 5, { fetchFn }));
    await ncm.withNcmSource('background', () => ncm.search('own-a2', 5, { fetchFn }));
    // 名额满了：本实例的后台搜索排队，排队期间连点歌也不给别的实例。
    const ctrl = new AbortController();
    const queued = ncm.withNcmSource('background', () => ncm.search('own-b', 5, { fetchFn, signal: ctrl.signal }));
    await new Promise((r) => setTimeout(r, 20));
    const answer = ncm.grantRemoteForTests('chat');
    assert.equal(answer.ok, false);
    assert.equal(answer.retryMs, 1000);
    ctrl.abort(new Error('done'));
    await assert.rejects(queued, /done/);
  } finally { [config.ncm.searchGapMs, config.ncm.searchPerMin, config.ncm.sharedReserve] = saved; ncm.resetRateLimitsForTests(); }
});

test('跨实例共享名额：管名额的服务转达冷却；别的实例碰到 405 会报回来', async () => {
  const { config } = await import('../server/config.js');
  const server = ncm.startSharedLimitServer('127.0.0.1:0');
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const url = `http://127.0.0.1:${server.address().port}`;
  ncm.resetRateLimitsForTests();
  try {
    const post = (p, body) => fetch(new URL(p, url), { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
    assert.deepEqual(await post('/slot', { kind: 'background' }), { ok: true });
    assert.deepEqual(await post('/cooldown', { ms: 60_000 }), { ok: true });
    const answer = await post('/slot', { kind: 'chat' });
    assert.equal(answer.ok, false);
    assert.ok(answer.coolingMs > 50_000);
    let n = 0;
    await assert.rejects(ncm.search('cooled-by-peer', 5, { fetchFn: async () => { n += 1; return json({}); } }), /cooldown/);
    assert.equal(n, 0);
    assert.equal((await fetch(new URL('/slot', url))).status, 403);
  } finally { server.close(); config.ncm.sharedUrl = ''; ncm.resetRateLimitsForTests(); }
});

test('要名额的实例：等服务放行再搜；服务说冷却就不搜；服务不通照常搜；405 报给服务', async () => {
  const { config } = await import('../server/config.js');
  const { startSlotServer } = await import('../server/ncm-shared.js');
  const replies = [];
  const cools = [];
  const server = startSlotServer('127.0.0.1:0', { grant: (kind) => replies.shift()?.(kind) ?? { ok: true }, cool: (ms) => cools.push(ms) });
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  ncm.resetRateLimitsForTests();
  config.ncm.sharedUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const sent = [];
    const fetchFn = async (u) => { sent.push(new URL(u).searchParams.get('keywords')); return json({ result: { songs: [] } }); };
    const kinds = [];
    replies.push((kind) => { kinds.push(kind); return { ok: false, retryMs: 250 }; }, (kind) => { kinds.push(kind); return { ok: true }; });
    const t0 = Date.now();
    await ncm.withNcmSource('chat', () => ncm.search('peer-wait', 5, { fetchFn }));
    assert.ok(Date.now() - t0 >= 200);
    assert.deepEqual(kinds, ['chat', 'chat']);
    replies.push(() => ({ ok: false, coolingMs: 30_000 }));
    await assert.rejects(ncm.search('peer-cool', 5, { fetchFn }), /cooldown/);
    assert.deepEqual(sent, ['peer-wait']);
    ncm.resetRateLimitsForTests();
    const status405 = async () => new Response('{}', { status: 405 });
    await assert.rejects(ncm.search('peer-405', 5, { fetchFn: status405 }), /405/);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(cools, [60_000]);
    ncm.resetRateLimitsForTests();
    server.close();
    config.ncm.sharedUrl = 'http://127.0.0.1:9';
    await ncm.search('peer-down', 5, { fetchFn });
    assert.deepEqual(sent, ['peer-wait', 'peer-down']);
  } finally { server.close(); config.ncm.sharedUrl = ''; ncm.resetRateLimitsForTests(); }
});

test('名额服务 /tts：老板闲着回 mp3，不闲回 409，纯文字超 100 字或整串超 400 字回 400，没接 tts 回 404', async () => {
  const { startSlotServer } = await import('../server/ncm-shared.js');
  const said = [];
  const server = startSlotServer('127.0.0.1:0', {
    grant: () => ({ ok: true }), cool: () => {},
    tts: async (text) => { said.push(text); return text === '忙' ? null : Buffer.from('mp3'); },
  });
  const bare = startSlotServer('127.0.0.1:0', { grant: () => ({ ok: true }), cool: () => {} });
  await Promise.all([server, bare].map((s) => new Promise((r) => (s.listening ? r() : s.once('listening', r)))));
  const post = (s, body) => fetch(`http://127.0.0.1:${s.address().port}/tts`, { method: 'POST', body: JSON.stringify(body) });
  try {
    const ok = await post(server, { text: '晚上好' });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'audio/mpeg');
    assert.equal(Buffer.from(await ok.arrayBuffer()).toString(), 'mp3');
    assert.equal((await post(server, { text: '忙' })).status, 409);
    assert.equal((await post(server, { text: '字'.repeat(101) })).status, 400);
    // 带语气提示和标记的整串：纯文字 ≤ 100 字就放行（提示和标记不算字数），整串超 400 字不放行
    const style = '[warm, soft late-night radio host, relaxed and gentle, unhurried]';
    assert.equal((await post(server, { text: `${style} <soft>${'字'.repeat(100)}</soft>` })).status, 200);
    assert.equal((await post(server, { text: `${style} ${'字'.repeat(101)}` })).status, 400);
    assert.equal((await post(server, { text: `${style} ${'字'.repeat(100)}${'[pause]'.repeat(40)}` })).status, 400);
    assert.equal((await post(bare, { text: '晚上好' })).status, 404);
    assert.equal(said.length, 3);
    assert.deepEqual(said.slice(0, 2), ['晚上好', '忙']);
  } finally { server.close(); bare.close(); }
});
