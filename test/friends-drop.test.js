import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createFriendStore, LIMITS } from '../server/public/friends.js';

// 问过没听：Vera 问「要不要听」，对方没回或回了不听 → drop。
// 记录不能消失（用户之后问「刚才谁推荐了什么」还要说得出来），也不能再自动插播。
const A = 'mem_aaaaaaaa';
const B = 'mem_bbbbbbbb';
const key = crypto.randomBytes(32);
const song = (id, title = `歌${id}`) => ({ id, title, artist: '某人', cover: 'https://p1.music.126.net/x/y.jpg', duration: 200 });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friends-drop-'));
  const clock = { t: Date.parse('2026-11-23T10:00:00Z') };
  let n = 100000;
  const store = createFriendStore({
    file: path.join(dir, 'friends.enc'), vaultKey: key, now: () => clock.t, randomCode: () => String(n++),
  });
  store.seen(A, '小王');
  store.seen(B, '小李');
  const { code } = store.createCode(A);
  store.redeem(B, code);
  return { store, clock, dir };
}

test('drop 之后不再被 next 挑走，但还在收件箱里', () => {
  const { store, clock } = setup();
  const rec = store.recommend(A, B, song('1', '晴天'));
  const offered = store.next(B);
  assert.equal(offered.id, rec.id, '第一次会交给网页去问');

  store.drop(B, rec.id);
  // 时间推过 offerAgainMs，否则 next 本来就返回 null，测不出「被丢弃」这件事
  clock.t += LIMITS.offerAgainMs + 1000;
  assert.equal(store.next(B), null, '丢弃后不该再自动插播');

  const inbox = store.inbox(B);
  const one = inbox.find((r) => r.id === rec.id);
  assert.ok(one, '记录要留着，找回靠它');
  assert.equal(one.status, 'dropped');
});

test('drop 之后收件箱里的待播数下降（不占名额）', () => {
  const { store } = setup();
  const recs = [
    store.recommend(A, B, song('11', '第一首')),
    store.recommend(A, B, song('12', '第二首')),
    store.recommend(A, B, song('13', '第三首')),
  ];
  const pending = () => store.inbox(B).filter((r) => r.status === 'new').length;
  assert.equal(pending(), 3);

  store.drop(B, recs[0].id);
  store.drop(B, recs[1].id);
  assert.equal(pending(), 1, '丢弃的两首不再算待播');
});

test('找回来的那首重新排队并会被 next 挑中', () => {
  const { store, clock } = setup();
  const rec = store.recommend(A, B, song('2', '十年'));
  store.next(B);
  store.drop(B, rec.id);
  assert.equal(store.droppedList(B).length, 1);

  const back = store.recover(B, rec.id);
  assert.equal(back.status, 'new', '恢复后是待播状态');
  clock.t += LIMITS.offerAgainMs + 1000;
  assert.equal(store.next(B)?.id, rec.id, '恢复后应该能被挑中');
});

test('droppedList 只给本人、只看最近的、按时间倒序', () => {
  const { store, clock } = setup();
  const first = store.recommend(A, B, song('3', '老歌'));
  clock.t += 1000;
  const second = store.recommend(A, B, song('4', '新歌'));
  store.drop(B, second.id);
  clock.t += 1000;
  store.drop(B, first.id);

  const list = store.droppedList(B);
  assert.deepEqual(list.map((r) => r.song.title), ['老歌', '新歌'], '最近丢弃的排前面');
  assert.equal(store.droppedList(A).length, 0, '推荐人看不到对方丢弃了什么');
});

test('超过 lostDays 的丢弃记录不再念', () => {
  const { store, clock } = setup();
  const rec = store.recommend(A, B, song('5', '过时的'));
  store.drop(B, rec.id);
  clock.t += (LIMITS.lostDays + 1) * 24 * 60 * 60_000;
  assert.equal(store.droppedList(B).length, 0);
});

test('重复 drop / recover 不会把已播的改回去', () => {
  const { store } = setup();
  const rec = store.recommend(A, B, song('6', '听过的'));
  store.next(B);
  store.played(B, rec.id);
  store.drop(B, rec.id);
  assert.equal(store.inbox(B).find((r) => r.id === rec.id).status, 'played', '播过就是播过');
});
