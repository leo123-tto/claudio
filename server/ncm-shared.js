// 盒子上的几个 Claudio（老板的、公用版）共用一个出口 IP，网易云按搜索总数限流，所以名额合在一起算。
// 老板的实例开一个只听本机的小服务管名额（NCM_SHARED_SERVE=127.0.0.1:8099），别的实例搜索前来要
// （NCM_SHARED_URL=http://127.0.0.1:8099）。服务不在（老板实例重启）就按自己的每分钟上限照常搜。
// 不放在 8090：那个端口经 Tailscale serve 对 tailnet 开着。
import http from 'node:http';

const MAX_BODY = 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function parseAddress(value) {
  const match = /^(?:\[?([^\]]*)\]?:)?(\d+)$/.exec(String(value).trim());
  if (!match) throw new Error(`NCM_SHARED_SERVE 格式不对：${value}`);
  return { host: match[1] || '127.0.0.1', port: Number(match[2]) };
}

// grant(kind) → { ok } | { ok:false, retryMs } | { ok:false, coolingMs }；cool(ms) 记下别的实例碰到的 405。
// tts(text) → mp3 Buffer | null：公用版要一句短口播（≤25 字），老板这边不闲就 null，回 409 让它跳过。
export const GUEST_TTS_MAX = 25;
// guest：公用版借老板网易云取链接（{ search, songUrl, find, lyric }，见 ncm.js 的 guest* 函数）。
// 只搜、只取链接；老板的 cookie 不出老板实例，回给公用版的只有歌的信息和直链。
const SONG_ID = /^(\d{1,15}|[a-z]{2,4}\d{1,20})$/;
const LEVELS = new Set(['standard', 'higher', 'exhigh', 'lossless', 'hires']);
const GUEST_URLS_PER_MIN = 40;
function guestSong(body) {
  return {
    ncmId: /^\d{1,15}$/.test(String(body.ncmId ?? body.id ?? '')) ? String(body.ncmId ?? body.id) : '',
    title: String(body.title || '').slice(0, 80),
    artist: String(body.artist || '').slice(0, 80),
    duration: Math.max(0, Math.min(3600, Number(body.duration) || 0)),
  };
}
async function handleGuest(guest, route, body, reply, { urlTimes }) {
  const level = LEVELS.has(body.level) ? body.level : 'exhigh';
  try {
    if (route === '/guest/search') {
      const keywords = String(body.keywords || '').trim().slice(0, 100);
      if (!keywords) return reply(400, { ok: false });
      return reply(200, { ok: true, songs: await guest.search(keywords, Math.max(1, Math.min(12, Number(body.limit) || 8))) });
    }
    if (route === '/guest/song-url') {
      const id = String(body.id || '');
      if (!SONG_ID.test(id)) return reply(400, { ok: false });
      const now = Date.now();
      while (urlTimes.length && urlTimes[0] <= now - 60_000) urlTimes.shift();
      if (urlTimes.length >= GUEST_URLS_PER_MIN) return reply(503, { ok: false, busy: true });
      urlTimes.push(now);
      return reply(200, { ok: true, audio: await guest.songUrl({ id, level, ...guestSong(body) }) });
    }
    if (route === '/guest/find') {
      const song = guestSong(body);
      if (!song.title) return reply(400, { ok: false });
      return reply(200, { ok: true, song: await guest.find(song, { level }) });
    }
    if (route === '/guest/lyric') {
      const id = String(body.id || '');
      if (!SONG_ID.test(id)) return reply(400, { ok: false });
      return reply(200, { ok: true, lrc: await guest.lyric(id) });
    }
  } catch (error) {
    const busy = ['NCM_BUSY', 'NCM_RATE_LIMITED', 'SOURCE_BUSY'].includes(error?.code);
    return reply(busy ? 503 : 502, { ok: false, busy });
  }
  return reply(404, { ok: false });
}

export function startSlotServer(address, { grant, cool, tts = null, guest = null }) {
  const urlTimes = [];
  const { host, port } = parseAddress(address);
  const server = http.createServer((req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (!LOOPBACK.has(req.socket.remoteAddress) || req.method !== 'POST') return reply(403, { ok: false });
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; if (raw.length > MAX_BODY) req.destroy(); });
    req.on('end', () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { return reply(400, { ok: false }); }
      if (req.url === '/slot') return reply(200, grant(body.kind === 'chat' ? 'chat' : 'background'));
      if (req.url === '/cooldown') { cool(Number(body.ms)); return reply(200, { ok: true }); }
      if (guest && req.url.startsWith('/guest/')) return handleGuest(guest, req.url, body, reply, { urlTimes });
      if (req.url === '/tts' && tts) {
        const text = String(body.text || '').trim();
        if (!text || [...text].length > GUEST_TTS_MAX) return reply(400, { ok: false });
        return Promise.resolve(tts(text)).catch(() => null).then((audio) => {
          if (!audio?.length) return reply(409, { ok: false, skip: true });
          res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length });
          res.end(audio);
        });
      }
      return reply(404, { ok: false });
    });
  });
  server.on('error', (error) => console.warn('[ncm-shared]', error.message));
  server.listen(port, host);
  server.unref();
  return server;
}

async function post(url, path, body, signal) {
  const timeout = AbortSignal.timeout(800);
  const res = await fetch(new URL(path, url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) throw new Error(`ncm-shared ${path} -> ${res.status}`);
  return res.json();
}

let warned = false;
function unreachable(error, signal) {
  signal?.throwIfAborted();
  if (!warned) { warned = true; console.warn('[ncm-shared] 名额服务不通，按本实例上限搜：', error.message); }
  return null;
}

// 返回服务的答复；服务不通返回 null（调用方照常搜）。
export async function requestSlot(url, kind, signal) {
  try {
    const answer = await post(url, '/slot', { kind }, signal);
    warned = false;
    return answer;
  } catch (error) {
    return unreachable(error, signal);
  }
}

export function reportCooldown(url, ms) {
  post(url, '/cooldown', { ms }).catch((error) => unreachable(error));
}

// 公用版这边：经老板实例借网易云登录态 / 找备用音源。服务不通或老板那边忙都抛 code=NCM_BUSY，调用方当「排队中」处理。
export function createOwnerChannel(url, { fetchFn = fetch } = {}) {
  async function ask(path, body, timeout, signal) {
    const timed = AbortSignal.timeout(timeout);
    let res;
    try {
      res = await fetchFn(new URL(path, url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timed]) : timed,
      });
    } catch (error) {
      signal?.throwIfAborted();
      throw Object.assign(new Error('老板实例连不上'), { code: 'NCM_BUSY', cause: error });
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 503 || data.busy) throw Object.assign(new Error('排队中，稍后再试'), { code: 'NCM_BUSY' });
    if (!res.ok || !data.ok) throw new Error(`owner ${path} -> ${res.status}`);
    return data;
  }
  return {
    async search(keywords, limit = 8, { signal } = {}) { return (await ask('/guest/search', { keywords, limit }, 12_000, signal)).songs || []; },
    async songUrl(song, { signal } = {}) { return (await ask('/guest/song-url', song, 25_000, signal)).audio || null; },
    async find(song, { signal } = {}) { return (await ask('/guest/find', song, 25_000, signal)).song || null; },
    async lyric(id, { signal } = {}) { return (await ask('/guest/lyric', { id }, 6_000, signal)).lrc || ''; },
  };
}
