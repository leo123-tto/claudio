// 家里小智点歌：只解析歌名并通知已经打开的播放器。
// 不在这里出声，也不再打一遍 DJ 模型。
import { randomUUID } from 'node:crypto';

const DEFAULT_ALLOW = Object.freeze([
  '127.0.0.1',
  '::1',
]);
// 家里其他设备（如小智开发板）的地址写 .env 的 REMOTE_ALLOW，逗号分隔。

export const REMOTE_ACTIONS = new Set([
  'pause',
  'resume',
  'next',
  'previous',
  'stop',
  'move',
  'volume_up',
  'volume_down',
  'volume_set',
]);

export function normalizeIp(ip = '') {
  const text = String(ip || '').trim().toLowerCase();
  return text.startsWith('::ffff:') ? text.slice('::ffff:'.length) : text;
}

export function remoteCallerAllowed(ip, extra = []) {
  const clean = normalizeIp(ip);
  return [...DEFAULT_ALLOW, ...extra].some((item) => normalizeIp(item) === clean);
}

// 空字符串表示「没指定歌」，交给播放器放已经备好的下一期。
const BOARD_TARGET = /开发板|这块板|板子|小喇叭|^board$/i;

export function isBoardTarget(where = '') {
  return BOARD_TARGET.test(String(where || '').trim());
}

export function chooseOutput(items = [], where = '') {
  const text = String(where || '').trim();
  if (!text) return { ok: false, status: 400, error: '要说放到哪：客厅的 A9、卧室，或者开发板' };
  if (isBoardTarget(text)) return { ok: true, target: 'board' };

  const rules = [
    {
      test: /a9|b&o|beo|bang|客厅音箱/i,
      match: (item) => /beoplay a9/i.test(`${item.deviceName || ''} ${item.name || ''}`),
      missing: '客厅的 B&O A9 现在不在网上',
    },
    {
      test: /卧室|homepod|home pod/i,
      match: (item) => /卧室/.test(`${item.deviceName || ''} ${item.name || ''}`),
      missing: '卧室的 HomePod 现在不在网上',
    },
    {
      test: /客厅电视|apple tv|苹果电视/i,
      match: (item) => /客厅/.test(`${item.deviceName || ''} ${item.name || ''}`),
      missing: '客厅那台 Apple TV 现在不在网上',
    },
    {
      test: /^客厅$/,
      match: (item) => /beoplay a9/i.test(`${item.deviceName || ''} ${item.name || ''}`),
      missing: '客厅的 B&O A9 现在不在网上',
    },
  ];
  for (const rule of rules) {
    if (!rule.test.test(text)) continue;
    const item = items.find(rule.match);
    if (!item) return { ok: false, status: 404, error: rule.missing };
    return { ok: true, target: 'room', outputId: item.id, name: item.deviceName || item.name };
  }

  const folded = text.toLowerCase();
  const item = items.find((entry) => {
    const name = `${entry.alias || ''} ${entry.deviceName || ''} ${entry.name || ''}`.toLowerCase();
    return name.includes(folded);
  });
  if (!item) return { ok: false, status: 404, error: '没找到这只音箱' };
  return { ok: true, target: 'room', outputId: item.id, name: item.deviceName || item.name };
}

const LIBRARY_GENRES = Object.freeze([
  '流行', '摇滚', '民谣', '说唱', '嘻哈', '电子', '爵士', '古风', '轻音乐', '蓝调', '乡村', '金属', '华语', '粤语',
]);

export function libraryRequest(input = '') {
  const raw = String(input || '').trim();
  const genre = LIBRARY_GENRES.find((item) => raw.toLowerCase().includes(item.toLowerCase())) || '';
  if (!raw || /推荐|随机|随便|来一首|random|曲库/i.test(raw)) {
    return { recommend: true, genre };
  }
  const query = cleanMusicQuery(raw);
  if (!query) return { recommend: true, genre };
  return { recommend: false, query, genre: '' };
}

export function djUserInput(raw = '') {
  const text = String(raw || '').trim();
  if (!libraryRequest(text).recommend) return null;
  if (!text || /^(?:你)?(?:给我)?(?:推荐一首|推荐|来一首|来首歌|随机|随便|放歌|放首歌|放一首歌|播放音乐|放音乐)$/i.test(text)) {
    return '';
  }
  return text;
}

