import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { matchesStyle, matchesResolvedStyle, styleConstraints, genreEvidence } from '../server/style-request.js';
import { episodeCandidates } from '../server/episode-candidates.js';

test('垫场歌证据只认真实曲风，不以标题、情绪或排除项证明匹配', () => {
  const constraints = styleConstraints('来点安静的钢琴');
  assert.equal(genreEvidence({ genre: '纯音乐' }, constraints), 'match');
  assert.equal(genreEvidence({ genre: '流行-华语流行' }, constraints), 'conflict');
  assert.equal(genreEvidence({ genre: 'pop', title: '钢琴作品' }, constraints), 'conflict');
  for (const genre of [undefined, '', '   ']) {
    assert.equal(genreEvidence({ genre }, constraints), 'unknown');
    assert.equal(genreEvidence({ genre, title: '钢琴作品' }, constraints), 'unknown');
  }
  for (const input of ['', '安静', '欢快', '悲伤', '不要摇滚']) {
    assert.equal(genreEvidence({ genre: 'pop' }, styleConstraints(input)), '');
    assert.equal(genreEvidence({}, styleConstraints(input)), '');
  }
});

test('G10 要不来点和要不要来点是建议，空白不改变含义', () => {
  for (const input of ['要不来点爵士', '要不要来点摇滚', '要 不 来 点 爵士', '要 不 要 来 点 摇滚', '要不要 来一点 摇滚']) {
    const constraints = styleConstraints(input);
    assert.ok(constraints.length, input);
    assert.ok(constraints.every(Array.isArray), input);
    assert.equal(matchesStyle({}, constraints), false, input);
    assert.equal(matchesStyle({ genre: 'jazz rock' }, constraints), true, input);
  }
});

test('G10 建议不吞掉真正的否定，也不会从不要回退为不', () => {
  for (const input of ['不要摇滚', '别摇滚', '不想听摇滚', '只要不要摇滚，其他都行', '只要 不要 摇滚', '要不别放摇滚', '要 不 别 放 摇滚']) {
    const constraints = styleConstraints(input);
    assert.equal(matchesStyle({ genre: 'rock' }, constraints), false, input);
    assert.equal(matchesStyle({}, constraints), true, input);
  }
  for (const input of ['要不来点爵士，但不要摇滚', '不要摇滚，要不要来点爵士', '要不要来点爵士，别放摇滚，来点安静的', '要不来点爵士，不想听摇滚']) {
    const constraints = styleConstraints(input);
    assert.equal(matchesStyle({ genre: 'jazz', mood: 'quiet' }, constraints), true, input);
    assert.equal(matchesStyle({ genre: 'jazz rock', mood: 'quiet' }, constraints), false, input);
    assert.equal(matchesStyle({}, constraints), false, input);
  }
});

test('不要摇滚只排除摇滚，仍要求后面的爵士', () => {
  const constraints = styleConstraints('不要摇滚，来点爵士');
  assert.equal(matchesStyle({ genre: 'jazz' }, constraints), true);
  assert.equal(matchesStyle({ genre: 'jazz rock' }, constraints), false);
  assert.equal(matchesStyle({ genre: 'classical' }, constraints), false);
});

test('否定词紧邻风格时只作为排除条件，未知标签仍可保留', () => {
  for (const input of ['别听摇滚', '不想听摇滚', '不听摇滚', '除了摇滚', '不要 摇滚', '别 摇滚', '除了 摇滚', '不要听那种摇滚', 'no rock', 'not rock', 'not too much rock', 'without rock']) {
    const constraints = styleConstraints(input);
    assert.ok(constraints.length, input);
    assert.equal(matchesStyle({ genre: 'rock' }, constraints), false, input);
    assert.equal(matchesStyle({ genre: 'jazz' }, constraints), true, input);
    assert.equal(matchesStyle({ title: '未知曲风' }, constraints), true, input);
  }
});

test('否定不越过分句污染后面的安静要求', () => {
  const constraints = styleConstraints('别太吵，来点安静的');
  assert.equal(matchesStyle({ mood: 'quiet' }, constraints), true);
  assert.equal(matchesStyle({ mood: 'happy' }, constraints), false);
});

