import test from 'node:test';
import assert from 'node:assert/strict';
import { plainText } from '../server/tts/tags.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-finalize-'));
process.env.CLAUDIO_RESOURCE_ROOT = directory;
process.env.CLAUDIO_DATA_DIR = directory;
process.env.CLAUDIO_NO_LISTEN = '1';
process.env.CLAUDIO_SKIP_PREFETCH = '1';
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('离线测试禁止真实网络'); };
const runtime = await import('../server/index.js');
const { services, finalizeEpisode, episodeBuffer } = runtime;
const { eventStore } = await import('../server/events.js');
services.cache = { has: () => false, pin: () => {}, ensure: async () => { throw new Error('不下载'); } };
let resolved;
let serial = 0;
const plan = (play) => ({ intent: 'recommend', say: '换成钢琴，接下来听这些歌。', play });
const song = (title, extra = {}) => ({ title, artist: 'Yiruma', discoveryType: 'adjacent', ...extra });
const titles = (ep) => ep.queue.filter((item) => item.type === 'song').map((item) => item.meta.title);

test.beforeEach(() => {
  episodeBuffer.invalidate();
  episodeBuffer.setCurrent({ queue: [] });
  fs.rmSync(eventStore.file, { force: true });
  resolved = [];
  services.ncm = {
    lyric: async () => '',
    resolve: async (candidate) => {
      resolved.push(candidate.title);
      return { title: candidate.title, artist: candidate.artist, id: String(++serial),
        url: `https://m.126.net/${serial}`, playable: true, genre: '轻音乐 / 新世纪 / 纯音乐' };
    },
  };
});

const pianoRecommendation = (extra = {}) => ({ styleRequest: '来点安静的钢琴', ...extra });
const writeEvents = (events) => {
  fs.mkdirSync(path.dirname(eventStore.file), { recursive: true });
  fs.writeFileSync(eventStore.file, events.map((event) => JSON.stringify(event)).join('\n'));
};

test('G11 旧近期钢琴可第二轮救回，真实开声超过十分钟才放行', async () => {
  const play = [song('近期钢琴甲'), song('近期钢琴乙')];
  writeEvents(play.map((item) => ({ type: 'play_started', song: item,
    at: new Date(Date.now() - 11 * 60_000).toISOString() })));
  const ep = await finalizeEpisode(plan(play), { recommendation: pianoRecommendation({ recentSongs: play }) });
  assert.deepEqual(titles(ep), play.map((item) => item.title));
  assert.deepEqual(resolved, play.map((item) => item.title));
});

test('G11 recent 不能掩盖禁播、收藏、不喜欢，明确点歌例外仍保留', async () => {
  const play = [song('禁播'), song('收藏'), song('不喜欢')];
  const recommendation = pianoRecommendation({ recentSongs: play, bannedSongs: [play[0]],
    favoriteSongs: [play[1]], dislikedSongs: [play[2]] });
  assert.deepEqual(titles(await finalizeEpisode(plan(play), { recommendation })), []);
  assert.deepEqual(resolved, []);
  assert.deepEqual(titles(await finalizeEpisode(plan(play), {
    recommendation: { ...recommendation, explicitRequest: true },
  })), ['禁播', '收藏']);
});

test('G11 第二轮查到真实曲名后也重新检查禁播、收藏与不喜欢', async () => {
  const play = [song('别名甲'), song('别名乙'), song('别名丙')];
  const actual = [song('真实禁播'), song('真实收藏'), song('真实不喜欢')];
  const base = services.ncm.resolve;
  services.ncm.resolve = async (candidate, options) => ({ ...await base(candidate, options),
    ...actual[candidate.playOrder] });
  const ep = await finalizeEpisode(plan(play), { recommendation: pianoRecommendation({
    recentSongs: play, bannedSongs: [actual[0]], favoriteSongs: [actual[1]], dislikedSongs: [actual[2]],
  }) });
  assert.deepEqual(titles(ep), []);
});

