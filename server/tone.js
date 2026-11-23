// 口播语气档：在「此刻场景」之上按时段定念法。每档管四件事：给大模型的写法（节奏、句长、措辞温度、能用哪些标记、几个），
// 给 5090 的开头导演提示（fishgw 每段都带），以及清洗标记时放行哪些、最多几个。
// 驾驶模式不管几点都是清楚、简短、不耳语。公用版默认和个人版一样；PUBLIC_TONE=mild 时降一档、不撩不耳语。
// 个人版另可由数据目录 user/tone-extension.md 按档追加本地语气要求（不进仓库，见 toneExtension）。
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { sanitizeTags } from './tts/tags.js';

const TAG_RULES = `say 里可以加演出标记，只给语音念，页面上会去掉。只能用下面这些，写法一字不差，别的一律不写（不要自创、不要中文标记、不要 <slow> 之类）：
- 点标记，放在要出声的那个位置：[sigh] 叹气、[small laugh] 轻笑、[laughing] 笑出声、[pause] 停顿、[shaky breath] 带颤的吸气。
- 成对标记，包住一小段，开了要关，不跨句号：<whisper>…</whisper> 耳语、<soft>…</soft> 放轻、<emphasis>…</emphasis> 加重。
情绪对得上才用：感慨、心疼、累了用 [sigh]；好笑、调侃用 [small laugh]，真乐了才 [laughing]；要留白、转折前用 [pause]；悄悄话、贴近了说用 <whisper>；安抚、哄人用 <soft>；歌名或关键的一句要强调用 <emphasis>。没有合适的就一个都不用。`;

const set = (...names) => new Set(names);

export const TIERS = {
  morning: {
    label: '清晨档',
    style: '[bright, fresh morning radio host, light and crisp, gentle energy]',
    prompt: '清爽、轻快：句子短，像刚醒时的一声招呼，措辞干净明亮。基本不用标记，最多一个 [small laugh]。',
    maxTags: 1, maxPairs: 0, points: set('small laugh'), pairs: set(),
  },
  work: {
    label: '上班档',
    style: '[soft, calm, low-key radio host, gentle and unobtrusive, even pace]',
    prompt: '克制、温和、不抢注意力：语速平稳，一两句、40 到 50 字，措辞淡一点，不撩、不煽情、不耳语。最多一个 [pause] 或一段 <soft>。',
    maxTags: 1, maxPairs: 1, points: set('pause'), pairs: set('soft'),
  },
  lunch: {
    label: '午休档',
    style: '[relaxed, friendly radio host, easygoing, a little playful]',
    prompt: '放松、随意，可以带一点玩笑和小八卦，句子松一点。可用 [small laugh]、[laughing]、[sigh]、<soft>，最多 2 个。',
    maxTags: 2, maxPairs: 1, points: set('small laugh', 'laughing', 'sigh'), pairs: set('soft'),
  },
  day: {
    label: '白天档',
    style: '[warm, relaxed radio host, natural and easygoing]',
    prompt: '自然、放松，像老朋友随口聊两句。可用 [small laugh]、[sigh]、[pause]、<soft>、<emphasis>，最多 2 个。',
    maxTags: 2, maxPairs: 1, points: set('small laugh', 'sigh', 'pause', 'laughing'), pairs: set('soft', 'emphasis'),
  },
  evening: {
    label: '傍晚档',
    style: '[warm, relaxed evening radio host, unhurried, slightly lazy and smooth]',
    prompt: '放松、带一点慵懒：语速放慢，句子之间留点空，措辞暖一点，像下班后瘫在沙发上说话。可用 [sigh]、[small laugh]、[pause]、<soft>，最多 2 个。',
    maxTags: 2, maxPairs: 1, points: set('sigh', 'small laugh', 'pause'), pairs: set('soft', 'emphasis'),
  },
  night: {
    label: '夜晚档',
    style: '[intimate late-night radio host, low and breathy, slow and sultry, close to the mic, with lingering pauses]',
    prompt: '慵懒、贴近、带一点撩人的性感，像凑在耳边说话。性感靠语气和节奏：放慢、留白、尾音轻一点，不写露骨的内容。把最贴近的一小句包进 <whisper>…</whisper>，可配 [sigh]、[shaky breath]、[pause]、<soft>，最多 3 个。',
    maxTags: 2, maxPairs: 1, points: set('sigh', 'shaky breath', 'pause', 'small laugh'), pairs: set('whisper', 'soft'),
  },
  late: {
    label: '深夜档',
    style: '[very soft, low and slow, whispering close to the ear, drowsy and tender]',
    prompt: '更低、更慢，以耳语为主：主要的一两句都包进 <whisper>…</whisper>，句子短，留白多，措辞温柔，不写露骨的内容。可配 [sigh]、[pause]，不用笑声，最多 3 个。',
    maxTags: 1, maxPairs: 2, points: set('sigh', 'pause', 'shaky breath'), pairs: set('whisper', 'soft'),
  },
  drive: {
    label: '驾驶档',
    style: '[clear, steady radio host, calm and concise]',
    prompt: '清楚、简短、平稳，不耳语，不加任何标记。',
    maxTags: 0, maxPairs: 0, points: set(), pairs: set(),
  },
};

