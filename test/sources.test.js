// 备用音源层（server/sources.js）：插件缺失 / 坏掉就跳过；认歌；核对整曲和音质；每个源单独排队、老板优先。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPacer, createSourceRegistry, flacInfo, loadPlugins, matchHit, SourceBusyError } from '../server/sources.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-sources-'));

// 假的媒体服务：按 URL 给文件大小和头几个字节
function mediaFetch(files) {
  return async (url, { headers } = {}) => {
    const file = files[new URL(url).pathname];
    if (!file) return new Response(null, { status: 404 });
    const head = file.head || Buffer.alloc(64);
    return new Response(head.subarray(0, 64), {
      status: 206,
      headers: { 'content-range': `bytes 0-63/${file.size}`, 'content-length': '64' },
    });
  };
}

function flacHead(sampleRate, bits) {
  const b = Buffer.alloc(64);
  b.write('fLaC', 0, 'latin1');
  const s = 8;
  b[s + 10] = (sampleRate >> 12) & 0xff;
  b[s + 11] = (sampleRate >> 4) & 0xff;
  b[s + 12] = ((sampleRate & 0x0f) << 4) | (1 << 1) | (((bits - 1) >> 4) & 1);
  b[s + 13] = ((bits - 1) & 0x0f) << 4;
  return b;
}

function fakePlugin(overrides = {}) {
  const calls = [];
  return {
    calls,
    name: 'fake',
    prefix: 'fk',
    hosts: ['cdn.example.org'],
    async search(keywords) {
      calls.push(`search:${keywords}`);
      return [
        { id: '1', title: '晴天 (Live)', artist: '周杰伦', duration: 300 },
        { id: '2', title: '晴天', artist: '翻唱歌手', duration: 269 },
        { id: '3', title: '晴天', artist: '周杰伦', duration: 269 },
      ];
    },
    async songUrl(id, { quality }) {
      calls.push(`url:${id}:${quality}`);
      if (quality === 'lossless') return { url: `http://a.cdn.example.org/${id}.flac`, format: 'flac', bitrate: 2000, duration: 269 };
      if (quality === 'exhigh') return { url: `http://a.cdn.example.org/${id}.mp3`, format: 'mp3', bitrate: 320, duration: 269 };
      return { url: `http://a.cdn.example.org/${id}-128.mp3`, format: 'mp3', bitrate: 128, duration: 269 };
    },
    async lyric(id) { return `[00:01.00]line ${id}`; },
    ...overrides,
  };
}

test('插件目录：不存在、没配都当没有；坏插件（抛错 / 形状不对 / 前缀重复）跳过，好的照样加载', async () => {
  assert.deepEqual(await loadPlugins(''), []);
  assert.deepEqual(await loadPlugins(path.join(tmp(), 'nope')), []);
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a-throws.mjs'), 'throw new Error("boom");');
  fs.writeFileSync(path.join(dir, 'b-shape.mjs'), 'export default { name: "x" };');
  const good = 'export default { name: "good", prefix: "gd", hosts: ["cdn.example.org"], search: async () => [], songUrl: async () => null };';
  fs.writeFileSync(path.join(dir, 'c-good.mjs'), good);
  fs.writeFileSync(path.join(dir, 'd-dup.mjs'), good);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
  const warnings = [];
  const plugins = await loadPlugins(dir, { log: (m) => warnings.push(m) });
  assert.deepEqual(plugins.map((p) => p.name), ['good']);
  assert.equal(warnings.length, 3);
});

test('没有插件时：不认备用 id、不放行任何域名、找歌直接 null', async () => {
  const reg = createSourceRegistry();
  assert.equal(reg.size, 0);
  assert.equal(reg.isAltId('fk3'), false);
  assert.equal(reg.allowsHost('a.cdn.example.org'), false);
  assert.equal(await reg.find({ title: '晴天', artist: '周杰伦' }), null);
  assert.equal(await reg.songUrl('fk3'), null);
  assert.equal(await reg.lyric('fk3'), '');
});

test('认歌：歌名去括号后相同、歌手对得上、时长差 ≤8 秒，翻唱和 Live 不认', () => {
  const hits = [
    { id: '1', title: '晴天 (Live)', artist: '周杰伦', duration: 300 },
    { id: '2', title: '晴天', artist: '翻唱歌手', duration: 269 },
    { id: '3', title: '晴天', artist: '周杰伦', duration: 269 },
  ];
  assert.equal(matchHit(hits, { title: '晴天', artist: '周杰伦', duration: 270 }).id, '3');
  assert.equal(matchHit(hits, { title: '晴天', artist: '周杰伦', duration: 200 }), null);
  assert.equal(matchHit(hits, { title: '雨天', artist: '周杰伦' }), null);
});

