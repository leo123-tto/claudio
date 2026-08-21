// Claudio server 入口：Express + WS。
// router → context → llm → (ncm | tts) 串成可播节目；预生成下一期掩盖模型 / Fish 延迟。
// 架构：前端（浏览器 / Tauri 窗）用 <audio> 播放，后端只当大脑 + API（不在后台出声）。
import http from 'node:http';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';

import { config } from './config.js';
import { route } from './router.js';
import { buildPromptBundle } from './context.js';
import {
  plan as llmPlan,
  callLlmStream,
  testCurrentModel,
  extractSayValue,
  extractJson,
  normalizeResult,
} from './llm/index.js';
import { getSettings, updateSettings, toPublicSettings } from './settings.js';
import { credentialStatus, getSecret, updateSecrets } from './secrets.js';
import { grokAuth } from './grok-auth.js';
import { assertAllowedOpenUrl, openSystemBrowser } from './open-url.js';
import * as ncm from './ncm.js';
import { synthesize } from './tts/index.js';
import { liveTtsManager, prepareLiveTts } from './tts/live.js';
import { testConnection as testFishConnection } from './tts/fish.js';
import * as state from './state.js';
import { startWeather, getCached as getWeather } from './weather.js';
import { startScheduler } from './scheduler.js';
import { appendMemory, readMemory } from './memory.js';
import { filterCandidates, rankCandidates } from './recommendation.js';
import { ensureDiscoveryPool } from './discovery.js';
import { episodeCandidates } from './episode-candidates.js';
import { createFavoritesStore } from './favorites.js';
import {
  currentProfile,
  inferExplicitFeedback,
  logEvent,
} from './events.js';
import { watchParentFromEnv } from './parent-watch.js';

watchParentFromEnv();

const app = express();
app.use(express.json());
// 前端：html/js/css 一律 no-store，避免 Tauri WKWebView 吃旧缓存导致"改了不生效"（本地应用、文件很小，重取无压力）
app.use(express.static(config.paths.web, {
  setHeaders: (res, p) => { if (/\.(html|js|css)$/.test(p)) res.setHeader('Cache-Control', 'no-store'); },
}));
app.use('/tts', express.static(config.paths.cacheTts)); // 合成的语音

const favoritesStore = createFavoritesStore({
  file: path.join(config.paths.user, 'favorites.md'),
  fetchPlaylistTracks: ncm.playlistTracks,
});

// ── 节目状态（内存）──
let currentEpisode = null;
let nextEpisode = null; // 预生成的下一期（buffer）
let generating = false; // 生成锁：一次只生成一期，避免后台重复生成

function commandAvailable(command) {
  if (!command) return false;
  const candidates = command.includes('/')
    ? [command]
    : String(process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, command));
  return candidates.some((candidate) => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; }
  });
}

function providerAvailability() {
  return {
    codex: commandAvailable('codex'),
    claude: commandAvailable(config.claude.bin),
    deepseek: Boolean(getSecret('deepseekApiKey')),
    grok: grokAuth.isLoggedIn(),
  };
}

function publicSettings(settings = getSettings()) {
  return toPublicSettings(settings, providerAvailability(), {
    ...credentialStatus(),
    grok: grokAuth.isLoggedIn(),
  }, {
    grok: grokAuth.publicStatus(),
  });
}

