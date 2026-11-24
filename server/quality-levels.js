// 歌曲音质档位（两版共用）：网易云 /song/url/v1 的 level，从低到高。
// 网页的音质菜单只列这几档；网易云另有 jyeffect（高清环绕声）/ sky（沉浸环绕声），是环绕声处理版，不列。
// 备用音源一般只有 128k / 320k / 一档无损（母带是 24 bit 就给 24 bit），见 sources.js 的 QUALITY_PLAN。
export const LEVELS = ['standard', 'higher', 'exhigh', 'lossless', 'hires', 'jymaster'];

// 网易云返回的档位可能是菜单外的（jyeffect / sky），排序时夹在 hires 和 jymaster 之间
const RANK = { none: -1, standard: 0, higher: 1, exhigh: 2, lossless: 3, hires: 4, jyeffect: 4.3, sky: 4.6, jymaster: 5 };
export const levelRank = (level) => RANK[level] ?? -1;
export const isLevel = (value) => LEVELS.includes(value);

// 往下一档（自动降档用）；最低就是 standard
export function stepDown(level) {
  const i = LEVELS.indexOf(level);
  return i > 0 ? LEVELS[i - 1] : 'standard';
}

// 取两档里低的那个（封顶用）
export const minLevel = (a, b) => (levelRank(a) <= levelRank(b) ? a : b);

// 备用音源的歌能要的档（无损只有一档：要 hires 时 24 bit 原样给，要 lossless 时公用版会封到 CD）
export const ALT_LEVELS = ['standard', 'exhigh', 'lossless', 'hires'];

// 网易云 /song/detail 的 privileges[i] → 这首对这个账号能要到的档。
// 2026-11-24 实测：chargeInfoList 的 rate 列出这首有哪几档（1999000 = Hi-Res，没有就没有 Hi-Res，哪怕 maxBrLevel 写着 jymaster）；
// plLevel 是这个账号能放到的最高档（老板的会员是 jyeffect，要 jymaster 会退成 jyeffect）。拿不准时回 null（网页就不标灰）。
const RATE_LEVEL = { 128000: 'standard', 192000: 'higher', 320000: 'exhigh', 999000: 'lossless', 1999000: 'hires' };
export function levelsFromPrivilege(p) {
  if (!p || typeof p !== 'object') return null;
  const cap = levelRank(String(p.plLevel || ''));
  if (cap < 0) return null; // 这个账号放不了（只有试听 / 灰了），多半走备用音源，不知道能要哪档
  const rates = Array.isArray(p.chargeInfoList) ? p.chargeInfoList.map((c) => RATE_LEVEL[Number(c?.rate)]).filter(Boolean) : [];
  const has = new Set(rates.length ? rates : LEVELS.filter((lv) => levelRank(lv) <= levelRank(String(p.maxBrLevel || '')) && lv !== 'jymaster'));
  if (p.maxBrLevel === 'jymaster') has.add('jymaster');
  const levels = LEVELS.filter((lv) => has.has(lv) && levelRank(lv) <= cap);
  return levels.length ? levels : null;
}