test('G11 第二轮仍检查风格、排除条件和解析后的重复 id', async () => {
  const play = [song('偏离风格'), song('明确排除', { tags: ['rock'] }), song('保留甲'), song('保留乙')];
  const base = services.ncm.resolve;
  services.ncm.resolve = async (candidate, options) => ({ ...await base(candidate, options), id: 'same-id',
    genre: candidate.playOrder === 0 ? '摇滚 / 流行 / 国语' : '纯音乐' });
  const ep = await finalizeEpisode(plan(play), { recommendation: pianoRecommendation({
    styleRequest: '安静的钢琴，不要摇滚', recentSongs: play,
  }) });
  assert.deepEqual(titles(ep), ['保留甲']);
});

test('G11 第二轮重新读取持有歌曲，当前曲按 id 和规范化歌名歌手阻止重播', async () => {
  const play = [song('持有别名'), song('当前别名'), song(' NOW ', { artist: ' yiruma ' })];
  const base = services.ncm.resolve;
  services.ncm.resolve = async (candidate, options) => {
    const item = await base(candidate, options);
    if (candidate.title === '持有别名') {
      episodeBuffer.setCurrent({ queue: [{ type: 'song', meta: { id: 'held', title: '别的标题', artist: '别的歌手' } }] });
      item.id = 'held';
    }
    if (candidate.title === '当前别名') item.id = 'current';
    return item;
  };
  const ep = await finalizeEpisode(plan(play), { recommendation: pianoRecommendation({ recentSongs: play }),
    nowPlaying: { id: 'current', title: 'now', artist: 'Yiruma' } });
  assert.deepEqual(titles(ep), []);
});

test('G11 十分钟冷却只认 play_started，完成或推荐事件不阻止救回', async () => {
  const play = [song('刚开声'), song('只完成'), song('只推荐')];
  writeEvents(play.map((item, index) => ({ type: ['play_started', 'play_completed', 'recommendation'][index],
    at: new Date().toISOString(), song: item })));
  const ep = await finalizeEpisode(plan(play), { recommendation: pianoRecommendation({ recentSongs: play }) });
  assert.deepEqual(titles(ep), ['只完成', '只推荐']);
});

test('G11 严格一轮有一首就不放宽近期', async () => {
  const play = [song('近期'), song('新钢琴')];
  const ep = await finalizeEpisode(plan(play), { recommendation: pianoRecommendation({ recentSongs: [play[0]] }) });
  assert.deepEqual(titles(ep), ['新钢琴']);
  assert.deepEqual(resolved, ['新钢琴']);
});

test('G11 第四第五首进入解析并救回，分数与发现位不能挤掉前两个可播模型选项', async () => {
  const play = Array.from({ length: 5 }, (_, index) => song(`候选${index + 1}`, {
    lane: index === 4 ? 'classic' : 'fresh', score: index * 20,
  }));
  const base = services.ncm.resolve;
  services.ncm.resolve = async (candidate, options) => ({ ...await base(candidate, options),
    playable: candidate.playOrder >= 3 });
  const ep = await finalizeEpisode(plan(play), { recommendation: pianoRecommendation({ discoveryLane: 'classic' }) });
  assert.deepEqual(resolved, play.map((item) => item.title));
  assert.deepEqual(titles(ep), ['候选4', '候选5']);
  resolved = [];
  services.ncm.resolve = base;
  const all = await finalizeEpisode(plan(play), { recommendation: pianoRecommendation({ discoveryLane: 'classic',
    poolSongs: [song('高分池', { genre: '钢琴', mood: '安静', score: 999 })] }) });
  assert.deepEqual(titles(all), ['候选1', '候选2']);
});

test('G11 排除项、chat 和 control 都不能触发放宽', async () => {
  const play = [song('近期')];
  for (const intent of ['recommend', 'chat', 'control']) {
    const ep = await finalizeEpisode({ ...plan(play), intent }, { recommendation: {
      styleRequest: intent === 'recommend' ? '不要摇滚' : '安静的钢琴', recentSongs: play,
    } });
    assert.deepEqual(titles(ep), []);
  }
  assert.deepEqual(resolved, []);
});