test('找歌：带前缀 id、http 升 https、按实际格式标音质；24 位 FLAC 只有要 Hi-Res 时才标 hires', async () => {
  const plugin = fakePlugin();
  const reg = createSourceRegistry({
    plugins: [plugin],
    fetchFn: mediaFetch({ '/3.flac': { size: 55_000_000, head: flacHead(44100, 24) }, '/3.mp3': { size: 10_700_000 } }),
  });
  const lossless = await reg.find({ title: '晴天', artist: '周杰伦', duration: 269 }, { level: 'lossless' });
  assert.equal(lossless.id, 'fk3');
  assert.equal(lossless.level, 'lossless');
  assert.match(lossless.url, /^https:\/\/a\.cdn\.example\.org\/3\.flac$/);
  assert.ok(lossless.bitrate > 1_000_000, 'bitrate 是 bps');
  assert.equal((await reg.songUrl('fk3', { level: 'hires' })).level, 'hires');
  const high = await reg.songUrl('fk3', { level: 'exhigh' });
  assert.equal(high.level, 'exhigh');
  assert.ok(high.bitrate >= 300_000 && high.bitrate < 340_000);
  assert.equal(reg.isAltId('fk3'), true);
  assert.equal(reg.allowsHost('a.cdn.example.org'), true);
  assert.equal(reg.allowsHost('evil.org'), false);
  assert.equal(await reg.lyric('fk3'), '[00:01.00]line 3');
  assert.deepEqual(flacInfo(flacHead(96000, 24)), { sampleRate: 96000, bits: 24 });
});

test('找歌：试听片段（文件太小）、低码率 AAC、不在白名单的域名都不要，往下一档试', async () => {
  const plugin = fakePlugin({
    async songUrl(id, { quality }) {
      if (quality === 'lossless') return { url: 'https://a.cdn.example.org/aac.m4a', format: 'aac', bitrate: 48, duration: 269 };
      if (quality === 'exhigh') return { url: 'https://a.cdn.example.org/trial.mp3', format: 'mp3', bitrate: 320, duration: 269 };
      return { url: 'https://evil.org/x.mp3', format: 'mp3', bitrate: 128, duration: 269 };
    },
  });
  const reg = createSourceRegistry({
    plugins: [plugin],
    fetchFn: mediaFetch({ '/aac.m4a': { size: 1_600_000 }, '/trial.mp3': { size: 1_200_000 }, '/x.mp3': { size: 4_300_000 } }),
  });
  assert.equal(await reg.songUrl('fk3', { level: 'lossless' }), null);
  assert.equal(await reg.songUrl('fk3', { level: 'standard' }), null);
});

test('网易云 id 认过一次就记住对应关系，下次不再搜', async () => {
  const plugin = fakePlugin();
  const reg = createSourceRegistry({ plugins: [plugin], fetchFn: mediaFetch({ '/3.mp3': { size: 10_700_000 } }) });
  await reg.find({ title: '晴天', artist: '周杰伦', duration: 269, ncmId: '186016' }, { level: 'exhigh' });
  assert.equal(reg.altFor('186016'), 'fk3');
  plugin.calls.length = 0;
  const again = await reg.find({ title: '晴天', artist: '周杰伦', ncmId: '186016' }, { level: 'exhigh' });
  assert.equal(again.id, 'fk3');
  assert.ok(!plugin.calls.some((c) => c.startsWith('search')));
});

test('排队：老板后台有人排队时别人等；别人最多用到 perMin − reserve；冷却中直接报忙', async () => {
  let t = 0;
  const sleeps = [];
  const pacer = createPacer({ perMin: 4, gapMs: 0, reserve: 2, guestWaitMs: 5000, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
  await pacer.turn('guest');
  await pacer.turn('guest');
  await assert.rejects(pacer.turn('guest'), SourceBusyError); // 只能用到 2 个，等 60 秒超过 5 秒上限
  await pacer.turn('chat'); // 老板点歌直接发
  await pacer.turn('background');
  pacer.cool(60_000);
  await assert.rejects(pacer.turn('chat'), SourceBusyError);
  await assert.rejects(pacer.turn('guest'), SourceBusyError);
});