// 把规整后的 result {say, play[], reason, memory} 变成可播节目：合成口播 + 解析直链 + 取词 + 组队列 + 落库。
// buildEpisode（预生成/自动期）与 buildEpisodeStream（用户说话现生成）共用这段尾巴，杜绝两处漂移。
async function finalizeEpisode(result, {
  userInput = '',
  recommendation = {},
  sayTtsOverride = null,
} = {}) {
  const t1 = Date.now();
  // 只有推荐意图才能取发现池兜底；聊天 / 控制即使模型或候选池里有歌，也绝不切歌。
  const filtered = filterCandidates(episodeCandidates(result, recommendation.poolSongs), recommendation);
  const ranked = rankCandidates(filtered, recommendation).slice(0, 6);
  // 合成开场口播 say（不做 segue 过渡，省 Fish 额度）+ 逐首解析直链，并行
  const [sayTts, resolved] = await Promise.all([
    sayTtsOverride || synthesize(result.say),
    Promise.all(ranked.map(async (candidate) => ({
      candidate,
      resolved: await ncm.resolve(candidate),
    }))),
  ]);
  const songs = resolved
    .filter(({ resolved: song }) => song.playable)
    .slice(0, 2)
    .map(({ candidate, resolved: song }) => ({ ...song, candidate }));
  // 给可播歌并行取歌词（拿不到不影响播放）
  await Promise.all(
    songs.map(async (song) => { song.lyric = song.id ? await ncm.lyric(song.id).catch(() => '') : ''; }),
  );
  console.log(`[episode] tts+resolve=${Date.now() - t1}ms`);

  const queue = [{ type: 'tts', url: sayTts.url, text: result.say }];
  for (const song of songs) {
    queue.push({
      type: 'song',
      url: song.url,
      meta: {
        title: song.title,
        artist: song.artist,
        lyric: song.lyric || '',
        discoveryType: song.candidate.discoveryType || 'adjacent',
        bridgeFrom: song.candidate.bridgeFrom || '',
      },
    });
  }
  for (const item of resolved.filter(({ resolved: song }) => !song.playable)) {
    console.warn(`[ncm] 拿不到直链，跳过：${item.candidate.title} — ${item.candidate.artist}`);
  }
  if (userInput) state.addMessage('user', userInput);
  state.addMessage('claudio', result.say);
  if (recommendation.fingerprint && songs.length) {
    logEvent({ type: 'recommendation', fingerprint: recommendation.fingerprint, source: recommendation.mode });
  }
  // 模型推断只落到候选层；同一事实至少有两次独立用户证据后，才同步进人工可编辑的旧记忆文件。
  if (userInput && result.memoryCandidates?.length) {
    const evidenceId = `message-${Date.now()}`;
    for (const item of result.memoryCandidates) {
      logEvent({
        type: 'memory_inferred',
        key: item.key,
        value: item.value,
        evidenceId,
        source: 'llm',
      });
    }
    for (const item of currentProfile().memories.stable) appendMemory(item.value);
  }

  return {
    id: Date.now(),
    say: result.say,
    intent: result.intent,
    action: result.action,
    actionValue: result.actionValue,
    reason: result.reason,
    queue,
  };
}

// 非流式：一次拿完整规整结果，再组节目（预生成 / 自动开一期用）
async function buildEpisode({ userInput = '', mood = '', sleep = null, nowPlaying = null } = {}) {
  const t0 = Date.now();
  const bundle = buildPromptBundle({ userInput, mood, sleep, nowPlaying });
  const result = await llmPlan(bundle.prompt);
  console.log(`[episode] llm=${Date.now() - t0}ms`);
  return finalizeEpisode(result, { userInput, recommendation: bundle.recommendation });
}

