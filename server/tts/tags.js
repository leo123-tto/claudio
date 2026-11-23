// 口播里的演出标记（Fish Drama 3）：大模型可以在 say 里写少量标记，只给 5090 念，页面和记录一律去掉。
// 白名单按 2026-11-23 在 5090 上实测（docs/research/2026-11-23-drama3-口播调研.md）：都不会被念成字；<slow> 会多编话，不用。
// 方括号点标记：放在要出声的位置；成对标记：包住要那样念的一小段，不跨句号。

export const POINT_TAGS = ['sigh', 'sighs', 'laughing', 'small laugh', 'pause', 'shaky breath', 'whisper'];
export const PAIR_TAGS = ['whisper', 'soft', 'emphasis'];

const POINT = new Set(POINT_TAGS);
const PAIR = new Set(PAIR_TAGS);
// 模型偶尔写成中文
const ALIASES = {
  叹气: 'sigh', 叹息: 'sigh', 轻叹: 'sigh', 笑: 'laughing', 笑声: 'laughing', 轻笑: 'small laugh', 浅笑: 'small laugh',
  停顿: 'pause', 停一下: 'pause', 颤抖的呼吸: 'shaky breath', 吸气: 'shaky breath', 耳语: 'whisper', 低语: 'whisper',
};
const TERMINATOR = /[。！？!?；;…\n]/;

function pointName(raw) {
  const name = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const mapped = ALIASES[name] || name;
  return POINT.has(mapped) ? mapped : '';
}

// 方括号（含全角）、尖括号标记，以及半截的 <whisper / [sigh
const TOKEN = /[[［【]([^\]］】\n]{0,40})[\]］】]|<\s*(\/?)\s*([a-zA-Z]+)\s*>|<\/?\s*[a-zA-Z]*\s*$|<\/?\s*[a-zA-Z]+(?=[^a-zA-Z>]|$)|[[［【][^\]］】\n]{0,40}$/g;

// 页面、记录、Fish 云端和 macOS say 用：所有标记一律去掉。
export function stripTags(text) {
  return String(text ?? '')
    .replace(TOKEN, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([，。！？、,.!?])/g, '$1')
    .trim();
}

// 给 5090 念的版本：只留白名单；点标记最多 maxTags 个，成对标记另算最多 maxPairs 段，不嵌套。
// 成对标记不跨句（各处都按句切）：碰到句末标点先收口，下一句有字时接着开；没收口的在末尾收口；空的一对不出。
// points / pairs 可以再收窄（按时段语气档）。
export function sanitizeTags(text, { maxTags = 2, maxPairs = 2, points = POINT, pairs: allowPairs = PAIR } = {}) {
  const source = String(text ?? '');
  let out = '';
  let want = '';   // 模型想要的
  let shown = '';  // 已经写出去、还没收口的
  let pointCount = 0;
  let pairCount = 0;
  const close = () => { if (shown) { out += `</${shown}>`; shown = ''; } };
  const write = (chunk) => {
    for (const char of chunk) {
      if (TERMINATOR.test(char)) close();
      else if (/\S/.test(char) && want !== shown) { close(); if (want) { out += `<${want}>`; shown = want; } }
      out += char;
    }
  };
  let last = 0;
  for (const match of source.matchAll(TOKEN)) {
    write(source.slice(last, match.index));
    last = match.index + match[0].length;
    const [, bracket, slash, name] = match;
    if (bracket !== undefined) {
      const tag = pointName(bracket);
      if (tag && points.has(tag) && pointCount < maxTags) { out += `[${tag}]`; pointCount += 1; }
      continue;
    }
    const pair = String(name || '').toLowerCase();
    if (!PAIR.has(pair) || !allowPairs.has(pair)) continue; // 白名单外的（含 <slow>）去掉标记，里面的字留着
    if (slash) {
      if (want === pair) { want = ''; if (shown === pair) close(); }
    } else if (!want && pairCount < maxPairs) {
      want = pair; pairCount += 1;
    }
  }
  write(source.slice(last));
  close();
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

export function hasTags(text) {
  return stripTags(text) !== String(text ?? '').trim();
}

// 句首的导演提示（时段语气），fishgw 会每段都带上；拆句时也要每段都带。
const LEAD = /^\s*(\[[^\]\n]{1,200}\])\s*/;
export function splitLead(text) {
  const value = String(text ?? '');
  const match = value.match(LEAD);
  if (!match || /^\[[a-z _-]+\]$/.test(match[1])) return { lead: '', body: value.trim() };
  return { lead: match[1], body: value.slice(match[0].length).trim() };
}

// 不认标记的语音（Fish 云端、macOS say）念的版本：开头的语气提示和句内标记都去掉。
export function plainText(text) {
  return stripTags(splitLead(text).body);
}

// 按语音来源给要念的文字：只有 5090（Drama 3）认标记。
export function textForProvider(text, provider) {
  return provider === 'pc5090' ? String(text ?? '').trim() : plainText(text);
}
