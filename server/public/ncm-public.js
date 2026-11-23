// 公用版的网易云客户端。和个人版 ncm.js 分开：个人版在模块加载时就绑定了老板的 cookie，这里每次调用自己带 cookie。
//
// - cookie 只放 header（放 query 会被网易云实例写进日志）。
// - 网易云实例的响应缓存只按 URL 做键（apicache 2 分钟），不认 cookie：带 cookie 的请求一律加 `_u=<cookie 哈希>`，
//   免得 A 的歌单 / 直链被缓存后发给 B。
// - 整个公用实例共用一个令牌桶，外加按人的令牌桶；某个接口遇到 405（操作频繁）就把这个接口停两分钟。
// - 搜索名额和老板的实例合着算（同一个出口 IP，网易云按搜索总数限流）：每次搜索先向老板实例的名额服务
//   （NCM_SHARED_URL，见 ../ncm-shared.js）要 kind=chat 的名额，老板优先；搜索碰到 405 就报给它，两边一起冷却 15 分钟。
//   不管名额服务给多少，公用版自己每分钟最多 3 个；名额服务不通（老板实例重启等）时更保守：每分钟最多 2 个、间隔至少 5 秒。
// - 匿名或非会员拿到的 VIP 歌只有 30–45 秒试听（freeTrialInfo），这里标成 trial，由上层决定跳过。
// - owner（可选，见 ../ncm-shared.js 的 createOwnerChannel）：经老板实例的 8099 借老板的网易云。
//   没绑定的人搜歌、取链接都走它（老板的 cookie 不进这个进程）；谁的网易云都放不了时，它再去备用音源找同一首。
//   网易云没搜到的歌整首用备用音源的，id 是「字母前缀 + 数字」，没有封面，红心只记在这里。
import crypto from 'node:crypto';
import { rankHits, VERSION_RE } from '../ncm.js';
import { createTimeoutSignal } from '../llm/openai-chat.js';
import { requestSlot, reportCooldown } from '../ncm-shared.js';

export class NcmBusyError extends Error {
  constructor(message = '排队中，稍后再试') {
    super(message);
    this.code = 'NCM_BUSY';
  }
}

export function cookieKey(cookie) {
  return cookie ? crypto.createHash('sha256').update(cookie).digest('hex').slice(0, 16) : '';
}