// 流式版：模型边生成，say 一闭合就先启动 Fish 流并回调（onSayReady → WS 先念），
// 整段完成后再走 finalizeEpisode。用于用户说话的现生成，削掉等待感。
async function buildEpisodeStream({ userInput = '', mood = '', sleep = null, nowPlaying = null } = {}, onSayReady) {
  const t0 = Date.now();
  const explicitFeedback = inferExplicitFeedback(userInput, nowPlaying);
  if (explicitFeedback) logEvent(explicitFeedback);
  const bundle = buildPromptBundle({ userInput, mood, sleep, nowPlaying });
  let sayFired = false;
  let earlySayTts = null;
  const raw = await callLlmStream(bundle.prompt, {
    timeout: 18000,
    onText: (text) => {
      if (sayFired) return;
      const say = extractSayValue(text);
      if (say) {
        sayFired = true;
        console.log(`[episode·stream] say=${Date.now() - t0}ms`);
        try {
          earlySayTts = prepareLiveTts(say, {
            onFirstByte: () => console.log(`[episode·stream] audio=${Date.now() - t0}ms`),
            onError: (error) => {
              console.error('[stream say]', error.message);
              broadcast({ kind: 'ttsError', error: error.message });
            },
          });
          onSayReady?.({ say, url: earlySayTts.url });
        } catch (error) {
          // 若管理员明确选择了非 Fish provider，就走该 provider 的完整合成；这里不做任何自动 provider 切换。
          synthesize(say)
            .then((tts) => { earlySayTts = tts; onSayReady?.({ say, url: tts.url }); })
            .catch((ttsError) => broadcast({ kind: 'ttsError', error: ttsError.message }));
        }
      }
    },
  });
  console.log(`[episode·stream] llm=${Date.now() - t0}ms`);
  const obj = extractJson(raw);
  if (!obj || typeof obj.say !== 'string') throw new Error(`流式解析失败：${String(raw).slice(0, 150)}`);
  const result = normalizeResult(obj);
  if (!earlySayTts && getSettings().tts.provider === 'fish') {
    earlySayTts = prepareLiveTts(result.say, {
      onFirstByte: () => console.log(`[episode·stream] audio=${Date.now() - t0}ms`),
      onError: (error) => broadcast({ kind: 'ttsError', error: error.message }),
    });
    onSayReady?.({ say: result.say, url: earlySayTts.url });
  }
  return finalizeEpisode(result, {
    userInput,
    recommendation: bundle.recommendation,
    sayTtsOverride: earlySayTts,
  });
}

// 后台预生成下一期（幂等）
async function ensureNext() {
  if (nextEpisode || generating) return;
  generating = true;
  try {
    nextEpisode = await buildEpisode({});
    console.log('[预生成] 下一期就绪');
    broadcast({ kind: 'nextReady' });
  } catch (e) {
    console.error('[预生成]', e.message);
  } finally {
    generating = false;
  }
}

// 取一期播放：优先用预生成的 buffer，否则现生成
async function takeEpisode() {
  let ep;
  if (nextEpisode) {
    ep = nextEpisode;
    nextEpisode = null;
  } else {
    if (generating) return null; // 正在预生成，让前端稍候重试
    generating = true;
    try {
      ep = await buildEpisode({});
    } finally {
      generating = false;
    }
  }
  currentEpisode = ep;
  broadcast({ kind: 'episode', episode: ep });
  setTimeout(ensureNext, 50); // 后台补 buffer
  return ep;
}

// 节律触发（默认关闭，SCHEDULER_ENABLED=1 才启用）：到点自动开一期，没人在听就跳过省额度。
async function onScheduled(reason) {
  if (clients.size === 0) return;
  if (generating) return;
  const moodMap = { 'morning-plan': '清晨，为新的一天挑几首', 'morning-show': '早间节目', 'hourly-mood': '' };
  generating = true;
  try {
    const ep = await buildEpisode({ mood: moodMap[reason] || '' });
    currentEpisode = ep;
    nextEpisode = null;
    broadcast({ kind: 'scheduled', reason, episode: ep });
    console.log(`[scheduler] ${reason} 已开播`);
  } catch (e) {
    console.error('[scheduler]', e.message);
  } finally {
    generating = false;
    setTimeout(ensureNext, 50); // 定时节目后也补 buffer，避免续播要现生成
  }
}

// 给 CLI / 状态查询：把一期压成精简清单（口播首句 + 曲目 title/artist），不含 url/歌词
const slimEp = (ep) => (ep ? {
  say: ep.say,
  tracks: ep.queue.filter((q) => q.type === 'song').map((q) => ({ title: q.meta.title, artist: q.meta.artist })),
} : null);

