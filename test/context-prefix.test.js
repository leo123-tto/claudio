import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 固定本地时区和虚构资料，避免碰个人数据或外部服务。
process.env.TZ = 'Asia/Shanghai';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-prefix-test-'));
process.env.CLAUDIO_RESOURCE_ROOT = root;
process.env.CLAUDIO_DATA_DIR = root;
const write = (file, content) => fs.writeFileSync(path.join(root, file), content);
fs.mkdirSync(path.join(root, 'user'));
fs.mkdirSync(path.join(root, 'cache'));
write('user/taste.md', '虚构听众喜欢有流动感的编曲，工作时听低干扰音乐。');
write('user/playlists.json', JSON.stringify({ playlists: [
  { name: '虚构工作歌单', mood: '专注', songs: [{ title: '手工虚构曲', artist: '手工虚构歌手' }] },
] }));
write('user/routines.md', '虚构听众上午工作，晚上散步。');
write('user/mood-rules.md', '虚构听众疲惫时喜欢轻柔的音乐。');
write('user/memory.md', '- 虚构听众喜欢乐器之间的呼应。');
write('cache/taste-digest.md', '虚构听众喜欢松弛而有变化的节奏。');
write('cache/bans.json', JSON.stringify({ seeded: true, songs: [{ title: '禁播虚构曲', artist: '禁播虚构歌手' }] }));
write('cache/state.json', JSON.stringify({ messages: [
  { role: 'user', content: '工作了一上午，想慢下来。' },
  { role: 'claudio', content: '窗边的光落下来，先听一段轻轻的旋律。' },
  { role: 'user', content: '有变化的编曲会让我更专注。' },
] }));

const favorites = Array.from({ length: 64 }, (_, i) => ({ title: `收藏虚构曲${i}`, artist: `收藏虚构歌手${i}` }));
const pool = ['bridge', 'popular', 'fresh', 'classic'].flatMap((lane) =>
  Array.from({ length: 32 }, (_, i) => ({ title: `${lane}虚构曲${i}`, artist: `池中虚构歌手${i}`, lane })));
const recent = Array.from({ length: 25 }, (_, i) => ({ title: `已播虚构曲${i}`, artist: `已播虚构歌手${i}` }));
const events = recent.map((song) => ({ type: 'play_started', at: '2026-11-02T00:00:00.000Z', song }));
function writeFavorites(songs = favorites) {
  write('user/favorites.md', songs.map(({ title, artist }) => `- ${title} — ${artist}`).join('\n'));
}
function writePool(songs = pool) {
  write('cache/discovery-pool.json', JSON.stringify({ songs }));
}
function setLane(lane = 'popular') {
  const previous = { popular: 'classic', fresh: 'popular', classic: 'fresh' }[lane];
  write('cache/listening-events.jsonl', [...events, { type: 'recommendation', lane: previous }]
    .map((event) => JSON.stringify(event)).join('\n'));
}
writeFavorites();
writePool();
setLane();
const { buildPromptBundle } = await import('../server/context.js');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
test.beforeEach(() => { writeFavorites(); writePool(); setLane(); });

const favoriteHeading = '收藏曲口味样本（只作锚点，自动推荐严禁照搬原曲）';
const recentHeading = '最近听过（硬避重；含今天播过的，程序还会再滤一遍）';
function section(prompt, heading) {
  return prompt.split(`## ${heading}\n`)[1]?.split('\n\n## ')[0] || '';
}
function favoriteLines(bundle) {
  return section(bundle.prompt, favoriteHeading).split('\n').filter((line) => line.startsWith('- '));
}
function lcp(a, b) {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return index;
}
function freezeTime(t, date = new Date(2026, 10, 2, 9, 15, 10)) {
  t.mock.timers.enable({ apis: ['Date'], now: date.getTime() });
}
const chat = { userInput: '今天有点累，陪我聊聊。' };

