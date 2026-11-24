// 网易云音乐封装：search → song_url → lyric，并把 {title, artist} 解析成可播直链。
// 通过 NCM_BASE 调用外部的 NeteaseCloudMusicApiEnhanced 实例。
//
// ⚠️ 硬约束：很多歌的 /song/url 需要登录 cookie 才返回真实直链；
//    VIP / 无版权歌即便登录也可能为 null。resolve() 拿不到时返回 playable:false。
import { AsyncLocalStorage } from 'node:async_hooks';
import { ncmQuality, withFlacHeader } from './audio-quality.js';
import { config } from './config.js';
import { audioQuality, getSettings } from './settings.js';
import { ALT_LEVELS, levelsFromPrivilege } from './quality-levels.js';
import { factStore, parseSongFacts } from './song-meta.js';
import { createTimeoutSignal } from './llm/openai-chat.js';
import { reportCooldown, requestSlot, startSlotServer } from './ncm-shared.js';
import { sources } from './sources.js';

const { base, cookie } = config.ncm;
const rateLimits = new Map();

// 备用音源（插件在数据目录里，没有就不启用）。网易云拿不到时才用，见 resolve()。
export { sources };
const sourceKind = () => (sourceStore.getStore() === 'chat' ? 'chat' : 'background');

// 每分钟记一行 [ncm-rate]：哪个接口、谁发的（后台备节目 / 点歌 / 发现池 / 垫场 / 开播前刷新…）、结果（ok / 405 / 冷却中没发 / 缓存命中 / 其他错）。
const sourceStore = new AsyncLocalStorage();
export function withNcmSource(source, fn) { return sourceStore.run(source, fn); }

// 搜索排队：2026-11-23 实测一开网页，垫场 8 首 + 后台两期各 6 首同时搜，一分钟内就 405，冷却期间点歌也搜不了。
// 非点歌的搜索排成一列：每个至少隔 searchGapMs，且任意 60 秒内（连点歌一起算）不超过 searchPerMin 个。
// 11-23 实测：不管隔不隔 1.5 秒，连着约 10 个搜索后网易云就回 405，所以按每分钟总数限。点歌直接发、不排队。
let searchChain = Promise.resolve();
const sentAt = [];
let localWaiting = 0;
function waitTurn(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}
function markSent() {
  const now = Date.now();
  sentAt.push(now);
  while (sentAt.length && sentAt[0] <= now - 60_000) sentAt.shift();
}
function nextSlot(gap, perMin) {
  const now = Date.now();
  while (sentAt.length && sentAt[0] <= now - 60_000) sentAt.shift();
  const last = sentAt.at(-1) ?? 0;
  let at = gap > 0 ? last + gap : now;
  if (perMin > 0 && sentAt.length >= perMin) at = Math.max(at, sentAt[sentAt.length - perMin] + 60_000);
  return at - now;
}
// 不用排队时返回 null，调用方不多等一拍。
// 冷却中的搜索不会真的发出去（call 直接报忙），不排队、不占名额，免得把队列堵到超时。
const searchCooling = () => rateLimits.get('/search')?.until > Date.now();
function pacedSearch(signal) {
  const { searchGapMs: gap, searchPerMin: perMin } = config.ncm;
  if (searchCooling()) return null;
  if ((!(gap > 0) && !(perMin > 0)) || sourceStore.getStore() === 'chat') { markSent(); return null; }
  localWaiting += 1;
  const turn = searchChain.then(async () => {
    // 调用方已经放弃（比如垫场 6 秒到点）就直接让出，不空等、不占名额。
    signal?.throwIfAborted();
    for (let wait = nextSlot(gap, perMin); wait > 0 && !searchCooling(); wait = nextSlot(gap, perMin)) await waitTurn(wait, signal);
    signal?.throwIfAborted();
    if (!searchCooling()) markSent();
  }).finally(() => { localWaiting = Math.max(0, localWaiting - 1); });
  searchChain = turn.catch(() => {});
  return turn;
}

function coolSearch(ms) {
  if (!(ms > 0)) return;
  const now = Date.now();
  const previous = rateLimits.get('/search');
  const until = now + Math.min(ms, 30 * 60_000);
  if (!previous || previous.until < until) rateLimits.set('/search', { delay: previous?.delay ?? 60_000, until });
}