test('G11 两轮共用解析预算，超时后不再给近期候选新预算', async () => {
  const play = [song('严格挂起'), song('近期救援')];
  let aborted = false;
  services.ncm.resolve = (candidate, { signal }) => {
    resolved.push(candidate.title);
    signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  };
  const ep = await finalizeEpisode(plan(play), { resolveTimeout: 20,
    recommendation: pianoRecommendation({ recentSongs: [play[1]] }) });
  assert.deepEqual(titles(ep), []);
  assert.deepEqual(resolved, ['严格挂起']);
  assert.equal(aborted, true);
});

test('G11 第二轮只拿剩余预算，取消能中断第二轮', async () => {
  const play = [song('严格失败'), song('近期救援')];
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  const controller = new AbortController();
  let relaxedSignal;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  services.ncm.resolve = async (candidate, { signal }) => {
    resolved.push(candidate.title);
    if (candidate.title === '严格失败') { clock += 15; return { playable: false }; }
    relaxedSignal = signal;
    entered();
    return new Promise(() => {});
  };
  try {
    const work = finalizeEpisode(plan(play), { resolveTimeout: 30, signal: controller.signal,
      recommendation: pianoRecommendation({ recentSongs: [play[1]] }) });
    await ready;
    const reason = new Error('取消第二轮');
    controller.abort(reason);
    await assert.rejects(work, (error) => error === reason);
    assert.equal(relaxedSignal.aborted, true);
    assert.deepEqual(resolved, ['严格失败', '近期救援']);
  } finally { Date.now = realNow; }
});

test('G11 有剩余预算的第二轮会按剩余时间取消解析', async () => {
  const play = [song('严格失败'), song('近期救援')];
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  const realSetTimeout = globalThis.setTimeout;
  const budgets = [];
  globalThis.setTimeout = (fn, delay, ...args) => { budgets.push(delay); return realSetTimeout(fn, delay, ...args); };
  services.ncm.resolve = async (candidate) => {
    if (candidate.title === '严格失败') { clock += 15; return { playable: false }; }
    return new Promise(() => {});
  };
  try {
    await finalizeEpisode(plan(play), { resolveTimeout: 30,
      recommendation: pianoRecommendation({ recentSongs: [play[1]] }) });
    assert.deepEqual(budgets, [30, 15]);
  } finally { Date.now = realNow; globalThis.setTimeout = realSetTimeout; }
});

test('G11 模型自报钢琴标签不能救回服务器查到的摇滚，空曲风仍可播', async () => {
  const genres = ['摇滚 / 流行 / 国语', '摇滚-日系摇滚 / 流行-日本流行 / 日语',
    '纯演奏音乐 / 纯音乐', '流行 / 古典-当代古典音乐 / 新世纪', ''];
  const play = genres.map((_, index) => song(`风格${index}`, { tags: ['钢琴'], genre: '钢琴' }));
  const base = services.ncm.resolve;
  services.ncm.resolve = async (candidate, options) => ({ ...await base(candidate, options), genre: genres[candidate.playOrder] });
  const ep = await finalizeEpisode(plan(play), { recommendation: pianoRecommendation() });
  assert.deepEqual(titles(ep), ['风格2', '风格3']);
  services.ncm.resolve = async (candidate, options) => ({ ...await base(candidate, options), genre: '' });
  assert.deepEqual(titles(await finalizeEpisode(plan([play[4]]), { recommendation: pianoRecommendation() })), ['风格4']);
});

test('G11 零歌结构化诊断含解析错误及超时，限制长度且不含 URL 或异常原文', async () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  services.ncm.resolve = async (candidate) => {
    if (candidate.playOrder === 0) throw new Error('https://secret.invalid/audio 私密异常');
    if (candidate.playOrder === 1) return { playable: false, url: 'https://secret.invalid/audio' };
    return new Promise(() => {});
  };
  try {
    await finalizeEpisode(plan([song('错误 https://secret.invalid/title'), song('无版权'), song('挂起')]), { resolveTimeout: 10 });
    assert.equal(warnings.length, 1);
    const payload = JSON.parse(warnings[0].slice('[episode-empty] '.length));
    assert.ok(payload.candidates.some((item) => item.reasons.includes('resolve-error')));
    assert.ok(payload.candidates.some((item) => item.reasons.includes('timeout')));
    assert.ok(payload.candidates.some((item) => item.reasons.includes('unplayable')));
    assert.doesNotMatch(warnings[0], /https?:\/\/|私密异常|secret\.invalid/);
    assert.ok(warnings[0].length < 12_000);
  } finally { console.warn = warn; }
});

