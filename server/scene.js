// 此刻是什么场景：只看时间、日期和听众亲口说的话，不用定位、设备或网络。
// 默认节奏：工作日白天上班。个人作息的补充说明（周日晚、周五下班）从 .env 读，见 config.scene。
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const RULES = {
  work: '工作模式：选不抢注意力、不闹腾的歌，人声少或轻、器乐和轻柔的优先；避开强鼓点、嘶吼、高能量电音和大起大落。口播只说一句，30 字内，语气轻。',
  commute: '路上：有点精神但不吵，节奏平稳。',
  lunch: '午休：放开一点，可以换口味、给点新鲜感。',
  evening: '下班后：放开，可以有故事感、跨风格。',
  weekend: '周末：放开，节奏随意。',
  morning: '清晨：轻柔、有唤醒感。',
  late: '深夜：安静、温柔、克制，口播也轻一点。',
  workout: '运动：节奏明快、有推进感，口播短。',
  relax: '休息：放开，随意一点。',
  sleep: '准备睡：很安静、慢，口播极短。',
};

const LABELS = {
  work: '工作模式', commute: '路上', lunch: '午休', evening: '下班后', weekend: '周末',
  morning: '清晨', late: '深夜', workout: '运动', relax: '休息', sleep: '准备睡',
};

// 听众说的话 → 场景。只认「此刻正在」的说法；否定（不在上班）、愿望（想跑步、喜欢跑步）、
// 以后（等我下班了）、泛称（工作日、睡前听的、适合跑步）都不算，免得一句闲话把几个小时的场景改掉。
// 「在单位」这类说法里的地点；自己常说的别的叫法写 .env 的 SCENE_WORK_PLACES（逗号分隔）。
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORK_PLACES = ['单位', '公司', '办公室', ...(config.scene?.workPlaces || [])].map(escapeRe).join('|');

const SAID = [
  { key: 'relax', re: /^(我|刚刚?|已经)?(下班了|下班啦|收工了)|刚下班|已经下班|休息一下|放松一下/ },
  { key: 'work', re: new RegExp(`(我|正在|还在|现在)在?(上班|办公|加班|开会|干活|工作)(?!日)|在(${WORK_PLACES})|上班中|工作中`) },
  { key: 'workout', re: /(我|正在|现在)在(跑步|健身|锻炼)|正在(跑步|健身|锻炼)|跑步中|健身中/ },
  { key: 'commute', re: /(我|正在|现在)在路上|在开车|开车中|在地铁上|在高铁上|通勤中/ },
  { key: 'sleep', re: /要睡了|准备睡了|准备睡觉|去睡觉了|该睡了/ },
];
const NOT_NOW = new RegExp(`(不|没|没有|别)在?(上班|办公|加班|${WORK_PLACES}|跑步|健身|锻炼|开车|路上)|等我|等会|待会|一会儿|之后|以后|明天|晚点|如果`);

function minutes(date) { return date.getHours() * 60 + date.getMinutes(); }
function hhmm(date) { return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; }
function at(date, hour, minute = 0, dayOffset = 0) {
  const next = new Date(date);
  next.setDate(next.getDate() + dayOffset);
  next.setHours(hour, minute, 0, 0);
  return next;
}

export function daypart(now) {
  const m = minutes(now);
  if (m < 5 * 60) return '深夜';
  if (m < 7 * 60) return '清晨';
  if (m < 9 * 60) return '早通勤';
  if (m < 12 * 60) return '上午';
  if (m < 13 * 60 + 30) return '午休';
  if (m < 18 * 60 + 30) return '下午';
  if (m < 23 * 60) return '晚上';
  return '深夜';
}

// 没听众说法时的默认场景。
export function defaultScene(now, notes = config.scene) {
  const day = now.getDay();
  const weekday = day >= 1 && day <= 5;
  const part = daypart(now);
  const m = minutes(now);
  if (part === '深夜') return { key: 'late' };
  if (part === '清晨') return { key: 'morning' };
  if (!weekday) {
    if (day === 0 && m >= 18 * 60) return { key: 'evening', note: notes?.sundayEveningNote || '' };
    return { key: 'weekend' };
  }
  if (part === '早通勤') return { key: 'commute' };
  if (part === '上午' || part === '下午') return { key: 'work' };
  if (part === '午休') return { key: 'lunch' };
  if (day === 5 && m < 20 * 60) return { key: 'evening', note: notes?.fridayEveningNote || '' };
  return { key: 'evening' };
}

export function sceneFromText(text = '') {
  const value = String(text);
  if (NOT_NOW.test(value)) return '';
  return SAID.find(({ re }) => re.test(value))?.key || '';
}

// 听众说的场景管多久：上班管到当天 19:00，休息管到当天结束，运动和路上管 2 小时，睡前管到第二天 7 点。
export function declaredUntil(key, now) {
  if (key === 'work') return now < at(now, 18, 30) ? at(now, 19) : new Date(now.getTime() + 2 * 3600_000);
  if (key === 'relax') return at(now, 4, 0, 1);
  if (key === 'sleep') return at(now, 7, 0, now.getHours() < 7 ? 0 : 1);
  return new Date(now.getTime() + 2 * 3600_000);
}

export function createSceneStore(file = path.join(config.paths.cache, 'scene.json')) {
  function read() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }
  return {
    // 听众这句话里说了此刻在干什么，就记下来；返回记下的场景。
    noteFromText(text, now = new Date()) {
      const key = sceneFromText(text);
      if (!key) return null;
      const entry = { key, said: String(text).trim().slice(0, 60), at: now.toISOString(), until: declaredUntil(key, now).toISOString() };
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(entry));
      } catch { /* 记不下就只影响这一次 */ }
      return entry;
    },
    declared(now = new Date()) {
      const entry = read();
      if (!entry?.key || !LABELS[entry.key]) return null;
      return new Date(entry.until).getTime() > now.getTime() ? entry : null;
    },
  };
}

export const sceneStore = createSceneStore();

// 规则和听众说的冲突时听听众的。
export function currentScene(now = new Date(), store = sceneStore) {
  let declared = store.declared(now);
  // 「我在上班」管到 19:00，但午休（12:00–13:30）自动放开，除非他就是午休时说的。
  if (declared?.key === 'work' && daypart(now) === '午休') {
    const said = new Date(declared.at);
    const saidAtLunch = said.toDateString() === now.toDateString() && daypart(said) === '午休';
    if (!saidAtLunch) declared = null;
  }
  const fallback = defaultScene(now);
  const key = declared?.key || fallback.key;
  const day = now.getDay();
  const dayType = day >= 1 && day <= 5 ? '工作日' : '周末';
  return {
    key,
    label: LABELS[key],
    rule: RULES[key],
    dayType,
    weekday: WEEKDAYS[day],
    daypart: daypart(now),
    declared,
    note: declared ? '' : fallback.note || '',
  };
}

export function sceneText(scene) {
  const head = `${scene.dayType}（${scene.weekday}）${scene.daypart} · ${scene.label}`;
  const why = scene.declared
    ? `听众 ${hhmm(new Date(scene.declared.at))} 说「${scene.declared.said}」，${hhmm(new Date(scene.declared.until))} 前按这个来；和默认规则冲突时听他的`
    : scene.note || '按时间默认';
  return `${head}（${why}）\n${scene.rule}`;
}