test('两个样本在本地同一小时稳定，跨小时及跨日轮换', (t) => {
  freezeTime(t);
  const first = buildPromptBundle(chat);
  t.mock.timers.setTime(new Date(2026, 10, 2, 9, 59, 59).getTime());
  const sameHour = buildPromptBundle(chat);
  assert.deepEqual(favoriteLines(first), favoriteLines(sameHour));
  assert.deepEqual(first.recommendation.poolSongs, sameHour.recommendation.poolSongs);
  assert.equal(favoriteLines(first).length, 12);
  assert.equal(first.recommendation.poolSongs.length, 12);

  t.mock.timers.setTime(new Date(2026, 10, 2, 10, 0, 0).getTime());
  const nextHour = buildPromptBundle(chat);
  assert.notDeepEqual(favoriteLines(first), favoriteLines(nextHour));
  assert.notDeepEqual(first.recommendation.poolSongs, nextHour.recommendation.poolSongs);

  t.mock.timers.setTime(new Date(2026, 10, 2, 23, 59, 59).getTime());
  const beforeMidnight = buildPromptBundle(chat);
  t.mock.timers.setTime(new Date(2026, 10, 3, 0, 0, 0).getTime());
  const midnight = buildPromptBundle(chat);
  t.mock.timers.setTime(new Date(2026, 10, 3, 0, 0, 5).getTime());
  const sameMidnightHour = buildPromptBundle(chat);
  assert.notDeepEqual(favoriteLines(beforeMidnight), favoriteLines(midnight));
  assert.notDeepEqual(beforeMidnight.recommendation.poolSongs, midnight.recommendation.poolSongs);
  assert.deepEqual(favoriteLines(midnight), favoriteLines(sameMidnightHour));
  assert.deepEqual(midnight.recommendation.poolSongs, sameMidnightHour.recommendation.poolSongs);
  t.mock.timers.setTime(new Date(2026, 10, 4, 0, 0, 0).getTime());
  const nextDay = buildPromptBundle(chat);
  assert.notDeepEqual(favoriteLines(midnight), favoriteLines(nextDay));
  assert.notDeepEqual(midnight.recommendation.poolSongs, nextDay.recommendation.poolSongs);
});

test('候选池种子独立于收藏和其他轨位，保持分组配额', (t) => {
  freezeTime(t);
  const samples = [];
  for (const lane of ['popular', 'fresh', 'classic']) {
    setLane(lane);
    const bundle = buildPromptBundle(chat);
    assert.equal(bundle.recommendation.discoveryLane, lane);
    assert.deepEqual(favoriteLines(bundle), favoriteLines(samples[0] || bundle));
    const songs = bundle.recommendation.poolSongs;
    assert.equal(songs.filter((song) => song.lane === lane).length, 4);
    assert.equal(songs.filter((song) => song.lane === 'bridge').length, 4);
    // 点歌提示词不带候选池（大脑会照抄），池子只给程序兜底；自动节目的提示词里仍逐首列出。
    assert.equal(section(bundle.prompt, '候选池'), '');
    const automaticPool = section(buildPromptBundle({}).prompt, '候选池');
    for (const song of songs) assert.ok(automaticPool.includes(`${song.title} — ${song.artist}`));
    samples.push(bundle);
  }
  // 桥接组配额不变，仍随轨位使用独立种子。
  assert.equal(new Set(samples.map((bundle) => JSON.stringify(bundle.recommendation.poolSongs.slice(0, 4)))).size, 3);
  setLane();
  assert.deepEqual(buildPromptBundle(chat).recommendation.poolSongs, samples[0].recommendation.poolSongs);
  writeFavorites(favorites.slice(0, 3));
  const changedFavorites = buildPromptBundle(chat);
  assert.notDeepEqual(favoriteLines(changedFavorites), favoriteLines(samples[0]));
  assert.deepEqual(changedFavorites.recommendation.poolSongs, samples[0].recommendation.poolSongs);
  writePool(pool.map((song) => ({ ...song, title: `刷新${song.title}` })));
  const changedPool = buildPromptBundle(chat);
  assert.notDeepEqual(changedPool.recommendation.poolSongs, changedFavorites.recommendation.poolSongs);
  assert.deepEqual(favoriteLines(changedPool), favoriteLines(changedFavorites));
});