// 跨实例共享名额（见 ncm-shared.js）。这里是管名额的一方：本实例的搜索照旧走上面的队列，
// 别的实例来要的名额记进同一个 sentAt，合起来每分钟不超过 searchPerMin。
// 老板实例优先：本实例有搜索在排队时不给；别的实例（点歌也算）只能用到 searchPerMin − sharedReserve。
function grantRemote() {
  const rule = rateLimits.get('/search');
  if (rule?.until > Date.now()) return { ok: false, coolingMs: rule.until - Date.now() };
  if (localWaiting > 0) return { ok: false, retryMs: 1000 };
  const { searchGapMs: gap, searchPerMin: perMin, sharedReserve } = config.ncm;
  const cap = perMin > 0 ? Math.max(1, perMin - sharedReserve) : 0;
  const wait = nextSlot(gap, cap);
  if (wait > 0) return { ok: false, retryMs: wait };
  markSent();
  return { ok: true };
}
export function startSharedLimitServer(address = config.ncm.sharedServe, { tts = null } = {}) {
  const guest = { search: guestSearch, songUrl: guestSongUrl, find: guestFind, lyric: guestLyric, levels: guestLevels };
  return address ? startSlotServer(address, { grant: grantRemote, cool: coolSearch, tts, guest }) : null;
}
export const grantRemoteForTests = grantRemote;

// 要名额的一方：服务说冷却就跟着冷却，说等就等，服务不通就照常搜。
async function sharedTurn(url, signal) {
  const kind = sourceStore.getStore() === 'chat' ? 'chat' : 'background';
  while (!searchCooling()) {
    const answer = await requestSlot(url, kind, signal);
    if (!answer || answer.ok) return;
    if (answer.coolingMs > 0) { coolSearch(answer.coolingMs); return; }
    await waitTurn(Math.min(Math.max(Number(answer.retryMs) || 1000, 200), 10_000), signal);
  }
}
const tally = new Map();
let tallyTimer = null;
function countCall(pathname, outcome) {
  const key = `${pathname} ${sourceStore.getStore() || 'other'} ${outcome}`;
  tally.set(key, (tally.get(key) || 0) + 1);
  if (!tallyTimer) {
    tallyTimer = setTimeout(flushNcmTally, 60_000);
    tallyTimer.unref?.();
  }
}
export function flushNcmTally() {
  clearTimeout(tallyTimer); tallyTimer = null;
  if (!tally.size) return null;
  const line = Object.fromEntries([...tally].sort(([a], [b]) => a.localeCompare(b)));
  tally.clear();
  console.log('[ncm-rate]', new Date().toTimeString().slice(0, 5), JSON.stringify(line));
  return line;
}

export function resetRateLimitsForTests() { rateLimits.clear(); searchCache.clear(); sentAt.length = 0; localWaiting = 0; }
// 搜索结果按关键词缓存 6 小时：模型常反复推同几首，少搜一次就少一次 405「操作频繁」
const searchCache = new Map();
const SEARCH_TTL = 6 * 3600_000;
const SEARCH_CACHE_MAX = 500;

export function coolingDown() {
  return [...rateLimits.values()].some(({ until }) => until > Date.now());
}

function rateLimitError(pathname, cooling = false) {
  return Object.assign(new Error(`ncm ${pathname} -> 405${cooling ? ' (cooldown)' : ''}`), {
    code: 'NCM_RATE_LIMITED',
  });
}

// 取消是整次节目失效，不能当成「这首歌找不到」吞掉；单个接口超时则仍可少歌继续。
function rethrowAbort(error, signal) {
  signal?.throwIfAborted();
  if (error?.name === 'AbortError') throw error;
}

