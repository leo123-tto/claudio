// 公用版（server/public）：网易云按人隔离、cookie 加密、老板优先、进门 / 额度 / 在播互斥 / 记忆隔离。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createNcmClient, cookieKey, NcmBusyError } from '../server/public/ncm-public.js';
import { createMemberStore, encrypt, decrypt, parseVaultKey, MEMORY_IDLE_MS } from '../server/public/members.js';
import { createGate, parseEngineLoad, createBrain, buildPrompt, normalizeReply } from '../server/public/brain.js';
import { createPublicApp, syncWithHub, parseCookies, clientIp, deviceLabel, qualityFor } from '../server/public/app.js';
import { HubError } from '../server/public/hub-client.js';

const KEY = parseVaultKey('11'.repeat(32));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-public-'));

function jsonRes(body, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

test('网易云：带 cookie 的请求加按人缓存键、cookie 只走 header；没登录不搜', async () => {
  const calls = [];
  const ncm = createNcmClient({
    base: 'http://ncm.test',
    sleep: async () => {},
    fetchFn: async (url, init) => {
      calls.push({ url: new URL(url), cookie: init.headers.Cookie });
      if (String(url).includes('/search')) return jsonRes({ result: { songs: [{ id: 1, name: '消愁', ar: [{ name: '毛不易' }] }] } });
      return jsonRes({ data: [{ url: 'http://m701.music.126.net/a.mp3', br: 320000, level: 'exhigh' }] });
    },
  });
  const song = await ncm.resolve({ title: '消愁', artist: '毛不易' }, { cookie: 'MUSIC_U=abc', memberId: 'mem_00000001' });
  assert.equal(song.playable, true);
  assert.equal(song.url, 'https://m701.music.126.net/a.mp3');
  const [search, url] = calls;
  assert.equal(search.cookie, 'MUSIC_U=abc');
  assert.equal(search.url.searchParams.get('_u'), cookieKey('MUSIC_U=abc'));
  assert.equal(url.cookie, 'MUSIC_U=abc');
  assert.equal(url.url.searchParams.get('_u'), cookieKey('MUSIC_U=abc'));
  assert.ok(!url.url.search.includes('abc'));
  // 盒子出口匿名搜索一律 405：没 cookie 根本不发
  const before = calls.length;
  await assert.rejects(ncm.search('晴天'), NcmBusyError);
  assert.equal(calls.length, before);
});

test('网易云：只有试听的版本跳过，标成 trial', async () => {
  const ncm = createNcmClient({
    base: 'http://ncm.test',
    sleep: async () => {},
    fetchFn: async (url) => String(url).includes('/search')
      ? jsonRes({ result: { songs: [{ id: 2, name: '十年', ar: [{ name: '陈奕迅' }] }] } })
      : jsonRes({ data: [{ url: 'http://m7.music.126.net/t.mp3', br: 128000, freeTrialInfo: { start: 0, end: 30 } }] }),
  });
  const song = await ncm.resolve({ title: '十年', artist: '陈奕迅' }, { cookie: 'MUSIC_U=x' });
  assert.equal(song.playable, false);
  assert.equal(song.reason, 'trial');
  assert.equal((await ncm.resolve({ title: '十年', artist: '陈奕迅' }, { cookie: 'MUSIC_U=x', allowTrial: true })).playable, true);
});

test('网易云：某接口 405 后这个接口停一段时间，别的接口照常；按人限速', async () => {
  let t = 0;
  let n = 0;
  const ncm = createNcmClient({ base: 'http://ncm.test', now: () => t, sleep: async () => {}, fetchFn: async (url) => { n += 1; return String(url).includes('/search') ? jsonRes({}, 405) : jsonRes({ ok: 1 }); } });
  await assert.rejects(ncm.call('/search', {}), NcmBusyError);
  await assert.rejects(ncm.call('/search', {}), NcmBusyError);
  assert.equal(n, 1);
  assert.deepEqual(await ncm.call('/login/qr/key', {}), { ok: 1 });
  t = 121_000;
  const ok = createNcmClient({ base: 'http://ncm.test', now: () => t, sleep: async () => {}, waitMs: 0, memberBurst: 2, memberRate: 0.01, fetchFn: async () => jsonRes({}) });
  await ok.call('/x', {}, { memberId: 'mem_00000001' });
  await ok.call('/x', {}, { memberId: 'mem_00000001' });
  await assert.rejects(ok.call('/x', {}, { memberId: 'mem_00000001' }), NcmBusyError);
  await ok.call('/x', {}, { memberId: 'mem_00000002' });
});

test('成员数据：cookie 加密落盘、解绑删除、hub 停用就整块删、30 天不用清记忆', () => {
  let t = 1_000_000;
  const root = tmp();
  const store = createMemberStore({ root, vaultKey: KEY, now: () => t });
  assert.equal(decrypt(KEY, encrypt(KEY, '你好')), '你好');
  store.setCookie('mem_00000001', 'MUSIC_U=secret');
  assert.ok(!fs.readFileSync(path.join(root, 'mem_00000001', 'ncm.enc'), 'utf8').includes('secret'));
  assert.equal(store.getCookie('mem_00000001'), 'MUSIC_U=secret');
  store.saveMemory('mem_00000001', { prefs: ['粤语'] });
  store.saveMemory('mem_00000002', { prefs: ['摇滚'] });
  assert.deepEqual(store.memory('mem_00000002').prefs, ['摇滚']);
  store.unbind('mem_00000001');
  assert.equal(store.bound('mem_00000001'), false);
  assert.deepEqual(store.memory('mem_00000001').prefs, ['粤语']);
  t += MEMORY_IDLE_MS + 1;
  const removed = store.sweep([{ id: 'mem_00000001', status: 'active' }, { id: 'mem_00000002', status: 'disabled' }]);
  assert.deepEqual(removed, ['mem_00000002']);
  assert.ok(!fs.existsSync(path.join(root, 'mem_00000002')));
  assert.deepEqual(store.memory('mem_00000001').prefs, []);
  assert.throws(() => store.saveMemory('../etc', {}), /bad member id/);
});

test('老板优先：引擎有人排队就等，等不到降级；公用实例同时只跑一个', async () => {
  assert.deepEqual(parseEngineLoad('tensorfold:requests_running 2\ntensorfold:requests_waiting 1\n'), { running: 2, waiting: 1 });
  let load = 'x:requests_running 0\nx:requests_waiting 1\n';
  let calls = 0;
  const persona = path.join(tmp(), 'p.md');
  fs.writeFileSync(persona, '人设');
  const brain = createBrain({
    baseUrl: 'http://llm', model: 'm', metricsUrl: 'http://metrics', personaFile: persona, waitMs: 3000,
    fetchFn: async () => ({ text: async () => load }),
    sleep: async () => { load = 'x:requests_running 1\nx:requests_waiting 0\n'; },
    call: async () => { calls += 1; return '{"say":"好","intent":"recommend","play":[{"title":"a","artist":"b"}],"memoryCandidates":[]}'; },
  });
  const out = await brain.ask({ text: '来点粤语', memory: {}, bound: false, hour: 9 });
  assert.equal(out.play.length, 1);
  assert.equal(calls, 1);
  const stuck = createBrain({
    baseUrl: 'http://llm', model: 'm', metricsUrl: 'http://metrics', personaFile: persona, waitMs: 0,
    fetchFn: async () => ({ text: async () => 'x:requests_waiting 3\n' }), sleep: async () => {}, call: async () => '{}',
  });
  await assert.rejects(stuck.ask({ text: 'x', memory: {}, bound: false, hour: 9 }), /忙/);
  const gate = createGate({ maxQueue: 1 });
  let release;
  const first = gate.run(() => new Promise((r) => { release = r; }));
  const second = gate.run(async () => 'ok');
  await assert.rejects(gate.run(async () => 'x'), (e) => e.queueFull === true);
  release();
  await first;
  assert.equal(await second, 'ok');
});

test('提示词不带别人的东西；回复清洗', () => {
  const prompt = buildPrompt({ persona: 'P', text: '来点', auto: false, memory: { prefs: ['粤语'], recent: [], turns: [] }, bound: false, hour: 22 });
  assert.match(prompt, /粤语/);
  assert.match(prompt, /没登录网易云/);
  assert.deepEqual(normalizeReply({ say: 'x', intent: 'chat', play: [{ title: 'a', artist: 'b' }] }).intent, 'recommend');
  assert.deepEqual(normalizeReply({ say: 'x', intent: 'chat', play: [] }).play, []);
});

test('小工具：cookie 解析、只信本机转发来的 CF 头、设备名', () => {
  assert.deepEqual(parseCookies('a=1; dj_dev=x%20y'), { a: '1', dj_dev: 'x y' });
  assert.equal(clientIp({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'cf-connecting-ip': '1.2.3.4' } }), '1.2.3.4');
  assert.equal(clientIp({ socket: { remoteAddress: '10.0.0.5' }, headers: { 'cf-connecting-ip': '1.2.3.4' } }), '10.0.0.5');
  assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605'), 'iPhone · Safari');
});