test('空池、小池和重复输入安全，采样不改写输入', (t) => {
  freezeTime(t);
  writeFavorites([]);
  writePool([]);
  const empty = buildPromptBundle(chat);
  assert.deepEqual(empty.recommendation.poolSongs, []);
  assert.deepEqual(favoriteLines(empty), []);
  for (const songs of [pool.slice(0, 2), pool]) {
    writePool([...songs, ...songs.map((song) => ({ ...song, lane: 'fresh' }))]);
    writeFavorites([...favorites.slice(0, 2), ...favorites.slice(0, 2)]);
    const files = ['user/favorites.md', 'cache/discovery-pool.json'];
    const original = files.map((file) => fs.readFileSync(path.join(root, file), 'utf8'));
    const result = buildPromptBundle(chat);
    const keys = result.recommendation.poolSongs.map((song) => `${song.title}|${song.artist}`);
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(new Set(favoriteLines(result)).size, 2);
    assert.equal(favoriteLines(result).length, 2);
    assert.deepEqual(result.recommendation.favoriteSongs, [...favorites.slice(0, 2), ...favorites.slice(0, 2)]);
    assert.deepEqual(files.map((file) => fs.readFileSync(path.join(root, file), 'utf8')), original);
    if (songs.length === 2) assert.equal(keys.length, 2);
  }
});

test('G13 近期、持有和禁播歌曲全部排除时不展示候选池', (t) => {
  freezeTime(t);
  const held = { title: '持有虚构曲', artist: '持有虚构歌手' };
  writePool([...recent, held, { title: '禁播虚构曲', artist: '禁播虚构歌手' }]);
  const { prompt, recommendation } = buildPromptBundle({ excludeSongs: [held] });
  assert.deepEqual(recommendation.poolSongs, []);
  assert.ok(!prompt.includes('## 候选池\n'));
  assert.deepEqual(recommendation.recentSongs, [...recent].reverse().concat(held));
  assert.equal(section(prompt, recentHeading), recommendation.recentSongs
    .map(({ title, artist }) => `- ${title} — ${artist}`).join('\n'));
});

test('G13 混合池先过滤再抽样，只留下可用歌曲且不修改池文件', (t) => {
  freezeTime(t);
  const held = { title: '持有虚构曲', artist: '持有虚构歌手' };
  const available = pool.slice(0, 4);
  writePool([...recent, held, { title: '禁播虚构曲', artist: '禁播虚构歌手' }, ...available]);
  const original = fs.readFileSync(path.join(root, 'cache/discovery-pool.json'), 'utf8');
  const { prompt, recommendation } = buildPromptBundle({ excludeSongs: [held] });
  assert.deepEqual(new Set(recommendation.poolSongs.map((song) => song.title)), new Set(available.map((song) => song.title)));
  assert.doesNotMatch(section(prompt, '候选池'), /已播虚构曲|持有虚构曲|禁播虚构曲/);
  assert.equal(fs.readFileSync(path.join(root, 'cache/discovery-pool.json'), 'utf8'), original);
});

test('G13 候选池避重同时忽略歌名和歌手大小写，仍区分不同组合', (t) => {
  freezeTime(t);
  const held = { title: 'Held Song', artist: 'Held Artist' };
  const banned = { title: 'Banned Song', artist: 'Banned Artist' };
  write('cache/bans.json', JSON.stringify({ seeded: true, songs: [banned] }));
  t.after(() => write('cache/bans.json', JSON.stringify({ seeded: true, songs: [{ title: '禁播虚构曲', artist: '禁播虚构歌手' }] })));
  const available = [
    { title: held.title, artist: 'Other Artist' },
    { title: 'Other Song', artist: held.artist },
  ];
  writePool([
    { title: 'HELD SONG', artist: 'held artist' },
    { title: 'banned song', artist: 'BANNED ARTIST' },
    ...available,
  ]);
  const { recommendation } = buildPromptBundle({ excludeSongs: [held] });
  assert.deepEqual(new Set(recommendation.poolSongs.map((song) => `${song.title}|${song.artist}`)),
    new Set(available.map((song) => `${song.title}|${song.artist}`)));
});

