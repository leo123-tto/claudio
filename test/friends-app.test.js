// 好友互荐（事项 26）接到公用版和老板内部口之后的整条链路：加好友、推荐、插播、报幕、反馈、隐私、清理。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createMemberStore, parseVaultKey } from '../server/public/members.js';
import { createPublicApp, syncWithHub } from '../server/public/app.js';
import { createFriendStore, OWNER_ID } from '../server/public/friends.js';
import { createOwnerApp, parseRecText, matchFriend, checkNick } from '../server/public/friends-routes.js';
import { HubError } from '../server/public/hub-client.js';
import { buildPrompt } from '../server/public/brain.js';
import { recIntro, withNote, VOICE_MAX } from '../server/public/voice.js';

const KEY = parseVaultKey('22'.repeat(32));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-friends-'));
const A = 'mem_0000000a';
const B = 'mem_0000000b';
const C = 'mem_0000000c';

function fakeHub() {
  const members = new Map();
  const devices = new Map();
  let seq = 0;
  const hub = {
    members,
    addMember(id, name) { members.set(id, { id, name, daily_total: 50, used: 0, max_devices: 3, status: 'active' }); },
    link: new Map(),
    view(m) { return { id: m.id, name: m.name, remaining: m.daily_total - m.used, daily_total: m.daily_total, devices: 1, max_devices: 3, expires: '' }; },
    async redeemLink(token) {
      const mid = hub.link.get(token);
      if (!mid) throw new HubError(403, 'invalid');
      const dt = `dev-${++seq}`;
      devices.set(dt, { id: `dev_${seq}`, member: mid });
      return { device_token: dt, device_id: `dev_${seq}`, member: hub.view(members.get(mid)) };
    },
    async verify(token) {
      const d = devices.get(token);
      if (!d) throw new HubError(403, 'invalid');
      const m = members.get(d.member);
      if (m.status !== 'active') throw new HubError(403, m.status);
      return { device_id: d.id, member: hub.view(m) };
    },
    forget() {},
    async consume(mid) { const m = members.get(mid); m.used += 1; return { remaining: m.daily_total - m.used }; },
    async states() { return { members: [...members.values()].map((m) => ({ id: m.id, status: m.status })) }; },
    async report() { return {}; },
  };
  return hub;
}