async function call(pathname, params = {}, {
  signal: parentSignal,
  timeout = 8000,
  fetchFn = fetch,
  anonymous = false,
} = {}) {
  parentSignal?.throwIfAborted();
  if (rateLimits.get(pathname)?.until > Date.now()) { countCall(pathname, 'cool'); throw rateLimitError(pathname, true); }
  const url = new URL(pathname, base);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  // cookie 只放 header：放进 query 会被网易云实例原样写进 ncm.log。
  const { signal, clear } = createTimeoutSignal(timeout, parentSignal);
  try {
    signal.throwIfAborted();
    const res = await fetchFn(url, { signal, headers: cookie && !anonymous ? { Cookie: cookie } : {} });
    signal.throwIfAborted();
    if (res.status === 405) {
      countCall(pathname, '405');
      const now = Date.now();
      const previous = rateLimits.get(pathname);
      // 同一批在途请求只开一次冷却，过期后再遇到 405 才翻倍。
      if (!previous || previous.until <= now) {
        const delay = previous ? Math.min(previous.delay * 2, 600_000) : 60_000;
        rateLimits.set(pathname, { delay, until: now + delay });
        if (pathname === '/search' && config.ncm.sharedUrl) reportCooldown(config.ncm.sharedUrl, delay);
      }
      throw rateLimitError(pathname);
    }
    if (!res.ok) { countCall(pathname, 'err'); throw new Error(`ncm ${pathname} -> ${res.status}`); }
    countCall(pathname, 'ok');
    rateLimits.delete(pathname);
    const data = await res.json();
    signal.throwIfAborted();
    return data;
  } finally {
    clear();
  }
}

export async function search(keywords, limit = 5, options = {}) {
  const key = `${limit}|${keywords}`;
  const hit = searchCache.get(key);
  if (hit && hit.until > Date.now()) { countCall('/search', 'cache'); return hit.songs; }
  const turn = pacedSearch(options.signal);
  if (turn) await turn;
  if (config.ncm.sharedUrl) await sharedTurn(config.ncm.sharedUrl, options.signal);
  // 搜索带登录 cookie。2026-11-22 夜里试过匿名搜索，11-23 早上实测盒子上匿名搜索一律 405、带 cookie 正常，改回。
  const data = await call('/search', { keywords, limit }, options);
  return rememberSearch(key, data);
}

