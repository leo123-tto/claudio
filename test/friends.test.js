import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createFriendStore, cleanNote, cleanName, noteProblem, judgePrompt, OWNER_ID, FriendError } from '../server/public/friends.js';

const A = 'mem_aaaaaaaa';
const B = 'mem_bbbbbbbb';
const C = 'mem_cccccccc';
const song = (id, title = `歌${id}`) => ({ id, title, artist: '某人', cover: 'https://p1.music.126.net/x/y.jpg', duration: 200 });

function setup(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friends-'));
  const file = path.join(dir, 'friends.enc');
  const clock = { t: Date.parse('2026-11-23T10:00:00Z') };
  let n = 100000;
  const make = () => createFriendStore({ file, vaultKey: opts.key || key, now: () => clock.t, randomCode: () => String(n++), ...opts });
  return { file, clock, make, store: make(), dir };
}
const key = crypto.randomBytes(32);

function befriend(store, a, b) {
  const { code } = store.createCode(a);
  return store.redeem(b, code);
}

test('好友码互加、自己的码、过期、用一次', () => {
  const { store, clock } = setup();
  store.seen(A, '小王');
  const { code } = store.createCode(A);
  assert.throws(() => store.redeem(A, code), (e) => e.code === 'self');
  assert.deepEqual(store.redeem(B, code), { id: A, name: '小王' });
  assert.ok(store.isFriend(A, B));
  assert.deepEqual(store.friends(B).map((f) => f.id), [A]);
  assert.deepEqual(store.friends(A).map((f) => f.id), [B]);
  assert.throws(() => store.redeem(C, code), (e) => e.code === 'bad-code' && e.status === 403);
  const second = store.createCode(A).code;
  clock.t += 16 * 60_000;
  assert.throws(() => store.redeem(C, second), (e) => e.code === 'bad-code');
});

test('同一人再生成好友码，旧码作废', () => {
  const { store } = setup();
  const first = store.createCode(A).code;
  store.createCode(A);
  assert.throws(() => store.redeem(B, first), (e) => e.code === 'bad-code');
});

test('不认识的 id 不收', () => {
  const { store } = setup();
  assert.throws(() => store.createCode('../x'), FriendError);
  assert.throws(() => store.recommend(A, 'mem_zz', song(1)), FriendError);
});

test('推荐：要先是好友；上限、去重、收件箱满、不接收', () => {
  const { store, clock } = setup();
  assert.throws(() => store.recommend(A, B, song(1)), (e) => e.code === 'not-friend');
  befriend(store, A, B);
  befriend(store, A, C);
  assert.throws(() => store.recommend(A, A, song(1)), (e) => e.code === 'self');
  store.recommend(A, B, song(1));
  assert.throws(() => store.recommend(A, B, song(1)), (e) => e.code === 'duplicate');
  store.recommend(A, B, song(2));
  store.recommend(A, B, song(3));
  assert.throws(() => store.recommend(A, B, song(4)), (e) => e.code === 'pair-limit' && e.status === 429);
  store.recommend(A, C, song(4));
  store.recommend(A, C, song(5));
  assert.equal(store.dayLeft(A), 0);
  assert.throws(() => store.recommend(A, C, song(6)), (e) => e.code === 'day-limit');
  clock.t += 25 * 3600_000;
  assert.equal(store.dayLeft(A), 5);
  assert.throws(() => store.recommend(A, B, song(1)), (e) => e.code === 'duplicate', '90 天内同一首不再推');
  store.setProfile(C, { accept: false });
  assert.throws(() => store.recommend(A, C, song(7)), (e) => e.code === 'not-accepting');
});

test('收件箱攒满 20 条没播的就不收了', () => {
  const { store, clock } = setup({ limits: { perDay: 99, pairPerDay: 99, sameSongDays: 90, inboxPending: 3, expireDays: 14, noteMax: 30, nickMax: 12, friendsMax: 50, codeMinutes: 15, listMax: 100, offerAgainMs: 1, gapMs: 0, noteWaitMs: 0 } });
  befriend(store, A, B);
  for (let i = 1; i <= 3; i++) store.recommend(A, B, song(i));
  assert.throws(() => store.recommend(A, B, song(9)), (e) => e.code === 'inbox-full');
  clock.t += 1;
});

