// 隐性关系进度：四个阶段，界面上永远不出现数字、经验值、进度条、连击天数。
// 只决定「怎么说话」：称呼、玩笑尺度、口播长度、要不要主动提旧事。
//
// 阶段只升不降 —— 长期不来也不会掉档，那不是惩罚，也不是打卡。
// 个人版从 listening-events 的累计时长 + 出现天数算，落盘 cache/familiarity.json 记住已到达的最高档；
// 公用版按每人放过的歌数算，落在该成员 memory.json 的 relation 里（见 server/public/*）。
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { readEvents } from './events.js';

// 顺序即等级；靠前的更低。阈值只在「升」的时候用。
export const RELATION_STAGES = [
  {
    key: 'first',
    label: '第一次听',
    // 提示词里的话：说人话，不出现「阶段 / 等级 / 亲密度」。
    prompt: '这是你们最开始的几次。礼貌、简短地介绍自己，别套近乎，不问私人问题，不提「我记得你」。',
    say: { min: 40, max: 90 },
  },
  {
    key: 'regular',
    label: '熟客',
    prompt: '他已经常来了。可以用「哎」「老规矩」这种口气，记得他一般几点听、爱在什么场景听；可以偶尔开个不伤人的小玩笑，但还是别打听私事。',
    say: { min: 55, max: 110 },
  },
  {
    key: 'oldfriend',
    label: '老友',
    prompt: '老熟人了。可以损他一句、拆穿他（「你又说随便」），可以主动提起以前听过的那首歌和那天聊的事；玩笑尺度可以大一点，但仍然不碰他标了别再提的事。',
    say: { min: 60, max: 120 },
  },
  {
    key: 'only',
    label: '只对你',
    prompt: '只有你们两个人知道的默契。可以有固定的开场方式、只有你们懂的梗，偶尔说一句不像 DJ 会说的话。珍惜这份默契，不炫耀、不排他，也不说「只有我懂你」这种话。',
    say: { min: 60, max: 120 },
  },
];

const STAGE_INDEX = new Map(RELATION_STAGES.map((stage, index) => [stage.key, index]));

export function stageByKey(key) {
  return RELATION_STAGES.find((stage) => stage.key === key) || RELATION_STAGES[0];
}

export function maxStage(a, b) {
  return (STAGE_INDEX.get(a) ?? 0) >= (STAGE_INDEX.get(b) ?? 0) ? a : b;
}

// 累计数据：只认 listen 类事件（点了播放、播到一半、播完），推荐和收藏不算「一起待过的时间」。
export function measureListening(events = []) {
  let seconds = 0;
  const days = new Set();
  let firstAt = null;
  for (const event of Array.isArray(events) ? events : []) {
    if (!['play_started', 'play_progress', 'play_completed'].includes(event?.type)) continue;
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) continue;
    days.add(new Date(at).toISOString().slice(0, 10));
    if (firstAt === null || at < firstAt) firstAt = at;
    const listened = Number(event.listenedSec);
    if (Number.isFinite(listened) && listened > 0) seconds += Math.min(listened, 4 * 3600);
    else if (event.type === 'play_started') seconds += 45; // 只有起点时按半首估，宁少不多
  }
  const minutes = Math.round(seconds / 60);
  const dayCount = days.size;
  const sinceDays = firstAt ? Math.floor((Date.now() - firstAt) / 86400_000) : 0;
  return { minutes, days: dayCount, sinceDays, firstAt: firstAt ? new Date(firstAt).toISOString() : null };
}

// 个人版：听满 10 小时或跨两周 → 熟客；60 小时且满两个月 → 老友；150 小时、满半年、且笔记本里有 8 条以上 → 只对你。
export function stageFromListening({ minutes = 0, sinceDays = 0, notes = 0 } = {}) {
  if (minutes >= 150 * 60 && sinceDays >= 180 && notes >= 8) return 'only';
  if (minutes >= 60 * 60 && sinceDays >= 60) return 'oldfriend';
  if (minutes >= 10 * 60 || sinceDays >= 14) return 'regular';
  return 'first';
}

// 公用版：没有可靠的收听秒数，按这个人一共放过多少首歌。
export function stageFromPlays({ plays = 0, notes = 0 } = {}) {
  if (plays >= 200 && notes >= 8) return 'only';
  if (plays >= 40) return 'oldfriend';
  if (plays >= 8) return 'regular';
  return 'first';
}

function defaultFile() {
  return path.join(config.paths.cache, 'familiarity.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

// 个人版：算一次、和已记住的最高档比、只升不降，升了才写盘。
export function currentRelation({ events = readEvents(), notes = 0, file = defaultFile() } = {}) {
  const metrics = measureListening(events);
  const computed = stageFromListening({ minutes: metrics.minutes, sinceDays: metrics.sinceDays, notes });
  const saved = readJson(file);
  const stage = maxStage(computed, saved?.stage || 'first');
  const state = {
    stage,
    label: stageByKey(stage).label,
    ...(stage !== computed ? { carried: true } : {}),
    metrics,
  };
  if (!saved || saved.stage !== stage) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        stage,
        firstReachedAt: saved?.firstReachedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metrics: { minutes: metrics.minutes, days: metrics.days, sinceDays: metrics.sinceDays },
      }, null, 2));
    } catch (error) {
      console.warn('[关系] 写入失败：', error.message);
    }
  }
  return state;
}

// 注入 prompt 的一段。只说「怎么说话」，一个数字都不给。
export function relationText(state) {
  const stage = stageByKey(state?.stage);
  return [
    `你们现在的关系：${stage.label}。`,
    stage.prompt,
    `这次口播大概 ${stage.say.min}–${stage.say.max} 字，按场景可短不可长。`,
    '这些话不用挂在嘴边，也不要提「你今天还没来」。',
  ].join('\n');
}