test('G11 无正向风格时仍按打分与桥接、发现位挑两首', async () => {
  const play = [song('低分桥', { score: 1 }), song('高分桥', { score: 99 }),
    song('发现', { score: 2, lane: 'classic' })];
  const ep = await finalizeEpisode(plan(play), { recommendation: { discoveryLane: 'classic' } });
  assert.deepEqual(titles(ep), ['高分桥', '发现']);
});
test('G15 零歌诊断区分限流与普通不可播，两处淘汰都不混用原因', async () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  services.ncm.resolve = async (candidate) => ({ playable: false, url: null,
    ...(candidate.title === '限流' ? { rateLimited: true, error: 'ncm /search -> 405' } : {}) });
  try {
    const ep = await finalizeEpisode(plan([song('限流'), song('无版权')]));
    assert.deepEqual(titles(ep), []);
    assert.equal(warnings.length, 1);
    const payload = JSON.parse(warnings[0].slice('[episode-empty] '.length));
    assert.deepEqual(payload.candidates.map(({ title, reasons }) => [title, reasons]), [
      ['限流', ['rate-limited']], ['无版权', ['unplayable']],
    ]);
  } finally { console.warn = warn; }
});
test.after(() => {
  runtime.closeRuntime(); runtime.wss.close();
  globalThis.fetch = realFetch;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('G7 无标签模型钢琴选歌可播，服务器覆盖模型 playOrder 并保留播放顺序', async () => {
  const ep = await finalizeEpisode(plan([
    song('River Flows in You', { score: 70, playOrder: 99 }),
    song('Kiss the Rain', { score: 99, playOrder: -1 }),
  ]), { recommendation: { styleRequest: '来点安静的钢琴' } });
  assert.deepEqual(titles(ep), ['River Flows in You', 'Kiss the Rain']);
});

test('G7 无正向标签的池候选不解析，自带 playOrder 也不能伪装成模型选歌', async () => {
  const ep = await finalizeEpisode(plan([]), { recommendation: {
    styleRequest: '来点安静的钢琴',
    poolSongs: [song('未知曲风', { playOrder: 0 })],
  } });
  assert.deepEqual(resolved, []);
  assert.deepEqual(titles(ep), []);
  services.ncm.resolve = async (candidate) => ({ ...candidate, id: 'pool', playable: true,
    url: 'https://m.126.net/pool', genre: 'rock', mood: 'upbeat' });
  const changed = await finalizeEpisode(plan([]), { recommendation: {
    styleRequest: '来点安静的钢琴',
    poolSongs: [song('标签被修正', { playOrder: 0, genre: 'piano', mood: 'calm' })],
  } });
  assert.deepEqual(titles(changed), []);
});

test('G7 模型歌的候选和解析元数据都必须符合排除条件', async () => {
  services.ncm.resolve = async (candidate) => ({ title: candidate.title, artist: candidate.artist,
    id: candidate.title, playable: true, url: 'https://m.126.net/fake',
    genre: candidate.title === '解析冲突' ? 'rock' : 'instrumental' });
  const ep = await finalizeEpisode(plan([
    song('候选冲突', { genre: 'rock', score: 99 }), song('解析冲突', { score: 90 }),
    song('保留钢琴', { score: 80 }),
  ]), { recommendation: { styleRequest: '安静的钢琴，不要摇滚' } });
  assert.deepEqual(titles(ep), ['保留钢琴']);
});

test('G7 禁播保留明确点歌例外，解析后仍排除已持有歌曲', async () => {
  const banned = song('禁播钢琴');
  const recommendation = { styleRequest: '安静的钢琴', bannedSongs: [banned] };
  assert.deepEqual(titles(await finalizeEpisode(plan([banned]), { recommendation })), []);
  const explicit = await finalizeEpisode(plan([banned]), { recommendation: { ...recommendation, explicitRequest: true } });
  assert.deepEqual(titles(explicit), ['禁播钢琴']);
  episodeBuffer.setCurrent(explicit);
  services.ncm.resolve = async () => ({ ...explicit.queue[0].meta, playable: true, url: 'https://m.126.net/repeated' });
  assert.deepEqual(titles(await finalizeEpisode(plan([song('另一个标题')]), { recommendation })), []);
});

test('G7 零歌聊天推荐：口播稿先合成但不放，选歌落空改成诚实口播后作废重来', async () => {
  services.ncm.resolve = async () => ({ playable: false });
  const spoken = [];
  services.prepareLiveTts = (text, { signal } = {}) => { spoken.push({ text, signal }); return { url: `/tts/fake${spoken.length}.mp3`, ready: Promise.resolve() }; };
  services.synthesize = async (text) => { spoken.push({ text }); return { url: '/tts/fake.mp3' }; };
  services.stream = async (_, { onText }) => {
    const raw = JSON.stringify(plan([song('不播放')]));
    onText(raw);
    await tick();
    return raw;
  };
  let reply;
  const res = new EventEmitter();
  res.status = () => res;
  res.json = (body) => { res.writableEnded = true; reply = body; };
  const layer = runtime.app._router.stack.find((entry) => entry.route?.path === '/api/chat');
  await layer.route.stack[0].handle({ body: { input: '来点安静的钢琴' } }, res);
  await tick();
  assert.equal(reply.ok, true);
  assert.equal(reply.episode.say, '这会儿没找到能放的，先接着听这首。');
  // 先合成的是大脑原稿（推荐要等选歌确认才放），落空后作废；最后念的是诚实口播
  assert.equal(spoken.length, 2);
  assert.equal(spoken[0].signal.aborted, true);
  assert.equal(plainText(spoken[1].text), reply.episode.say);
  assert.equal(reply.episode.queue.find((item) => item.type === 'tts')?.text, reply.episode.say);
  assert.equal(reply.episode.queue.find((item) => item.type === 'tts')?.url, '/tts/fake2.mp3');
});

test('G7 零歌自动节目不进缓冲、不合成，按失败退避重试', async () => {
  let planned = 0;
  services.plan = async () => { planned += 1; return plan([song('无版权')]); };
  services.ncm.resolve = async () => ({ playable: false });
  const spoken = [];
  services.synthesize = async (text) => { spoken.push(text); return { url: '/tts/fake.mp3' }; };
  services.prepareLiveTts = () => { throw new Error('自动节目不应开流'); };
  const ws = new EventEmitter();
  const sent = [];
  ws.send = (raw) => sent.push(JSON.parse(raw).kind);
  process.env.CLAUDIO_SKIP_PREFETCH = '0';
  runtime.wss.emit('connection', ws);
  for (let i = 0; i < 50 && !(planned && !episodeBuffer.snapshot().generating); i += 1) await tick();
  process.env.CLAUDIO_SKIP_PREFETCH = '1';
  assert.equal(planned, 1);
  assert.equal(episodeBuffer.snapshot().next, null);
  assert.ok(!sent.includes('nextReady'));
  episodeBuffer.retryVoices();
  await tick();
  assert.deepEqual(spoken, []);
  ws.emit('close');
  episodeBuffer.idle();
});

test('点歌时大脑点名的歌先找、先放，不被发现池的歌挤出候选', async () => {
  const play = [
    { title: '大哥', artist: '卫兰', discoveryType: 'explore', lane: 'classic', score: 80 },
    { title: '至少还有你', artist: '林忆莲', discoveryType: 'explore', lane: 'classic', score: 78 },
    { title: '喜帖街', artist: '谢安琪', discoveryType: 'explore', lane: 'classic', score: 76 },
  ];
  const poolSongs = [
    ...['池桥一', '池桥二', '池桥三', '池桥四'].map((title) => ({ title, artist: '池歌手', discoveryType: 'adjacent', score: 90 })),
    ...['池流行一', '池流行二', '池流行三'].map((title) => ({ title, artist: '池歌手', lane: 'popular', score: 90 })),
  ];
  const ep = await finalizeEpisode({ intent: 'recommend', say: '来两首粤语老歌。', play },
    { recommendation: { poolSongs, discoveryLane: 'popular' }, chat: true });
  assert.deepEqual(titles(ep), ['大哥', '至少还有你']);
  assert.deepEqual(resolved.slice(0, 3), ['大哥', '至少还有你', '喜帖街']);
});

test('口播引用的旧事：歌在放就记下来（事件日志只记 id），歌没放就摘掉那句话', async () => {
  const { readEvents } = await import('../server/events.js');
  const play = [song('老街'), song('晴天')];
  const matched = {
    id: 'n_0000000a', kind: 'song', text: '他循环老街，说那是大学那条路', quote: '老街我循环了四遍',
    songs: [{ title: '老街' }], at: '2026-06-01T00:00:00.000Z', status: 'active', sensitive: 'normal',
  };
  const ep = await finalizeEpisode(
    { ...plan(play), say: '你上次循环老街，说那是大学那条路，那就接着听。', memoryRef: matched.id },
    { recommendation: { ...pianoRecommendation({}), mentionable: [matched] } },
  );
  assert.equal(ep.memoryRef?.id, matched.id);
  assert.equal(ep.memoryRef?.quote, '老街我循环了四遍');
  const cited = readEvents().filter((event) => event.type === 'memory_cited');
  assert.equal(cited.length, 1);
  assert.equal(cited[0].key, matched.id);
  assert.equal(cited[0].value, undefined, '收听事件日志里不落记忆原文');

  // 引用那条挂的歌没放成：引用作废，说出口的那句也要摘掉
  const broken = { ...matched, id: 'n_0000000b', songs: [{ title: '十年', artist: '陈奕迅' }] };
  const strippedEp = await finalizeEpisode(
    { ...plan(play), say: '你上次循环老街，说那是大学那条路。今晚这首很轻。', memoryRef: broken.id },
    { recommendation: { ...pianoRecommendation({}), mentionable: [broken] } },
  );
  assert.equal(strippedEp.memoryRef, undefined);
  assert.doesNotMatch(strippedEp.say, /大学那条路/);
  assert.match(strippedEp.say, /今晚这首很轻/);
});

test('点名歌手的歌都放不了：不拿发现池里别人的歌补，直说这位歌手的歌拿不到', async () => {
  services.ncm.resolve = async (candidate) => {
    resolved.push(candidate.title);
    return candidate.artist === '甲歌手' ? { title: candidate.title, artist: candidate.artist, url: null, playable: false }
      : { title: candidate.title, artist: candidate.artist, id: String(++serial), url: `https://m.126.net/${serial}`, playable: true };
  };
  const play = ['一', '二', '三'].map((t) => ({ title: `甲${t}`, artist: '甲歌手', discoveryType: 'explore' }));
  const poolSongs = ['池一', '池二'].map((title) => ({ title, artist: '乙歌手', discoveryType: 'adjacent', score: 90 }));
  const ep = await finalizeEpisode({ intent: 'recommend', say: '甲歌手的歌，先听《甲一》，再听《甲二》。', play },
    { recommendation: { poolSongs, discoveryLane: 'popular' }, chat: true, userInput: '放首甲歌手的歌' });
  assert.deepEqual(titles(ep), []);
  assert.equal(ep.say, '甲歌手的歌这会儿拿不到，先接着听这首。');
  assert.equal(resolved.some((t) => t.startsWith('池')), false);
  // 没点名歌手（只说换一首）时，发现池照旧补位
  const loose = await finalizeEpisode({ intent: 'recommend', say: '换一批。', play },
    { recommendation: { poolSongs, discoveryLane: 'popular' }, chat: true, userInput: '换一首' });
  assert.equal(titles(loose).length > 0, true);
});