test('歌的信息不全或 id 不像歌不收；封面只收网易云图床', () => {
  const { store } = setup();
  befriend(store, A, B);
  assert.throws(() => store.recommend(A, B, { id: 'javascript:1', title: 'x' }), (e) => e.code === 'bad-song');
  assert.throws(() => store.recommend(A, B, { id: 5 }), (e) => e.code === 'bad-song');
  const r = store.recommend(A, B, { id: 'kw123', title: '备用', artist: 'x', cover: 'https://evil.example/a.jpg' });
  assert.equal(r.song.cover, '');
  assert.equal(r.song.id, 'kw123');
});

test('插播：最早的先给，隔 10 分钟才给下一首；半小时没开播再给', () => {
  const { store, clock } = setup();
  befriend(store, A, B);
  store.recommend(A, B, song(1));
  store.recommend(A, B, song(2));
  const first = store.next(B);
  assert.equal(first.song.id, 1);
  assert.equal(first.from.id, A);
  assert.equal(store.next(B), null, '10 分钟内不再插');
  clock.t += 11 * 60_000;
  const second = store.next(B);
  assert.equal(second.song.id, 2, '第一首刚给过、还没满半小时，先给第二首');
  store.played(B, second.id);
  clock.t += 25 * 60_000;
  const again = store.next(B);
  assert.equal(again.id, first.id, '第一首给过半小时还没开播，再给一次');
  store.played(B, again.id);
  clock.t += 11 * 60_000;
  assert.equal(store.next(B), null);
});

test('附言：判完才带；在判时最多等 3 分钟，判不过的不给对方', () => {
  const { store, clock } = setup();
  befriend(store, A, B);
  const r = store.recommend(A, B, song(1), '下雨天听这个');
  assert.equal(r.noteState, 'pending');
  assert.equal(store.next(B), null, '附言还在判，先等等');
  clock.t += 4 * 60_000;
  const d = store.next(B);
  assert.equal(d.note, '', '等不及了，送的时候不带附言');
  store.setNoteVerdict(r.id, true);
  assert.equal(store.inbox(B)[0].note, '下雨天听这个');
  const r2 = store.recommend(A, B, song(2), '坏话');
  store.setNoteVerdict(r2.id, false);
  assert.equal(store.inbox(B).find((x) => x.id === r2.id).note, '');
  assert.equal(store.sent(A).find((x) => x.id === r2.id).noteState, 'rejected');
  store.setNoteVerdict(r2.id, true);
  assert.equal(store.sent(A).find((x) => x.id === r2.id).noteState, 'rejected', '判过的不再改');
});

test('推荐人看不到被跳过：给了没放仍是「已送达」，放了是已播，好听带红心', () => {
  const { store, clock } = setup();
  befriend(store, A, B);
  const r1 = store.recommend(A, B, song(1));
  const r2 = store.recommend(A, B, song(2));
  store.next(B);
  assert.equal(store.sent(A).find((x) => x.id === r1.id).status, 'sent');
  store.played(B, r1.id);
  assert.equal(store.sent(A).find((x) => x.id === r1.id).status, 'played');
  store.likeSong(B, 1);
  const seen = store.sent(A).find((x) => x.id === r1.id);
  assert.equal(seen.liked, true);
  assert.ok(!('skipped' in seen) && !('offeredAt' in seen) && !('playedAt' in seen));
  clock.t += 15 * 24 * 3600_000;
  assert.equal(store.sent(A).find((x) => x.id === r2.id).status, 'expired');
  assert.equal(store.inbox(B).find((x) => x.id === r2.id).status, 'expired');
});

test('屏蔽：解除好友，之后发的静默丢弃，发的人仍看到「已送达」', () => {
  const { store } = setup();
  befriend(store, A, B);
  const before = store.recommend(A, B, song(1));
  store.block(B, A);
  assert.equal(store.isFriend(A, B), false);
  const after = store.recommend(A, B, song(2));
  assert.equal(after.status, 'sent');
  assert.equal(store.next(B, { force: true }), null, '屏蔽的人发的都不给');
  assert.deepEqual(store.inbox(B), []);
  assert.equal(store.sent(A).find((x) => x.id === before.id).status, 'sent');
  assert.throws(() => store.played(B, after.id), (e) => e.code === 'no-rec');
  assert.deepEqual(store.me(B).blocked.map((b) => b.id), [A]);
  store.unblock(B, A);
  assert.deepEqual(store.inbox(B), [], '解除屏蔽后，屏蔽前没播的也不会冒出来');
  assert.throws(() => store.recommend(A, B, song(3)), (e) => e.code === 'not-friend', '解除屏蔽不等于加回好友');
  befriend(store, B, A);
  assert.ok(store.isFriend(A, B));
});