// PUBLIC_TONE=mild 时公用版用的温和档：夜里不撩、不耳语，只放轻。
const MILD = {
  night: {
    label: '夜晚档',
    style: '[warm, soft late-night radio host, relaxed and gentle, unhurried]',
    prompt: '放松、温柔、慢一点，不撩、不耳语。可用 [sigh]、[pause]、一段 <soft>，最多 2 个。',
    maxTags: 1, maxPairs: 1, points: set('sigh', 'pause'), pairs: set('soft'),
  },
  late: {
    label: '深夜档',
    style: '[soft, low, gentle late-night radio host, slow and calm]',
    prompt: '轻、慢、温柔，句子短，不撩、不耳语。可以用一段 <soft>…</soft> 包住最后一句，可配 [pause]，最多 2 个。',
    maxTags: 1, maxPairs: 1, points: set('pause', 'sigh'), pairs: set('soft'),
  },
};

function toMinutes(text, fallback) {
  const match = String(text || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const value = Number(match[1]) * 60 + Number(match[2]);
  return value >= 0 && value < 24 * 60 ? value : fallback;
}

export function toneBounds(tone = config.tone) {
  return {
    morning: toMinutes(tone?.morningFrom, 5 * 60),
    day: toMinutes(tone?.dayFrom, 9 * 60),
    evening: toMinutes(tone?.eveningFrom, 18 * 60),
    night: toMinutes(tone?.nightFrom, 21 * 60),
    late: toMinutes(tone?.lateFrom, 23 * 60),
  };
}

function byClock(now, bounds) {
  const m = now.getHours() * 60 + now.getMinutes();
  const inRange = (from, to) => (from <= to ? m >= from && m < to : m >= from || m < to);
  if (inRange(bounds.late, bounds.morning)) return 'late';
  if (inRange(bounds.morning, bounds.day)) return 'morning';
  if (inRange(bounds.night, bounds.late)) return 'night';
  if (inRange(bounds.evening, bounds.night)) return 'evening';
  return 'day';
}

// 此刻用哪一档。场景说上班 / 午休 / 准备睡时听场景的，其余按钟点。
export function toneKey({ now = new Date(), scene = null, drive = false, bounds = toneBounds() } = {}) {
  if (drive) return 'drive';
  if (scene?.key === 'work') return 'work';
  if (scene?.key === 'lunch') return 'lunch';
  if (scene?.key === 'sleep') return 'late';
  return byClock(now, bounds);
}

export function toneFor(key, { mild = false } = {}) {
  const tier = (mild && MILD[key]) || TIERS[key] || TIERS.day;
  return { key, ...tier };
}

// 本地语气扩展（个人版）：数据目录 user/tone-extension.md。开头可写
//   ---
//   label: 设置面板上开关的名字
//   tiers: night, late
//   ---
// 正文按档追加进提示词。上班档、驾驶档永远不追加。文件不在就没有这个开关。
const NEVER_EXTEND = new Set(['work', 'drive', 'morning']);

export function readToneExtension(file = path.join(config.paths.user, 'tone-extension.md')) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  const head = match ? match[1] : '';
  const body = (match ? raw.slice(match[0].length) : raw).trim();
  if (!body) return null;
  const field = (name) => head.match(new RegExp(`^${name}\\s*:\\s*(.+)$`, 'm'))?.[1]?.trim() || '';
  const tiers = field('tiers').split(/[,，\s]+/).filter((key) => TIERS[key] && !NEVER_EXTEND.has(key));
  return { label: field('label').slice(0, 20) || '本地语气扩展', tiers: tiers.length ? tiers : ['night', 'late'], body };
}

// 给提示词的一段。extension：开关开着时传 readToneExtension() 的结果。
// now：此刻（公用版传北京时间的 beijingClock）。扩展还要按钟点也落在它写的档里才加——
// 睡前场景不看钟点直接是深夜档，21 点前说「准备睡了」也不能带上扩展。不给 now 只看档。
export function tonePrompt(tone, { extension = null, now = null, bounds = toneBounds() } = {}) {
  const byTier = extension && extension.tiers.includes(tone.key) && !NEVER_EXTEND.has(tone.key);
  const extra = byTier && (!now || extension.tiers.includes(byClock(now, bounds))) ? extension.body : '';
  return [
    `## 口播语气（此刻：${tone.label}）`,
    tone.prompt,
    tone.maxTags ? TAG_RULES : '这一档 say 里不写任何标记。',
    extra,
  ].filter(Boolean).join('\n');
}

// 给 5090 念的版本：开头加这一档的导演提示，句内标记按这一档放行。
export function ttsText(say, tone) {
  const body = sanitizeTags(say, { maxTags: tone.maxTags, maxPairs: tone.maxPairs, points: tone.points, pairs: tone.pairs });
  return body ? `${tone.style} ${body}` : '';
}