export function shortenSay(text, limit = 45) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  const slice = clean.slice(0, limit);
  let cut = -1;
  for (const mark of ['。', '，', '；', '！', '？']) {
    cut = Math.max(cut, slice.lastIndexOf(mark));
  }
  return cut >= 12 ? slice.slice(0, cut + 1) : slice;
}

export function lyricLines(raw, count = 2) {
  return String(raw || '')
    .split('\n')
    .map((line) => line.replace(/\[[^\]]*\]/g, '').trim())
    .filter((line) => line && !/^(作词|作曲|编曲|制作人)/.test(line))
    .slice(0, count);
}

export function episodeTrack(episode) {
  const song = (episode?.queue || []).find((item) => item?.type === 'song' && item.url);
  if (!song) return null;
  return {
    say: String(episode.say || '').replace(/\s+/g, ' ').trim(),
    title: song.meta?.title || '',
    artist: song.meta?.artist || '',
    genre: song.meta?.genre || '',
    id: song.meta?.id || song.id || '',
    lyric: song.meta?.lyric || '',
    url: song.meta?.remoteUrl || song.url,
  };
}

export function pickLibrarySong(songs = [], { genre = '', random = Math.random } = {}) {
  const pool = songs.filter((song) => song?.title && song?.artist);
  if (!pool.length) return null;
  const matched = genre
    ? pool.filter((song) => String(song.genre || '').toLowerCase().includes(genre.toLowerCase()))
    : [];
  const choices = matched.length ? matched : pool;
  const index = Math.min(choices.length - 1, Math.max(0, Math.floor(Number(random()) * choices.length) || 0));
  return choices[index];
}

export function cleanMusicQuery(input = '') {
  const text = String(input).trim().replace(/[。！!？?，,；;]+$/g, '').trim();
  if (!text || /^(?:random|随机|随便|来一首|放首歌|放一首歌|放歌|播放音乐|放音乐|来首歌)$/i.test(text)) {
    return '';
  }
  return text
    .replace(/^(?:请|麻烦|帮我|给我)?(?:播放|放|来|播)(?:一首|首|点)?(?:音乐|歌)?/, '')
    .trim();
}

export function songEpisode(song, { epoch = 0 } = {}) {
  return {
    id: randomUUID(), epoch, voice: { status: 'skipped' },
    intent: 'play',
    say: '',
    queue: [{
      type: 'song',
      url: song.url,
      meta: {
        id: song.id || '', remoteUrl: song.url,
        title: song.title || '',
        artist: song.artist || '',
        lyric: song.lyric || '',
        ...(song.year ? { year: song.year } : {}),
        ...(song.genre ? { genre: song.genre } : {}),
      },
    }],
  };
}

export async function resolvePlayRequest(input, { resolve, epoch = 0 }) {
  const query = cleanMusicQuery(input);
  if (!query) return { ok: true, mode: 'next' };
  const song = await resolve({ title: query, artist: '' });
  if (!song?.playable || !song.url) {
    const busy = /405|操作频繁|busy/.test(String(song?.error || ''));
    return {
      ok: false,
      status: busy ? 429 : 404,
      error: busy ? '网易云这会儿太忙，等一会儿再点' : '没找到能放的版本',
    };
  }
  return { ok: true, mode: 'track', song, episode: songEpisode(song, { epoch }) };
}

export function normalizeControl(body = {}) {
  const action = String(body.action || '').trim();
  if (!REMOTE_ACTIONS.has(action)) return { ok: false, status: 400, error: '不认识这个操作' };
  const actionValue = action === 'volume_set'
    ? Math.max(0, Math.min(100, Number(body.value) || 0))
    : 0;
  return { ok: true, control: { action, actionValue } };
}

export function createAckWaiter(timeoutMs = 4000) {
  const waits = new Map();
  return {
    expect(id) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waits.delete(id);
          resolve({ ok: false, error: '播放器没有回应' });
        }, timeoutMs);
        waits.set(id, { resolve, timer });
      });
    },
    receive(message = {}) {
      const wait = waits.get(message.id);
      if (!wait) return false;
      clearTimeout(wait.timer);
      waits.delete(message.id);
      wait.resolve({ ok: Boolean(message.ok), error: String(message.error || '') });
      return true;
    },
  };
}