test('互加时解开两边的屏蔽', () => {
  const { store } = setup();
  befriend(store, A, B);
  store.block(B, A);
  befriend(store, A, B);
  assert.deepEqual(store.me(B).blocked, []);
});

test('隐私：每人只拿得到自己的那份；别人的推荐取不到', () => {
  const { store } = setup();
  befriend(store, A, B);
  befriend(store, A, C);
  const r = store.recommend(A, B, song(1), '只给B');
  assert.deepEqual(store.inbox(C), []);
  assert.deepEqual(store.sent(C), []);
  assert.throws(() => store.played(C, r.id), (e) => e.code === 'no-rec');
  assert.throws(() => store.like(A, r.id), (e) => e.code === 'no-rec', '发的人不能替收的人点好听');
  const view = store.overview(C, '小陈');
  assert.deepEqual(Object.keys(view).sort(), ['dayLeft', 'friends', 'inbox', 'me', 'noteMax', 'sent']);
  assert.deepEqual(view.friends.map((f) => Object.keys(f).sort()), [['accept', 'id', 'name']]);
});

test('落盘加密：文件里看不到歌名和附言；换钥匙读不出、不覆盖原文件', () => {
  const { store, file, make, dir } = setup();
  befriend(store, A, B);
  store.recommend(A, B, song(1, '晴天'), '下雨天');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('晴天') && !raw.includes('下雨天') && !raw.includes(A));
  assert.equal(make().inbox(B).length, 1, '同一把钥匙重开读得回来');
  const other = createFriendStore({ file, vaultKey: crypto.randomBytes(32) });
  assert.deepEqual(other.inbox(B), []);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('friends.enc.bad-')), '读不出的原文件留着');
});

test('成员删除：关系、好友码、推荐全清', () => {
  const { store } = setup();
  befriend(store, A, B);
  befriend(store, B, C);
  store.recommend(A, B, song(1));
  store.recommend(B, A, song(2));
  store.block(C, A);
  store.createCode(A);
  assert.deepEqual(store.ids().sort(), [A, B, C].sort());
  assert.equal(store.purge(A), true);
  assert.equal(store.purge(A), false);
  assert.deepEqual(store.friends(B).map((f) => f.id), [C]);
  assert.deepEqual(store.inbox(B), []);
  assert.deepEqual(store.sent(B), []);
  assert.deepEqual(store.me(C).blocked, []);
});

test('老板也在圈子里：默认叫站长，能互加互推', () => {
  const { store } = setup({ ownerName: '站长老王' });
  befriend(store, OWNER_ID, A);
  assert.equal(store.friends(A)[0].name, '站长老王');
  store.recommend(A, OWNER_ID, song(1));
  assert.equal(store.next(OWNER_ID).from.id, A);
  store.recommend(OWNER_ID, A, song(2));
  assert.equal(store.inbox(A)[0].from.name, '站长老王');
});

test('昵称：自己改的优先，去掉标记和换行、截到 12 字', () => {
  const { store } = setup();
  store.seen(A, '小王\n<b>');
  assert.equal(store.nameOf(A), '小王 b');
  store.setProfile(A, { nick: '[laugh]大王<script>一二三四五六七八九十' });
  assert.equal([...store.nameOf(A)].length <= 12, true);
  assert.ok(!/[[\]<>]/.test(store.nameOf(A)));
  assert.equal(store.nameOf(C), '朋友');
});

test('统计只给数字', () => {
  const { store } = setup();
  befriend(store, A, B);
  const r = store.recommend(A, B, song(1), '附言');
  store.played(B, r.id);
  assert.deepEqual(store.stats(), { friendPairs: 1, recsToday: 1, recsTotal: 1, playedToday: 1 });
});

test('附言清洗和本地规则', () => {
  assert.equal(cleanNote('  下雨天\n听这个[laugh] <b>  '), '下雨天 听这个');
  assert.equal(cleanNote('a{b}c'), 'a b c');
  assert.equal(cleanName('【小王】"x"'), '小王 x');
  assert.equal(noteProblem(''), '');
  assert.equal(noteProblem('一'.repeat(31)), 'too-long');
  assert.equal(noteProblem('看 www.x.com'), 'link');
  assert.equal(noteProblem('打 13812345678'), 'number');
  assert.equal(noteProblem('号码 123 456 789'), 'number');
  assert.equal(noteProblem('加我微信'), 'contact');
  assert.equal(noteProblem('这首超赞', ['超赞']), 'word');
  assert.equal(noteProblem('下雨天听这个，想起 2019 年'), '');
  assert.match(judgePrompt('你好'), /「你好」/);
});