// ── HTTP 契约 ──
app.post('/api/chat', async (req, res) => {
  try {
    const { input = '', mood = '', sleep = null, nowPlaying = null } = req.body ?? {};
    const { userInput, control } = route(input);

    // 明确的本机播放指令无需等待大模型 / Fish：前端拿到动作后直接操作唯一播放层。
    // 较长或模糊的话仍交给模型做三分意图判断。
    if (control) {
      state.addMessage('user', userInput);
      state.addMessage('claudio', control.reply);
      return res.json({ ok: true, control, streamed: false });
    }

    if (userInput || sleep) {
      // 用户指定内容 → 现生成（个性化）。前台请求**不被后台预生成的 generating 锁挡住**——你说话立即响应、
      // 不用等后台那期跑完（之前会 429 让你干等）。前端 busy 锁防连点；前台/后台请求互不阻塞。
      const ep = await buildEpisodeStream({ userInput, mood, sleep, nowPlaying },
        ({ say, url }) => broadcast({ kind: 'sayReady', say, url }));
      currentEpisode = ep;
      broadcast({ kind: 'episode', episode: ep });
      setTimeout(ensureNext, 50);
      return res.json({ ok: true, episode: ep, streamed: true });
    }
    // 开始 / 自动 → 优先用预生成的
    const ep = await takeEpisode();
    if (!ep) return res.status(202).json({ ok: false, busy: true, error: '首期马上就好，请稍候…' });
    return res.json({ ok: true, episode: ep });
  } catch (e) {
    console.error('[/api/chat]', e);
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

// 音频代理：把网易云跨域直链转成同源流，让前端 WebAudio AnalyserNode 能做真频谱（跨域直链会被静音）。
// 透传 Range 以支持进度条 seek / 分段加载；只允许网易云音频域名，防开放代理(SSRF)。
function isAllowedAudio(u) {
  try { return /(^|\.)(126|netease)\.(net|com)$/.test(new URL(u).hostname); }
  catch { return false; }
}
// 只白名单初始 URL 不够：fetch 默认跟随重定向，可经开放重定向被导向内网。
// 这里手动跟随，每跳都用 isAllowedAudio 复验，限制跳数，从源头堵住 SSRF。
async function fetchAudio(url, { headers, signal }) {
  let cur = url;
  for (let i = 0; i <= 2; i++) {
    const up = await fetch(cur, { headers, signal, redirect: 'manual' });
    if (up.status >= 300 && up.status < 400 && up.headers.get('location')) {
      const next = new URL(up.headers.get('location'), cur).href;
      if (!isAllowedAudio(next)) throw new Error('redirect to disallowed host');
      cur = next;
      continue;
    }
    return up;
  }
  throw new Error('too many redirects');
}
app.get('/proxy', async (req, res) => {
  const target = req.query.url;
  if (typeof target !== 'string' || !isAllowedAudio(target)) return res.status(400).end('bad url');
  const ac = new AbortController();
  const onClose = () => ac.abort();
  req.on('close', onClose); // 客户端断开（切歌 / 关页）→ 中止上游，不挂连接占资源
  const timer = setTimeout(() => ac.abort(), 30000); // 上游 30s 无响应即放弃
  try {
    const headers = {};
    if (req.headers.range) headers.range = req.headers.range; // 透传 Range → 支持 seek
    const up = await fetchAudio(target, { headers, signal: ac.signal });
    res.status(up.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
      const v = up.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!up.body) return res.end();
    Readable.fromWeb(up.body).pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).end('proxy error');
    console.warn('[proxy]', e.message);
  } finally {
    clearTimeout(timer);
    req.off('close', onClose);
  }
});

app.get('/api/now', (_req, res) => res.json({ ok: true, episode: currentEpisode }));

app.get('/api/tts/stream/:id.mp3', async (req, res) => {
  await liveTtsManager.handle(String(req.params.id || ''), res);
});

app.get('/api/settings', (_req, res) => {
  res.json({ ok: true, settings: publicSettings() });
});

app.patch('/api/settings', (req, res) => {
  try {
    const settings = updateSettings(req.body ?? {});
    // 预生成节目可能来自旧模型 / 旧推荐模式，切换后丢弃并按新设置补一份。
    nextEpisode = null;
    setTimeout(ensureNext, 20);
    res.json({ ok: true, settings: publicSettings(settings) });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message ?? error) });
  }
});

