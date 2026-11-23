// 公用版 HTTP 路由。只开这里列出来的接口——个人版的设置、设备、记忆、小智、代理一个都不挂。
// 进门靠设备令牌（httpOnly cookie），每个请求都去 hub 核一次（缓存几秒）。
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { BrainBusyError } from './brain.js';
import { NcmBusyError, toHttps } from './ncm-public.js';
import { HubError } from './hub-client.js';
import { createMediaProxy } from './media.js';
import { createMixer, shuffle, songKey } from './mix.js';
import { createVoice, introLine } from './voice.js';
import { oneSentence } from '../drive.js';
import { appVersion } from '../version.js';

const COOKIE = 'dj_dev';

// 音质：绑了网易云且是会员默认要无损（只到 CD 级，见 ncm-public.js 的 songUrl），其余要 exhigh（320k，没绑定的免费歌也能拿到）；
// 账号面板选了「流畅」，或这次打开网页卡顿自动降档（smooth，网页每次请求带上）也要 320k。没有这档网易云自己降
export function qualityFor(memory, cookie, smooth = false) {
  return cookie && memory?.account?.vip && !smooth && memory?.quality !== 'smooth' ? 'lossless' : 'exhigh';
}

// 浏览器直接去音乐 CDN 取（国内 CDN 首字节几十毫秒；经家里盒子和 Cloudflare 隧道要绕美国，1–2 秒、带宽忽高忽低）。
// 只给 https 直链（不带 cookie）；直链失效或放不了，网页再退回同源 /media 代理
export function directUrl(url) {
  const text = toHttps(url);
  return /^https:\/\/[\w.-]+(:\d+)?\//.test(text) && text.length < 2000 ? text : '';
}

// 封面只认网易云图床的 https 地址
export function safeCover(url) {
  const text = String(url || '');
  return /^https:\/\/p\d+\.music\.126\.net\/[\w\-./=]+$/.test(text) && text.length < 300 ? text : '';
}

// 歌 id：网易云是纯数字；网易云没有、从备用音源来的是「2–4 个小写字母 + 数字」
export const SONG_ID = /^(\d{1,15}|[a-z]{2,4}\d{1,20})$/;
export function parseSongId(value) {
  const text = String(value ?? '');
  if (!SONG_ID.test(text)) return 0;
  return /^\d+$/.test(text) ? Number(text) : text;
}

export function songView(song) {
  return {
    id: song.id, title: song.title, artist: song.artist, url: `/media/${song.id}`, duration: song.duration || 0,
    level: song.level || '', bitrate: song.bitrate || 0, gain: song.gain ?? null, cover: song.cover || '',
    ...(song.quality ? { quality: song.quality } : {}),
    ...(directUrl(song.url) ? { direct: directUrl(song.url) } : {}),
  };
}
const COOKIE_MAX_AGE = 400 * 24 * 3600; // 浏览器允许的上限
const HEARTBEAT_TTL = 70_000;

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function deviceLabel(ua) {
  const s = String(ua || '');
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android'
    : /Mac OS X/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : '设备';
  const browser = /MicroMessenger/.test(s) ? '微信' : /Edg\//.test(s) ? 'Edge' : /Chrome\//.test(s) ? 'Chrome'
    : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : '';
  return [os, browser].filter(Boolean).join(' · ');
}

// cloudflared 在本机转发，所以只有对端是本机时才信 CF-Connecting-IP
export function clientIp(req) {
  const peer = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  const local = peer === '127.0.0.1' || peer === '::1';
  return (local && String(req.headers['cf-connecting-ip'] || '').trim()) || peer || '-';
}

export function createFailLimiter({ max = 10, windowMs = 10 * 60_000, now = () => Date.now() } = {}) {
  const hits = new Map();
  return {
    blocked(ip) {
      const list = (hits.get(ip) || []).filter((t) => now() - t < windowMs);
      hits.set(ip, list);
      return list.length >= max;
    },
    fail(ip) {
      const list = (hits.get(ip) || []).filter((t) => now() - t < windowMs);
      list.push(now());
      hits.set(ip, list);
      if (hits.size > 5000) hits.delete(hits.keys().next().value);
    },
  };
}

