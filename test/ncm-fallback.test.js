// 网易云拿不到时回落备用音源（个人版 resolve），以及公用版经 8099 借老板网易云：只搜、只取链接、不写回。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-ncm-fallback-'));
process.env.CLAUDIO_DATA_DIR = fixture;
process.env.CLAUDIO_RESOURCE_ROOT = fixture;
process.env.NCM_COOKIE = 'MUSIC_U=owner-test-cookie';
after(() => fs.rmSync(fixture, { recursive: true, force: true }));
const ncm = await import('../server/ncm.js');
const { createOwnerChannel } = await import('../server/ncm-shared.js');
const { allowedAudioUrl } = await import('../server/audio-cache.js');

const realFetch = globalThis.fetch;
const ncmCalls = [];
let ncmRoutes = {};
// NCM 实例和备用音源的 CDN 都假的；别的（本机 8099）走真的
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname === 'a.cdn.example.org') {
    return new Response(Buffer.alloc(64), { status: 206, headers: { 'content-range': 'bytes 0-63/10700000' } });
  }
  if (url.hostname === 'localhost' && url.port === '3000') {
    ncmCalls.push({ path: url.pathname, cookie: init.headers?.Cookie || '' });
    const body = ncmRoutes[url.pathname]?.(url) ?? {};
    if (body === 405) return new Response('{}', { status: 405 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
};
after(() => { globalThis.fetch = realFetch; });

const plugin = {
  calls: [],
  name: 'fake', prefix: 'fk', hosts: ['cdn.example.org'],
  async search(keywords) { plugin.calls.push(`search:${keywords}`); return [{ id: '3', title: '晴天', artist: '周杰伦', duration: 269 }]; },
  async songUrl(id, { quality }) { plugin.calls.push(`url:${id}`); return { url: `http://a.cdn.example.org/${id}-${quality}.mp3`, format: 'mp3', bitrate: 320, duration: 269 }; },
  async lyric(id) { return `[00:00.00]fk ${id}`; },
};
const searchHit = { result: { songs: [{ id: 186016, name: '晴天', ar: [{ name: '周杰伦' }], al: { name: '叶惠美' }, dt: 269_000, fee: 1 }] } };

function reset({ withPlugin = true } = {}) {
  ncm.resetRateLimitsForTests();
  ncm.sources.setPlugins(withPlugin ? [plugin] : []);
  plugin.calls.length = 0;
  ncmCalls.length = 0;
  ncmRoutes = {
    '/search': () => searchHit,
    '/song/url/v1': () => ({ data: [{ id: 186016, url: null }] }),
    '/song/detail': () => ({ songs: [] }),
    '/song/wiki/summary': () => ({}),
  };
}

test('网易云灰掉：保留网易云的 id，只把音频换成备用音源的；之后按 id 刷新直链也走对应关系', async () => {
  reset();
  const song = await ncm.resolve({ title: '晴天', artist: '周杰伦' });
  assert.equal(song.playable, true);
  assert.equal(song.id, 186016);
  assert.equal(song.source, 'fake');
  assert.match(song.url, /^https:\/\/a\.cdn\.example\.org\/3-/);
  const refreshed = await ncm.songUrl(186016, 'exhigh');
  assert.match(refreshed.url, /^https:\/\/a\.cdn\.example\.org\/3-exhigh/);
});

test('网易云只有试听（freeTrialInfo）也回落', async () => {
  reset();
  ncmRoutes['/song/url/v1'] = () => ({ data: [{ id: 186016, url: 'https://m701.music.126.net/trial.mp3', br: 128000, freeTrialInfo: { start: 0, end: 30 } }] });
  const song = await ncm.resolve({ title: '晴天', artist: '周杰伦' });
  assert.equal(song.id, 186016);
  assert.match(song.url, /a\.cdn\.example\.org/);
});

test('网易云搜索被限流：整首用备用音源的，id 带前缀；歌词也从备用音源取', async () => {
  reset();
  ncmRoutes['/search'] = () => 405;
  const song = await ncm.resolve({ title: '晴天', artist: '周杰伦' });
  assert.equal(song.playable, true);
  assert.equal(song.id, 'fk3');
  assert.equal(await ncm.lyric('fk3'), '[00:00.00]fk 3');
  assert.equal(await ncm.songFacts('fk3').then((f) => Object.keys(f).length), 0);
});

test('没有插件：照旧报放不了 / 限流，不多发任何请求', async () => {
  reset({ withPlugin: false });
  const gray = await ncm.resolve({ title: '晴天', artist: '周杰伦' });
  assert.equal(gray.playable, false);
  ncm.resetRateLimitsForTests();
  ncmRoutes['/search'] = () => 405;
  const limited = await ncm.resolve({ title: '晴天2', artist: '周杰伦' });
  assert.equal(limited.playable, false);
  assert.equal(limited.rateLimited, true);
  assert.equal(plugin.calls.length, 0);
  assert.equal(ncm.sources.isAltId('fk3'), false);
});

test('公用版借老板网易云（经 8099）：只发搜索和取链接，带老板 cookie 但不回给对方；放不了就找备用音源；本机不落任何文件', async () => {
  reset();
  const before = fs.readdirSync(fixture, { recursive: true });
  const server = ncm.startSharedLimitServer('127.0.0.1:0');
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const owner = createOwnerChannel(`http://127.0.0.1:${server.address().port}`, { fetchFn: realFetch });
  try {
    const songs = await owner.search('晴天 周杰伦', 5);
    assert.deepEqual(songs.map((s) => [s.id, s.duration]), [[186016, 269]]);
    ncmRoutes['/song/url/v1'] = () => ({ data: [{ id: 186016, url: 'https://m701.music.126.net/full.mp3', br: 320000, level: 'exhigh' }] });
    const audio = await owner.songUrl({ id: '186016', level: 'exhigh' });
    assert.equal(audio.url, 'https://m701.music.126.net/full.mp3');
    assert.equal(JSON.stringify(audio).includes('owner-test-cookie'), false);
    ncmRoutes['/song/url/v1'] = () => ({ data: [{ id: 186016, url: null }] });
    const alt = await owner.songUrl({ id: '186016', level: 'exhigh', title: '晴天', artist: '周杰伦', duration: 269 });
    assert.equal(alt.id, 'fk3');
    assert.match(alt.url, /a\.cdn\.example\.org/);
    assert.equal(await owner.lyric('fk3'), '[00:00.00]fk 3');
    await assert.rejects(owner.songUrl({ id: '../etc' }), /owner/);
    // 只碰了搜索和取链接两个接口，而且都带老板的 cookie
    assert.deepEqual([...new Set(ncmCalls.map((c) => c.path))].sort(), ['/search', '/song/url/v1']);
    assert.ok(ncmCalls.every((c) => c.cookie === 'MUSIC_U=owner-test-cookie'));
    // 不记年份曲风、不写播放记录 / 收藏 / 记忆：数据目录里没有新文件
    assert.deepEqual(fs.readdirSync(fixture, { recursive: true }), before);
  } finally {
    server.close();
  }
});

test('音频白名单：插件声明的域名（https）放行，别的不放；没插件时只认网易云', () => {
  reset();
  assert.equal(allowedAudioUrl('https://a.cdn.example.org/3.mp3'), true);
  assert.equal(allowedAudioUrl('https://evil.example.com/3.mp3'), false);
  reset({ withPlugin: false });
  assert.equal(allowedAudioUrl('https://a.cdn.example.org/3.mp3'), false);
  assert.equal(allowedAudioUrl('https://m701.music.126.net/a.mp3'), true);
});