function rememberSearch(key, data) {
  const songs = (data?.result?.songs ?? []).map((s) => ({
    id: s.id,
    title: s.name,
    artist: (s.artists ?? s.ar ?? []).map((a) => a.name).join(' / '),
    album: s.album?.name ?? s.al?.name ?? '',
    duration: Math.round((s.duration ?? s.dt ?? 0) / 1000),
    fee: Number(s.fee ?? -1),
  }));
  if (songs.length) {
    searchCache.delete(key);
    searchCache.set(key, { songs, until: Date.now() + SEARCH_TTL });
    if (searchCache.size > SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
  }
  return songs;
}

export function currentAudioQuality() {
  return audioQuality();
}

// 音质菜单：这首能要哪几档（见 quality-levels.js）。只在网页打开菜单时问一次，按 id 记 6 小时。拿不准回 null
const levelCache = new Map();
export async function songLevels(id, options = {}) {
  if (sources.isAltId(id)) return ALT_LEVELS;
  const key = String(id);
  const hit = levelCache.get(key);
  if (hit && hit.until > Date.now()) return hit.levels;
  const detail = await call('/song/detail', { ids: key }, options);
  const levels = levelsFromPrivilege(detail?.privileges?.find((p) => String(p?.id) === key) || detail?.privileges?.[0]);
  levelCache.set(key, { levels, until: Date.now() + 6 * 3600_000 });
  if (levelCache.size > 2000) levelCache.delete(levelCache.keys().next().value);
  return levels;
}

const SURROUND = new Set(['jyeffect', 'sky']);

// 只问网易云。只有试听（freeTrialInfo）也当拿不到，trial 标出来给公用版看。
async function ncmSongUrl(id, level, options) {
  // v1 接口用 level 要音质：standard / higher / exhigh / lossless / hires。
  // 会员不够或这首没有该档时，url 为空，或返回比请求更低的 level。
  // 2026-11-22 起网易云对默认的 eapi 回 -460「网络环境存在风险」（Mac 和盒子都是），weapi 正常，登录后音质也照旧。
  const data = await call('/song/url/v1', { id, level, crypto: 'weapi' }, options);
  const item = data?.data?.[0];
  // 要超清母带但账号不够时，网易云退给环绕声处理版（jyeffect / sky），不是原声：改要 Hi-Res
  if (level === 'jymaster' && SURROUND.has(item?.level)) return ncmSongUrl(id, 'hires', options);
  if (!item?.url) return null;
  const peak = Number(item.peak) || 0;
  const gain = Number(item.gain);
  const trial = Boolean(item.freeTrialInfo);
  // 页面标的真实音质；试听版不放，不用去读 FLAC 头
  const quality = trial ? ncmQuality(item)
    : await withFlacHeader(ncmQuality(item), item.url, { signal: options?.signal, ...(options?.fetchFn ? { fetchFn: options.fetchFn } : {}) });
  return {
    url: item.url,
    level: String(item.level || level),
    bitrate: Number(item.br) || 0,
    gain: peak > 0 && Number.isFinite(gain) && Math.abs(gain) < 30 ? gain : null,
    trial,
    ...(quality ? { quality } : {}),
  };
}

// 备用音源的 id 只会来自已加载的插件，所以这里不用等加载（保持同步发请求，取消和超时测试靠这个）。
export async function songUrl(id, level = currentAudioQuality(), options = {}) {
  if (sources.isAltId(id)) return sources.songUrl(id, { level, signal: options.signal });
  const audio = await ncmSongUrl(id, level, options);
  if (audio && !audio.trial) return audio;
  // 网易云这首灰了 / 只剩试听：之前认过备用音源的，直接换那边的直链
  const alt = sources.altFor(id);
  return alt ? sources.songUrl(alt, { level, signal: options.signal }) : null;
}

export async function songFacts(id, options = {}) {
  if (sources.isAltId(id)) return {};
  const detail = await call('/song/detail', { ids: id }, options);
  let facts = parseSongFacts(detail);
  if (!facts.genre) {
    const wiki = await call('/song/wiki/summary', { id }, {
      ...options,
      timeout: Math.min(options.timeout ?? 8000, 4000),
    }).catch((error) => {
      rethrowAbort(error, options.signal);
      return null;
    });
    facts = parseSongFacts(detail, wiki);
  }
  return facts;
}

export async function lyric(id, options = {}) {
  if (sources.isAltId(id)) return sources.lyric(id, options);
  const data = await call('/lyric', { id }, options);
  return data?.lrc?.lyric ?? '';
}

export async function similarSongs(id, options = {}) {
  const data = await call('/simi/song', { id }, options);
  const songs = data?.songs ?? [];
  return songs.map((song) => ({
    id: song.id,
    title: song.name,
    artist: (song.artists ?? song.ar ?? []).map((artist) => artist.name).join(' / '),
    album: song.album?.name ?? song.al?.name ?? '',
  }));
}

export function normalizePlaylistTracks(data) {
  return (data?.songs ?? [])
    .map((song) => ({
      id: song.id,
      title: String(song.name || '').trim(),
      artist: (song.artists ?? song.ar ?? []).map((artist) => String(artist.name || '').trim()).filter(Boolean).join(' / '),
    }))
    .filter((song) => song.title && song.artist);
}

export async function playlistTracks(id, { limit = 10000, ...options } = {}) {
  // 官方歌单常超过 1000 首，接口会一次返回完整 songs；不传 limit 时放宽到 10000，避免默认只取一页。
  const safeLimit = Math.max(1, Math.min(10000, Number(limit) || 10000));
  const data = await call('/playlist/track/all', { id, limit: safeLimit, offset: 0 }, options);
  return normalizePlaylistTracks(data);
}

export const VERSION_RE = /\blive\b|现场|伴奏|instrumental|off ?vocal|karaoke|\bdj\b|remix|翻自|原唱|\bcover\b|片段|铃声|加速|降调|升调|\d\.\d+x|抖音|钢琴版|女声版|男声版|[(（【\[][^)）】\]]*版[)）】\]]/i;

function baseTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[(\[【].*?[)\]】]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function artistKey(value) {
  return String(value || '').normalize('NFKC').toLowerCase().split('/')[0].trim();
}

function artistMatches(hitArtist, want) {
  return String(hitArtist || '').normalize('NFKC').toLowerCase().split('/')
    .map((name) => name.trim())
    .some((name) => name.length >= 2 && (name.includes(want) || want.includes(name)));
}

