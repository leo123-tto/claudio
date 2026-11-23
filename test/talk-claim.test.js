// 个人版口播频率：聊天里说「少说点」只记下；领取时按档位定这一期开不开口（不开口就交出去掉口播的副本）；话多档一段一首。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { EventEmitter } from 'node:events';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-talk-'));
process.env.CLAUDIO_RESOURCE_ROOT = directory;
process.env.CLAUDIO_DATA_DIR = directory;
process.env.CLAUDIO_NO_LISTEN = '1';
process.env.CLAUDIO_SKIP_PREFETCH = '1';
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw Error('离线测试禁止真实网络'); };
const realNow = Date.now;
const runtime = await import('../server/index.js');
const { services, episodeBuffer, closeRuntime } = runtime;
const state = await import('../server/state.js');
const { getSettings } = await import('../server/settings.js');
const messages = [];
const settle = async () => { for (let i = 0; i < 5; i += 1) await tick(); };
let id = 0;
let clock = new Date(2026, 10, 23, 19, 40).getTime(); // 周一 19:40
const advance = (minutes) => { clock += minutes * 60_000; };
Date.now = () => clock;

services.cache = { has: () => false, pin: () => {}, ensure: async () => { throw Error('不下载'); }, info: () => null, resolve: () => null };
services.ncm = { ...services.ncm, lyric: async () => '', songUrl: async (songId) => ({ url: `https://m.126.net/fresh-${songId}` }), resolve: async (song) => ({ ...song, id: String(++id), url: `https://m.126.net/${id}`, playable: true }) };
services.synthesize = async () => ({ url: '/tts/complete.mp3' });
const plan = (overrides = {}) => ({ say: '坐一会儿。先听甲乐队的《候选甲》。', intent: 'recommend', play: [{ title: '候选甲', artist: '甲乐队', discoveryType: 'adjacent', score: 90 }, { title: '候选乙', artist: '乙乐队', discoveryType: 'explore', lane: 'fresh', score: 80 }], ...overrides });
services.plan = async () => { throw Error('说话频率的指令不该打大脑'); };

async function request(url, body, method = body === undefined ? 'GET' : 'POST') {
  const parsed = new URL(url, 'http://fake.local');
  const route = runtime.app._router.stack.find((layer) => layer.route?.path === parsed.pathname && layer.route.methods[method.toLowerCase()]);
  assert.ok(route, `已注册路由 ${method} ${parsed.pathname}`);
  const req = { body, query: Object.fromEntries(parsed.searchParams), params: {}, ip: '127.0.0.1' };
  const res = new EventEmitter();
  let result;
  res.status = (status) => { res.statusCode = status; return res; };
  res.json = (value) => { res.writableEnded = true; result = { status: res.statusCode || 200, body: structuredClone(value) }; return res; };
  await route.route.stack[0].handle(req, res);
  return result;
}

// 备好一期（带口播）并交给领取
let seq = 0;
const adopt = (say) => {
  const key = `talk-${++seq}`;
  const ep = { id: `ep-${key}`, epoch: episodeBuffer.snapshot().epoch, say, sayTts: say, voice: { status: 'ready' },
    queue: [{ type: 'tts', url: `/tts/${key}.mp3`, text: say }, { type: 'song', url: `https://m.126.net/${key}`, meta: { id: key, title: key, artist: '歌手' } }] };
  episodeBuffer.adopt(ep, key);
  return { key, ep };
};
const claim = async (key) => (await request(`/api/next?claimId=${key}`)).body.episode;
const start = (key, ep) => request('/api/episode/started', { id: ep.id, claimId: key });

test.before(() => {
  const ws = new EventEmitter();
  ws.send = (raw) => messages.push(JSON.parse(raw));
  runtime.wss.emit('connection', ws);
});
test.after(() => {
  Date.now = realNow;
  closeRuntime(); runtime.wss.close(); globalThis.fetch = realFetch; fs.rmSync(directory, { recursive: true, force: true });
});

test('聊天里说「安静点」：只记下并回一句确认，不打大脑、不进对话记录', async () => {
  const before = state.recentMessages(200).length;
  const out = await request('/api/chat', { input: '安静点', requestId: 'talk-1' });
  assert.equal(out.body.ok, true);
  assert.equal(out.body.control.action, 'talk');
  assert.match(out.body.control.reply, /少说点/);
  assert.equal(getSettings().voice.talk, 'quiet');
  assert.equal(state.recentMessages(200).length, before);
});