const REASONS = {
  link_used: '这个邀请链接已经用过了。换台设备的话，在已登录的设备上点「添加设备」拿配对码。',
  link_expired: '邀请链接过期了，找发链接的人要一个新的。',
  invalid: '链接或配对码不对。',
  device_limit: '设备数已满，先在已登录的设备上退出一台。',
  disabled: '这个账号已停用。',
  expired: '这个账号已到期，找发链接的人续期。',
  quota: '今天的次数用完了，明天再来。',
  rate_limit: '今天申请次数太多了，明天再试。',
  hub_unreachable: '后台暂时连不上，稍后再试。',
};

function sendError(res, error) {
  if (error instanceof HubError) {
    const status = error.status >= 400 && error.status < 600 ? error.status : 500;
    return res.status(status).json({ error: error.reason, message: REASONS[error.reason] || '请求没成功' });
  }
  if (error instanceof BrainBusyError || error instanceof NcmBusyError) {
    return res.status(503).json({ error: 'busy', message: error.message });
  }
  return res.status(500).json({ error: 'server_error', message: '出了点问题，稍后再试' });
}

export function createPublicApp({
  hub,
  ncm,
  brain,
  members,
  webRoot,
  cookieSecure = true,
  applyOrigins = [],
  turnstileSecret = '',
  turnstileSiteKey = '',
  maxListeners = 8,
  freeChartId = '3778678',
  ttsUrl = '',
  fetchFn = fetch,
  log = () => {},
  now = () => Date.now(),
}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  const failLimiter = createFailLimiter({ now });
  const applyLimiter = createFailLimiter({ max: 10, windowMs: 3600_000, now });
  const listeners = new Map(); // memberId -> { deviceId, at }
  const qrKeys = new Map(); // memberId -> { key, at }
  const media = createMediaProxy({ ncm, members, qualityFor, fetchFn, now, log });
  const mixer = createMixer({ ncm, brain, members, qualityFor, log, now });
  const voice = createVoice({ ttsUrl, fetchFn, now, log });

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Strict-Transport-Security': 'max-age=15552000',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; img-src 'self' data: https://*.music.126.net; media-src 'self' blob: https:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    });
    next();
  });
  app.use(express.json({ limit: '16kb' }));

  const setDeviceCookie = (res, token) => {
    res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${cookieSecure ? '; Secure' : ''}`);
  };
  const clearDeviceCookie = (res) => {
    res.append('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${cookieSecure ? '; Secure' : ''}`);
  };

  // ---- 申请（也可以从 PUBLIC_APPLY_ORIGINS 里的站点跨域提交）----
  const corsApply = (req, res) => {
    const origin = String(req.headers.origin || '');
    if (applyOrigins.includes(origin)) {
      res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
    }
  };
  app.options('/api/apply', (req, res) => { corsApply(req, res); res.sendStatus(204); });
  app.get('/api/apply/config', (req, res) => { corsApply(req, res); res.json({ turnstileSiteKey }); });
  app.post('/api/apply', async (req, res) => {
    corsApply(req, res);
    const ip = clientIp(req);
    if (applyLimiter.blocked(ip)) return res.status(429).json({ error: 'rate_limit', message: REASONS.rate_limit });
    applyLimiter.fail(ip);
    const { name, note, wechat, turnstileToken } = req.body || {};
    if (!String(name || '').trim() || !String(note || '').trim()) {
      return res.status(400).json({ error: 'invalid', message: '称呼和说明都要填' });
    }
    if (turnstileSecret) {
      const form = new URLSearchParams({ secret: turnstileSecret, response: String(turnstileToken || ''), remoteip: ip });
      const ok = await fetchFn('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form })
        .then((r) => r.json()).then((d) => d?.success === true).catch(() => false);
      if (!ok) return res.status(400).json({ error: 'captcha', message: '人机校验没通过，刷新再试' });
    }
    try {
      const out = await hub.apply({ name, note, wechat, ip });
      log('apply', out.id);
      res.json({ ok: true });
    } catch (error) { sendError(res, error); }
  });

  // ---- 进门：邀请链接 / 配对码 ----
  app.post('/api/join', async (req, res) => {
    const ip = clientIp(req);
    if (failLimiter.blocked(ip)) return res.status(429).json({ error: 'rate_limit', message: '试错太多次了，10 分钟后再来' });
    try {
      const out = await hub.redeemLink(String(req.body?.token || ''), deviceLabel(req.headers['user-agent']));
      setDeviceCookie(res, out.device_token);
      log('join', out.member.id);
      res.json({ ok: true, name: out.member.name });
    } catch (error) {
      if (error instanceof HubError && error.status === 403) failLimiter.fail(ip);
      sendError(res, error);
    }
  });

  app.post('/api/pair/redeem', async (req, res) => {
    const ip = clientIp(req);
    if (failLimiter.blocked(ip)) return res.status(429).json({ error: 'rate_limit', message: '试错太多次了，10 分钟后再来' });
    try {
      const out = await hub.pairRedeem(String(req.body?.code || ''), deviceLabel(req.headers['user-agent']));
      setDeviceCookie(res, out.device_token);
      log('pair', out.member.id);
      res.json({ ok: true, name: out.member.name });
    } catch (error) {
      if (error instanceof HubError && error.status === 403) failLimiter.fail(ip);
      sendError(res, error);
    }
  });

  // ---- 以下都要已绑定的设备 ----
  async function auth(req, res, next) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return res.status(401).json({ error: 'no_device', message: '这台设备还没加入' });
    try {
      const out = await hub.verify(token);
      req.device = { token, id: out.device_id };
      req.member = out.member;
      next();
    } catch (error) {
      if (error instanceof HubError && error.status === 403) {
        clearDeviceCookie(res);
        return res.status(401).json({ error: error.reason, message: REASONS[error.reason] || '这台设备已失效' });
      }
      sendError(res, error);
    }
  }

  const memberView = (m) => {
    const mem = members.memory(m.id);
    return {
      name: m.name,
      remaining: m.remaining,
      dailyTotal: m.daily_total,
      devices: m.devices,
      maxDevices: m.max_devices,
      expires: m.expires,
      bound: members.bound(m.id),
      // 没绑定也能点歌（用运营者配置的默认音源，见 ncm-public.js 的 owner）；网页据此决定提示「绑定后才能点歌」还是直接让点
      canAsk: members.bound(m.id) || Boolean(ncm.borrowsOwner),
      nickname: mem.account?.nickname || '',
      vip: Boolean(mem.account?.vip),
      quality: mem.quality === 'smooth' ? 'smooth' : 'lossless',
      prefs: mem.prefs,
    };
  };

  // 菜单里看设备数要准：先丢掉这台的核验缓存再核一次
  // 网页（web/，和个人版同一份）先问这个：公用版只露出配额、最近听过、账号这几样，播放引擎用 public.js
  app.get('/api/mode', (req, res) => res.json({ mode: 'public', features: { quota: true, history: true, account: true, drive: true }, version: appVersion() }));

  app.get('/api/me', (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) hub.forget(token);
    next();
  }, auth, (req, res) => res.json(memberView(req.member)));

  app.post('/api/logout', auth, async (req, res) => {
    try { await hub.logout(req.device.token); } catch { /* 本机照样退出 */ }
    clearDeviceCookie(res);
    res.json({ ok: true });
  });

  app.post('/api/pair/create', auth, async (req, res) => {
    try {
      const out = await hub.pairCreate(req.device.token);
      res.json({ code: out.code, expires: out.expires });
    } catch (error) { sendError(res, error); }
  });

  // 同时一处在播：换设备时新设备可以接过来，旧设备下次心跳收到 409 就停
  app.post('/api/play/heartbeat', auth, (req, res) => {
    const mid = req.member.id;
    const t = now();
    for (const [id, v] of listeners) if (t - v.at > HEARTBEAT_TTL) listeners.delete(id);
    const cur = listeners.get(mid);
    if (cur && cur.deviceId !== req.device.id && !req.body?.takeover) {
      return res.status(409).json({ error: 'other_device', message: '你的另一台设备正在放，要在这台接着放吗？' });
    }
    if (!cur && listeners.size >= maxListeners) {
      return res.status(503).json({ error: 'busy', message: '电台这会儿人满了，过一会儿再来' });
    }
    listeners.set(mid, { deviceId: req.device.id, at: t });
    res.json({ ok: true });
  });

  app.post('/api/play/stop', auth, (req, res) => {
    if (listeners.get(req.member.id)?.deviceId === req.device.id) listeners.delete(req.member.id);
    res.json({ ok: true });
  });

  const hearted = (mem, id) => (mem.hearts || []).includes(id) || (mem.taste?.likeIds || []).includes(id);
  const withLiked = (mem, songs) => songs.map((song) => ({ ...song, liked: hearted(mem, song.id) }));

  async function pickSongs(candidates, { cookie, memberId, bound, level }) {
    const songs = [];
    let trials = 0;
    for (const cand of candidates) {
      if (songs.length >= 2) break;
      let song;
      try {
        song = await ncm.resolve(cand, { cookie, memberId, level, allowTrial: false });
      } catch (error) {
        // 限速 / 限流时已经找到的先放，一首都没有才报忙
        if (error instanceof NcmBusyError && songs.length) break;
        throw error;
      }
      if (song.playable && !songs.some((s) => s.id === song.id)) {
        media.remember(memberId, level, song);
        songs.push(songView(song));
      } else if (song.reason === 'trial') trials += 1;
    }
    let notice = '';
    if (!songs.length) {
      if (trials) notice = bound ? '这几首要黑胶会员才能听完整版，换个说法试试？' : '这几首没登录只能听 30 秒试听，已跳过。扫码登录网易云就能放完整版（会员歌要会员）。';
      else notice = '网易云上没找到能放的版本（可能没有版权），换一首试试。';
    }
    return { songs, notice };
  }

  async function fallbackCandidates(text, memory) {
    const recent = new Set((memory.recent || []).map((s) => `${s.title}|${s.artist}`));
    return (await ncm.search(text.slice(0, 40), { limit: 10, cookie: memory.cookie, memberId: memory.memberId }))
      .filter((h) => !recent.has(`${h.title}|${h.artist}`)).slice(0, 4).map((h) => ({ title: h.title, artist: h.artist }));
  }

  // 自动续播不搜歌：绑定的人按「红心 4 : 推荐 4 : 新歌 2」混着来（见 mix.js），没绑定的从榜单里的免费歌挑（都是已知 id，只问直链）
  async function autoSongs(m, memory, cookie, smooth) {
    const level = qualityFor(memory, cookie, smooth);
    const playById = (song, options) => ncm.playById(song, options);
    let picked;
    if (cookie) {
      // 红心抽样一天换一次（也补上封面）
      const stale = !memory.taste?.likes?.length || !(now() - (memory.taste.at || 0) < 24 * 3600_000);
      if (stale && memory.account?.uid) {
        const taste = await ncm.taste(cookie, memory.account.uid, { memberId: m.id }).catch(() => null);
        if (taste) memory.taste = { ...taste, at: now() };
      }
      picked = await mixer.pick(m, memory, cookie, { level, playById });
    } else {
      const pool = await ncm.freeChart(freeChartId, { memberId: m.id });
      const recent = new Set((memory.recent || []).map(songKey));
      let fresh = pool.filter((s) => !recent.has(songKey(s)));
      if (!fresh.length) fresh = pool;
      picked = [];
      for (const cand of shuffle(fresh).slice(0, 4)) {
        if (picked.length >= 2) break;
        let song;
        try {
          song = await playById(cand, { cookie, memberId: m.id, level });
        } catch (error) {
          if (error instanceof NcmBusyError && picked.length) break;
          throw error;
        }
        if (song.playable) picked.push(song);
      }
    }
    for (const song of picked) media.remember(m.id, level, song);
    const songs = picked.map(songView);
    let notice = '';
    if (!songs.length) {
      notice = cookie ? '红心和推荐里这几首暂时放不了，说说想听什么？'
        : ncm.borrowsOwner ? '榜单里这几首暂时放不了，说说想听什么？' : '这会儿没有能放的免费歌，扫码绑定网易云后能放更多。';
    }
    return { songs, notice };
  }

  app.post('/api/chat', auth, async (req, res) => {
    const m = req.member;
    const text = String(req.body?.text || '').trim().slice(0, 200);
    const auto = !text;
    const drive = req.body?.drive === true; // 驾驶模式：DJ 只说一句
    const smooth = req.body?.smooth === true; // 这次打开网页卡过，降到 320k
    const cookie = members.getCookie(m.id);
    // 盒子出口匿名搜索一律 405，会连累主实例：没有默认音源（没配 NCM_SHARED_URL）时，没绑定的不开放点歌，也不扣次数
    if (!auto && !cookie && !ncm.borrowsOwner) {
      return res.json({ say: '', songs: [], notice: '绑定网易云后才能点歌（右上角菜单里扫码）。不绑定也能按播放，听榜单里的免费歌。', intent: 'chat', remaining: null, needBind: true });
    }
    if (!auto && brain.gate.full) return res.status(503).json({ error: 'busy', message: '排队的人有点多，稍后再试' });
    try {
      const quota = await hub.consume(m.id, auto ? 'song' : 'chat');
      const memory = members.memory(m.id);
      if (auto) {
        const picked = await autoSongs(m, memory, cookie, smooth);
        // 选歌要好几秒，期间「开始放」可能记了最近听过：只合并这里改过的字段，别拿旧快照整份覆盖
        const { taste, deck, rec, simi, fresh, freshTried } = memory;
        members.saveMemory(m.id, { ...members.memory(m.id), taste, deck, rec, simi, fresh, freshTried });
        // 每批第一首报个幕（模板，不叫大脑）；老板那边不闲就只出字
        const first = picked.songs[0];
        if (first) {
          first.say = introLine(first);
          first.voice = voice.request(m.id, first.say);
        }
        return res.json({ say: '', songs: withLiked(memory, picked.songs), notice: picked.notice, intent: 'recommend', remaining: quota.remaining, degraded: false });
      }
      let reply;
      let degraded = false;
      try {
        reply = await brain.ask({ text, auto, memory, bound: true, drive, hour: new Date(now() + 8 * 3600_000).getUTCHours() });
      } catch (error) {
        if (error?.queueFull) throw error;
        degraded = true;
        log('brain-degraded', m.id, error.code || error.name);
        reply = { say: '', intent: 'recommend', play: await fallbackCandidates(text, { ...memory, cookie, memberId: m.id }), memoryCandidates: [] };
      }
      let picked = { songs: [], notice: '' };
      if (reply.intent === 'recommend') picked = await pickSongs(reply.play, { cookie, memberId: m.id, bound: true, level: qualityFor(memory, cookie, smooth) });
      // 推荐了但一首都放不了，就别让 DJ 说「来了」，只给提示
      const nothing = reply.intent === 'recommend' && !picked.songs.length;
      const fullSay = nothing ? '' : (degraded ? 'DJ 这会儿有点忙，先按你说的直接找了两首。' : reply.say);
      const say = drive ? oneSentence(fullSay) : fullSay;
      const turns = [...(memory.turns || []), { role: 'user', text }];
      if (say) turns.push({ role: 'dj', text: say });
      const prefs = [...(memory.prefs || [])];
      for (const p of reply.memoryCandidates) if (!prefs.includes(p)) prefs.push(p);
      members.saveMemory(m.id, { ...members.memory(m.id), turns, prefs });
      const voiceId = say && !degraded ? voice.request(m.id, say) : '';
      res.json({ say, voice: voiceId, songs: withLiked(memory, picked.songs), notice: picked.notice, intent: reply.intent, remaining: quota.remaining, degraded });
    } catch (error) { sendError(res, error); }
  });

  app.post('/api/play/started', auth, (req, res) => {
    const title = String(req.body?.title || '').slice(0, 80);
    const artist = String(req.body?.artist || '').slice(0, 80);
    const id = parseSongId(req.body?.id);
    const cover = safeCover(req.body?.cover);
    if (title) {
      const mem = members.memory(req.member.id);
      // 最近听过：同一首放到最前，最多 100 首（members.js 截）
      const history = id ? [{ id, title, artist, cover, at: now() }, ...(mem.history || []).filter((s) => s.id !== id)] : mem.history;
      members.saveMemory(req.member.id, { ...mem, recent: [...(mem.recent || []), { id, title, artist }], history });
    }
    res.json({ ok: true });
  });

  // 红心：绑定了就同步到 TA 网易云「我喜欢的音乐」，没绑定只记在这里

  app.get('/api/history', auth, (req, res) => {
    const mem = members.memory(req.member.id);
    res.json({ songs: (mem.history || []).map((s) => ({ ...s, liked: hearted(mem, s.id) })) });
  });

  app.post('/api/fav', auth, async (req, res) => {
    const id = parseSongId(req.body?.id);
    if (!id) return res.status(400).json({ error: 'invalid' });
    const on = req.body?.on !== false;
    const mid = req.member.id;
    const cookie = members.getCookie(mid);
    try {
      // 备用音源的歌在网易云里没有，红心只记在这里
      const synced = Boolean(cookie) && typeof id === 'number';
      if (synced && !(await ncm.like(cookie, id, on, { memberId: mid }))) {
        return res.status(502).json({ error: 'ncm', message: '网易云没收下，稍后再试' });
      }
      const mem = members.memory(mid);
      const hearts = (mem.hearts || []).filter((x) => x !== id);
      if (on) hearts.unshift(id);
      let taste = mem.taste;
      if (taste) {
        const likeIds = (taste.likeIds || []).filter((x) => x !== id);
        if (on) likeIds.unshift(id);
        const song = { id, title: String(req.body?.title || '').slice(0, 80), artist: String(req.body?.artist || '').slice(0, 80), cover: safeCover(req.body?.cover) };
        const likes = (taste.likes || []).filter((s) => s.id !== id);
        if (on && song.title) likes.unshift(song);
        taste = { ...taste, likeIds, likes };
      }
      members.saveMemory(mid, { ...mem, hearts: hearts.slice(0, 500), taste });
      res.json({ ok: true, liked: on, synced });
    } catch (error) { sendError(res, error); }
  });

  // 从「最近听过」点回去放；直链过期重取（fresh=1）；卡顿后要 320k（q=exhigh）
  app.get('/api/song/:id', auth, async (req, res) => {
    const id = String(req.params.id);
    if (!SONG_ID.test(id)) return res.status(400).json({ error: 'invalid' });
    try {
      const info = await media.meta(req.member.id, parseSongId(id), { smooth: req.query.q === 'exhigh', fresh: req.query.fresh === '1' });
      if (!info) return res.status(404).json({ error: 'gone', message: '这首现在放不了了' });
      const { url: cdn, ...rest } = info;
      res.json({ id: parseSongId(id), url: `/media/${id}`, ...rest, ...(directUrl(cdn) ? { direct: directUrl(cdn) } : {}) });
    } catch (error) { sendError(res, error); }
  });

  // 口播（见 voice.js）：念好了给 mp3，不念（老板那边不闲 / 失败 / 过期）回 204，网页直接放歌
  app.get('/api/voice/:id', auth, async (req, res) => {
    const audio = await voice.get(req.member.id, req.params.id);
    if (!audio) return res.status(204).end();
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, no-store' }).send(audio);
  });

  // 音频一律经同源代理（见 media.js）
  app.get('/media/:id', auth, (req, res) => media.handle(req, res));

  app.get('/api/lyric', auth, async (req, res) => {
    const id = String(req.query.id || '');
    if (!SONG_ID.test(id)) return res.status(400).json({ error: 'invalid' });
    try { res.json({ lrc: await ncm.lyric(id, { memberId: req.member.id }) }); } catch (error) { sendError(res, error); }
  });

  // ---- 网易云扫码绑定 ----
  app.post('/api/ncm/qr', auth, async (req, res) => {
    try {
      const out = await ncm.qrStart({ memberId: req.member.id });
      qrKeys.set(req.member.id, { key: out.key, at: now() });
      res.json({ img: out.img });
    } catch (error) { sendError(res, error); }
  });

  app.get('/api/ncm/qr/status', auth, async (req, res) => {
    const mid = req.member.id;
    const pending = qrKeys.get(mid);
    if (!pending || now() - pending.at > 5 * 60_000) return res.json({ code: 800, message: '二维码过期了' });
    try {
      const out = await ncm.qrCheck(pending.key, { memberId: mid });
      if (out.code !== 803) return res.json({ code: out.code, message: out.message });
      qrKeys.delete(mid);
      members.setCookie(mid, out.cookie);
      const account = await ncm.account(out.cookie, { memberId: mid }).catch(() => null);
      const taste = account ? await ncm.taste(out.cookie, account.uid, { memberId: mid }).catch(() => null) : null;
      const mem = members.memory(mid);
      members.saveMemory(mid, { ...mem, account, taste });
      hub.report({ [mid]: { bound: true } }).catch(() => {});
      log('ncm-bound', mid);
      res.json({ code: 803, nickname: account?.nickname || '', vip: Boolean(account?.vip), likes: taste?.likeCount || 0 });
    } catch (error) { sendError(res, error); }
  });

  app.post('/api/ncm/unbind', auth, (req, res) => {
    members.unbind(req.member.id);
    hub.report({ [req.member.id]: { bound: false } }).catch(() => {});
    log('ncm-unbound', req.member.id);
    res.json({ ok: true });
  });

  app.post('/api/memory/clear', auth, (req, res) => {
    const { quality } = members.memory(req.member.id);
    members.clearMemory(req.member.id);
    if (quality) members.saveMemory(req.member.id, { ...members.memory(req.member.id), quality }); // 音质是设置，不算记忆
    res.json({ ok: true });
  });

  // 账号面板的音质：流畅（320k）/ 无损（CD），记在这个人的记忆里，换设备也算
  app.post('/api/quality', auth, (req, res) => {
    const quality = req.body?.quality === 'smooth' ? 'smooth' : 'lossless';
    members.saveMemory(req.member.id, { ...members.memory(req.member.id), quality });
    res.json({ ok: true, quality });
  });

  // ---- 页面 ----
  app.use(express.static(webRoot, { index: 'index.html', maxAge: '5m' }));
  app.get('/join', (req, res) => res.sendFile(path.join(webRoot, 'index.html')));
  app.get('/apply', (req, res) => res.sendFile(path.join(webRoot, 'apply.html')));
  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((req, res) => res.status(404).send('not found'));

  return { app, listeners };
}

// 定时跟 hub 对一次：停用 / 到期 / 删除的人，本地数据整块删；顺手报一下谁绑了网易云
export async function syncWithHub({ hub, members, log = () => {} }) {
  const { members: states } = await hub.states();
  const removed = members.sweep(states);
  for (const id of removed) log('purged', id);
  const items = Object.fromEntries(members.ids().map((id) => [id, { bound: members.bound(id) }]));
  if (Object.keys(items).length) await hub.report(items);
  return removed;
}

export function randomVaultKey() {
  return crypto.randomBytes(32).toString('hex');
}