// 给了歌手就只认这位歌手的版本：网易云没版权的歌（比如周杰伦）搜出来全是翻唱，宁可换一首也不拿翻唱顶替。
// 给了歌名也只认这首：搜「枫 周杰伦」时网易云会给他的合唱 Live、挂他名字的上传，那不是这首。
// 剩下的按歌名对上排前；Live、伴奏、DJ、各种「xx版」没点名就往后排。同分保持网易云原顺序。
export function rankHits(hits = [], { title = '', artist = '' } = {}) {
  const wantTitle = baseTitle(title);
  const wantArtist = artistKey(artist);
  const askedVersion = VERSION_RE.test(title);
  const score = (hit) => {
    const name = baseTitle(hit.title);
    let value = 0;
    if (wantTitle && name === wantTitle) value += 4;
    else if (wantTitle && name && (name.includes(wantTitle) || wantTitle.includes(name))) value += 2;
    if (!askedVersion && VERSION_RE.test(`${hit.title} ${hit.album || ''}`)) value -= 3;
    return value;
  };
  // 给了歌名就只认这首（含全称 / 简称互相包含）：同一位歌手的别的歌、合唱里挂了名的歌都不算这首
  const titleOk = (hit) => {
    if (!wantTitle) return true;
    const name = baseTitle(hit.title);
    return Boolean(name) && (name === wantTitle || name.includes(wantTitle) || wantTitle.includes(name));
  };
  return hits
    .filter((hit) => (!wantArtist || artistMatches(hit.artist, wantArtist)) && titleOk(hit))
    .map((hit, index) => ({ hit, index, value: score(hit) }))
    .sort((a, b) => b.value - a.value || a.index - b.index)
    .map((item) => item.hit);
}

// 把大模型给的 {title, artist} 解析成可播条目。
// 在前几个搜索命中里逐个试 song_url，第一个能拿到直链的就用。
// 网易云拿不到（搜索被限流 / 找不到这位歌手的版本 / 都灰了或只有试听）时问备用音源：
// - 网易云认出了这首歌：保留网易云的 id、年份曲风和歌词，只把音频换成备用音源的（按歌名、歌手、时长认同一首）；
// - 网易云连歌都没搜到：整首用备用音源的（id 带前缀）。
export async function resolve({ title, artist }, options = {}) {
  options.signal?.throwIfAborted();
  const asked = currentAudioQuality();
  const query = [title, artist].filter(Boolean).join(' ');
  let hits = [];
  try {
    hits = await search(query, 8, options);
  } catch (e) {
    rethrowAbort(e, options.signal);
    const alt = await altSong({ title, artist }, asked, options);
    if (alt) return alt;
    return { title, artist, url: null, playable: false, error: e.message,
      ...(e.code === 'NCM_RATE_LIMITED' ? { rateLimited: true } : {}) };
  }
  const ranked = rankHits(hits, { title, artist });
  if (!ranked.length) {
    const alt = await altSong({ title, artist }, asked, options);
    return alt || { title, artist, url: null, playable: false, error: '网易云上找不到这位歌手的版本' };
  }
  // 先用设置里的音质逐个试；全失败再降到 standard 兜底（低音质有时反而有直链）。
  const levels = [...new Set([asked, 'standard'])];
  let rateLimited = null;
  outer:
  for (const level of levels) {
    for (const hit of ranked) {
      try {
        const audio = await ncmSongUrl(hit.id, level, options);
        if (audio?.url && !audio.trial) return withFacts(hit, audio, asked, options);
      } catch (error) {
        rethrowAbort(error, options.signal);
        if (error.code === 'NCM_RATE_LIMITED') { rateLimited = error; break outer; }
        // 试下一个命中
      }
    }
  }
  const top = ranked[0];
  const swapped = await altAudio(top, asked, options);
  if (swapped) return withFacts(top, swapped, asked, options);
  if (rateLimited) return { title, artist, url: null, playable: false, error: rateLimited.message, rateLimited: true };
  return { title, artist, url: null, playable: false };
}

async function withFacts(hit, audio, asked, options) {
  const facts = await songFacts(hit.id, options).catch((error) => {
    rethrowAbort(error, options.signal);
    return {};
  });
  options.signal?.throwIfAborted();
  const song = { ...hit, ...facts };
  factStore.remember(song);
  return {
    ...song,
    url: audio.url,
    playable: true,
    level: audio.level,
    bitrate: audio.bitrate,
    ...(audio.quality ? { quality: audio.quality } : {}),
    requestedLevel: asked,
    ...(audio.source ? { source: audio.source } : {}),
  };
}

// 网易云认出来了但放不了：备用音源里找同一首，只拿音频
async function altAudio(hit, level, options) {
  await sources.ready();
  if (!sources.size) return null;
  try {
    const found = await sources.find({ title: hit.title, artist: hit.artist, duration: hit.duration, ncmId: hit.id },
      { level, kind: sourceKind(), signal: options.signal });
    return found && { url: found.url, level: found.level, bitrate: found.bitrate, source: found.source, ...(found.quality ? { quality: found.quality } : {}) };
  } catch (error) {
    rethrowAbort(error, options.signal);
    return null;
  }
}