test('来点钢琴仍保持正向 group 数组契约并要求钢琴证据', () => {
  const constraints = styleConstraints('来点钢琴');
  assert.deepEqual(constraints, [['钢琴', 'piano']]);
  assert.equal(matchesStyle({ instrument: 'piano' }, constraints), true);
  assert.equal(matchesStyle({ instrument: 'guitar' }, constraints), false);
  assert.equal(matchesStyle({}, constraints), false);
});

test('发现池兜底按排除条件过滤已有元数据', () => {
  const pool = [
    { title: '摇滚候选', artist: '甲', genre: 'rock' },
    { title: '爵士候选', artist: '乙', genre: 'jazz' },
  ];
  const candidates = episodeCandidates({ intent: 'recommend', play: [] }, pool, '不要摇滚');
  assert.deepEqual(candidates.map((song) => song.title), ['爵士候选']);
});

test('G11 模型选歌的器乐家族只核对解析后的曲风和标题', () => {
  const families = ['纯音乐', '纯演奏', '轻音乐', '新世纪', '古典', '器乐', '配乐', 'instrumental', 'new age', 'classical'];
  for (const request of ['钢琴', '吉他', '小提琴', '大提琴', '萨克斯', '纯音乐', '器乐', '轻音乐']) {
    const constraints = styleConstraints(request);
    for (const genre of families) {
      assert.equal(matchesResolvedStyle({ genre }, constraints), true, `${request}: ${genre}`);
    }
    assert.equal(matchesResolvedStyle({ genre: 'pop', title: `一首${request}作品` }, constraints), true, request);
    assert.equal(matchesResolvedStyle({ genre: 'pop', title: '普通流行歌' }, constraints), false, request);
  }
  assert.equal(matchesResolvedStyle({ genre: 'Jazz' }, styleConstraints('萨克斯')), true);
  assert.equal(matchesResolvedStyle({ genre: '爵士' }, styleConstraints('萨克斯')), true);
  assert.equal(matchesResolvedStyle({ genre: 'jazz' }, styleConstraints('钢琴')), false);
});

test('G11 曲风组仍需自己的词，每个正向组都要通过，情绪不作曲风冲突', () => {
  for (const request of ['爵士', '古典', '摇滚', '民谣', '电子', '说唱', '蓝调', '乡村', '金属']) {
    const constraints = styleConstraints(request);
    for (const genre of constraints[0]) assert.equal(matchesResolvedStyle({ genre }, constraints), true, `${request}: ${genre}`);
    assert.equal(matchesResolvedStyle({ genre: 'pop', title: '普通歌曲' }, constraints), false, request);
  }
  assert.equal(matchesResolvedStyle({ genre: 'instrumental' }, styleConstraints('古典')), false);
  assert.equal(matchesResolvedStyle({ genre: 'rock' }, styleConstraints('安静舒缓、欢快又伤感')), true);
  const multiple = styleConstraints('来点钢琴和爵士，安静一些');
  assert.equal(matchesResolvedStyle({ genre: 'instrumental' }, multiple), false);
  assert.equal(matchesResolvedStyle({ genre: 'jazz', title: 'Piano song' }, multiple), true);
});

test('G11 未知曲风允许，模型自报的标签和其他字段不能覆盖真实冲突', () => {
  const constraints = styleConstraints('钢琴');
  for (const genre of [undefined, '', '   ']) {
    assert.equal(matchesResolvedStyle({ genre, title: '普通歌曲' }, constraints), true);
  }
  assert.equal(matchesResolvedStyle({ genre: 'pop', title: '普通歌曲', mood: 'piano', style: 'piano', instrument: 'piano', tags: ['piano'], artist: 'piano' }, constraints), false);
  assert.equal(matchesResolvedStyle({ genre: 'pop', title: '普通歌曲', candidate: { genre: 'piano', title: '钢琴' } }, constraints), false);
});

