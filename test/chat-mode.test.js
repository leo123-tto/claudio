// 聊天模式（事项 24）：要不要马上换歌、多轮对话怎么进提示词、Vera 自己推的歌排成下一期。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { askedForMusic, chatWhen, recentTurnsText, chatModeRules } from '../server/chat-mode.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-chatmode-'));
process.env.CLAUDIO_RESOURCE_ROOT = directory;
process.env.CLAUDIO_DATA_DIR = directory;
process.env.CLAUDIO_NO_LISTEN = '1';
process.env.CLAUDIO_SKIP_PREFETCH = '1';
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw Error('离线测试禁止真实网络'); };
const runtime = await import('../server/index.js');
const { services, episodeBuffer, closeRuntime } = runtime;
const settle = async () => { for (let i = 0; i < 5; i += 1) await tick(); };
let id = 0;
services.cache = { has: () => false, pin: () => {}, ensure: async () => { throw Error('不下载'); }, info: () => null, resolve: () => null };
services.ncm = { ...services.ncm, lyric: async () => '', songUrl: async (songId) => ({ url: `https://m.126.net/fresh-${songId}` }), resolve: async (song) => ({ ...song, id: String(++id), url: `https://m.126.net/${id}`, playable: true }) };
services.synthesize = async () => ({ url: '/tts/complete.mp3' });
services.prepareLiveTts = () => ({ url: '/api/tts/stream/chat.mp3', ready: Promise.resolve() });
services.plan = async () => { throw Error('后台不备节目'); };
let prompt = '';
let answer = {};
services.stream = async (text, { onText }) => { prompt = text; const raw = JSON.stringify(answer); onText?.(raw); return raw; };

async function request(url, body) {
  const route = runtime.app._router.stack.find((layer) => layer.route?.path === url && layer.route.methods[body === undefined ? 'get' : 'post']);
  const res = new EventEmitter();
  let result;
  res.status = (status) => { res.statusCode = status; return res; };
  res.json = (value) => { res.writableEnded = true; result = { status: res.statusCode || 200, body: structuredClone(value) }; return res; };
  await route.route.stack[0].handle({ body, query: {}, params: {}, ip: '127.0.0.1' }, res);
  return result;
}
const recommend = { say: '这首完了给你接一首轻的。', intent: 'recommend', action: 'none', play: [
  { title: '候选甲', artist: '甲乐队', discoveryType: 'adjacent', score: 90 }, { title: '候选乙', artist: '乙乐队', discoveryType: 'explore', score: 80 }] };

test('听众这句在要歌才马上换；闲聊、心情、问问题都不算', () => {
  for (const text of ['放首周杰伦', '来点安静的钢琴', '换一首', '想听《晴天》', '推荐几首爵士', '下一首',
    '放周杰伦的晴天', '我要听陈奕迅', '播一下孙燕姿', '换成爵士', 'play some jazz', '帮我放五月天']) assert.equal(askedForMusic(text), true, text);
  for (const text of ['今天好累', '你觉得这首怎么样', '哈哈', '我刚下班', '放心吧', '你放的这首挺好', '']) assert.equal(askedForMusic(text), false, text);
});

test('只有聊天模式里、Vera 自己推的歌才排到下一首', () => {
  assert.equal(chatWhen({ chatMode: false, intent: 'recommend', userInput: '今天好累' }), null);
  assert.equal(chatWhen({ chatMode: true, intent: 'chat', userInput: '今天好累' }), null);
  assert.equal(chatWhen({ chatMode: true, intent: 'recommend', userInput: '今天好累' }), 'next');
  assert.equal(chatWhen({ chatMode: true, intent: 'recommend', userInput: '换一首' }), 'now');
});

test('最近几轮对话按旧到新排，只要听众和 Vera 的话，长句截断', () => {
  const messages = [
    { role: 'user', content: '第一句' }, { role: 'claudio', content: '' }, { role: 'system', content: '不要' },
    { role: 'claudio', content: '回第一句' }, { role: 'user', content: 'x'.repeat(200) },
  ];
  const text = recentTurnsText(messages);
  assert.equal(text.split('\n').length, 3);
  assert.match(text, /^听众：第一句\nVera：回第一句\n听众：x{120}$/);
  assert.equal(recentTurnsText(Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: String(i) })), { turns: 2 }).split('\n').length, 4);
  assert.equal(recentTurnsText([]), '');
});

