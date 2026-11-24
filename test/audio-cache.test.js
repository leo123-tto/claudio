import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAudioCache } from '../server/audio-cache.js';
import { materializeAudio } from '../server/exclusive-play.js';

function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-media-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, cache: createAudioCache({ root, ...options }) };
}

const audio = () => new Response(Buffer.alloc(1200, 7), { headers: { 'content-type': 'audio/mpeg' } });

test('只有整首落盘后才提供媒体路径，重启能复用而不重下载', async (t) => {
  let downloads = 0;
  const { root, cache } = setup(t, { fetch: async () => { downloads += 1; return audio(); } });
  const result = await cache.ensure({ id: 123, url: 'https://m7.music.126.net/test?token=kept' });
  assert.equal(result.url, '/media/123');
  assert.equal(result.contentType, 'audio/mpeg');
  assert.equal(fs.readFileSync(cache.resolve('/media/123')).length, 1200);
  assert.equal(cache.has('123'), true);
  const second = createAudioCache({ root, fetch: async () => { throw new Error('不得重新下载'); } });
  assert.equal((await second.ensure({ id: 123 })).file, result.file);
  assert.equal(downloads, 1);
  assert.equal(fs.readdirSync(root).some((name) => name.endsWith('.tmp')), false);
});

test('拒绝路径穿越、符号链接和不在白名单里的重定向', async (t) => {
  const { root, cache } = setup(t, {
    fetch: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
  });
  await assert.rejects(cache.ensure({ id: '../secret', url: 'https://m7.music.126.net/test' }), /ID|id/);
  await assert.rejects(cache.ensure({ id: '22', url: 'https://m7.music.126.net/test' }), /地址|host/);
  await assert.rejects(cache.ensure({ id: '23', url: 'https://music.126.net.evil.example/test' }), /地址|host/);
  assert.equal(cache.resolve('/media/../secret'), null);
  assert.equal(cache.resolve('/media/%2e%2e'), null);
  fs.symlinkSync(path.join(root, 'missing'), path.join(root, '24.audio'));
  assert.equal(cache.resolve('24'), null);
});

test('中途取消会传到下载并清掉临时文件，半首不能被访问', async (t) => {
  const controller = new AbortController();
  const { root, cache } = setup(t, {
    fetch: async (_url, { signal }) => new Response(new ReadableStream({
      start(stream) {
        stream.enqueue(new Uint8Array(1200));
        signal.addEventListener('abort', () => stream.error(signal.reason), { once: true });
        queueMicrotask(() => controller.abort());
      },
    })),
  });
  await assert.rejects(cache.ensure({ id: '25', url: 'https://m7.music.126.net/test' }, { signal: controller.signal }), /abort/i);
  assert.equal(cache.has('25'), false);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('超出上限时按最近访问淘汰，正在使用的 pin 文件保留', async (t) => {
  let clock = 1_000;
  const { cache } = setup(t, { maxBytes: 2500, now: () => clock++, fetch: async () => audio() });
  await cache.ensure({ id: '1', url: 'https://m7.music.126.net/1' });
  await cache.ensure({ id: '2', url: 'https://m7.music.126.net/2' });
  cache.pin(['1']);
  await cache.ensure({ id: '3', url: 'https://m7.music.126.net/3' });
  assert.equal(cache.has('1'), true);
  assert.equal(cache.has('2'), false);
  assert.equal(cache.has('3'), true);
  cache.pin([]);
  cache.resolve('1');
  await cache.ensure({ id: '4', url: 'https://m7.music.126.net/4' });
  assert.equal(cache.has('3'), false);
  assert.equal(cache.has('1'), true);
});

test('单独输出复用同一份本地媒体，缺失的媒体不退回远端下载', async (t) => {
  const { cache } = setup(t, { fetch: async () => audio() });
  const saved = await cache.ensure({ id: '35', url: 'https://m7.music.126.net/test' });
  assert.equal(await materializeAudio('/media/35', { cache }), saved.file);
  await assert.rejects(materializeAudio('/media/36', { cache }), /准备|缓存/);
});

test('正文停住时取消会主动关闭reader，半首不留缓存', async (t) => {
  const controller = new AbortController();
  let reading;
  const started = new Promise((resolve) => { reading = resolve; });
  let canceled = false;
  const { cache } = setup(t, { fetch: async () => new Response(new ReadableStream({
    pull() { reading(); },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 })) });
  const work = cache.ensure({ id: '40', url: 'https://m7.music.126.net/test' }, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(Promise.race([work, new Promise((_, reject) => {
    const timeout = setTimeout(() => reject(new Error('取消没有关闭reader')), 200);
    work.finally(() => clearTimeout(timeout)).catch(() => {});
  })]), /abort/i);
  assert.equal(canceled, true);
  assert.equal(cache.has('40'), false);
});

test('同歌共享下载，取消一个请求不影响仍需要音频的另一位', async (t) => {
  const first = new AbortController();
  const second = new AbortController();
  let complete;
  let downloads = 0;
  let upstreamSignal;
  const gate = new Promise((resolve) => { complete = resolve; });
  const { cache } = setup(t, { fetch: async (_url, { signal }) => {
    downloads += 1;
    upstreamSignal = signal;
    await gate;
    return audio();
  } });
  const song = { id: '41', url: 'https://m7.music.126.net/test' };
  const left = cache.ensure(song, { signal: first.signal });
  const right = cache.ensure(song, { signal: second.signal });
  first.abort();
  await assert.rejects(Promise.race([left, new Promise((_, reject) => {
    const timeout = setTimeout(() => reject(new Error('请求没有及时取消')), 200);
    left.finally(() => clearTimeout(timeout)).catch(() => {});
  })]), /abort/i);
  assert.equal(upstreamSignal.aborted, false);
  complete();
  assert.equal((await right).url, '/media/41');
  assert.equal(downloads, 1);
});

test('音质换档后缓存里别的档不算数、下载时换掉；/media 仍能放旧档；没记档的旧文件按极高算', async (t) => {
  let level = 'exhigh';
  let downloads = 0;
  const { root, cache } = setup(t, { level: () => level, fetch: async () => { downloads += 1; return audio(); } });
  await cache.ensure({ id: 7, url: 'https://m7.music.126.net/a.mp3', quality: { format: 'mp3', bitrate: 320000 } });
  assert.equal(cache.has('7'), true);
  assert.deepEqual(cache.info('7').quality, { format: 'mp3', bitrate: 320000 });
  level = 'lossless';
  assert.equal(cache.has('7'), false);
  assert.ok(cache.resolve('/media/7'), '换档后旧文件 /media 照样能放');
  const fresh = await cache.ensure({ id: 7, url: 'https://m7.music.126.net/a.flac', level: 'lossless' });
  assert.equal(fresh.level, 'lossless');
  assert.equal(downloads, 2);
  assert.equal(cache.has('7'), true);
  // 以前没记档的文件
  fs.writeFileSync(path.join(root, '8.audio'), Buffer.alloc(1200, 1));
  fs.writeFileSync(path.join(root, '8.json'), JSON.stringify({ size: 1200, contentType: 'audio/mpeg' }));
  assert.equal(cache.has('8'), false);
  level = 'exhigh';
  assert.equal(cache.has('8'), true);
});