app.patch('/api/settings/credentials', (req, res) => {
  try {
    updateSecrets(req.body ?? {});
    nextEpisode = null;
    res.json({ ok: true, settings: publicSettings() });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message ?? error) });
  }
});

app.get('/api/settings/grok', (_req, res) => {
  res.json({ ok: true, grok: grokAuth.publicStatus(), settings: publicSettings() });
});

app.post('/api/settings/grok/login', async (_req, res) => {
  try {
    const grok = await grokAuth.startLogin();
    res.json({ ok: true, grok, settings: publicSettings() });
  } catch (error) {
    res.status(503).json({ ok: false, error: String(error?.message ?? error) });
  }
});

app.post('/api/settings/grok/logout', (_req, res) => {
  try {
    const grok = grokAuth.logout();
    const settings = getSettings();
    if (settings.llm.provider === 'grok') nextEpisode = null;
    res.json({ ok: true, grok, settings: publicSettings() });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message ?? error) });
  }
});

app.post('/api/settings/test', async (_req, res) => {
  try {
    const timing = await testCurrentModel({ timeout: 15000 });
    res.json({ ok: true, timing });
  } catch (error) {
    res.status(503).json({ ok: false, error: String(error?.message ?? error) });
  }
});

app.post('/api/settings/test-fish', async (_req, res) => {
  try {
    const timing = await testFishConnection();
    const fileName = 'fish-settings-test.mp3';
    const file = path.join(config.paths.cacheTts, fileName);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, timing.audio);
    fs.renameSync(temp, file);
    const { audio: _audio, ...publicTiming } = timing;
    res.json({
      ok: true,
      timing: publicTiming,
      audioUrl: `/tts/${fileName}?v=${Date.now()}`,
    });
  } catch (error) {
    res.status(503).json({ ok: false, error: String(error?.message ?? error) });
  }
});

// Fish Audio 余额（给 CLI 启动显示；API key 只在后端用、不外泄）
app.get('/api/fish-credit', async (_req, res) => {
  const key = getSecret('fishApiKey');
  if (!key) return res.json({ ok: false, error: 'no-key' });
  try {
    const r = await fetch('https://api.fish.audio/wallet/self/api-credit', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.json({ ok: false, error: `fish ${r.status}` });
    const j = await r.json();
    res.json({ ok: true, credit: j.credit });
  } catch (e) { res.json({ ok: false, error: String(e?.message ?? e) }); }
});

// 用系统默认浏览器打开外部链接（Tauri 窗里前端 window.open 打不开 → 走这里）。
// 严格白名单 https 站点，避免 `open` 被当成任意命令 / 打开本地文件或 app。
app.get('/api/open', (req, res) => {
  try {
    const url = assertAllowedOpenUrl(req.query.url);
    openSystemBrowser(url);
    res.json({ ok: true });
  } catch (e) {
    const message = String(e?.message ?? e);
    res.status(message === 'url not allowed' ? 400 : 500).json({ ok: false, error: message });
  }
});

app.get('/api/weather', (_req, res) => res.json({ ok: true, weather: getWeather() }));

// 记忆：Claudio 慢慢记下的关于 ta 的事（人可读文档 user/memory.md 的内容）
app.get('/api/memory', (_req, res) => res.json({ ok: true, memory: readMemory(200) }));

app.get('/api/profile', (_req, res) => {
  const profile = currentProfile();
  res.json({
    ok: true,
    profile: {
      topArtists: profile.artists.slice(0, 12),
      topSongs: profile.songs.slice(0, 12),
      stableMemories: profile.memories.stable.slice(-20),
      pendingMemoryCount: profile.memories.pending.length,
    },
  });
});

app.get('/api/favorites', (_req, res) => {
  res.json({ ok: true, ...favoritesStore.summary() });
});

app.post('/api/favorites/import', async (req, res) => {
  try {
    const result = await favoritesStore.importPlaylist(req.body?.playlist);
    // 丢掉旧的预生成节目，让新口味从下一次推荐立即生效；发现池在后台重建，不拖慢界面。
    nextEpisode = null;
    ensureDiscoveryPool({ force: true }).catch((error) => console.warn('[discovery]', error.message));
    setTimeout(ensureNext, 20);
    console.log(`[口味曲库] 歌单 ${result.playlistId}：新增 ${result.added}，共 ${result.total} 首`);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message ?? error) });
  }
});