test('聊天规则：默认接话不换歌、可以不说；驾驶模式只说一句', () => {
  assert.match(chatModeRules(), /intent=chat、play=\[\]/);
  assert.match(chatModeRules(), /say 可以是 ""/);
  assert.match(chatModeRules({ drive: true }), /只说一句/);
});

test('聊天模式：提示词带多轮对话和聊天规则；不开聊天模式就没有', async () => {
  answer = { say: '嗯，我在听。', intent: 'chat', action: 'none', play: [] };
  await request('/api/chat', { input: '我刚下班', chatMode: true, requestId: 'c1' });
  assert.doesNotMatch(prompt, /## 最近的对话/); // 第一句：这句本身在「听众刚说」里，不重复
  await request('/api/chat', { input: '地铁好挤', chatMode: true, requestId: 'c1b' });
  assert.match(prompt, /## 最近的对话（旧 → 新）\n听众：我刚下班\nVera：嗯，我在听。/);
  assert.match(prompt, /## 聊天模式/);
  assert.ok(prompt.indexOf('## 聊天模式') < prompt.indexOf('## 听众刚说'));
  await request('/api/chat', { input: '我刚下班', requestId: 'c2' });
  assert.doesNotMatch(prompt, /## 聊天模式/);
});

test('聊天模式里 Vera 自己推的歌：这次只回话，歌排成下一期、领取时不再念', async () => {
  answer = recommend;
  const out = await request('/api/chat', { input: '今天有点累', chatMode: true, requestId: 'c3' });
  assert.equal(out.body.ok, true);
  const ep = out.body.episode;
  assert.equal(ep.intent, 'chat');
  assert.equal(ep.queue.some((item) => item.type === 'song'), false);
  assert.ok(ep.queue.some((item) => item.type === 'tts'));
  assert.deepEqual(ep.queued.map((song) => song.title), ['候选甲', '候选乙']);
  await settle();
  const next = await episodeBuffer.claim('chat-claim');
  assert.deepEqual(next.queue.map((item) => item.meta.title), ['候选甲', '候选乙']);
  assert.equal(next.say, '');
  assert.equal(next.voice.status, 'skipped');
  episodeBuffer.release('chat-claim');
});

test('聊天里她觉得不用回：say 为空，不出字、不合成、不记一句空话', async () => {
  answer = { say: '', intent: 'chat', action: 'none', play: [] };
  const state = await import('../server/state.js');
  const before = state.recentMessages(200).length;
  const out = await request('/api/chat', { input: '嗯', chatMode: true, requestId: 'c-empty' });
  assert.equal(out.body.ok, true);
  assert.equal(out.body.episode.say, '');
  assert.equal(out.body.episode.voice.status, 'skipped');
  assert.equal(out.body.episode.queue.length, 0);
  const added = state.recentMessages(200).slice(before);
  assert.deepEqual(added.map((m) => m.role), ['user']);
});

test('聊天模式里听众明确要歌：照旧马上换', async () => {
  answer = recommend;
  const out = await request('/api/chat', { input: '换一首轻的', chatMode: true, requestId: 'c4' });
  assert.equal(out.body.episode.intent, 'recommend');
  assert.ok(out.body.episode.queue.some((item) => item.type === 'song'));
  assert.equal(out.body.episode.queued, undefined);
});

test('网页从 /api/mode 拿到聊天模式的背景音量和恢复时间', async () => {
  const out = await request('/api/mode');
  assert.equal(out.body.features.chatMode, true);
  assert.equal(out.body.chat.bed, 0.25);
  assert.equal(out.body.chat.idleMs, 45000);
});

test.after(async () => {
  globalThis.fetch = realFetch;
  await closeRuntime?.();
  fs.rmSync(directory, { recursive: true, force: true });
});
