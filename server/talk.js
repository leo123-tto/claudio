// 口播频率：两版共用的纯逻辑（不读配置、不碰文件，方便测试）。
//   话多 chatty    每首歌前都说
//   适中 normal    现在的习惯，默认
//   安静 quiet     开头问个好，之后只在「时刻」出声：换主题、整点、换了时段，其余只放歌
//   几乎不说 minimal 只有开头问好和睡前道别
// 听众当面说话的回复、朋友的推荐（以后做）永远开口；驾驶模式只管缩短，由已有代码叠在这上面。
// 「今天 / 今晚 / 这会儿」说的是只管到本地午夜，之后回到长期的档位。
import fs from 'node:fs';
import path from 'node:path';

export const TALK_LEVELS = Object.freeze(['chatty', 'normal', 'quiet', 'minimal']);
export const TALK_LABELS = Object.freeze({ chatty: '话多', normal: '适中', quiet: '安静', minimal: '几乎不说' });
export const DEFAULT_TALK = 'normal';
// 这么久没开过口，再开口就算「开头」
export const FIRST_GAP_MS = 30 * 60_000;

export const normalizeTalk = (level) => (TALK_LEVELS.includes(level) ? level : DEFAULT_TALK);

// ---- 听懂一句话 ----
// 只认整句、很短的指令（和 intent.js 的播放器指令一样）：「只放歌手陈奕迅的歌」「不用少说点」「他叫我别说话了」都不算。
const TIME_WORD = /^(?:今天晚上|今天|今晚|今儿|今夜|这会儿|这会|现在|此刻)(?:先|就|都)?/;
const LEAD = /^(?:(?:vera|Vera|请|麻烦|你|那|好|好的|嗯|喂)[，,、\s]*)+/;
const TAIL = /(?:吧|啊|呀|哦|嘛|了|哈|呢|啦|儿)+$/;
const RULES = [
  ['minimal', /^(?:别打扰我?|不要打扰我?|不用说话|不要说话|别说话|别讲话|别开口|不用开口|闭嘴|(?:只|光|仅)(?:放|播)歌(?:就)?(?:行|好|可以)?|只要歌(?:就)?(?:行|好)?)$/],
  ['quiet', /^(?:少说点话?|少说几句|少讲点|少聊点|少说话|话少点|话少一点|话少些|安静点|安静一点|安静些|别那么多话|话别那么多|别太吵|别这么吵)$/],
  ['chatty', /^(?:多聊聊|多聊点|多聊几句|多说点|多说说|多说几句|多讲点|多讲讲|话多点|话多一点|可以多说点)$/],
  ['normal', /^(?:正常说话|正常点|恢复正常|恢复说话|恢复默认|照常说话|照常|像平时一样说话|说话正常点|可以说话了)$/],
];

export function talkFromText(text) {
  let rest = String(text ?? '').trim().replace(/[。！!？?，,；;、…~～\s]+$/g, '').trim();
  if (!rest || rest.length > 20) return null;
  rest = rest.replace(LEAD, '');
  const timed = TIME_WORD.exec(rest);
  if (timed) rest = rest.slice(timed[0].length).replace(LEAD, '');
  rest = rest.replace(/^[，,、\s]+/, '');
  // 「别说话了」这类末尾的语气词先去掉再比，但「了」也可能是规则里的一部分，两种写法都试
  const candidates = [rest, rest.replace(TAIL, '')];
  for (const [level, re] of RULES) {
    if (candidates.some((c) => c && re.test(c))) return { level, today: Boolean(timed) };
  }
  return null;
}

// ---- 存和取 ----
// stored：{ level, today: { level, until } }。today 过了 until（本地午夜）就当没有。
export function effectiveTalk(stored, now = Date.now()) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  const today = stored?.today;
  if (today && TALK_LEVELS.includes(today.level) && Number(today.until) > at) return today.level;
  return normalizeTalk(stored?.level);
}

// 下一个午夜（毫秒）。tzOffsetMs 不给就用本机时区；公用版按北京时间传 8 小时，不依赖容器的时区。
export function nextMidnight(now = Date.now(), tzOffsetMs = null) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  if (tzOffsetMs == null) {
    const d = new Date(at);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  }
  const day = 24 * 3600_000;
  return Math.floor((at + tzOffsetMs) / day) * day + day - tzOffsetMs;
}

