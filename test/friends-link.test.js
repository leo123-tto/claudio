// 老板个人版进好友圈：经本机内部口去要朋友推荐的歌，做成一期；出任何问题都照常备节目。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFriendsLink, buildFriendEpisode, FriendsLinkError } from '../server/friends-link.js';
import { toneFor } from '../server/tone.js';

const rec = { id: 'rec_1', from: { id: 'mem_0000000a', name: '小王' }, song: { id: 42, title: '晴天', artist: '周杰伦', cover: 'https://p1.music.126.net/a.jpg', duration: 200 }, note: '下雨天听这个' };

function fakeLink(next = rec) {
  const posts = [];
  return {
    posts,
    async post(name, body) {
      posts.push([name, body]);
      if (name === 'next') return { rec: next };
      return { ok: true };
    },
  };
}

test('没配 FRIENDS_URL 就整个关掉', () => {
  assert.equal(createFriendsLink(''), null);
});

test('转发：只认列出来的操作；连不上回 503；对方的错误原样带回', async () => {
  const seen = [];
  const link = createFriendsLink('http://127.0.0.1:8092', {
    fetchFn: async (url, init) => {
      seen.push([String(url), init.method]);
      if (String(url).endsWith('/owner/add')) return new Response(JSON.stringify({ error: 'bad-code', message: '好友码不对' }), { status: 403 });
      if (String(url).endsWith('/owner/code')) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify({ friends: [] }), { status: 200 });
    },
  });
  assert.deepEqual(await link.overview(), { friends: [] });
  assert.deepEqual(seen[0], ['http://127.0.0.1:8092/owner/overview', 'GET']);
  await assert.rejects(link.post('add', { code: '1' }), (e) => e instanceof FriendsLinkError && e.status === 403 && e.body.error === 'bad-code');
  await assert.rejects(link.post('code'), (e) => e.status === 503);
  assert.throws(() => link.post('../admin'), (e) => e.status === 404);
});

test('一期只有这首：标 friend、带出处，报幕念推荐人和附言，开口语气档照加', async () => {
  const link = fakeLink();
  const tone = toneFor('day');
  const ep = await buildFriendEpisode({ link, epoch: 3, tone, songUrl: async () => ({ url: 'https://m.music.126.net/42.mp3', quality: { format: 'mp3' } }), resolve: async () => assert.fail('有直链就不搜') });
  assert.equal(ep.epoch, 3);
  assert.equal(ep.queue.length, 1);
  assert.equal(ep.queue[0].meta.discoveryType, 'friend');
  assert.equal(ep.queue[0].meta.friendRec, 'rec_1');
  assert.equal(ep.friendRec.from, '小王');
  assert.equal(ep.say, '小王给你推荐了周杰伦的《晴天》：「下雨天听这个」要听吗？');
  assert.match(ep.sayTts, /小王给你推荐了《晴天》。.*小王留了句话：下雨天听这个。要听吗？/);
  assert.ok(ep.sayTts.startsWith(tone.style));
  assert.equal(ep.voice.status, 'pending');
});

test('驾驶模式只念一句，那一句带着是谁推荐的', async () => {
  const ep = await buildFriendEpisode({ link: fakeLink(), drive: true, songUrl: async () => ({ url: 'https://x/1.mp3' }), resolve: async () => null });
  assert.ok(ep.sayTts.startsWith('小王给你推荐了《晴天》'));
  assert.ok(!ep.sayTts.includes('留了句话'));
});

test('按 id 取不到就搜一次；都放不了告诉公用版别再给；网易云忙不算放不了', async () => {
  const searched = await buildFriendEpisode({ link: fakeLink(), songUrl: async () => null, resolve: async () => ({ id: 'kw9', url: 'https://x/kw9.mp3', playable: true }) });
  assert.equal(searched.queue[0].meta.id, 'kw9');
  const gone = fakeLink();
  assert.equal(await buildFriendEpisode({ link: gone, songUrl: async () => null, resolve: async () => ({ playable: false }) }), null);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(gone.posts.at(-1), ['unplayable', { rec: 'rec_1' }]);
  const busy = fakeLink();
  assert.equal(await buildFriendEpisode({ link: busy, songUrl: async () => { throw Object.assign(new Error('405'), { code: 'NCM_RATE_LIMITED' }); }, resolve: async () => null }), null);
  assert.ok(!busy.posts.some(([name]) => name === 'unplayable'));
});

test('没有推荐、连不上：返回 null，照常备节目', async () => {
  assert.equal(await buildFriendEpisode({ link: fakeLink(null), songUrl: async () => assert.fail(), resolve: async () => assert.fail() }), null);
  const down = { post: async () => { throw new FriendsLinkError(503); } };
  assert.equal(await buildFriendEpisode({ link: down, songUrl: async () => assert.fail(), resolve: async () => assert.fail() }), null);
  assert.equal(await buildFriendEpisode({ link: null }), null);
});

test('老板禁播过的歌，朋友推荐了也不放，告诉公用版放不了', async () => {
  const link = fakeLink();
  const ep = await buildFriendEpisode({ link, banned: (s) => s.title === '晴天', songUrl: async () => assert.fail('禁播的不去取'), resolve: async () => assert.fail() });
  assert.equal(ep, null);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(link.posts.at(-1), ['unplayable', { rec: 'rec_1' }]);
});