async function startApp({ judge = async () => true, playable = () => true, askIdle = null, ttsCalls = null } = {}) {
  const hub = fakeHub();
  const members = createMemberStore({ root: tmp(), vaultKey: KEY });
  const friends = createFriendStore({ file: path.join(tmp(), 'friends.enc'), vaultKey: KEY, ownerName: '站长' });
  const webRoot = tmp();
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html>');
  const calls = [];
  const ncm = {
    freeChart: async () => [{ id: 11, title: '榜上歌', artist: 'C' }],
    playById: async (song, o) => {
      calls.push(`id:${song.id}:${o.cookie || ''}`);
      return playable(song) ? { ...song, url: `https://m.music.126.net/${song.id}.mp3`, playable: true } : { ...song, playable: false, reason: 'no-url' };
    },
    like: async () => true,
    lyric: async () => '',
  };
  const brain = {
    gate: { full: false },
    ask: async () => { throw new Error('不该叫大脑'); },
    judge: async (prompt) => judge(prompt),
    ...(askIdle ? { askIdle } : {}),
  };
  const fetchFn = async (url, init) => {
    if (!String(url).endsWith('/tts')) return new Response('', { status: 404 });
    ttsCalls?.push(JSON.parse(init.body).text);
    return new Response(new Uint8Array([9]), { status: 200 });
  };
  const { app, recommendFriend } = createPublicApp({
    hub, members, ncm, brain, webRoot, cookieSecure: false, friends, friendWords: () => ['坏词'], ownerName: '站长',
    ttsUrl: ttsCalls ? 'http://127.0.0.1:8099' : '', fetchFn,
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const owner = http.createServer(createOwnerApp({ friends, recommend: recommendFriend, words: () => [] }));
  await new Promise((r) => owner.listen(0, '127.0.0.1', r));
  const ownerBase = `http://127.0.0.1:${owner.address().port}`;
  const call = async (root, pathname, { method = 'GET', body, cookie } = {}) => {
    const res = await fetch(root + pathname, {
      method: body ? 'POST' : method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const req = (p, o) => call(base, p, o);
  const own = (p, body) => call(ownerBase, p, body === undefined ? {} : { body });
  const join = async (mid, name) => {
    hub.addMember(mid, name);
    hub.link.set(`link-${mid}`, mid);
    const res = await fetch(`${base}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: `link-${mid}` }) });
    return res.headers.get('set-cookie').split(';')[0];
  };
  const listen = (cookie, song) => req('/api/play/started', { body: song, cookie });
  const befriend = async (ca, cb) => {
    const { data } = await req('/api/friends/code', { body: {}, cookie: ca });
    return req('/api/friends/add', { body: { code: data.code }, cookie: cb });
  };
  return {
    hub, members, friends, calls, req, own, join, listen, befriend, base, ownerBase,
    close: () => { server.close(); owner.close(); },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('网页：/api/mode 露出 friends；没设备 401', async () => {
  const t = await startApp();
  try {
    assert.equal((await t.req('/api/mode')).data.features.friends, true);
    assert.equal((await t.req('/api/friends')).status, 401);
  } finally { t.close(); }
});

test('加好友、推荐、插播第一首、报幕带名字和附言、开播算已播、红心算好听；推荐人看不到跳过', async () => {
  const ttsCalls = [];
  const t = await startApp({ ttsCalls });
  try {
    const a = await t.join(A, '小王');
    const b = await t.join(B, '小李');
    assert.equal((await t.befriend(a, b)).data.friend.name, '小王');
    assert.deepEqual((await t.req('/api/friends', { cookie: a })).data.friends.map((f) => f.name), ['小李']);
    // 只能推荐自己听过的
    assert.equal((await t.req('/api/friends/recommend', { body: { to: B, songId: 777 }, cookie: a })).data.error, 'bad-song');
    await t.listen(a, { id: 777, title: '晴天', artist: '周杰伦', cover: 'https://p1.music.126.net/a/b.jpg' });
    // 本地规则不过：整条不发
    const bad = await t.req('/api/friends/recommend', { body: { to: B, songId: 777, note: '加我微信' }, cookie: a });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error, 'note-contact');
    const ok = await t.req('/api/friends/recommend', { body: { to: B, songId: 777, note: '下雨天[laugh]听这个' }, cookie: a });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.rec.note, '下雨天听这个');
    await settle();
    assert.equal((await t.req('/api/friends', { cookie: a })).data.sent[0].noteState, 'ok');
    // B 下一批：推荐的歌排第一首，用 B 自己的登录态（没绑定 = 空 cookie）去取
    const batch = (await t.req('/api/chat', { body: { text: '' }, cookie: b })).data;
    assert.equal(batch.songs[0].id, 777);
    assert.equal(batch.songs[0].rec.from, '小王');
    assert.equal(batch.songs[0].rec.note, '下雨天听这个');
    assert.equal(batch.songs[0].say, '小王给你推荐了周杰伦的《晴天》：「下雨天听这个」');
    assert.ok(t.calls.includes('id:777:'));
    assert.match(ttsCalls.at(-1), /小王给你推荐了《晴天》.*小王留了句话：下雨天听这个/);
    // 下一批不再插（隔 10 分钟）
    const again = (await t.req('/api/chat', { body: { text: '' }, cookie: b })).data;
    assert.ok(!again.songs.some((s) => s.rec));
    // 发出去还没放：A 看到「已送达」；B 开播、红心
    assert.equal((await t.req('/api/friends', { cookie: a })).data.sent[0].status, 'sent');
    await t.listen(b, { id: 777, title: '晴天', artist: '周杰伦', rec: batch.songs[0].rec.id });
    assert.equal((await t.req('/api/friends', { cookie: a })).data.sent[0].status, 'played');
    await t.req('/api/fav', { body: { id: 777, title: '晴天', artist: '周杰伦' }, cookie: b });
    const sent = (await t.req('/api/friends', { cookie: a })).data.sent[0];
    assert.equal(sent.liked, true);
    assert.deepEqual(Object.keys(sent).sort(), ['at', 'id', 'liked', 'note', 'noteState', 'song', 'status', 'to']);
    // 隐私：C 拿不到 A、B 之间的任何东西，也不能替 B 点好听
    const c = await t.join(C, '小陈');
    const cView = (await t.req('/api/friends', { cookie: c })).data;
    assert.deepEqual([cView.friends, cView.inbox, cView.sent], [[], [], []]);
    assert.equal((await t.req('/api/friends/like', { body: { rec: batch.songs[0].rec.id }, cookie: c })).status, 404);
    assert.equal((await t.req('/api/friends/recommend', { body: { to: B, songId: 777 }, cookie: c })).data.error, 'bad-song');
  } finally { t.close(); }
});

test('附言大脑判不过 / 判不了：只推荐歌，收的人看不到、不念；推荐人看到没通过', async () => {
  for (const verdict of [false, null]) {
    const ttsCalls = [];
    const t = await startApp({ judge: async () => verdict, ttsCalls });
    try {
      const a = await t.join(A, '小王');
      const b = await t.join(B, '小李');
      await t.befriend(a, b);
      await t.listen(a, { id: 5, title: '歌五', artist: '某' });
      await t.req('/api/friends/recommend', { body: { to: B, songId: 5, note: '一句话' }, cookie: a });
      await settle();
      assert.equal((await t.req('/api/friends', { cookie: a })).data.sent[0].noteState, 'rejected');
      const batch = (await t.req('/api/chat', { body: { text: '' }, cookie: b })).data;
      assert.equal(batch.songs[0].rec.note, '');
      assert.equal(batch.songs[0].say, '小王给你推荐了某的《歌五》。');
      assert.ok(!ttsCalls.at(-1).includes('一句话'));
    } finally { t.close(); }
  }
});

test('对 DJ 说「把这首推荐给小李，说……」：不打大脑、不扣次数；没这个好友就问', async () => {
  const t = await startApp();
  try {
    const a = await t.join(A, '小王');
    const b = await t.join(B, '小李');
    await t.befriend(a, b);
    await t.listen(a, { id: 9, title: '歌九', artist: '某' });
    const used = t.hub.members.get(A).used;
    const r = (await t.req('/api/chat', { body: { text: '把这首推荐给小李，说早点睡' }, cookie: a })).data;
    assert.match(r.say, /《歌九》推荐给小李了/);
    assert.equal(r.remaining, null);
    assert.equal(t.hub.members.get(A).used, used);
    assert.equal((await t.req('/api/friends', { cookie: a })).data.sent[0].note, '早点睡');
    const miss = (await t.req('/api/chat', { body: { text: '把这首推荐给老张' }, cookie: a })).data;
    assert.match(miss.say, /没找到「老张」/);
    // 没说「这首」、名字也不是好友：照常交给大脑（这里的假大脑会抛错 → 降级搜歌，不会回「没找到」）
    const normal = (await t.req('/api/chat', { body: { text: '推荐给大伙儿几首老歌' }, cookie: a })).data;
    assert.ok(!/没找到/.test(normal.say || ''));
  } finally { t.close(); }
});

test('放不了：标出来不再给，不卡这一批', async () => {
  const t = await startApp({ playable: (s) => s.id !== 66 });
  try {
    const a = await t.join(A, '小王');
    const b = await t.join(B, '小李');
    await t.befriend(a, b);
    await t.listen(a, { id: 66, title: '灰歌', artist: '某' });
    await t.req('/api/friends/recommend', { body: { to: B, songId: 66 }, cookie: a });
    const batch = (await t.req('/api/chat', { body: { text: '' }, cookie: b })).data;
    assert.ok(batch.songs.length && !batch.songs.some((s) => s.rec));
    assert.equal((await t.req('/api/friends', { cookie: b })).data.inbox[0].status, 'unplayable');
  } finally { t.close(); }
});

test('口播频率「几乎不说」：别的歌不报，好友推荐照样报幕', async () => {
  const t = await startApp({ ttsCalls: [] });
  try {
    const a = await t.join(A, '小王');
    const b = await t.join(B, '小李');
    await t.befriend(a, b);
    await t.req('/api/talk', { body: { level: 'minimal' }, cookie: b });
    await t.req('/api/chat', { body: { text: '' }, cookie: b }); // 开头问好那一次
    const quiet = (await t.req('/api/chat', { body: { text: '' }, cookie: b })).data;
    assert.equal(quiet.songs[0].voice, undefined);
    await t.listen(a, { id: 3, title: '歌三', artist: '某' });
    await t.req('/api/friends/recommend', { body: { to: B, songId: 3 }, cookie: a });
    const out = (await t.req('/api/chat', { body: { text: '' }, cookie: b })).data;
    assert.equal(out.songs[0].id, 3);
    assert.ok(out.songs[0].voice);
    assert.ok(out.songs[0].say.startsWith('小王给你推荐了'));
  } finally { t.close(); }
});

test('屏蔽：对方照样看到已送达，自己这边永远不来；好友码试错按 IP 限次', async () => {
  const t = await startApp();
  try {
    const a = await t.join(A, '小王');
    const b = await t.join(B, '小李');
    await t.befriend(a, b);
    await t.req('/api/friends/block', { body: { id: A }, cookie: b });
    await t.listen(a, { id: 8, title: '歌八', artist: '某' });
    const r = await t.req('/api/friends/recommend', { body: { to: B, songId: 8 }, cookie: a });
    assert.equal(r.data.rec.status, 'sent', '被屏蔽的人照样看到已送达');
    assert.deepEqual((await t.req('/api/friends', { cookie: a })).data.friends, [], '屏蔽同时解除好友');
    assert.deepEqual((await t.req('/api/friends', { cookie: b })).data.inbox, []);
    assert.ok(!(await t.req('/api/chat', { body: { text: '' }, cookie: b })).data.songs.some((s) => s.rec));
    for (let i = 0; i < 10; i++) await t.req('/api/friends/add', { body: { code: '000000' }, cookie: a });
    assert.equal((await t.req('/api/friends/add', { body: { code: '000000' }, cookie: a })).status, 429);
  } finally { t.close(); }
});

test('昵称：过本地规则，不能冒充站长', async () => {
  const t = await startApp();
  try {
    const a = await t.join(A, '小王');
    assert.equal((await t.req('/api/friends/profile', { body: { nick: '站长' }, cookie: a })).data.error, 'nick-owner');
    assert.equal((await t.req('/api/friends/profile', { body: { nick: '坏词哥' }, cookie: a })).data.error, 'nick-word');
    assert.equal((await t.req('/api/friends/profile', { body: { nick: '王老五', accept: false }, cookie: a })).data.name, '王老五');
    assert.throws(() => checkNick('13812345678'), /昵称/);
  } finally { t.close(); }
});

test('老板内部口：互加、互推；老板的附言不叫大脑；/owner 不挂在对外口上', async () => {
  let judged = 0;
  const t = await startApp({ judge: async () => { judged += 1; return true; } });
  try {
    const a = await t.join(A, '小王');
    const { data: code } = await t.own('/owner/code', {});
    assert.equal((await t.req('/api/friends/add', { body: { code: code.code }, cookie: a })).data.friend.name, '站长');
    assert.equal((await t.req('/owner/overview')).status, 404, '对外口没有 /owner');
    // 老板推给小王：附言直接算通过
    const sent = await t.own('/owner/recommend', { to: A, song: { id: 42, title: '老板的歌', artist: '某' }, note: '听听这个' });
    assert.equal(sent.data.rec.noteState, 'ok');
    assert.equal(judged, 0);
    assert.equal((await t.req('/api/friends', { cookie: a })).data.inbox[0].note, '听听这个');
    // 小王推给老板
    await t.listen(a, { id: 43, title: '给老板', artist: '某' });
    await t.req('/api/friends/recommend', { body: { to: OWNER_ID, songId: 43 }, cookie: a });
    const next = (await t.own('/owner/next', {})).data.rec;
    assert.equal(next.song.id, 43);
    assert.equal(next.from.name, '小王');
    await t.own('/owner/played', { rec: next.id });
    await t.own('/owner/like-song', { songId: 43 });
    const view = (await t.req('/api/friends', { cookie: a })).data.sent.find((s) => s.song.id === 43);
    assert.equal(view.status, 'played');
    assert.equal(view.liked, true);
    assert.deepEqual(Object.keys((await t.own('/owner/stats')).data).sort(), ['friendPairs', 'playedToday', 'recsToday', 'recsTotal']);
    assert.equal((await t.own('/owner/remove', { id: A })).status, 200);
    assert.deepEqual((await t.own('/owner/overview')).data.friends, []);
  } finally { t.close(); }
});

test('内部口只认本机来源', async () => {
  const friends = createFriendStore({ file: path.join(tmp(), 'f.enc'), vaultKey: KEY });
  const app = createOwnerApp({ friends, recommend: () => ({}), words: () => [] });
  const res = { statusCode: 0, status(c) { this.statusCode = c; return this; }, json() { return this; } };
  let passed = false;
  app.handle({ method: 'GET', url: '/owner/overview', headers: {}, socket: { remoteAddress: '203.0.113.9' } }, res, () => { passed = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(passed, false);
});

test('同步：hub 删掉的人从好友圈清掉（只用过好友的也清），老板不动', async () => {
  const t = await startApp();
  try {
    const a = await t.join(A, '小王');
    const b = await t.join(B, '小李');
    await t.befriend(a, b);
    const { data: code } = await t.own('/owner/code', {});
    await t.req('/api/friends/add', { body: { code: code.code }, cookie: a });
    t.hub.members.get(A).status = 'disabled';
    await syncWithHub({ hub: t.hub, members: t.members, friends: t.friends });
    assert.deepEqual(t.friends.friends(B), []);
    assert.deepEqual(t.friends.friends(OWNER_ID), []);
    assert.ok(!t.friends.ids().includes(A));
  } finally { t.close(); }
});

test('报幕：大脑只拿到推荐人名字、拿不到附言；第一句带出处；附言放不下就不念', () => {
  const prompt = buildPrompt({ persona: 'P', memory: {}, bound: true, hour: 10, intro: { title: '晴天', artist: '周杰伦', from: '小王' } });
  assert.match(prompt, /第一句必须是「小王给你推荐了《晴天》」/);
  const { say, speak } = recIntro({ from: '小王', song: { title: '晴天（Live）', artist: '周杰伦 / 某' }, note: '下雨天' }, () => 0);
  assert.equal(say, '小王给你推荐了周杰伦的《晴天》：「下雨天」');
  assert.ok(speak.startsWith('小王给你推荐了《晴天》'));
  assert.ok(!/ta/.test(speak));
  const long = withNote('小王给你推荐了《晴天》。' + '好'.repeat(80) + '。', '小王', '一'.repeat(30));
  assert.ok(!long.includes('一一'));
  assert.ok([...long].length <= VOICE_MAX + 5);
});

test('说法解析：几种「推荐给」', () => {
  assert.deepEqual(parseRecText('把这首推荐给小李'), { name: '小李', note: '', explicit: true });
  assert.deepEqual(parseRecText('推荐给小李，说早点睡。'), { name: '小李', note: '早点睡', explicit: false });
  assert.deepEqual(parseRecText('把这首歌分享给 老张 跟他说 想你了'), { name: '老张', note: '想你了', explicit: true });
  assert.equal(parseRecText('来点推荐'), null);
  assert.equal(parseRecText('给我推荐点歌'), null);
  assert.equal(parseRecText('推荐给我几首周杰伦的歌'), null);
  assert.equal(parseRecText('发给我点轻音乐'), null);
  assert.equal(parseRecText('分享给我一首歌'), null);
  assert.deepEqual(matchFriend([{ name: '小李' }, { name: '小李子' }], '小李').hits.length, 1);
  assert.deepEqual(matchFriend([{ name: '李雷' }, { name: '李华' }], '李').hits.length, 2);
});