// 听懂的一句话落进存储：今天的只写临时档；长期的写长期档，并清掉今天的（刚说的才算数）
export function applyTalk(stored, change, { now = Date.now(), tzOffsetMs = null } = {}) {
  const base = { level: normalizeTalk(stored?.level) };
  if (change.today) return { ...base, today: { level: change.level, until: nextMidnight(now, tzOffsetMs) } };
  return { level: change.level };
}

const ACK = {
  chatty: ['好，每首歌我都多聊两句。', '好，今天每首歌我都多聊两句。'],
  normal: ['好，恢复正常说话。', '好，今天照常说话。'],
  quiet: ['好，少说点，只在整点、换时段或换主题时出声。', '好，今天少说点，只在整点、换时段或换主题时出声。'],
  minimal: ['好，只放歌，不打扰你。', '好，今天只放歌，不打扰你。'],
};
export const talkAck = ({ level, today }) => ACK[normalizeTalk(level)][today ? 1 : 0];

// ---- 这一段说不说 ----
// ctx：{ userSpoke, recommended, first, closing, themeChanged, tierChanged, hourChanged }
// 返回开口的理由（空 = 不说）；理由按优先顺序排。
export function speakReasons(level, ctx = {}) {
  const why = [];
  if (ctx.userSpoke) why.push('userSpoke');
  if (ctx.recommended) why.push('recommended');
  const mode = normalizeTalk(level);
  if (mode === 'chatty' || mode === 'normal') { why.push(mode); return why; }
  if (ctx.first) why.push('first');
  if (ctx.closing) why.push('closing');
  if (mode === 'quiet') {
    if (ctx.themeChanged) why.push('themeChanged');
    if (ctx.tierChanged) why.push('tierChanged');
    if (ctx.hourChanged) why.push('hourChanged');
  }
  return why;
}

export const shouldSpeak = (level, ctx) => speakReasons(level, ctx).length > 0;

// 今天的临时档存在一个小文件里（个人版 cache/talk.json）：{ level, until }。读不到、过期都当没有。
export function createTodayFile(file, { now = () => Date.now() } = {}) {
  return {
    read() {
      try {
        const v = JSON.parse(fs.readFileSync(file, 'utf8'));
        return TALK_LEVELS.includes(v?.level) && Number(v.until) > now() ? { level: v.level, until: Number(v.until) } : null;
      } catch { return null; }
    },
    write(today) {
      try {
        if (!today) { fs.rmSync(file, { force: true }); return; }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(today));
      } catch { /* 记不下来就只管这一次 */ }
    },
  };
}

// ---- 上一次开口的记录 ----
export const hourKeyOf = (at, tzOffsetMs = null) => {
  if (tzOffsetMs == null) {
    const d = new Date(at);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}-${d.getHours()}`;
  }
  return String(Math.floor((at + tzOffsetMs) / 3600_000));
};

// 每个实例（个人版一个，公用版每位朋友一个）一份，只在内存里：重启后第一段算「开头」。
// 上一次开口的时刻、时段、主题、整点；closing 只在上一次开口不是道别时才算，免得睡前场景里每段都道别。
// 「开头」看的是有没有在听：最近 30 分钟没放过歌（markPlayed）才算新一轮开头。只看开口的话，安静档每半小时就会重新问好。
export function createTalkTracker({ gapMs = FIRST_GAP_MS } = {}) {
  let last = null;
  let playedAt = 0;
  return {
    context({ at = Date.now(), tier = '', mood = '', hourKey = '', closing = false } = {}) {
      return {
        first: !last || at - Math.max(playedAt, last.at) > gapMs,
        themeChanged: Boolean(last) && (mood || '') !== (last.mood || ''),
        tierChanged: Boolean(last) && tier !== last.tier,
        hourChanged: Boolean(last) && hourKey !== last.hourKey,
        closing: Boolean(closing) && !last?.closing,
      };
    },
    markSpoken({ at = Date.now(), tier = '', mood = '', hourKey = '', closing = false } = {}) {
      last = { at, tier, mood: mood || '', hourKey, closing: Boolean(closing) };
      playedAt = Math.max(playedAt, at);
    },
    markPlayed(at = Date.now()) { playedAt = Math.max(playedAt, at); },
    get last() { return last && { ...last }; },
  };
}