// 网易云连歌都没找到：整首用备用音源的
async function altSong({ title, artist }, level, options) {
  await sources.ready();
  if (!sources.size || !title) return null;
  try {
    const found = await sources.find({ title, artist }, { level, kind: sourceKind(), signal: options.signal });
    return found && { ...found, playable: true, requestedLevel: level };
  } catch (error) {
    rethrowAbort(error, options.signal);
    return null;
  }
}

// ---- 公用版未绑定账号时的默认音源（只经本机 8099 名额服务调用，见 ncm-shared.js）----
// 只取链接、只搜：不调 resolve()（它会记年份曲风），不碰播放记录、收藏、记忆和音频缓存，cookie 不出这个进程。
// 搜索名额按「别的实例」算：老板有搜索在排队时不给，最多用到 searchPerMin − sharedReserve。

async function guestTurn(signal) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const answer = grantRemote();
    if (answer.ok) return;
    if (answer.coolingMs > 0) throw rateLimitError('/search', true);
    const wait = Math.max(200, answer.retryMs || 1000);
    if (Date.now() + wait > deadline) throw Object.assign(new Error('排队中'), { code: 'NCM_BUSY' });
    await waitTurn(wait, signal);
  }
}

export function guestSearch(keywords, limit = 8, { signal, fetchFn } = {}) {
  return withNcmSource('guest', async () => {
    const key = `${limit}|${keywords}`;
    const hit = searchCache.get(key);
    if (hit && hit.until > Date.now()) { countCall('/search', 'cache'); return hit.songs; }
    await guestTurn(signal);
    const data = await call('/search', { keywords, limit }, { signal, fetchFn });
    return rememberSearch(key, data);
  });
}

// 按 id 取直链：网易云 id 用老板的登录态；网易云放不了（灰 / 只有试听）而给了歌名时，再找备用音源。
export function guestSongUrl({ id, level = 'exhigh', title = '', artist = '', duration = 0 } = {}, { signal, fetchFn } = {}) {
  return withNcmSource('guest', async () => {
    await sources.ready();
    if (sources.isAltId(id)) return sources.songUrl(id, { level, signal });
    const audio = await ncmSongUrl(id, level, { signal, fetchFn }).catch((error) => {
      rethrowAbort(error, signal);
      return null;
    });
    if (audio && !audio.trial) return audio;
    return guestFind({ ncmId: id, title, artist, duration }, { level, signal });
  });
}

// 音质菜单：给没绑定的人用：这首按本实例的账号能要哪几档
export function guestLevels(id, { signal } = {}) {
  return withNcmSource('guest', () => songLevels(id, { signal }));
}

// 只找备用音源（公用版已绑定的人自己的登录态放不了时用）
export async function guestFind(song, { level = 'exhigh', signal } = {}) {
  await sources.ready();
  if (!sources.size) return null;
  const alt = song.ncmId && sources.altFor(song.ncmId);
  if (alt) {
    const audio = await sources.songUrl(alt, { level, signal });
    if (audio) return { id: alt, ...audio };
  }
  if (!song.title) return null;
  const found = await sources.find(song, { level, kind: 'guest', signal });
  return found;
}

export async function guestLyric(id, { signal } = {}) {
  await sources.ready();
  return sources.isAltId(id) ? sources.lyric(id, { signal }) : '';
}

// 给无头播放的「下一首」用。跳过已经放过的 id，找另一首能放的。
export async function resolveNext({ query, excludeIds = [] } = {}, options = {}) {
  options.signal?.throwIfAborted();
  const text = String(query || '').trim();
  if (!text) return null;
  let hits = [];
  try {
    hits = await search(text, 12, options);
  } catch (error) {
    rethrowAbort(error, options.signal);
    return null;
  }
  const skipped = new Set(excludeIds.filter(Boolean).map((id) => String(id)));
  for (const hit of hits) {
    if (!hit?.id || skipped.has(String(hit.id))) continue;
    const song = await resolve({ title: hit.title, artist: hit.artist }, options);
    if (song?.playable && song.url && !skipped.has(String(song.id))) return song;
  }
  return null;
}