export function toHttps(url) {
  return String(url || '').replace(/^http:\/\//i, 'https://');
}

// 网易云歌曲对象（song/detail、歌单、每日推荐、FM 都是这个形状）→ 公用版用的样子
export function trackView(s) {
  return {
    id: Number(s?.id) || 0,
    title: String(s?.name || ''),
    artist: (s?.ar ?? s?.artists ?? []).map((a) => a.name).join(' / '),
    duration: Math.round((s?.dt ?? s?.duration ?? 0) / 1000),
    cover: toHttps(s?.al?.picUrl ?? s?.album?.picUrl ?? s?.album?.blurPicUrl ?? ''),
  };
}

// 扫码成功时网易云回的整串 Set-Cookie（几条用 ; 连着，夹着 Max-Age / Path / Expires 之类属性）→ 只留「名=值」。
// 整套都存（加密）：只留 MUSIC_U / __csrf 时，每日推荐和私人 FM 实测回空。
const COOKIE_ATTRS = new Set(['max-age', 'expires', 'path', 'domain', 'httponly', 'secure', 'samesite']);
export function loginCookie(raw) {
  const pairs = new Map();
  for (const part of String(raw || '').split(';')) {
    const i = part.indexOf('=');
    const name = (i > 0 ? part.slice(0, i) : part).trim();
    if (!name || COOKIE_ATTRS.has(name.toLowerCase()) || i <= 0) continue;
    const value = part.slice(i + 1).trim();
    if (value) pairs.set(name, value);
  }
  return [...pairs].map(([k, v]) => `${k}=${v}`).join('; ');
}

export function createBucket({ ratePerSec, burst, now = () => Date.now() }) {
  let tokens = burst;
  let last = now();
  return {
    // 拿不到令牌时最多等 maxWaitMs（排队），还拿不到才算忙
    async acquire(maxWaitMs = 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
      const deadline = now() + maxWaitMs;
      while (!this.take()) {
        const wait = Math.ceil(1000 / ratePerSec);
        if (now() + wait > deadline) return false;
        await sleep(wait);
      }
      return true;
    },
    take() {
      const t = now();
      tokens = Math.min(burst, tokens + ((t - last) / 1000) * ratePerSec);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

export function createNcmClient({
  base,
  fetchFn = fetch,
  // 2026-11-23 实测：约 10 分钟 57 次（多是一连串搜索）就被 405。全站压到每分钟 30 次；
  // 拿不到令牌先排队几秒，不直接报忙。搜索另有名额（见文件头）。
  globalRate = 0.5,
  globalBurst = 10,
  memberRate = 0.25,
  memberBurst = 15,
  sharedUrl = '',
  slotFn = (url) => requestSlot(url, 'chat'),
  reportFn = reportCooldown,
  maxPerMin = 3,
  fallbackPerMin = 2,
  fallbackGapMs = 5000,
  waitMs = 8000,
  cooldownMs = 120_000,
  searchCooldownMs = 15 * 60_000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  owner = null,
} = {}) {
  // 老板实例那边忙 / 连不上统一当排队中
  const viaOwner = (promise) => promise.catch((error) => {
    if (error?.code === 'NCM_BUSY') throw new NcmBusyError(error.message);
    throw error;
  });
  // 这个人自己点太快：不去备用音源绕过，直接告诉 TA
  const memberBusy = () => Object.assign(new NcmBusyError('你点得太快了，歇一会儿再来'), { member: true });
  // 搜到过的歌记下歌名歌手时长：按 id 取链放不了时，备用音源要靠它认歌
  const known = new Map();
  const remember = (song) => {
    if (!song?.id || !song.title) return;
    known.set(String(song.id), { title: song.title, artist: song.artist || '', duration: song.duration || 0 });
    if (known.size > 5000) known.delete(known.keys().next().value);
  };
  const metaOf = (id, song) => ({ ...(known.get(String(id)) || {}), ...(song?.title ? { title: song.title, artist: song.artist || '', duration: song.duration || 0 } : {}) });
  const globalBucket = createBucket({ ratePerSec: globalRate, burst: globalBurst, now });
  const memberBuckets = new Map();
  const searchCache = new Map();
  // 放不了的（只有试听 / 没直链）按「歌 + 账号」记 6 小时，下次直接跳过，不再问网易云
  const deadSongs = new Map();
  const DEAD_TTL = 6 * 3600_000;
  const searchSentAt = [];
  // 按接口冷却（和个人版一样）：搜索被限流时扫码登录照样能用
  const pausedUntil = new Map();
  const paused = (pathname) => (pausedUntil.get(pathname) || 0) > now();

  // 本地上限：还要等多久（0 = 现在就能搜）
  function localWait(perMin, gap) {
    const t = now();
    while (searchSentAt.length && searchSentAt[0] <= t - 60_000) searchSentAt.shift();
    let at = searchSentAt.length && gap > 0 ? searchSentAt.at(-1) + gap : t;
    if (searchSentAt.length >= perMin) at = Math.max(at, searchSentAt[searchSentAt.length - perMin] + 60_000);
    return Math.max(0, at - t);
  }

  // 搜索前要名额；最多等 waitMs，等不到就告诉听众排队中
  async function searchTurn() {
    const deadline = now() + waitMs;
    const hold = async (wait) => {
      if (now() + wait > deadline) throw new NcmBusyError();
      await sleep(wait);
    };
    for (;;) {
      if (paused('/search')) throw new NcmBusyError();
      const own = localWait(maxPerMin, 0);
      if (own > 0) { await hold(own); continue; }
      const answer = sharedUrl ? await slotFn(sharedUrl) : null;
      if (answer?.coolingMs > 0) {
        pausedUntil.set('/search', now() + Number(answer.coolingMs));
        throw new NcmBusyError();
      }
      if (answer && !answer.ok) { await hold(Math.max(200, Number(answer.retryMs) || 1000)); continue; }
      if (!answer) {
        const wait = localWait(fallbackPerMin, fallbackGapMs);
        if (wait > 0) { await hold(wait); continue; }
      }
      searchSentAt.push(now());
      return;
    }
  }

  function memberBucket(memberId) {
    if (!memberId) return null;
    let bucket = memberBuckets.get(memberId);
    if (!bucket) {
      bucket = createBucket({ ratePerSec: memberRate, burst: memberBurst, now });
      memberBuckets.set(memberId, bucket);
      if (memberBuckets.size > 500) memberBuckets.delete(memberBuckets.keys().next().value);
    }
    return bucket;
  }

  async function call(pathname, params = {}, { cookie = '', memberId = '', signal, timeout = 8000 } = {}) {
    if (paused(pathname)) throw new NcmBusyError();
    // 扫码后查状态是网页每 3 秒轮询一次、最长 3 分钟，不占点歌的令牌，免得扫得慢的人把自己和别人都卡住
    const polling = pathname === '/login/qr/check';
    const bucket = polling ? null : memberBucket(memberId);
    if (bucket && !(await bucket.acquire(waitMs, sleep))) throw memberBusy();
    if (!polling && !(await globalBucket.acquire(waitMs, sleep))) throw new NcmBusyError('排队中，稍后再试');
    if (pathname === '/search') await searchTurn();
    const url = new URL(pathname, base);
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
    if (cookie) url.searchParams.set('_u', cookieKey(cookie));
    const { signal: timed, clear } = createTimeoutSignal(timeout, signal);
    try {
      const res = await fetchFn(url, { signal: timed, headers: cookie ? { Cookie: cookie } : {} });
      if (res.status === 405) {
        const search = pathname === '/search';
        pausedUntil.set(pathname, now() + (search ? searchCooldownMs : cooldownMs));
        if (search && sharedUrl) reportFn(sharedUrl, searchCooldownMs);
        throw new NcmBusyError();
      }
      if (!res.ok) throw new Error(`ncm ${pathname} -> ${res.status}`);
      return await res.json();
    } finally {
      clear();
    }
  }

  async function search(keywords, { limit = 8, ...options } = {}) {
    const key = `${limit}|${keywords}`;
    const hit = searchCache.get(key);
    if (hit && hit.until > now()) return hit.songs;
    // 2026-11-23 实测：盒子出口上匿名搜索一律 405，带登录态正常。所以绑定了网易云的人用自己的 cookie 搜；
    // 没绑定的经老板实例用老板的登录态搜（名额按别的实例算，老板优先）。结果不含个人信息，按关键词大家共用缓存。
    let songs;
    if (options.cookie) {
      const data = await call('/search', { keywords, limit }, options);
      songs = (data?.result?.songs ?? []).map((s) => ({
        id: s.id,
        title: s.name,
        artist: (s.artists ?? s.ar ?? []).map((a) => a.name).join(' / '),
        album: s.album?.name ?? s.al?.name ?? '',
        duration: Math.round((s.duration ?? s.dt ?? 0) / 1000),
        fee: Number(s.fee ?? -1),
      }));
    } else if (owner) {
      const bucket = memberBucket(options.memberId);
      if (bucket && !(await bucket.acquire(waitMs, sleep))) throw memberBusy();
      songs = await viaOwner(owner.search(keywords, limit));
    } else {
      throw new NcmBusyError('绑定网易云后才能点歌');
    }
    songs.forEach(remember);
    if (songs.length) {
      searchCache.set(key, { songs, until: now() + 6 * 3600_000 });
      if (searchCache.size > 1000) searchCache.delete(searchCache.keys().next().value);
    }
    return songs;
  }

  // 要 level 那一档；这首没有时网易云自己降档。无损（会员才有）拿不到链接时再按 exhigh 要一次。
  // gain：把这首拉到 -18 LUFS 要加的分贝（2026-11-23 实测 7 首「ebur128 实测 + gain」都在 -17.9±0.05），
  // 网页按它统一响度；试听版的 gain=2 / peak=0 是占位，不算。
  async function ncmSongUrl(id, { level = 'exhigh', ...options } = {}) {
    for (const lv of level === 'lossless' ? ['lossless', 'exhigh'] : [level]) {
      const data = await call('/song/url/v1', { id, level: lv, crypto: 'weapi' }, options);
      const item = data?.data?.[0];
      if (!item?.url) continue;
      const peak = Number(item.peak) || 0;
      const gain = Number(item.gain);
      return {
        url: toHttps(item.url),
        level: String(item.level || ''),
        bitrate: Number(item.br) || 0,
        gain: peak > 0 && Number.isFinite(gain) && Math.abs(gain) < 30 ? gain : null,
        trial: Boolean(item.freeTrialInfo),
      };
    }
    return null;
  }

  const altView = (audio) => audio?.url && {
    url: toHttps(audio.url), level: String(audio.level || ''), bitrate: Number(audio.bitrate) || 0, gain: audio.gain ?? null, trial: false,
    ...(audio.source ? { source: audio.source } : {}),
  };

  // 按 id 取直链。绑定的人用自己的登录态，放不了（灰 / 只有试听）再经老板实例找备用音源；
  // 没绑定的整个交给老板实例（老板的登录态，放不了它自己会找备用音源）。
  async function songUrl(id, { level = 'exhigh', song = null, ...options } = {}) {
    const meta = metaOf(id, song);
    if (!/^\d+$/.test(String(id))) return owner ? altView(await viaOwner(owner.songUrl({ id: String(id), level }))) : null;
    if (!options.cookie && owner) {
      const bucket = memberBucket(options.memberId);
      if (bucket && !(await bucket.acquire(waitMs, sleep))) throw memberBusy();
      return altView(await viaOwner(owner.songUrl({ id: String(id), level, ...meta })));
    }
    const audio = await ncmSongUrl(id, { level, ...options });
    if ((audio && !audio.trial) || !owner || !options.cookie) return audio;
    const alt = await viaOwner(owner.find({ ncmId: String(id), level, ...meta })).catch((error) => {
      if (error instanceof NcmBusyError) return null;
      throw error;
    });
    return altView(alt) || audio;
  }

  // 网易云连歌都没搜到（或搜索在排队）：整首用备用音源的
  async function findAlt({ title, artist }, { level = 'exhigh' } = {}) {
    if (!owner || !title) return null;
    const found = await viaOwner(owner.find({ title, artist, level })).catch(() => null);
    if (!found?.url) return null;
    return { id: found.id, title: found.title, artist: found.artist, album: found.album || '', duration: found.duration || 0, cover: '', ...altView(found), playable: true };
  }

  // 把 {title, artist} 解析成能放的歌。allowTrial=false 时跳过只有试听的版本。
  // 没登录时，搜索结果里 fee=1（VIP）/ 4（付费专辑）的直接当试听跳过，不再去问直链。
  async function resolve({ title, artist }, { allowTrial = false, ...options } = {}) {
    // 公用版更严：没点名要 Live / 翻唱 / 「xx版」就不要，免得把网友上传的翻唱当原唱放
    const askedVersion = VERSION_RE.test(title);
    let found;
    try {
      found = await search([title, artist].filter(Boolean).join(' '), options);
    } catch (error) {
      const alt = error instanceof NcmBusyError && !error.member ? await findAlt({ title, artist }, options) : null;
      if (alt) return alt;
      throw error;
    }
    const hits = rankHits(found, { title, artist })
      .filter((hit) => askedVersion || !VERSION_RE.test(`${hit.title} ${hit.album || ''}`));
    const who = cookieKey(options.cookie || '');
    let trialOnly = false;
    for (const hit of hits.slice(0, 2)) {
      const deadKey = `${hit.id}|${who}`;
      const dead = deadSongs.get(deadKey);
      if (dead && dead.until > now() && !(dead.trial && allowTrial)) { if (dead.trial) trialOnly = true; continue; }
      if (!options.cookie && !owner && !allowTrial && (hit.fee === 1 || hit.fee === 4)) { trialOnly = true; continue; }
      const audio = await songUrl(hit.id, { ...options, song: hit });
      if (!audio || (audio.trial && !allowTrial)) {
        deadSongs.set(deadKey, { trial: Boolean(audio?.trial), until: now() + DEAD_TTL });
        if (deadSongs.size > 5000) deadSongs.delete(deadSongs.keys().next().value);
        if (audio?.trial) trialOnly = true;
        continue;
      }
      return { ...hit, ...audio, playable: true };
    }
    if (!hits.length) {
      const alt = await findAlt({ title, artist }, options);
      if (alt) return alt;
    }
    return { title, artist, playable: false, reason: hits.length ? (trialOnly ? 'trial' : 'no-url') : 'not-found' };
  }

  // 没绑定的人只放榜单里的免费歌（fee 0 / 8）：一个榜单请求管 12 小时，不搜歌
  const chartCache = new Map();
  async function freeChart(id, options = {}) {
    const hit = chartCache.get(id);
    if (hit && hit.until > now()) return hit.songs;
    const data = await call('/playlist/track/all', { id, limit: 200, offset: 0 }, { ...options, cookie: '' });
    // 能借老板网易云时榜单里的歌都能放；不能借时只留免费歌（fee 0 / 8）
    const songs = (data?.songs ?? [])
      .filter((s) => owner || [0, 8].includes(Number(s.fee)))
      .map(trackView)
      .filter((s) => s.id && s.title);
    chartCache.set(id, { songs, until: now() + 12 * 3600_000 });
    return songs;
  }

  // 已知 id 的歌直接问直链（不搜）；放不了的记进 deadSongs
  async function playById(song, { allowTrial = false, ...options } = {}) {
    const deadKey = `${song.id}|${cookieKey(options.cookie || '')}`;
    const dead = deadSongs.get(deadKey);
    if (dead && dead.until > now()) return { ...song, playable: false, reason: dead.trial ? 'trial' : 'no-url' };
    remember(song);
    const audio = await songUrl(song.id, { ...options, song });
    if (!audio || (audio.trial && !allowTrial)) {
      deadSongs.set(deadKey, { trial: Boolean(audio?.trial), until: now() + DEAD_TTL });
      if (deadSongs.size > 5000) deadSongs.delete(deadSongs.keys().next().value);
      return { ...song, playable: false, reason: audio?.trial ? 'trial' : 'no-url' };
    }
    return { ...song, ...audio, playable: true };
  }

  async function lyric(id, options = {}) {
    if (!/^\d+$/.test(String(id))) return owner ? viaOwner(owner.lyric(String(id))) : '';
    const data = await call('/lyric', { id }, options);
    return data?.lrc?.lyric ?? '';
  }

  // ---- 扫码登录 ----
  async function qrStart(options = {}) {
    const key = (await call('/login/qr/key', { timestamp: now() }, options))?.data?.unikey;
    if (!key) throw new Error('拿不到二维码');
    const created = await call('/login/qr/create', { key, qrimg: true, timestamp: now() }, options);
    const img = created?.data?.qrimg;
    if (!img) throw new Error('拿不到二维码');
    return { key, img };
  }

  // 800 过期 / 801 待扫 / 802 待确认 / 803 成功；其他码（如 8821 风控）原样带回
  async function qrCheck(key, options = {}) {
    const data = await call('/login/qr/check', { key, timestamp: now() }, options);
    const code = Number(data?.code) || 0;
    if (code !== 803) return { code, message: String(data?.message || '') };
    const cookie = loginCookie(data?.cookie);
    if (!/(^|; )MUSIC_U=/.test(cookie)) return { code: 0, message: '登录成功但没拿到登录态' };
    return { code, cookie };
  }

  async function account(cookie, options = {}) {
    const data = await call('/user/account', { timestamp: now() }, { ...options, cookie });
    const profile = data?.profile;
    if (!profile?.userId) return null;
    return { uid: profile.userId, nickname: String(profile.nickname || ''), vip: Number(data?.account?.vipType) > 0 };
  }

  // 读口味：喜欢的歌（抽样 80 首，带 id，自动续播直接用、不用搜）+ 自建歌单名
  async function taste(cookie, uid, options = {}) {
    const ids = (await call('/likelist', { uid, timestamp: now() }, { ...options, cookie }))?.ids ?? [];
    const sample = [...ids].sort(() => Math.random() - 0.5).slice(0, 80);
    let likes = [];
    if (sample.length) {
      const detail = await call('/song/detail', { ids: sample.join(',') }, { ...options, cookie });
      likes = (detail?.songs ?? []).map(trackView).filter((s) => s.id && s.title);
    }
    const lists = (await call('/user/playlist', { uid, limit: 30, timestamp: now() }, { ...options, cookie }))?.playlist ?? [];
    const playlists = lists.filter((p) => String(p.userId) === String(uid)).map((p) => String(p.name || '')).filter(Boolean).slice(1, 11);
    return { likeCount: ids.length, likeIds: ids.map(Number).filter(Boolean).slice(0, 5000), likes, playlists };
  }

  // 每日推荐（约 30 首，一天一换）和私人 FM（一次 3 首）：都用听众自己的登录态，不搜歌，不占搜索名额。
  // 带 timestamp 绕开网易云实例的 2 分钟缓存。
  async function dailyRecommend(cookie, options = {}) {
    const data = await call('/recommend/songs', { timestamp: now() }, { ...options, cookie });
    return (data?.data?.dailySongs ?? data?.recommend ?? []).map(trackView).filter((s) => s.id && s.title);
  }

  async function personalFm(cookie, options = {}) {
    const data = await call('/personal_fm', { timestamp: now() }, { ...options, cookie });
    return (data?.data ?? []).map(trackView).filter((s) => s.id && s.title);
  }

  // 和某首歌相似的歌（按 id，不用登录，不搜）：每日推荐 / FM 拿不到时用 TA 红心歌的相似歌顶上
  async function simiSongs(id, options = {}) {
    const data = await call('/simi/song', { id }, { ...options, cookie: '' });
    return (data?.songs ?? []).map(trackView).filter((s) => s.id && s.title);
  }

  // 加 / 取消红心，写到听众自己的网易云「我喜欢的音乐」
  async function like(cookie, id, on = true, options = {}) {
    const data = await call('/like', { id, like: on ? 'true' : 'false', timestamp: now() }, { ...options, cookie });
    return Number(data?.code) === 200;
  }

  return { borrowsOwner: Boolean(owner), call, search, songUrl, resolve, freeChart, playById, lyric, qrStart, qrCheck, account, taste, dailyRecommend, personalFm, simiSongs, like, paused };
}