app.post('/api/events', (req, res) => {
  try {
    const event = logEvent(req.body ?? {});
    res.json({ ok: true, event: { id: event.id, type: event.type, at: event.at } });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message ?? error) });
  }
});

// 给 CLI / 健康检查：服务在线 + 首期是否预热好 + 天气
app.get('/api/status', (_req, res) => res.json({
  ok: true, nextReady: !!nextEpisode, generating, weather: getWeather(),
  next: slimEp(nextEpisode), current: slimEp(currentEpisode),
  llm: (() => {
    const settings = getSettings();
    return {
      provider: settings.llm.provider,
      model: settings.llm.models[settings.llm.provider],
      reasoningEffort: settings.llm.reasoningEffort,
    };
  })(),
  tts: {
    provider: getSettings().tts.provider,
    model: getSettings().tts.fish.model,
  },
  ncm: {
    base: config.ncm.base,
    level: config.ncm.level,
  },
}));

app.post('/api/fav', (req, res) => {
  const { title, artist } = req.body ?? {};
  if (!title) return res.status(400).json({ ok: false, error: 'no title' });
  const count = state.addFav({ title, artist });
  logEvent({ type: 'favorite', song: { title, artist }, source: 'button' });
  console.log(`[收藏] ${title} — ${artist}（共 ${count} 首，会沉淀进品味）`);
  res.json({ ok: true, count });
});

app.get('/api/next', async (_req, res) => {
  try {
    const ep = await takeEpisode();
    if (!ep) return res.status(202).json({ ok: false, busy: true, error: '下一期马上就好…' });
    res.json({ ok: true, episode: ep });
  } catch (e) {
    console.error('[/api/next]', e);
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

// 注：后端播放引擎（`/api/player/*` + server/player.js）已于 2026-06-07 移除——播放回到前端（浏览器/窗口用 <audio> 放歌）。
//     后端只当大脑 + API：聊天/选歌走 /api/chat，换歌走 /api/next。

// ── WS /stream：推 now-playing / 字幕 / 状态 ──
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/stream' });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ kind: 'hello', episode: currentEpisode, nextReady: !!nextEpisode }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const ws of clients) {
    try { ws.send(s); } catch { clients.delete(ws); }
  }
}

server.listen(config.port, () => {
  console.log(`🎙️  Claudio on http://localhost:${config.port}  (TTS=${getSettings().tts.provider}, NCM=${config.ncm.base})`);
  startWeather(); // 后台拉天气 + 每 30 分钟刷新（注入选歌 prompt）
  ensureDiscoveryPool().catch((error) => console.warn('[discovery]', error.message));
  ensureNext(); // 启动即预热第一期
  // 节律默认关闭（用户：只手动触发）；SCHEDULER_ENABLED=1 才开 07:00 规划 / 09:00 早间 / 整点情绪
  if (config.scheduler.enabled) {
    startScheduler({ onTrigger: onScheduled });
    console.log('[scheduler] 已启用');
  } else {
    console.log('[scheduler] 未启用（只手动触发；.env SCHEDULER_ENABLED=1 可开）');
  }
});

function shutdown(signal) {
  console.log(`[runtime] 收到 ${signal}，正在关闭 Claudio`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 1500).unref();
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