// ---- 整个 app：用假的 hub / 网易云 / 大脑 ----
function fakeHub() {
  const members = new Map();
  const devices = new Map();
  let seq = 0;
  const hub = {
    applied: [],
    members,
    addMember(id, extra = {}) { members.set(id, { id, name: id, daily_total: 3, used: 0, max_devices: 3, status: 'active', ...extra }); },
    link: new Map(),
    async apply(body) { hub.applied.push(body); return { id: 'app_1' }; },
    view(m) { return { id: m.id, name: m.name, remaining: m.daily_total - m.used, daily_total: m.daily_total, devices: [...devices.values()].filter((d) => d.member === m.id).length, max_devices: m.max_devices, expires: '' }; },
    async redeemLink(token) {
      const mid = hub.link.get(token);
      if (!mid) throw new HubError(403, 'invalid');
      hub.link.delete(token);
      const dt = `dev-token-${++seq}`;
      devices.set(dt, { id: `dev_${seq}`, member: mid });
      return { device_token: dt, device_id: `dev_${seq}`, member: hub.view(members.get(mid)) };
    },
    async pairRedeem() { throw new HubError(403, 'invalid'); },
    async pairCreate() { return { code: '123456', expires: '' }; },
    async verify(token) {
      const d = devices.get(token);
      if (!d) throw new HubError(403, 'invalid');
      const m = members.get(d.member);
      if (m.status !== 'active') throw new HubError(403, m.status);
      return { device_id: d.id, member: hub.view(m) };
    },
    async logout(token) { devices.delete(token); return {}; },
    forget() {},
    async consume(mid) {
      const m = members.get(mid);
      if (m.used >= m.daily_total) throw new HubError(429, 'quota');
      m.used += 1;
      return { remaining: m.daily_total - m.used };
    },
    async states() { return { members: [...members.values()].map((m) => ({ id: m.id, status: m.status })) }; },
    reported: [],
    async report(items) { hub.reported.push(items); return {}; },
  };
  return hub;
}