test('G11 模型家族不放宽发现池或负向要求的字面匹配', () => {
  assert.equal(matchesStyle({ genre: 'classical' }, styleConstraints('钢琴')), false);
  const candidates = episodeCandidates({ intent: 'recommend', play: [] }, [
    { title: '古典作品', artist: '甲', genre: 'classical' },
    { title: '钢琴作品', artist: '乙', genre: 'piano' },
  ], '钢琴');
  assert.deepEqual(candidates.map((song) => song.title), ['钢琴作品']);
  const exclusions = styleConstraints('不要钢琴');
  assert.equal(matchesStyle({ genre: '纯音乐' }, exclusions), true);
  assert.equal(matchesStyle({ genre: 'classical' }, exclusions), true);
  assert.equal(matchesStyle({ genre: 'piano' }, exclusions), false);
  assert.equal(matchesResolvedStyle({ genre: 'piano' }, exclusions), true, '排除仍交给原有 matchesStyle');
  assert.equal(matchesResolvedStyle({ genre: 'classical' }, styleConstraints('不要摇滚，来点钢琴')), true);
});

test('仅有排除的聊天要求延续到自动推荐，并拦住解析后的冲突元数据', { timeout: 3000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-style-'));
  const envKeys = ['CLAUDIO_RESOURCE_ROOT', 'CLAUDIO_DATA_DIR', 'CLAUDIO_NO_LISTEN', 'CLAUDIO_SKIP_PREFETCH'];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.CLAUDIO_RESOURCE_ROOT = directory;
  process.env.CLAUDIO_DATA_DIR = directory;
  process.env.CLAUDIO_NO_LISTEN = '1';
  process.env.CLAUDIO_SKIP_PREFETCH = '1';
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('离线测试禁止真实网络'); };
  const runtime = await import('../server/index.js');
  t.after(() => {
    runtime.closeRuntime();
    runtime.wss.close();
    globalThis.fetch = realFetch;
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const { services } = runtime;
  services.cache = { has: () => false, pin: () => {}, ensure: async () => { throw new Error('不下载'); } };
  let id = 0;
  services.ncm = {
    lyric: async () => '',
    resolve: async (song) => ({ ...song, id: String(++id), url: `https://m.126.net/${id}`, playable: true,
      genre: song.title === '待查曲风' ? 'rock' : (song.title === '候选已知冲突' ? 'jazz' : song.genre) }),
  };
  services.synthesize = async () => ({ url: '/tts/fake.mp3' });
  services.prepareLiveTts = () => ({ url: '/tts/fake.mp3', ready: Promise.resolve() });
  services.stream = async () => JSON.stringify({ say: '好，避开摇滚。', intent: 'chat', play: [] });
  const layer = runtime.app._router.stack.find((entry) => entry.route?.path === '/api/chat');
  const response = new EventEmitter();
  let reply;
  response.status = () => response;
  response.json = (value) => { response.writableEnded = true; reply = value; return response; };
  await layer.route.stack[0].handle({ body: { input: '不要摇滚', requestId: 'negative-style' } }, response);
  assert.equal(reply.ok, true);
  let automaticPrompt = '';
  services.plan = async (prompt) => {
    automaticPrompt = prompt;
    return { say: '', intent: 'recommend', play: [
      { title: '待查曲风', artist: '甲', genre: 'jazz', discoveryType: 'adjacent', score: 90 },
      { title: '候选已知冲突', artist: '丙', genre: 'rock', discoveryType: 'adjacent', score: 85 },
      { title: '可留爵士', artist: '乙', genre: 'jazz', discoveryType: 'adjacent', score: 80 },
    ] };
  };
  const ws = new EventEmitter();
  const ready = new Promise((resolve) => {
    ws.send = (raw) => {
      if (JSON.parse(raw).kind !== 'nextReady') return;
      process.env.CLAUDIO_SKIP_PREFETCH = '1';
      resolve();
    };
  });
  process.env.CLAUDIO_SKIP_PREFETCH = '0';
  runtime.wss.emit('connection', ws);
  await ready;
  const episode = await runtime.episodeBuffer.claim('auto-style');
  assert.match(automaticPrompt, /不要摇滚/);
  assert.ok(episode);
  assert.deepEqual(episode.queue.map((item) => item.meta.title), ['可留爵士']);
});