test('安静档：开头问好，同一小时里只放歌；整点又出声；没开口的一期不记进对话，原件的 say 不动', async () => {
  const first = adopt('晚上好。');
  assert.equal((await claim(first.key)).say, '晚上好。');
  await start(first.key, first.ep);
  advance(8);
  const quiet = adopt('这首不错。');
  const history = state.recentMessages(200).length;
  const delivered = await claim(quiet.key);
  assert.equal(delivered.say, '');
  assert.equal(delivered.voice.status, 'skipped');
  assert.equal(delivered.queue.some((item) => item.type === 'tts'), false);
  assert.equal(delivered.queue.filter((item) => item.type === 'song').length, 1);
  assert.equal(quiet.ep.say, '这首不错。'); // 原件的 say 不动
  const again = await claim(quiet.key); // 同一个领取编号：结果一样
  assert.equal(again.say, '');
  await start(quiet.key, quiet.ep);
  assert.equal(state.recentMessages(200).length, history); // 没开口，不记「Vera 说了」
  advance(25); // 20:13：新的整点
  const hour = adopt('八点过了。');
  assert.equal((await claim(hour.key)).say, '八点过了。');
  await start(hour.key, hour.ep);
});

test('不开口的这期，语音合成不会再把口播塞回去（voiceReady 不发）', async () => {
  advance(5);
  messages.length = 0;
  const muted = adopt('不该念出来。');
  muted.ep.voice = { status: 'pending' };
  muted.ep.queue = muted.ep.queue.filter((item) => item.type !== 'tts');
  const delivered = await claim(muted.key);
  await settle();
  assert.equal(delivered.say, '');
  assert.equal(messages.some((m) => m.kind === 'voiceReady' && m.episodeId === muted.ep.id), false);
  assert.equal(episodeBuffer.getVoice(muted.ep.id).status, 'skipped');
});

test('「今天别打扰我」：只到今天，不改长期档；几乎不说只有开头；再说「恢复正常」就回来', async () => {
  const out = await request('/api/chat', { input: '今天别打扰我', requestId: 'talk-2' });
  assert.match(out.body.control.reply, /今天/);
  assert.equal(getSettings().voice.talk, 'quiet');
  assert.ok(fs.existsSync(path.join(directory, 'cache', 'talk.json')));
  advance(20);
  const quiet = adopt('这首也不错。');
  assert.equal((await claim(quiet.key)).say, '');
  await start(quiet.key, quiet.ep);
  advance(25); // 21:03：整点和时段（傍晚 → 夜晚）都变了，几乎不说也不开口
  const silent = adopt('九点了。');
  assert.equal((await claim(silent.key)).say, '');
  await start(silent.key, silent.ep);
  advance(40); // 隔了 40 分钟没放歌：新一轮的开头
  const hello = adopt('晚上好。');
  assert.equal((await claim(hello.key)).say, '晚上好。');
  await start(hello.key, hello.ep);
  await request('/api/chat', { input: '恢复正常', requestId: 'talk-3' });
  assert.equal(getSettings().voice.talk, 'normal');
  assert.equal(fs.existsSync(path.join(directory, 'cache', 'talk.json')), false);
  advance(5);
  const normal = adopt('接着听。');
  assert.equal((await claim(normal.key)).say, '接着听。');
  // 午夜之后今天的临时档失效
  await request('/api/chat', { input: '今晚只放歌', requestId: 'talk-4' });
  advance(3 * 60);
  const next = adopt('早啊。');
  assert.equal((await claim(next.key)).say, '早啊。');
});

test('话多档：后台节目一段只放一首，提示词告诉大脑；回到适中后恢复两首', async () => {
  await request('/api/chat', { input: '多聊聊', requestId: 'talk-5' });
  assert.equal(getSettings().voice.talk, 'chatty');
  const prompts = [];
  services.plan = async (prompt) => { prompts.push(prompt); return plan(); };
  process.env.CLAUDIO_SKIP_PREFETCH = '0';
  await runtime.onScheduled('morning-show'); await settle();
  const one = messages.filter((m) => m.kind === 'scheduled').at(-1);
  assert.match(prompts.at(-1), /本段只放一首歌/);
  assert.equal(one.episode.queue.filter((item) => item.type === 'song').length, 1);
  assert.equal(one.episode.queue.find((item) => item.type === 'song').meta.title, '候选甲'); // 取大脑点名的第一首
  assert.ok(one.episode.say);
  await request('/api/chat', { input: '正常说话', requestId: 'talk-6' });
  await runtime.onScheduled('morning-show'); await settle();
  const two = messages.filter((m) => m.kind === 'scheduled').at(-1);
  assert.doesNotMatch(prompts.at(-1), /本段只放一首歌/);
  assert.equal(two.episode.queue.filter((item) => item.type === 'song').length, 2);
  process.env.CLAUDIO_SKIP_PREFETCH = '1';
});