async function startApp(overrides = {}) {
  const hub = fakeHub();
  const root = tmp();
  const members = createMemberStore({ root, vaultKey: KEY });
  const webRoot = tmp();
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html>');
  const ncmResolve = { fn: null };
  const ncmCalls = [];
  const ncm = {
    resolve: async (c, o) => (ncmCalls.push(`resolve:${o.cookie || ''}`), ncmResolve.fn ? ncmResolve.fn(c, o) : { id: [...c.title].reduce((n, ch) => n + ch.codePointAt(0), 0), title: c.title, artist: c.artist, url: `https://m.music.126.net/${c.title}.mp3`, playable: true }),
    search: async () => { ncmCalls.push('search'); return [{ title: '搜到的', artist: '某人' }]; },
    freeChart: async () => { ncmCalls.push('chart'); await ncmResolve.chartGate; return [{ id: 11, title: '榜上免费歌', artist: 'C' }]; },
    playById: async (song, o) => { ncmCalls.push(`id:${song.id}:${o.cookie || ''}`); return { ...song, url: `https://m.music.126.net/${song.id}.mp3`, playable: true }; },
    qrStart: async () => ({ key: 'k', img: 'data:image/png;base64,AA' }),
    qrCheck: async () => ({ code: 803, cookie: 'MUSIC_U=friend' }),
    account: async () => ({ uid: 1, nickname: '朋友', vip: true }),
    taste: async () => ({ likeCount: 2, likes: [{ id: 21, title: 'x', artist: 'y' }], playlists: [] }),
    dailyRecommend: async () => { ncmCalls.push('daily'); return [{ id: 31, title: '推荐一', artist: 'R' }, { id: 32, title: '推荐二', artist: 'R' }]; },
    personalFm: async () => { ncmCalls.push('fm'); return [{ id: 41, title: 'FM 一', artist: 'F' }]; },
    simiSongs: async () => { ncmCalls.push('simi'); return [{ id: 51, title: '相似一', artist: 'S' }]; },
    like: async (cookie, id, on) => { ncmCalls.push(`like:${id}:${on}`); return true; },
    songUrl: async () => ({ url: 'https://m.music.126.net/r.mp3' }),
    lyric: async () => '',
    ...overrides.ncm,
  };
  const brainAsks = [];
  const brain = {
    gate: { full: false },
    ask: async (input) => { brainAsks.push(input); return { say: '来了', intent: 'recommend', play: [{ title: '歌一', artist: 'A' }, { title: '歌二', artist: 'B' }], memoryCandidates: input.text.includes('粤语') ? ['喜欢粤语'] : [] }; },
  };
  const { app } = createPublicApp({ hub, members, webRoot, cookieSecure: false, applyOrigins: ['https://www.example.com'], maxListeners: 8, ...overrides, ncm, brain });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (pathname, { method = 'GET', body, cookie, headers = {} } = {}) => {
    const res = await fetch(base + pathname, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie') || '';
    const data = await res.json().catch(() => null);
    return { status: res.status, data, setCookie, headers: res.headers };
  };
  const join = async (mid) => {
    const token = `link-${mid}`;
    hub.link.set(token, mid);
    const r = await req('/api/join', { method: 'POST', body: { token } });
    assert.equal(r.status, 200);
    assert.match(r.setCookie, /HttpOnly/);
    return r.setCookie.split(';')[0];
  };
  return { hub, members, brainAsks, ncmResolve, ncmCalls, req, join, base, close: () => server.close() };
}

test('app：没设备 401；链接进门；链接只能用一次；无效链接被拒', async () => {
  const t = await startApp();
  try {
    t.hub.addMember('mem_00000001');
    assert.equal((await t.req('/api/me')).status, 401);
    const cookie = await t.join('mem_00000001');
    const me = await t.req('/api/me', { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.data.remaining, 3);
    const again = await t.req('/api/join', { method: 'POST', body: { token: 'link-mem_00000001' } });
    assert.equal(again.status, 403);
    assert.equal((await t.req('/api/settings')).status, 404);
    assert.equal((await t.req('/api/outputs')).status, 404);
    assert.equal((await t.req('/proxy?u=http://127.0.0.1:8090/')).status, 404);
  } finally { t.close(); }
});

test('app：网页先问 /api/mode，公用版只开配额、最近听过、账号（没设备也能问）', async () => {
  const t = await startApp();
  try {
    const mode = await t.req('/api/mode');
    assert.equal(mode.status, 200);
    assert.equal(mode.data.mode, 'public');
    assert.deepEqual(Object.keys(mode.data.features).sort(), ['account', 'history', 'quota']);
  } finally { t.close(); }
});

test('app：额度用完提示；停用后立即失效并清 cookie', async () => {
  const t = await startApp();
  try {
    t.hub.addMember('mem_00000001');
    const cookie = await t.join('mem_00000001');
    t.members.setCookie('mem_00000001', 'MUSIC_U=a');
    for (let i = 0; i < 3; i += 1) {
      const r = await t.req('/api/chat', { method: 'POST', body: { text: '来点歌' }, cookie });
      assert.equal(r.status, 200);
      assert.equal(r.data.songs.length, 2);
    }
    const over = await t.req('/api/chat', { method: 'POST', body: { text: '再来' }, cookie });
    assert.equal(over.status, 429);
    assert.match(over.data.message, /次数用完/);
    t.hub.members.get('mem_00000001').status = 'disabled';
    const gone = await t.req('/api/me', { cookie });
    assert.equal(gone.status, 401);
    assert.match(gone.setCookie, /Max-Age=0/);
  } finally { t.close(); }
});

test('app：两个人的记忆互不可见；扫码绑定后只用自己的 cookie；解绑删 cookie', async () => {
  const t = await startApp();
  try {
    t.hub.addMember('mem_00000001');
    t.hub.addMember('mem_00000002');
    const a = await t.join('mem_00000001');
    const b = await t.join('mem_00000002');
    t.members.setCookie('mem_00000001', 'MUSIC_U=a');
    t.members.setCookie('mem_00000002', 'MUSIC_U=b');
    await t.req('/api/chat', { method: 'POST', body: { text: '我喜欢粤语' }, cookie: a });
    assert.deepEqual((await t.req('/api/me', { cookie: a })).data.prefs, ['喜欢粤语']);
    assert.deepEqual((await t.req('/api/me', { cookie: b })).data.prefs, []);
    await t.req('/api/chat', { method: 'POST', body: { text: '随便' }, cookie: b });
    assert.equal(t.brainAsks.at(-1).memory.prefs?.length ?? 0, 0);
    assert.equal(t.brainAsks.at(-1).memory.turns.some((x) => x.text.includes('粤语')), false);

    assert.equal((await t.req('/api/ncm/qr', { method: 'POST', cookie: a })).status, 200);
    const st = await t.req('/api/ncm/qr/status', { cookie: a });
    assert.equal(st.data.code, 803);
    assert.equal(t.members.getCookie('mem_00000001'), 'MUSIC_U=friend');
    assert.equal(t.members.getCookie('mem_00000002'), 'MUSIC_U=b');
    assert.ok(t.ncmCalls.includes('resolve:MUSIC_U=b'));
    assert.ok(!t.ncmCalls.some((c) => c.startsWith('resolve:') && !c.endsWith('MUSIC_U=a') && !c.endsWith('MUSIC_U=b')));
    assert.equal((await t.req('/api/me', { cookie: a })).data.nickname, '朋友');
    await t.req('/api/ncm/unbind', { method: 'POST', cookie: a });
    assert.equal(t.members.bound('mem_00000001'), false);
    assert.deepEqual(t.hub.reported.at(-1), { mem_00000001: { bound: false } });
  } finally { t.close(); }
});

test('app：同时一处在播，另一台可以接过来；整体在线上限', async () => {
  const t = await startApp({ maxListeners: 1 });
  try {
    t.hub.addMember('mem_00000001');
    t.hub.addMember('mem_00000002');
    const a1 = await t.join('mem_00000001');
    const a2 = await t.join('mem_00000001');
    const b = await t.join('mem_00000002');
    assert.equal((await t.req('/api/play/heartbeat', { method: 'POST', body: {}, cookie: a1 })).status, 200);
    assert.equal((await t.req('/api/play/heartbeat', { method: 'POST', body: {}, cookie: a2 })).status, 409);
    assert.equal((await t.req('/api/play/heartbeat', { method: 'POST', body: { takeover: true }, cookie: a2 })).status, 200);
    assert.equal((await t.req('/api/play/heartbeat', { method: 'POST', body: {}, cookie: a1 })).status, 409);
    assert.equal((await t.req('/api/play/heartbeat', { method: 'POST', body: {}, cookie: b })).status, 503);
  } finally { t.close(); }
});

test('app：申请只收白名单来源的跨域、校验人机、转给 hub 时带真实 IP', async () => {
  const verify = [];
  const t = await startApp({
    turnstileSecret: 's',
    turnstileSiteKey: 'site-key',
    fetchFn: async (url, init) => { verify.push(String(init.body)); return jsonRes({ success: String(init.body).includes('response=good') }); },
  });
  try {
    const cfg = await t.req('/api/apply/config', { headers: { Origin: 'https://www.example.com' } });
    assert.deepEqual(cfg.data, { turnstileSiteKey: 'site-key' });
    const pre = await t.req('/api/apply', { method: 'OPTIONS', headers: { Origin: 'https://www.example.com' } });
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://www.example.com');
    const evil = await t.req('/api/apply', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    const bad = await t.req('/api/apply', { method: 'POST', body: { name: '小王', note: '同学', turnstileToken: 'bad' } });
    assert.equal(bad.status, 400);
    const ok = await t.req('/api/apply', { method: 'POST', body: { name: '小王', note: '同学', wechat: 'wx', turnstileToken: 'good' }, headers: { 'CF-Connecting-IP': '5.6.7.8' } });
    assert.equal(ok.status, 200);
    assert.equal(t.hub.applied[0].ip, '5.6.7.8');
    assert.match(verify[1], /remoteip=5.6.7.8/);
  } finally { t.close(); }
});

test('同步：hub 说停用 / 删除的人，本地数据删掉并上报绑定状态', async () => {
  const hub = fakeHub();
  hub.addMember('mem_00000001');
  hub.addMember('mem_00000002', { status: 'expired' });
  const members = createMemberStore({ root: tmp(), vaultKey: KEY });
  members.setCookie('mem_00000001', 'MUSIC_U=a');
  members.setCookie('mem_00000002', 'MUSIC_U=b');
  members.setCookie('mem_00000003', 'MUSIC_U=c');
  const removed = await syncWithHub({ hub, members });
  assert.deepEqual(removed.sort(), ['mem_00000002', 'mem_00000003']);
  assert.deepEqual(hub.reported.at(-1), { mem_00000001: { bound: true } });
});

test('app：一首都放不了时 DJ 不报幕，只给提示', async () => {
  const t = await startApp();
  try {
    t.hub.addMember('mem_00000001');
    const cookie = await t.join('mem_00000001');
    t.members.setCookie('mem_00000001', 'MUSIC_U=a');
    t.ncmResolve.fn = async (c) => ({ title: c.title, artist: c.artist, playable: false, reason: 'not-found' });
    const r = await t.req('/api/chat', { method: 'POST', body: { text: '来首没版权的' }, cookie });
    assert.equal(r.status, 200);
    assert.equal(r.data.say, '');
    assert.deepEqual(r.data.songs, []);
    assert.match(r.data.notice, /没找到能放的版本/);
  } finally { t.close(); }
});

test('网易云：没点名要的翻唱 / 「xx版」不当原唱放', async () => {
  const ncm = createNcmClient({
    base: 'http://ncm.test',
    sleep: async () => {},
    fetchFn: async (url) => String(url).includes('/search')
      ? jsonRes({ result: { songs: [{ id: 3, name: '稻香(治愈版)', ar: [{ name: '周杰伦.' }, { name: '街道办GDC' }] }] } })
      : jsonRes({ data: [{ url: 'http://m7.music.126.net/c.mp3', br: 320000 }] }),
  });
  const song = await ncm.resolve({ title: '稻香', artist: '周杰伦' }, { cookie: 'MUSIC_U=x' });
  assert.equal(song.playable, false);
  assert.equal(song.reason, 'not-found');
});

test('网易云：放不了的歌记住，下次不再问；榜单只留免费歌、按 id 放不搜', async () => {
  const urls = [];
  const ncm = createNcmClient({
    base: 'http://ncm.test',
    sleep: async () => {},
    fetchFn: async (url) => {
      if (String(url).includes('/search')) return jsonRes({ result: { songs: [{ id: 7, name: '十年', ar: [{ name: '陈奕迅' }], fee: 1 }] } });
      urls.push(String(url));
      return jsonRes({ data: [{ url: 'http://m7.music.126.net/t.mp3', freeTrialInfo: { start: 0, end: 30 } }] });
    },
  });
  await ncm.resolve({ title: '十年', artist: '陈奕迅' }, { cookie: 'MUSIC_U=x' });
  await ncm.resolve({ title: '十年', artist: '陈奕迅' }, { cookie: 'MUSIC_U=x' });
  assert.equal(urls.length, 1);

  const seen = [];
  const chartNcm = createNcmClient({
    base: 'http://ncm.test',
    sleep: async () => {},
    fetchFn: async (url) => {
      seen.push(new URL(url).pathname);
      if (String(url).includes('/playlist/track/all')) {
        return jsonRes({ songs: [{ id: 1, name: '免费', ar: [{ name: 'A' }], fee: 8 }, { id: 2, name: '会员', ar: [{ name: 'B' }], fee: 1 }] });
      }
      return jsonRes({ data: [{ url: 'http://m7.music.126.net/f.mp3' }] });
    },
  });
  const pool = await chartNcm.freeChart('3778678');
  assert.deepEqual(pool.map((x) => x.id), [1]);
  await chartNcm.freeChart('3778678');
  assert.equal((await chartNcm.playById(pool[0])).playable, true);
  assert.deepEqual(seen, ['/playlist/track/all', '/song/url/v1']);
});

test('网易云：令牌不够时先排队；名额服务不通时每分钟最多 2 个搜索、间隔 ≥5 秒', async () => {
  let t = 0;
  const slept = [];
  const ncm = createNcmClient({
    base: 'http://ncm.test', now: () => t, globalBurst: 1, globalRate: 0.5, waitMs: 120_000,
    sleep: async (ms) => { slept.push(ms); t += ms; },
    fetchFn: async () => jsonRes({ result: { songs: [] } }),
  });
  const at = [];
  for (let i = 0; i < 3; i += 1) { await ncm.call('/search', {}); at.push(t); }
  assert.ok(at[1] - at[0] >= 5000);
  assert.ok(at[2] - at[0] >= 60_000);
});

test('网易云：搜索先向老板实例要名额（kind=chat），等 / 冷却照办，405 报回去一起冷却', async () => {
  let t = 0;
  const answers = [{ ok: false, retryMs: 1500 }, { ok: true }, { ok: false, coolingMs: 600_000 }, { ok: true }];
  const asked = [];
  const reported = [];
  let status = 200;
  const ncm = createNcmClient({
    base: 'http://ncm.test', now: () => t, sharedUrl: 'http://127.0.0.1:8099',
    sleep: async (ms) => { t += ms; },
    slotFn: async (url) => { asked.push(url); return answers.shift(); },
    reportFn: (url, ms) => reported.push([url, ms]),
    fetchFn: async () => (status === 200 ? jsonRes({ result: { songs: [] } }) : jsonRes({}, status)),
  });
  await ncm.call('/search', {});
  assert.equal(t, 1500);
  assert.equal(asked.length, 2);
  await assert.rejects(ncm.call('/search', {}), NcmBusyError);
  assert.equal(ncm.paused('/search'), true);
  t += 600_001;
  status = 405;
  await assert.rejects(ncm.call('/search', {}), NcmBusyError);
  assert.deepEqual(reported, [['http://127.0.0.1:8099', 15 * 60_000]]);
  // 名额服务一直说等，等过 waitMs 就报排队中
  const busy = createNcmClient({
    base: 'http://ncm.test', now: () => t, sharedUrl: 'x', waitMs: 3000,
    sleep: async (ms) => { t += ms; },
    slotFn: async () => ({ ok: false, retryMs: 2000 }),
    fetchFn: async () => jsonRes({}),
  });
  await assert.rejects(busy.call('/search', {}), /排队中/);
  // 名额服务一直给，公用版自己每分钟也只搜 3 个
  let t2 = 0;
  const capped = createNcmClient({
    base: 'http://ncm.test', now: () => t2, sharedUrl: 'x', waitMs: 1000,
    sleep: async (ms) => { t2 += ms; },
    slotFn: async () => ({ ok: true }),
    fetchFn: async () => jsonRes({ result: { songs: [] } }),
  });
  for (let i = 0; i < 3; i += 1) await capped.call('/search', {});
  await assert.rejects(capped.call('/search', {}), /排队中/);
  t2 += 60_001;
  await capped.call('/search', {});
});

test('app：没绑定不开放点歌（不搜、不打大脑、不扣次数）；自动续播只按已知 id 放，不搜', async () => {
  const t = await startApp();
  try {
    t.hub.addMember('mem_00000001');
    const cookie = await t.join('mem_00000001');
    const ask = await t.req('/api/chat', { method: 'POST', body: { text: '来首周杰伦' }, cookie });
    assert.equal(ask.status, 200);
    assert.equal(ask.data.needBind, true);
    assert.match(ask.data.notice, /绑定网易云后才能点歌/);
    assert.equal(t.brainAsks.length, 0);
    assert.equal(t.hub.members.get('mem_00000001').used, 0);

    const free = await t.req('/api/chat', { method: 'POST', body: { text: '' }, cookie });
    assert.deepEqual(free.data.songs.map((x) => x.id), [11]);
    assert.deepEqual(t.ncmCalls, ['chart', 'id:11:']);

    // 绑定后：自动续播从红心 + 每日推荐里按已知 id 放（红心是空的就现读一次），请求里不搜；
    // 新歌池是空的，后台叫一次大脑攒新歌
    t.members.setCookie('mem_00000001', 'MUSIC_U=a');
    t.members.saveMemory('mem_00000001', { account: { uid: 1 } });
    t.ncmCalls.length = 0;
    const mine = await t.req('/api/chat', { method: 'POST', body: { text: '' }, cookie });
    assert.equal(mine.data.songs.length, 2);
    assert.ok(mine.data.songs.every((x) => [21, 31, 32, 41].includes(x.id)));
    assert.ok(!t.ncmCalls.includes('search'));
    assert.ok(t.ncmCalls.filter((c) => c.startsWith('id:')).every((c) => c.endsWith(':MUSIC_U=a')));
    for (let i = 0; i < 20 && !t.members.memory('mem_00000001').fresh; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(t.brainAsks.length, 1);
    assert.deepEqual(t.members.memory('mem_00000001').fresh.songs.map((x) => x.title), ['歌一', '歌二']);
  } finally { t.close(); }
});

test('网易云：扫码后轮询状态 3 分钟不被限速卡住，也不占别人的点歌令牌', async () => {
  let t = 0;
  const ncm = createNcmClient({
    base: 'http://ncm.test', now: () => t,
    sleep: async (ms) => { t += ms; },
    fetchFn: async (url) => (String(url).includes('/login/qr/check') ? jsonRes({ code: 801 }) : jsonRes({ data: [{ url: 'http://m7.music.126.net/a.mp3' }] })),
  });
  for (let i = 0; i < 90; i += 1) {
    assert.equal((await ncm.qrCheck('k', { memberId: 'mem_00000001' })).code, 801);
    t += 2000;
  }
  // 一次都没有为了等令牌而多睡（网页真实是定时并发轮询，等令牌会越积越多，最后报忙）
  assert.equal(t, 180_000);
  const before = t;
  await ncm.songUrl(1, { memberId: 'mem_00000002' });
  assert.equal(t, before);
});

test('音质：会员要无损、拿不到再要 exhigh；gain 带回来，试听占位的 gain 不算', async () => {
  assert.equal(qualityFor({ account: { vip: true } }, 'MUSIC_U=a'), 'lossless');
  assert.equal(qualityFor({ account: { vip: false } }, 'MUSIC_U=a'), 'exhigh');
  assert.equal(qualityFor({ account: { vip: true } }, ''), 'exhigh');
  const asked = [];
  const ncm = createNcmClient({
    base: 'http://ncm.test',
    sleep: async () => {},
    fetchFn: async (url) => {
      const level = new URL(url).searchParams.get('level');
      asked.push(level);
      if (level === 'lossless') return jsonRes({ data: [{ url: null }] });
      return jsonRes({ data: [{ url: 'http://m7.music.126.net/a.mp3', level: 'exhigh', br: 320000, gain: -9.6, peak: 1 }] });
    },
  });
  const audio = await ncm.songUrl(1, { level: 'lossless', cookie: 'MUSIC_U=a' });
  assert.deepEqual(asked, ['lossless', 'exhigh']);
  assert.equal(audio.bitrate, 320000);
  assert.equal(audio.gain, -9.6);
  const trial = createNcmClient({
    base: 'http://ncm.test',
    sleep: async () => {},
    fetchFn: async () => jsonRes({ data: [{ url: 'http://m7.music.126.net/t.mp3', level: 'standard', gain: 2, peak: 0, freeTrialInfo: {} }] }),
  });
  assert.equal((await trial.songUrl(2)).gain, null);
});

test('音频同源代理：网页只拿到 /media/<id>；透传 Range；直链按人记住不重复问；没设备 401', async () => {
  const upstream = [];
  const fetchFn = async (url, init) => {
    upstream.push({ url: String(url), range: init?.headers?.Range });
    return new Response(new Uint8Array([1, 2, 3, 4]), { status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-3/100', 'content-length': '4' } });
  };
  const t = await startApp({ fetchFn });
  try {
    t.hub.addMember('mem_00000001');
    const cookie = await t.join('mem_00000001');
    const out = await t.req('/api/chat', { method: 'POST', body: { text: '' }, cookie });
    assert.equal(out.data.songs[0].url, '/media/11');
    const res = await fetch(`${t.base}/media/11`, { headers: { Cookie: cookie, Range: 'bytes=0-3' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), 'bytes 0-3/100');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3, 4]);
    assert.deepEqual(upstream, [{ url: 'https://m.music.126.net/11.mp3', range: 'bytes=0-3' }]);
    assert.equal((await fetch(`${t.base}/media/11`)).status, 401);
    assert.equal((await fetch(`${t.base}/media/1x`, { headers: { Cookie: cookie } })).status, 400);
    // 没记住的歌现取直链（songUrl）
    await (await fetch(`${t.base}/media/99`, { headers: { Cookie: cookie } })).arrayBuffer();
    assert.equal(upstream.at(-1).url, 'https://m.music.126.net/r.mp3');
  } finally { t.close(); }
});

test('音频代理限速：先放一段，之后按速率睡', async () => {
  const { throttle } = await import('../server/public/media.js');
  let t = 0;
  const slept = [];
  const chunks = [Buffer.alloc(100), Buffer.alloc(100), Buffer.alloc(100)];
  const out = throttle(chunks, { bytesPerSec: 100, burst: 100, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
  let total = 0;
  for await (const c of out) total += c.length;
  assert.equal(total, 300);
  assert.deepEqual(slept, [1000, 1000]);
});

test('续播配比：一副牌 10 张，红心 4 推荐 4 新歌 2；每日推荐到北京时间 6 点换', async () => {
  const { drawKinds, nextRefresh } = await import('../server/public/mix.js');
  let deck;
  const all = [];
  for (let i = 0; i < 10; i += 1) { const d = drawKinds(deck, 2); deck = d.deck; all.push(...d.kinds); }
  const count = (k) => all.filter((x) => x === k).length;
  assert.deepEqual([count('like'), count('rec'), count('new')], [8, 8, 4]);
  const t = Date.parse('2026-11-23T05:00:00+08:00');
  assert.equal(nextRefresh(t), Date.parse('2026-11-23T06:00:00+08:00'));
  assert.equal(nextRefresh(Date.parse('2026-11-23T13:00:00+08:00')), Date.parse('2026-11-24T06:00:00+08:00'));
});

test('续播推荐兜底：每日推荐和 FM 都空时拿红心歌的相似歌', async () => {
  const { createMixer } = await import('../server/public/mix.js');
  const calls = [];
  const ncm = {
    dailyRecommend: async () => [], personalFm: async () => [],
    simiSongs: async (id) => { calls.push(id); return [{ id: 900 + id, title: `相似${id}`, artist: 'S' }]; },
  };
  const mixer = createMixer({ ncm, brain: { ask: async () => ({ play: [] }) }, members: { memory: () => ({}), saveMemory: () => {} }, qualityFor: () => 'exhigh', rand: () => 0.99 });
  const memory = { taste: { likes: [{ id: 1, title: 'a', artist: 'x' }] }, deck: ['rec', 'rec'], fresh: { songs: [{ id: 5, title: 'n', artist: 'y' }, { id: 6, title: 'm', artist: 'y' }] } };
  const songs = await mixer.pick({ id: 'mem_00000001' }, memory, 'MUSIC_U=a', { count: 1, level: 'exhigh', playById: async (s) => ({ ...s, playable: true }) });
  assert.deepEqual(songs.map((s) => s.id), [901]);
  assert.deepEqual(calls, [1]);
});

test('扫码登录态整套存：去掉 Max-Age / Path 之类属性，只留名=值', async () => {
  const { loginCookie } = await import('../server/public/ncm-public.js');
  const raw = 'MUSIC_R_T=1; Max-Age=2147483647; Expires=Thu, 01 Jan 2099 00:00:00 GMT; Path=/eapi/clientlog;MUSIC_U=abc; Max-Age=15552000; Path=/; HTTPOnly;__csrf=x1; Path=/;NMTID=n2; Path=/';
  assert.equal(loginCookie(raw), 'MUSIC_R_T=1; MUSIC_U=abc; __csrf=x1; NMTID=n2');
});

test('口播：一句不超过 25 字；自动接着放每批第一首报幕；老板那边不闲（409）就不念；只有本人能取', async () => {
  const { voiceText, introLine } = await import('../server/public/voice.js');
  assert.equal(voiceText('晚上好。' + '长'.repeat(30)), '晚上好。');
  assert.equal(voiceText('长'.repeat(30)), '');
  assert.ok([...introLine({ title: '晴天 (Live)', artist: '周杰伦 / 某某' })].length <= 25);
  let busy = false;
  const ttsCalls = [];
  const fetchFn = async (url, init) => {
    if (String(url).endsWith('/tts')) {
      ttsCalls.push(JSON.parse(init.body).text);
      return busy ? new Response('{}', { status: 409 }) : new Response(new Uint8Array([9, 9]), { status: 200 });
    }
    return new Response('', { status: 404 });
  };
  const t = await startApp({ fetchFn, ttsUrl: 'http://127.0.0.1:8099' });
  try {
    t.hub.addMember('mem_00000001');
    t.hub.addMember('mem_00000002');
    const a = await t.join('mem_00000001');
    const b = await t.join('mem_00000002');
    const out = await t.req('/api/chat', { method: 'POST', body: { text: '' }, cookie: a });
    const first = out.data.songs[0];
    assert.match(first.say, /榜上免费歌/);
    assert.ok(first.voice);
    assert.deepEqual(ttsCalls, [first.say]);
    const mine = await fetch(`${t.base}/api/voice/${first.voice}`, { headers: { Cookie: a } });
    assert.equal(mine.status, 200);
    assert.equal(mine.headers.get('content-type'), 'audio/mpeg');
    assert.equal((await fetch(`${t.base}/api/voice/${first.voice}`, { headers: { Cookie: b } })).status, 204);
    busy = true;
    const again = await t.req('/api/chat', { method: 'POST', body: { text: '' }, cookie: a });
    assert.equal((await fetch(`${t.base}/api/voice/${again.data.songs[0].voice}`, { headers: { Cookie: a } })).status, 204);
  } finally { t.close(); }
});

test('最近听过：同一首放到最前、最多 100 首；红心没绑定只记本地，绑定了同步网易云；点回去放', async () => {
  const t = await startApp();
  try {
    t.hub.addMember('mem_00000001');
    const cookie = await t.join('mem_00000001');
    for (let i = 1; i <= 102; i += 1) {
      await t.req('/api/play/started', { method: 'POST', body: { id: i, title: `歌${i}`, artist: 'A', cover: i === 1 ? 'https://p1.music.126.net/abc==/1.jpg' : 'javascript:alert(1)' }, cookie });
    }
    await t.req('/api/play/started', { method: 'POST', body: { id: 50, title: '歌50', artist: 'A' }, cookie });
    let h = (await t.req('/api/history', { cookie })).data.songs;
    assert.equal(h.length, 100);
    assert.equal(h[0].id, 50);
    assert.equal(h.filter((s) => s.id === 50).length, 1);
    assert.ok(h.every((s) => s.cover === ''));
    // 没绑定：只记本地，不碰网易云
    assert.equal((await t.req('/api/fav', { method: 'POST', body: { id: 50 }, cookie })).data.synced, false);
    assert.ok(!t.ncmCalls.some((c) => c.startsWith('like:')));
    h = (await t.req('/api/history', { cookie })).data.songs;
    assert.equal(h[0].liked, true);
    // 绑定后：同步到网易云，取消也同步
    t.members.setCookie('mem_00000001', 'MUSIC_U=a');
    assert.equal((await t.req('/api/fav', { method: 'POST', body: { id: 60, on: true }, cookie })).data.synced, true);
    await t.req('/api/fav', { method: 'POST', body: { id: 60, on: false }, cookie });
    assert.deepEqual(t.ncmCalls.filter((c) => c.startsWith('like:')), ['like:60:true', 'like:60:false']);
    const again = await t.req('/api/song/60', { cookie });
    assert.equal(again.data.url, '/media/60');
    // 清空记忆连最近听过一起清
    await t.req('/api/memory/clear', { method: 'POST', cookie });
    assert.equal((await t.req('/api/history', { cookie })).data.songs.length, 0);
  } finally { t.close(); }
});

test('自动接着放选歌期间记下的最近听过不会被旧快照冲掉', async () => {
  const t = await startApp();
  try {
    t.hub.addMember('mem_00000001');
    const cookie = await t.join('mem_00000001');
    let open;
    t.ncmResolve.chartGate = new Promise((r) => { open = r; });
    const auto = t.req('/api/chat', { method: 'POST', body: { text: '' }, cookie });
    await new Promise((r) => setTimeout(r, 30));
    await t.req('/api/play/started', { method: 'POST', body: { id: 7, title: '正在放', artist: 'A' }, cookie });
    open();
    await auto;
    assert.deepEqual((await t.req('/api/history', { cookie })).data.songs.map((s) => s.id), [7]);
  } finally { t.close(); }
});

// ---- 没绑定的人借老板网易云（经老板实例 8099）、网易云放不了时回落备用音源 ----
function fakeOwner() {
  const calls = [];
  return {
    calls,
    async search(keywords) { calls.push(`search:${keywords}`); return [{ id: 186016, title: '晴天', artist: '周杰伦', album: '叶惠美', duration: 269, fee: 1 }]; },
    async songUrl(song) { calls.push(`url:${song.id}:${song.level}:${song.title || ''}`); return song.id === 'fk3' ? { url: 'https://a.cdn.example.org/3.mp3', level: 'exhigh', bitrate: 320000, source: 'fake' } : { url: 'https://m701.music.126.net/full.mp3', level: 'exhigh', bitrate: 320000, gain: -3 }; },
    async find(song) { calls.push(`find:${song.ncmId || ''}:${song.title}`); return { id: 'fk3', title: '晴天', artist: '周杰伦', duration: 269, url: 'https://a.cdn.example.org/3.mp3', level: 'lossless', bitrate: 1650000, source: 'fake' }; },
    async lyric(id) { calls.push(`lyric:${id}`); return '[00:00.00]x'; },
  };
}

test('借老板网易云：没绑定的人经老板实例搜和取链接（VIP 也放整曲）；本进程不发带 cookie 的请求', async () => {
  const fetched = [];
  const owner = fakeOwner();
  const ncm = createNcmClient({ base: 'http://ncm.local', owner, fetchFn: async (url, o) => { fetched.push([String(url), o.headers]); return jsonRes({}); } });
  assert.equal(ncm.borrowsOwner, true);
  const song = await ncm.resolve({ title: '晴天', artist: '周杰伦' }, { memberId: 'm1', level: 'exhigh' });
  assert.equal(song.playable, true);
  assert.equal(song.id, 186016);
  assert.equal(song.url, 'https://m701.music.126.net/full.mp3');
  assert.equal(song.trial, false);
  assert.deepEqual(owner.calls, ['search:晴天 周杰伦', 'url:186016:exhigh:晴天']);
  assert.deepEqual(fetched, []);
  // 按 id 重取（/media 过期重取）也走老板实例，带上搜到时记下的歌名
  owner.calls.length = 0;
  await ncm.songUrl(186016, { memberId: 'm1', level: 'exhigh' });
  assert.deepEqual(owner.calls, ['url:186016:exhigh:晴天']);
});

test('借老板网易云：老板那边搜索排队 / 冷却时整首用备用音源的（id 带前缀，没封面）；歌词也经老板实例取', async () => {
  const owner = fakeOwner();
  owner.search = async () => { throw Object.assign(new Error('排队中'), { code: 'NCM_BUSY' }); };
  const ncm = createNcmClient({ base: 'http://ncm.local', owner, fetchFn: async () => jsonRes({}) });
  const song = await ncm.resolve({ title: '晴天', artist: '周杰伦' }, { memberId: 'm1', level: 'exhigh' });
  assert.equal(song.id, 'fk3');
  assert.equal(song.cover, '');
  assert.equal(song.level, 'lossless');
  assert.equal(await ncm.lyric('fk3'), '[00:00.00]x');
  await assert.rejects(ncm.search('别的', { memberId: 'm1' }), NcmBusyError);
});

test('绑定的人：用自己的登录态；只有试听时经老板实例找备用音源（不借老板网易云）', async () => {
  const owner = fakeOwner();
  const ncm = createNcmClient({
    base: 'http://ncm.local', owner,
    fetchFn: async (url) => {
      const u = new URL(url);
      if (u.pathname === '/search') return jsonRes({ result: { songs: [{ id: 186016, name: '晴天', ar: [{ name: '周杰伦' }], dt: 269000, fee: 1 }] } });
      return jsonRes({ data: [{ id: 186016, url: 'http://m701.music.126.net/trial.mp3', br: 128000, freeTrialInfo: { start: 0 } }] });
    },
  });
  const song = await ncm.resolve({ title: '晴天', artist: '周杰伦' }, { cookie: 'MUSIC_U=friend', memberId: 'm2', level: 'lossless' });
  assert.equal(song.id, 186016);
  assert.equal(song.url, 'https://a.cdn.example.org/3.mp3');
  assert.equal(song.level, 'lossless');
  assert.deepEqual(owner.calls, ['find:186016:晴天']);
});

test('借老板网易云：自己点太快（按人限速）时不去备用音源绕过', async () => {
  const owner = fakeOwner();
  const ncm = createNcmClient({ base: 'http://ncm.local', owner, memberBurst: 1, memberRate: 0.001, waitMs: 0, fetchFn: async () => jsonRes({}) });
  await ncm.resolve({ title: '晴天', artist: '周杰伦' }, { memberId: 'm9', level: 'exhigh' }).catch(() => {});
  owner.calls.length = 0;
  await assert.rejects(ncm.resolve({ title: '晴天2', artist: '周杰伦' }, { memberId: 'm9', level: 'exhigh' }), /太快/);
  assert.ok(!owner.calls.some((c) => c.startsWith('find:')));
});

test('不借老板（没配 NCM_SHARED_URL）：照旧没绑定不能搜', async () => {
  const ncm = createNcmClient({ base: 'http://ncm.local', fetchFn: async () => jsonRes({}) });
  assert.equal(ncm.borrowsOwner, false);
  await assert.rejects(ncm.search('晴天', {}), /绑定网易云后才能点歌/);
});

test('app：能借老板网易云时没绑定也能点歌；备用音源的歌能放、能记最近听过，红心只记本地不碰网易云', async () => {
  const t = await startApp({ ncm: {
    borrowsOwner: true,
    resolve: async (c, o) => (t.ncmCalls.push(`resolve:${o.cookie || ''}`), { id: 'fk3', title: c.title, artist: c.artist, url: 'https://a.cdn.example.org/3.mp3', level: 'exhigh', bitrate: 320000, playable: true }),
    songUrl: async (id) => (t.ncmCalls.push(`url:${id}`), { url: 'https://a.cdn.example.org/3.mp3', level: 'exhigh', bitrate: 320000 }),
  } });
  try {
    t.hub.addMember('mem_00000001');
    const cookie = await t.join('mem_00000001');
    const ask = await t.req('/api/chat', { method: 'POST', body: { text: '来首晴天' }, cookie });
    assert.equal(ask.status, 200);
    assert.equal(ask.data.needBind, undefined);
    assert.equal(t.brainAsks.length, 1);
    assert.deepEqual(ask.data.songs.map((s) => [s.id, s.url]), [['fk3', '/media/fk3']]);
    assert.ok(t.ncmCalls.includes('resolve:'));

    const started = await t.req('/api/play/started', { method: 'POST', body: { id: 'fk3', title: '晴天', artist: '周杰伦' }, cookie });
    assert.equal(started.status, 200);
    assert.equal(t.members.memory('mem_00000001').history[0].id, 'fk3');

    const fav = await t.req('/api/fav', { method: 'POST', body: { id: 'fk3', title: '晴天', artist: '周杰伦' }, cookie });
    assert.deepEqual(fav.data, { ok: true, liked: true, synced: false });
    assert.ok(!t.ncmCalls.some((c) => c.startsWith('like:')));
    const hist = await t.req('/api/history', { cookie });
    assert.deepEqual(hist.data.songs.map((x) => [x.id, x.liked]), [['fk3', true]]);
    assert.equal((await t.req('/api/me', { cookie })).data.canAsk, true);

    const back = await t.req('/api/song/fk3', { cookie });
    assert.equal(back.status, 200);
    assert.equal(back.data.id, 'fk3');
    assert.equal((await t.req('/api/song/..%2Fx', { cookie })).status, 400);
    assert.equal((await t.req('/api/lyric?id=FK3', { cookie })).status, 400);
  } finally { t.close(); }
});
