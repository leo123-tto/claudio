// 兜底歌没有足够标签证明符合要求时，宁可少放。
const GROUPS = [
  ['钢琴', 'piano'], ['吉他', 'guitar'], ['小提琴', 'violin'], ['大提琴', 'cello'],
  ['萨克斯', 'sax'], ['爵士', 'jazz'], ['古典', 'classical'], ['摇滚', 'rock'],
  ['民谣', 'folk'], ['电子', 'electronic', 'edm'], ['说唱', '嘻哈', 'hip hop', 'rap'],
  ['纯音乐', '器乐', 'instrumental'], ['安静', '舒缓', '轻柔', '温柔', '平静', '轻松', '放松', '治愈', 'quiet', 'calm', 'soft', 'relax'],
  ['欢快', '开心', '轻快', 'happy', 'upbeat'], ['悲伤', '伤感', '难过', 'sad'],
  ['轻音乐', 'easy listening'], ['蓝调', 'blues'], ['乡村', 'country'], ['金属', 'metal'],
];
// 仅用于核对模型选歌的真实元数据；不要扩入 GROUPS，发现池和否定仍按字面匹配。
const INSTRUMENT_FAMILY = ['纯音乐', '纯演奏', '轻音乐', '新世纪', '古典', '器乐', '配乐', 'instrumental', 'new age', 'classical'];
const RESOLVED_FAMILIES = new Map([
  ...['钢琴', '吉他', '小提琴', '大提琴', '纯音乐', '轻音乐'].map((word) => [word, INSTRUMENT_FAMILY]),
  ['萨克斯', [...INSTRUMENT_FAMILY, '爵士', 'jazz']],
]);
const MOOD_GROUPS = new Set(['安静', '欢快', '悲伤']);
// 只认紧邻词前的否定和常见修饰词，不跨分句影响后面的正向要求。
const NEGATED_BEFORE = /(?:不\s*要|别|不想|不听|不喜欢|不爱|不放|避免|排除|除了|不(?!\s*要))\s*(?:(?:再|听|放|来|要|点|些|一[点些]|太|很|那么|这么|的|那种|这种)\s*)*$|\b(?:no|not|without|except|excluding|avoid)\s+(?:(?:any|more|too|much)\s+)*$/;
const SUGGESTION_BEFORE = /要\s*不\s*(?:要\s*)?来\s*(?:一\s*)?[点些]\s*$/;

export function styleConstraints(input = '') {
  const text = String(input).toLowerCase();
  // 正向仍返回原 group；排除项也放进数组，让 .length 继续表示存在风格约束。
  return GROUPS.flatMap((group) => {
    let found = false;
    let exclude = false;
    for (const word of group) {
      for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + word.length)) {
        found = true;
        // 「要不来点 / 要不要来点」是建议；后面另有否定时仍照常识别。
        const before = text.slice(0, at).replace(SUGGESTION_BEFORE, '');
        if (NEGATED_BEFORE.test(before)) exclude = true;
      }
    }
    return found ? [exclude ? { exclude: group } : group] : [];
  });
}
export function matchesStyle(song, constraints = []) {
  const tags = [song.genre, song.style, song.mood, song.instrument, song.tags, song.title]
    .flat(Infinity).filter(Boolean).join(' ').toLowerCase();
  return constraints.every((constraint) => {
    const group = Array.isArray(constraint) ? constraint : constraint.exclude;
    const matched = group.some((word) => tags.includes(word));
    return Array.isArray(constraint) ? matched : !matched;
  });
}

export function matchesResolvedStyle(resolved, constraints = []) {
  // 没有真实曲风时不把未知当冲突；模型的自报标签不能用来抵消已查到的冲突。
  const genre = String(resolved?.genre || '').trim().toLowerCase();
  if (!genre) return true;
  const tags = `${genre} ${resolved?.title || ''}`.toLowerCase();
  return constraints.every((group) => {
    if (!Array.isArray(group) || MOOD_GROUPS.has(group[0])) return true;
    return [...group, ...(RESOLVED_FAMILIES.get(group[0]) || [])].some((word) => tags.includes(word));
  });
}

// 垫场歌只认网易云曲风，标题不算证据；只有心情或排除时没法核对，返回空串。
export function genreEvidence(resolved, constraints = []) {
  const groups = constraints.filter((group) => Array.isArray(group) && !MOOD_GROUPS.has(group[0]));
  if (!groups.length) return '';
  const genre = String(resolved?.genre || '').trim();
  if (!genre) return 'unknown';
  return matchesResolvedStyle({ genre }, groups) ? 'match' : 'conflict';
}