test('段落由稳定到易变排列，任务附加规则相邻，听众原话仍在最后', (t) => {
  freezeTime(t);
  const options = { userInput: '来点钢琴', briefSay: true, sleep: { remainingMin: 15 }, nowPlaying: { type: 'song', title: '正在播虚构曲', artist: '虚构歌手' } };
  const { prompt } = buildPromptBundle(options);
  assert.deepEqual([...prompt.matchAll(/^## (.+)$/gm)].map((match) => match[1]), [
    '输出契约（严格只输出 JSON）', '听众口味档案', '听众手工歌单（理解场景，不要把它当默认点歌单）',
    '作息', '情绪规则', '持续整理的品味（他亲口说过好听或点过爱心后自动整理；手写口味档案仍以 taste.md 为准）',
    '人工可编辑的长期记忆（保留旧系统，只作稳定背景）', '禁播（自动推荐不要再选，听众可以要求恢复）',
    favoriteHeading, '结构化行为画像（分数越高越偏爱，负数表示避开）', recentHeading,
    '最近三次口播的首个分句（不得复用这些开头或意象）', '最近听众自己说过的话', '本次最高优先级任务',
    '睡前模式', '此刻场景（选歌和口播长度按这个来）', '环境', '正在播放', '听众刚说',
  ]);
  const task = section(prompt, '本次最高优先级任务');
  assert.ok(task.indexOf('听众刚说了话') < task.indexOf('本次有明确的正向曲风'));
  assert.ok(task.indexOf('本次有明确的正向曲风') < task.indexOf('本次简短口播'));
  assert.ok(prompt.startsWith('你是 Claudio，听众的私人电台 DJ。'));
  assert.ok(prompt.endsWith(`## 听众刚说\n${options.userInput}`));
  const auto = buildPromptBundle({ ...options, userInput: '', mood: '安静' }).prompt;
  assert.ok(section(auto, '本次最高优先级任务').includes('这次是自动推荐，intent=recommend，action=none。\n本次有明确的正向曲风'));
  assert.match(section(prompt, recentHeading), /已播虚构曲0 — 已播虚构歌手0/);
  const ordinaryRecent = section(buildPromptBundle(chat).prompt, recentHeading).split('\n');
  assert.equal(ordinaryRecent.length, recent.length);
});

test('相隔数秒的固定状态提示词共享至听众历史，自动转聊天的前缀增益可复核', (t) => {
  freezeTime(t);
  for (const mood of ['', '安静']) {
    const automatic = buildPromptBundle({ mood }).prompt;
    const first = buildPromptBundle({ ...chat, mood }).prompt;
    t.mock.timers.tick(5000);
    const second = buildPromptBundle({ ...chat, mood }).prompt;
    const endOfHistory = first.indexOf('## 最近听众自己说过的话\n')
      + `## 最近听众自己说过的话\n${section(first, '最近听众自己说过的话')}`.length;
    t.diagnostic(`style=${Boolean(mood)} auto→chat LCP=${lcp(automatic, first)} chars; chat→chat LCP=${lcp(first, second)} chars; history end=${endOfHistory}`);
    assert.ok(lcp(first, second) >= endOfHistory);
    // 点歌不带候选池，与自动节目共享到候选池之前；盒子按 2048 token 一块缓存，候选池已在第一块之后，不损失命中。
    assert.ok(lcp(automatic, first) >= automatic.indexOf('## 候选池\n'));
    assert.notEqual(section(first, '环境'), section(second, '环境'));
  }
});

test('驾驶模式：提示词尾部加一句「只说一句」，放在任务规则后面（不插进稳定段落）', () => {
  const now = new Date('2026-11-23T09:00:00+08:00');
  const plain = buildPromptBundle({ now }).prompt;
  const driving = buildPromptBundle({ now, drive: true }).prompt;
  assert.doesNotMatch(plain, /驾驶模式/);
  assert.match(driving, /## 驾驶模式\n听众正在开车/);
  // 放在任务规则之后、易变段落那一截，不插进前面稳定的档案 / 画像
  assert.ok(driving.indexOf('## 驾驶模式') > driving.indexOf('## 本次最高优先级任务'));
  assert.ok(driving.indexOf('## 驾驶模式') < driving.indexOf('## 此刻场景'));
});
