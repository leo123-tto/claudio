// Claudio server 入口：Express + WS。
// router → context → llm → (ncm | tts) 串成可播节目；预生成下一期掩盖模型 / Fish 延迟。
// 架构：前端（浏览器）用 <audio> 播放，后端只当大脑 + API（不在后台出声）。
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';

import { config } from './config.js';
import { createEpisodeBuffer } from './episode-buffer.js';
import { correctSay } from './episode-coherence.js';
import { styleConstraints, matchesStyle, matchesResolvedStyle } from './style-request.js';
import { resolveEpisodeSongs, refreshEpisodeUrls } from './episode-audio.js';
import { audioCache } from './audio-cache.js';
import { createFillerService, fillerCandidates } from './filler.js';
import { currentScene, sceneStore } from './scene.js';
import { handoffStore } from './handoff.js';
import { route } from './router.js';
import { buildPromptBundle } from './context.js';
import {
  plan as llmPlan,
  callLlmStream,
  testCurrentModel,
  extractSayValue,
  extractClosedString,
  extractClosedPlayItems,
  extractJson,
  normalizeResult,
} from './llm/index.js';
import { getSettings, updateSettings, toPublicSettings } from './settings.js';
import { credentialStatus, getSecret, updateSecrets } from './secrets.js';
import * as ncm from './ncm.js';
import { synthesize } from './tts/index.js';
import { withAbort } from './tts/abort.js';
import { liveTtsManager, prepareLiveTts } from './tts/live.js';
import { testConnection as testFishConnection } from './tts/fish.js';
import {
  laneEvents as pc5090LaneEvents,
  testConnection as testPc5090Connection,
  warm as warmPc5090,
  getLaneStatus,
  probeLane as probeTtsLane,
  synthesizeIfIdle as synthesizeGuestLine,
} from './tts/pc5090.js';
import * as state from './state.js';
import { startWeather, getCached as getWeather } from './weather.js';
import { startScheduler } from './scheduler.js';
import { appendMemory, readMemory } from './memory.js';
import { filterCandidates, orderByPlayOrder, pickDiverse, rankCandidates, selectDiverseShortlist } from './recommendation.js';
import { ensureDiscoveryPool } from './discovery.js';
import { episodeCandidates } from './episode-candidates.js';
import { createFavoritesStore } from './favorites.js';
import { renderTasteDigest } from './taste-digest.js';
import {
  currentProfile,
  inferExplicitFeedback,
  logEvent,
  readEvents,
} from './events.js';
import { watchParentFromEnv } from './parent-watch.js';
import { listOutputs, selectOutput, openBluetoothSettings } from './audio-route-mac.js';
import { banStore } from './bans.js';
import { controlExclusive, exclusiveStatus, materializeAudio, playExclusive, stopExclusive } from './exclusive-play.js';
import {
  cleanMusicQuery,
  createAckWaiter,
  isBoardTarget,
  djUserInput,
  episodeTrack,
  lyricLines,
  libraryRequest,
  shortenSay,
  normalizeControl,
  remoteCallerAllowed,
  resolvePlayRequest,
} from './remote-play.js';
import { controlHeadless, forgetHeadless, headlessStatus, playDefaultFile, playInRoom, stopHeadlessPlayback } from './headless-play.js';
import { looksLikeRoomCommand, matchRoomCommand } from './rooms.js';
import { roomStore } from './room-store.js';
import { decodeVoiceAudio, transcribeAudio } from './voice.js';
import { createDriveState, oneSentence } from './drive.js';
import { appVersion } from './version.js';
import { stripTags } from './tts/tags.js';
import { readToneExtension, toneFor, toneKey, ttsText } from './tone.js';
import { applyTalk, createTalkTracker, createTodayFile, effectiveTalk, hourKeyOf, speakReasons, talkAck, talkFromText } from './talk.js';

export const services = { plan: llmPlan, stream: callLlmStream, ncm, synthesize, prepareLiveTts,
  listOutputs, selectOutput, openBluetoothSettings, playExclusive, stopExclusive,
  materializeAudio, playDefaultFile, probeTtsLane, cache: audioCache };

watchParentFromEnv();

const app = express();
// Tailscale serve 从本机转发过来时，req.ip 取它带的真实来源；直接从外面来的请求不信这个头。
app.set('trust proxy', 'loopback');
const remoteAcks = createAckWaiter();
app.use(express.json({ limit: '8mb' }));
// 前端：html/js/css 一律 no-store，避免浏览器吃旧缓存导致"改了不生效"（文件很小，重取无压力）
app.use(express.static(config.paths.web, {
  setHeaders: (res, p) => { if (/\.(html|js|css)$/.test(p)) res.setHeader('Cache-Control', 'no-store'); },
}));
app.use('/tts', express.static(config.paths.cacheTts)); // 合成的语音

const favoritesStore = createFavoritesStore({
  file: path.join(config.paths.user, 'favorites.md'),
  fetchPlaylistTracks: (...args) => services.ncm.playlistTracks(...args),
});
const tasteDigestFile = path.join(config.paths.cache, 'taste-digest.md');
let currentEpisode = null;
let activeChat = null;
let activeRemote = null;
let recommendationMood = '';
let scheduledRequest = null;
let ttsLaneState = 'ready';
function voiceRecovered() {
  if (ttsLaneState === 'ready') return;
  ttsLaneState = 'ready';
  broadcast({ kind: 'ttsLane', state: 'ready' });
}
const historyDetails = new WeakMap();
const cachedDownloads = new Map();
const successfulSongs = new Map();

function refreshTasteDigest() {
  try {
    const text = renderTasteDigest({ profile: currentProfile(), events: readEvents(400) });
    fs.mkdirSync(path.dirname(tasteDigestFile), { recursive: true });
    const temp = `${tasteDigestFile}.tmp`;
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, tasteDigestFile);
  } catch (error) {
    console.warn('[taste]', error.message);
  }
}

function noteTasteChanged({ rebuild = true } = {}) {
  refreshTasteDigest();
  episodeBuffer.invalidate();
  filler.invalidate();
  if (rebuild) ensureNext();
}

function clientError(error) {
  const text = String(error?.message || error);
  if (/超过|超时|timeout|aborted/i.test(text)) {
    if (/选歌|解析/.test(text)) return '歌曲解析超过 20 秒，请重试';
    return getSettings().llm.provider === 'local' ? '大脑超过 150 秒没回应' : '大脑超过 60 秒没回应';
  }
  if (/替换|更新|失效|缺少|停止/.test(text)) return text;
  return '这次节目没准备好，请稍后重试';
}

function commitEpisode(ep, userInput = '') {
  if (userInput) state.addMessage('user', userInput);
  // 这一期开口了才记进对话、才算「上一次开口」；没开口的只算在听
  if (ep.say && !ep.muted) talkTracker.markSpoken(ep.speakStamp || talkStamp());
  else talkTracker.markPlayed();
  if (!ep.muted) state.addMessage('claudio', ep.say);
  const recommendation = historyDetails.get(ep) || {};
  if (recommendation.fingerprint && ep.queue.some((item) => item.type === 'song')) {
    const playedLane = ep.queue.map((item) => item.meta?.lane).find((lane) => ['popular', 'fresh', 'classic'].includes(lane));
    logEvent({ type: 'recommendation', fingerprint: recommendation.fingerprint,
      source: recommendation.mode, lane: playedLane || recommendation.discoveryLane });
  }
}

function updatePins() {
  const held = episodeBuffer.held();
  const ids = held.flatMap((ep) => ep.queue.filter((q) => q.type === 'song').map((q) => q.meta.id));
  for (const ep of held) {
    for (const item of ep.queue.filter((q) => q.type === 'song')) {
      if (services.cache.has(item.meta.id)) { item.url = `/media/${item.meta.id}`; continue; }
      const remoteUrl = item.meta.remoteUrl || item.url;
      const previous = cachedDownloads.get(String(item.meta.id));
      if (previous?.url === remoteUrl) continue;
      previous?.controller.abort();
      const controller = new AbortController();
      const job = { controller, epoch: ep.epoch, url: remoteUrl };
      cachedDownloads.set(String(item.meta.id), job);
      services.cache.ensure({ id: item.meta.id, url: item.meta.remoteUrl || item.url }, { signal: controller.signal })
        .then((cached) => {
          if (!controller.signal.aborted && ep.epoch === episodeBuffer.snapshot().epoch) item.url = cached.url;
        }).catch(() => {}).finally(() => {
          if (cachedDownloads.get(String(item.meta.id)) === job) cachedDownloads.delete(String(item.meta.id));
        });
    }
  }
  for (const [id, job] of cachedDownloads) {
    if (!ids.map(String).includes(id)) { job.controller.abort(); cachedDownloads.delete(id); }
  }
  services.cache.pin([...ids, ...(filler?.pins() || [])]);
}

const driveState = createDriveState();
// 此刻的口播语气档（server/tone.js）；本地语气扩展只在个人版、设置里开着时用
function currentTone() {
  return toneFor(toneKey({ scene: currentScene(), drive: driveState.on() }));
}
function toneExtensionOn() { return getSettings().voice?.toneExtension !== false; }

// 口播频率（server/talk.js）：长期档在设置 voice.talk，「今天…」的临时档在 cache/talk.json，到本地午夜失效
const talkToday = createTodayFile(path.join(config.paths.cache, 'talk.json'));
const talkTracker = createTalkTracker();
function talkLevel() {
  return effectiveTalk({ level: getSettings().voice?.talk, today: talkToday.read() });
}
function setTalk(change) {
  if (change.today) talkToday.write(applyTalk({ level: getSettings().voice?.talk }, change).today);
  else {
    updateSettings({ voice: { talk: change.level } });
    talkToday.write(null);
  }
}
// 此刻的时段不看驾驶模式（驾驶只管缩短口播）；睡前场景就是道别
function talkStamp(at = Date.now()) {
  const now = new Date(at);
  const scene = currentScene(now);
  return { at, tier: toneKey({ now, scene }), mood: recommendationMood, hourKey: hourKeyOf(at), closing: scene.key === 'sleep' };
}
const episodeBuffer = createEpisodeBuffer({
  // 领取时定这一期说不说：当面说话的回复不走领取，永远开口
  speaks: (ep) => {
    ep.speakStamp = talkStamp();
    return speakReasons(talkLevel(), talkTracker.context(ep.speakStamp)).length > 0;
  },
  capacity: config.episodeBuffer,
  enabled: () => process.env.CLAUDIO_SKIP_PREFETCH !== '1',
  hasClients: () => clients.size > 0,
  listening: () => clients.size > 0,
  // 后台备出来一首歌都没有（多半是网易云限流、搜索超时）就不进缓冲，按失败退避重试；免得两格都是「没找到能放的」、后台停住。
  build: (options) => ncm.withNcmSource('background', async () => {
    // 后台节目没人等，解析预算放宽到 90 秒：网易云搜索每分钟有上限，排队的候选来得及轮到。
    const ep = await buildEpisode({ ...options, mood: recommendationMood, resolveTimeout: BACKGROUND_RESOLVE_BUDGET_MS });
    if (ep.intent === 'recommend' && !ep.queue.length) throw new Error('后台节目没有能放的歌');
    return ep;
  }),
  synthesize: async (text, options) => {
    const audio = await services.synthesize(text, options);
    options.signal?.throwIfAborted();
    if (!audio.cached) voiceRecovered();
    return audio;
  },
  offline: () => getSettings().tts.provider === 'pc5090' && ['busy', 'error', 'offline'].includes(getLaneStatus()?.state),
  refresh: async (ep, { signal }) => {
    await ncm.withNcmSource('refresh', () => refreshEpisodeUrls(ep, { signal, cache: services.cache, songUrl: (...args) => services.ncm.songUrl(...args) }));
    signal.throwIfAborted();
    updatePins();
    return ep;
  },
  commit: (ep) => { currentEpisode = ep; commitEpisode(ep); },
  emit: (message) => {
    if (message.kind === 'episodesInvalidated') {
      scheduledRequest = null;
      if (activeChat?.epoch != null && activeChat.epoch < message.epoch) activeChat.controller.abort(new Error('节目已更新，请重试'));
      if (activeRemote?.epoch < message.epoch) activeRemote.controller.abort(new Error('节目已更新，请重试'));
    }
    broadcast(message);
    if (message.kind === 'nextReady') void deliverScheduled(message.epoch);
  },
  changed: () => updatePins(),
});
const filler = createFillerService({
  candidates: (exclude) => fillerCandidates({
    favorites: favoritesStore.list(), recent: [...readEvents(200).filter((e) => ['play_started', 'play_completed'].includes(e.type)).map((e) => e.song).filter(Boolean), ...successfulSongs.values()],
    played: readEvents(400).filter((e) => ['play_started', 'play_completed'].includes(e.type)).map((e) => e.song).filter(Boolean),
    banned: banStore.list(), held: episodeBuffer.exclusions(), exclude,
    cached: (id) => services.cache.has(id),
  }),
  resolve: (...args) => ncm.withNcmSource('filler', () => services.ncm.resolve(...args)),
  lyric: (...args) => ncm.withNcmSource('filler', () => services.ncm.lyric(...args)),
  style: () => styleConstraints(recommendationMood), limited: () => Boolean(services.ncm.coolingDown?.()),
  cache: { has: (...args) => services.cache.has(...args), ensure: (...args) => services.cache.ensure(...args) },
  changed: () => updatePins(),
});

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
    local: Boolean(getSecret('localLlmApiKey')),
    claude: commandAvailable(config.claude.bin),
    deepseek: Boolean(getSecret('deepseekApiKey')),
  };
}

function publicSettings(settings = getSettings()) {
  return toPublicSettings(settings, providerAvailability(), credentialStatus(), { toneExtension: readToneExtension() });
}

const RESOLVE_BUDGET_MS = 20_000;
const BACKGROUND_RESOLVE_BUDGET_MS = 90_000;
const STYLE_REPLAY_COOLDOWN_MS = 10 * 60_000;

function sameSong(song, other) {
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return (song.id && other.id && String(song.id) === String(other.id))
    || (clean(song.title) && clean(song.title) === clean(other.title) && clean(song.artist) === clean(other.artist));
}

// byOrder：点了曲风或当面点歌时，按大脑点名先后放前两首；自动节目用 pickDiverse 搭配桥接和发现。
function assemblePlayable(resolved, recommendation = {}, byOrder = false, limit = 2) {
  const playable = resolved
    .filter(({ resolved: song }) => song.playable)
    .map(({ candidate, resolved: song }) => ({
      ...song,
      candidate,
      lane: candidate.lane,
      discoveryType: candidate.discoveryType,
      playOrder: candidate.playOrder,
    }));
  // pickDiverse 把桥接歌排前面；放的时候按口播提歌的先后。
  // 话多档一段只放一首：按大脑点名的先后取第一首（口播就是按它写的），不让桥接排序换掉
  const picked = byOrder || limit === 1 ? orderByPlayOrder(playable).slice(0, limit) : pickDiverse(playable, recommendation.discoveryLane);
  return { resolved, songs: orderByPlayOrder(picked) };
}

export async function finalizeEpisode(result, {
  recommendation = {}, signal, resolveLimit = 0, epoch = episodeBuffer.snapshot().epoch, chat = false,
  nowPlaying = null, resolveTimeout = RESOLVE_BUDGET_MS, tone = currentTone(), single = false,
} = {}) {
  signal?.throwIfAborted();
  const constraints = styleConstraints(recommendation.styleRequest);
  const styleMode = constraints.some(Array.isArray);
  const exclusions = constraints.filter((constraint) => constraint.exclude);
  const drops = new Map();
  const candidateKey = (song) => JSON.stringify([song.title, song.artist, song.playOrder ?? null]);
  const drop = (candidate, reason) => {
    const key = candidateKey(candidate);
    if (!drops.has(key)) drops.set(key, { candidate, reasons: new Set() });
    drops.get(key).reasons.add(reason);
  };
  // 只有本次分配的位置可信，发现池不能伪装成模型选歌。
  const pool = recommendation.poolSongs?.map((song) => ({ ...song, playOrder: undefined }));
  const candidates = episodeCandidates(result, pool, recommendation.styleRequest);
  // 池中缺少标签证据的歌不会进入解析，也记下淘汰原因。
  if (result.intent === 'recommend') {
    for (const song of pool || []) {
      if (!matchesStyle(song, exclusions)) drop(song, 'exclusion');
      else if (!matchesStyle(song, constraints)) drop(song, 'style');
    }
  }
  const resolvedCache = new Map();
  const deadline = Date.now() + resolveTimeout;
  async function select(relaxed) {
    signal?.throwIfAborted();
    const options = { ...recommendation, ...(relaxed ? { recentSongs: [] } : {}), onDrop: drop };
    const source = relaxed ? candidates.filter((song) => song.playOrder != null) : candidates;
    const filtered = filterCandidates(source, options);
    const ranked = styleMode ? orderByPlayOrder(filtered) : rankCandidates(filtered, recommendation);
    let shortlist = styleMode ? ranked.slice(0, 6) : selectDiverseShortlist(ranked, recommendation.discoveryLane, 6);
    // 点歌时听众要的是大脑点名的那几首：先找它们，发现池只补空位（自动节目照旧按多样性挑）。
    if (chat) shortlist = [...orderByPlayOrder(ranked.filter((song) => song.playOrder != null)),
      ...shortlist.filter((song) => song.playOrder == null)].slice(0, 6);
    if (resolveLimit > 0) shortlist = shortlist.slice(0, resolveLimit);
    for (const song of filtered) if (!shortlist.includes(song)
      && !shortlist.some((item) => candidateKey(item) === candidateKey(song))) drop(song, 'shortlist-limit');
    const pending = shortlist.filter((song) => !resolvedCache.has(candidateKey(song)));
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining > 0 && pending.length) {
      const resolved = await resolveEpisodeSongs(pending, {
        resolve: (candidate, options) => takeEarlyResolve(candidate) || services.ncm.resolve(candidate, options),
        signal, timeout: remaining, onDrop: drop,
      });
      for (const pair of resolved) resolvedCache.set(candidateKey(pair.candidate), pair.resolved);
    } else for (const song of pending) drop(song, 'timeout');
    signal?.throwIfAborted();
    // 解析期间别的节目可能已领走歌曲，第二轮也必须现查。
    const held = episodeBuffer.exclusions();
    const cooldown = relaxed ? readEvents().filter((event) => event.type === 'play_started'
      && Date.parse(event.at) >= Date.now() - STYLE_REPLAY_COOLDOWN_MS).map((event) => event.song).filter(Boolean) : [];
    const seen = [];
    const playable = [];
    for (const candidate of shortlist) {
      const song = resolvedCache.get(candidateKey(candidate));
      if (!song) continue;
      let reason = !song.playable || !song.url ? (song.rateLimited ? 'rate-limited' : 'unplayable') : '';
      if (!reason && held.some((other) => sameSong(song, other) || sameSong(candidate, other))) reason = 'held';
      if (!reason && relaxed && nowPlaying && (sameSong(song, nowPlaying) || sameSong(candidate, nowPlaying))) reason = 'now-playing';
      if (!reason && relaxed && cooldown.some((other) => sameSong(song, other) || sameSong(candidate, other))) reason = 'cooldown';
      if (!reason && (!matchesStyle(candidate, exclusions) || !matchesStyle(song, exclusions))) reason = 'exclusion';
      if (!reason && !(candidate.playOrder != null ? matchesResolvedStyle(song, constraints)
        : matchesStyle({ ...candidate, ...song }, constraints))) reason = 'style';
      if (!reason && relaxed) {
        filterCandidates([song], { ...options, onDrop: (_, why) => { reason = why; } });
      }
      if (!reason && seen.some((other) => sameSong(song, other))) reason = 'duplicate';
      if (reason) { drop(candidate, reason); continue; }
      seen.push(song);
      playable.push({ candidate, resolved: song });
    }
    return assemblePlayable(playable, recommendation, styleMode || chat, single ? 1 : 2).songs;
  }
  let songs = await select(false);
  if (result.intent === 'recommend' && styleMode && !songs.length) songs = await select(true);
  const emptyRecommendation = result.intent === 'recommend' && !songs.length;
  if (emptyRecommendation) {
    // 不记录模型原文、提示词或解析错误，字段也防止夹带直链。
    const safe = (value) => String(value || '').replace(/https?:\/\/\S+/gi, '[url]').replace(/[\r\n\t]/g, ' ').slice(0, 80);
    const items = [...drops.values()].slice(0, 24).map(({ candidate, reasons }) => ({
      title: safe(candidate.title), artist: safe(candidate.artist), reasons: [...reasons],
    }));
    console.warn('[episode-empty]', JSON.stringify({ candidates: items, omitted: Math.max(0, drops.size - items.length) }));
  }
  if (chat && result.intent === 'recommend') {
    // 点歌时大脑挑了什么、为什么掉、最后放什么：只记歌名歌手和掉落原因，查「点 A 却放 B」用。
    const name = (s) => `${String(s?.title || '').slice(0, 40)} - ${String(s?.artist || '').slice(0, 30)}`;
    console.log('[chat-picks]', JSON.stringify({
      planned: (result.play || []).map((song, i) => {
        const why = drops.get(candidateKey({ ...song, playOrder: i }))?.reasons;
        return why ? `${name(song)}: ${[...why].join('/')}` : name(song);
      }),
      dropped: [...drops.values()].slice(0, 8).map(({ candidate, reasons }) => `${name(candidate)}: ${[...reasons].join('/')}`),
      final: songs.map(name),
    }));
  }
  const fullSay = emptyRecommendation ? '这会儿没找到能放的，先接着听这首。'
    : result.intent === 'recommend' ? correctSay(result.say, result.play || [], songs) : result.say;
  // 驾驶模式：提示词已经要求一句话，这里再兜一次底
  const say = driveState.on() ? oneSentence(fullSay) : fullSay;
  // 念的版本：大脑原话没被改过才带它写的演出标记；改过（校正歌名、驾驶模式截短、没歌可放）就念干净的
  const sayTts = say ? ttsText(say === result.say ? (result.sayTagged || say) : say, tone) : '';
  const ep = {
    id: randomUUID(), epoch, sayWrittenAt: Date.now(), say, sayTts, intent: result.intent,
    action: result.action, actionValue: result.actionValue, reason: result.reason,
    voice: { status: say && !(emptyRecommendation && !chat) ? 'pending' : 'skipped' },
    queue: songs.map((song) => ({ type: 'song', url: services.cache.has(song.id) ? `/media/${song.id}` : song.url,
      meta: { id: song.id || '', title: song.title, artist: song.artist, lyric: song.lyric || '',
        remoteUrl: song.url, discoveryType: song.candidate.discoveryType || 'adjacent',
        bridgeFrom: song.candidate.bridgeFrom || '',
        ...(song.lane ? { lane: song.lane } : {}), ...(song.year ? { year: song.year } : {}),
        ...(song.genre ? { genre: song.genre } : {}), ...(song.cover ? { cover: song.cover } : {}),
        ...(song.quality ? { quality: song.quality } : {}) } })),
  };
  historyDetails.set(ep, recommendation);
  for (const item of ep.queue) {
    successfulSongs.set(String(item.meta.id || `${item.meta.title}|${item.meta.artist}`), { ...item.meta, url: item.meta.remoteUrl, playable: true });
    if (successfulSongs.size > 100) successfulSongs.delete(successfulSongs.keys().next().value);
    void services.ncm.lyric(item.meta.id, { signal }).then((lyric) => {
      if (signal?.aborted || ep.epoch !== episodeBuffer.snapshot().epoch) return;
      item.meta.lyric = lyric;
      if (lyric) broadcast({ kind: 'lyrics', id: ep.id, tracks: [{ ...item.meta }] });
    }).catch(() => {});
  }
  return ep;
}

async function buildEpisode({ userInput = '', mood = '', sleep = null, nowPlaying = null,
  briefSay = false, resolveLimit = 0, resolveTimeout, signal, epoch = episodeBuffer.snapshot().epoch,
  excludeSongs = episodeBuffer.exclusions(), recentSays = episodeBuffer.held().map((ep) => ep.say),
} = {}) {
  // 话多档：自动节目一段只放一首，每首歌前都有口播（点歌不受影响）
  const single = !userInput && talkLevel() === 'chatty';
  const bundle = buildPromptBundle({ userInput, mood, sleep, nowPlaying, briefSay, excludeSongs, recentSays, drive: driveState.on(), toneExtension: toneExtensionOn(), singleSong: single });
  const result = await services.plan(bundle.prompt, { signal });
  signal?.throwIfAborted();
  return finalizeEpisode(result, { recommendation: bundle.recommendation, resolveLimit, resolveTimeout, signal, epoch, nowPlaying, tone: bundle.tone, single });
}

// 点歌时大脑每写完一首就先去网易云找，等整段写完再用；只留一分钟，过期不用。
const earlyResolves = new Map();
const earlyKey = (song) => `${String(song?.title || '').trim().toLowerCase()}|${String(song?.artist || '').trim().toLowerCase()}`;
function startEarlyResolve(song, signal) {
  const key = earlyKey(song);
  if (!song?.title || earlyResolves.has(key)) return;
  const promise = services.ncm.resolve({ title: song.title, artist: song.artist }, { signal });
  promise.catch(() => {});
  earlyResolves.set(key, { promise, at: Date.now() });
  for (const [k, v] of earlyResolves) if (Date.now() - v.at > 60000) earlyResolves.delete(k);
}
function takeEarlyResolve(song) {
  const key = earlyKey(song);
  const hit = earlyResolves.get(key);
  if (!hit) return null;
  earlyResolves.delete(key);
  return Date.now() - hit.at <= 60000 ? hit.promise : null;
}

async function buildEpisodeStream({ userInput = '', mood = '', sleep = null, nowPlaying = null, signal, isCurrent, mark = () => {} }, send) {
  const isValid = () => isCurrent() && !signal.aborted;
  const drive = driveState.on();
  const bundle = buildPromptBundle({ userInput, mood, sleep, nowPlaying, drive, toneExtension: toneExtensionOn(),
    excludeSongs: episodeBuffer.exclusions(), recentSays: episodeBuffer.held().map((ep) => ep.say) });
  const { tone } = bundle;
  // 大脑写的 say 带演出标记：页面和记录用去掉标记的（驾驶模式再截成一句），语音用带标记、带时段语气的
  const tidy = (raw) => String(raw || '').replace(/\s+/g, ' ').trim();
  const shown = (raw) => (drive ? oneSentence(stripTags(tidy(raw))) : stripTags(tidy(raw)));
  const spoken = (raw) => ttsText(drive ? shown(raw) : tidy(raw), tone);
  let live = null;
  let liveText = '';
  let liveSay = '';
  let liveAbort = null;
  let episode = null;
  let voiceFailed = false;
  let voiceReady = false;
  // 口播稿一写完就先合成（不等选歌）；推荐的口播要等选歌定下、确认没被改写才放出去，改写了就作废重来
  let confirmed = false;
  let readySent = false;
  function fail() {
    if (!isValid() || voiceFailed) return;
    voiceFailed = true;
    if (episode) { episode.voice = { status: 'skipped' }; episode.queue = episode.queue.filter((q) => q.type !== 'tts'); }
    send({ kind: 'sayFailed' });
  }
  function announce() {
    if (readySent || !voiceReady || !confirmed || voiceFailed || !isValid()) return;
    readySent = true;
    if (episode) {
      episode.voice = { status: 'ready' };
      episode.queue.unshift({ type: 'tts', url: live.url, text: liveSay });
    }
    send({ kind: 'sayReady', say: liveSay, url: live.url });
  }
  function startVoice(text, say) {
    if (!text || live || voiceFailed || !isValid()) return;
    try {
      const controller = new AbortController();
      const voiceSignal = AbortSignal.any([signal, controller.signal]);
      const current = ['fish', 'pc5090'].includes(getSettings().tts.provider)
        ? services.prepareLiveTts(text, { signal: voiceSignal, onError: () => { if (live === current) fail(); } })
        : { ready: services.synthesize(text, { signal: voiceSignal }).then((audio) => { current.url = audio.url; }) };
      live = current; liveText = text; liveSay = say; liveAbort = controller;
      mark('voiceStart');
      Promise.resolve(current.ready).then(() => {
        if (live !== current || !isValid() || voiceFailed) return;
        mark('voiceReady');
        voiceReady = true;
        if (!current.cached) voiceRecovered();
        announce();
      }, () => { if (live === current) fail(); });
    } catch { fail(); }
  }
  mark('llmStart');
  let draftSent = false;
  const raw = await services.stream(bundle.prompt, { signal, maxTokens: CHAT_MAX_TOKENS, onText: (text) => {
    mark('llmFirst');
    if (isValid()) for (const song of extractClosedPlayItems(text).slice(0, 3)) startEarlyResolve(song, signal);
    if (!draftSent && isValid()) {
      // 口播稿一写完就先推文字、先合成，前端不用等选歌
      const draft = extractSayValue(text);
      if (draft) {
        draftSent = true;
        mark('sayDraft');
        send({ kind: 'sayDraft', say: shown(draft) });
        startVoice(spoken(draft), shown(draft));
      }
    }
    // 聊天、控制不换歌，口播不会被改写：合成好了就放
    if (!confirmed && ['chat', 'control'].includes(extractClosedString(text, 'intent'))) { confirmed = true; announce(); }
  } });
  signal.throwIfAborted();
  mark('llmDone');
  const obj = extractJson(raw);
  if (!obj || typeof obj.say !== 'string') throw new Error('大脑返回的节目格式不完整');
  const result = normalizeResult(obj);
  episode = await finalizeEpisode(result, { recommendation: bundle.recommendation, signal, chat: true, nowPlaying, tone });
  signal.throwIfAborted();
  mark('songsReady');
  if (live && liveText !== episode.sayTts) {
    // 选歌后口播被改写（歌名校正、没找到能放的）：先合成的那段作废，按最终稿重来
    mark('voiceRedo');
    // 只记为什么重来（不记口播原文）：rewritten = 选歌后 say 被校正 / 截短；diffAt = 两版第一个不同的位置
    const diffAt = [...liveText].findIndex((ch, i) => ch !== [...episode.sayTts][i]);
    console.log('[voice-redo]', JSON.stringify({ rewritten: episode.say !== result.say, tagged: result.sayTagged !== result.say,
      live: [...liveText].length, final: [...episode.sayTts].length, diffAt }));
    liveAbort?.abort(new Error('口播已改写'));
    live = null; voiceReady = false; readySent = false;
  }
  confirmed = true;
  if (!live) startVoice(episode.sayTts, episode.say);
  if (voiceFailed) episode.voice = { status: 'skipped' };
  else if (voiceReady) {
    if (readySent) {
      episode.voice = { status: 'ready' };
      episode.queue.unshift({ type: 'tts', url: live.url, text: episode.say });
    } else announce();
  }
  if (userInput && result.memoryCandidates?.length) {
    const evidenceId = `message-${randomUUID()}`;
    for (const item of result.memoryCandidates) logEvent({ type: 'memory_inferred', key: item.key, value: item.value, evidenceId, source: 'llm' });
    for (const item of currentProfile().memories.stable) appendMemory(item.value);
  }
  return episode;
}

const CHAT_MAX_TOKENS = 800; // 点歌口播短、只要 3 首，留 800 足够；自动节目仍是 1600

function ensureNext() { episodeBuffer.ensure(); }

async function takeEpisode(claimId) { return episodeBuffer.claim(claimId); }

async function onScheduled(reason) {
  if (!clients.size || episodeBuffer.snapshot().foreground) return;
  const moodMap = { 'morning-plan': '清晨，为新的一天挑几首', 'morning-show': '早间节目', 'hourly-mood': '' };
  recommendationMood = moodMap[reason] || '';
  const epoch = episodeBuffer.invalidate();
  scheduledRequest = { reason, epoch };
  ensureNext();
}

async function deliverScheduled(epoch) {
  if (scheduledRequest?.epoch !== epoch) return;
  const request = scheduledRequest;
  scheduledRequest = null;
  const claimId = randomUUID();
  try {
    const episode = await episodeBuffer.claim(claimId);
    if (!episode || episode.epoch !== episodeBuffer.snapshot().epoch) return;
    // 定时节目也先领取；播放器真正开声后再发 started。
    broadcast({ kind: 'scheduled', reason: request.reason, claimId, episode, epoch });
  } catch { episodeBuffer.release(claimId); }
}

// 给 CLI / 状态查询：把一期压成精简清单（口播首句 + 曲目 title/artist），不含 url/歌词
const slimEp = (ep) => (ep ? {
  say: ep.say,
  tracks: ep.queue.filter((q) => q.type === 'song').map((q) => ({ title: q.meta.title, artist: q.meta.artist })),
} : null);

// ── HTTP 契约 ──
app.post('/api/chat', async (req, res) => {
  const requestId = String(req.body?.requestId || randomUUID());
  activeChat?.controller.abort(new Error('这次请求已被新的请求替换'));
  activeRemote?.controller.abort(new Error('这次请求已被新的请求替换'));
  const chat = { requestId, controller: new AbortController() };
  activeChat = chat;
  const isCurrent = () => activeChat === chat && !chat.controller.signal.aborted
    && (chat.epoch == null || chat.epoch === episodeBuffer.snapshot().epoch);
  const send = (message) => { if (isCurrent()) broadcast({ ...message, requestId, origin: 'chat' }); };
  // 每段耗时记一行 [chat-timing]，毫秒，从收到请求起算；只记阶段和数字，不记听众原话。
  const t0 = performance.now();
  const marks = {};
  const mark = (key) => { if (marks[key] == null) marks[key] = Math.round(performance.now() - t0); };
  const reply = (body, status = 200) => {
    mark('reply');
    setTimeout(() => console.log(`[chat-timing] ${Object.entries(marks).map(([k, v]) => `${k}=${v}`).join(' ')}`), 15000).unref();
    return res.status(status).json({ ...body, requestId, origin: 'chat' });
  };
  res.once('close', () => { if (!res.writableEnded) chat.controller.abort(); });
  try {
    const { input = '', mood = '', sleep = null, nowPlaying = null } = req.body ?? {};
    const { userInput, control } = route(input);
    // 「少说点」「今天别打扰我」：记下口播频率，回一句确认。不打大脑；话多档进出时备好的节目是一首一段 / 两首一段，作废重备
    const talkChange = !control && !mood && !sleep ? talkFromText(userInput) : null;
    if (talkChange) {
      const wasChatty = talkLevel() === 'chatty';
      setTalk(talkChange);
      if (wasChatty !== (talkLevel() === 'chatty')) episodeBuffer.invalidate();
      return reply({ ok: true, control: { intent: 'control', action: 'talk', actionValue: 0, reply: talkAck(talkChange) }, streamed: false });
    }
    if (mood || styleConstraints(userInput).length) {
      recommendationMood = mood || userInput;
      episodeBuffer.invalidate();
      filler.invalidate();
    }
    // 「我在上班」「在跑步」这类话记成此刻的场景；场景变了，已备好的节目按旧场景选的，作废重备。
    const before = currentScene().key;
    if (sceneStore.noteFromText(userInput) && currentScene().key !== before) episodeBuffer.invalidate();
    const explicitFeedback = inferExplicitFeedback(userInput, nowPlaying);
    if (explicitFeedback) {
      logEvent(explicitFeedback);
      if (explicitFeedback.type === 'explicit_like' && explicitFeedback.song?.artist) favoritesStore.rememberSong(explicitFeedback.song, { source: 'chat' });
      if (explicitFeedback.type === 'explicit_dislike' && explicitFeedback.song?.title) banStore.add(explicitFeedback.song);
      noteTasteChanged({ rebuild: false });
    }
    chat.epoch = episodeBuffer.snapshot().epoch;
    if (!userInput && !sleep && !mood) {
      const claimId = String(req.body?.claimId || requestId);
      const ep = await takeEpisode(claimId);
      chat.controller.signal.throwIfAborted();
      return reply(ep ? { ok: true, claimId, episode: ep } : { ok: false, busy: true }, ep ? 200 : 202);
    }
    const outcome = await episodeBuffer.runForeground((laneSignal) => ncm.withNcmSource('chat', async () => {
      mark('lane');
      const signal = AbortSignal.any([laneSignal, chat.controller.signal]);
      signal.throwIfAborted();
      if (!control && looksLikeRoomCommand(userInput)) {
        const menu = await services.listOutputs();
        signal.throwIfAborted();
        const room = matchRoomCommand(userInput, menu.items);
        if (room) {
          const selected = await services.selectOutput(room.outputId);
          signal.throwIfAborted();
          const text = selected.ok ? room.reply : (selected.error || '没能切换播放设备');
          state.addMessage('user', userInput); state.addMessage('claudio', text);
          return { ok: true, control: { ...room, reply: text }, output: selected };
        }
      }
      if (control) {
        const playing = nowPlaying?.type === 'song' && nowPlaying.title;
        const text = control.action === 'favorite' && !playing ? '现在没有在放歌，没法记。' : control.reply;
        state.addMessage('user', userInput); state.addMessage('claudio', text);
        return { ok: true, control: { ...control, reply: text }, streamed: false };
      }
      const ep = await buildEpisodeStream({ userInput, mood, sleep, nowPlaying, signal, isCurrent, mark }, send);
      signal.throwIfAborted();
      // 聊天只记对话；有新歌时才替换正在播放的音乐节目。
      if (ep.queue.some((item) => item.type === 'song')) {
        currentEpisode = ep;
        episodeBuffer.setCurrent(ep);
      }
      commitEpisode(ep, userInput);
      send({ kind: 'episode', episode: ep });
      return { ok: true, episode: ep, streamed: true };
    }));
    return reply(outcome);
  } catch (error) {
    return reply({ ok: false, error: clientError(error) }, 500);
  } finally {
    if (activeChat === chat) ensureNext();
  }
});

// 音频代理：把网易云跨域直链转成同源流，让前端 WebAudio AnalyserNode 能做真频谱（跨域直链会被静音）。
// 透传 Range 以支持进度条 seek / 分段加载；只允许网易云音频域名，防开放代理(SSRF)。
function isAllowedAudio(u) {
  try {
    const { hostname, protocol } = new URL(u);
    return /(^|\.)(126|netease)\.(net|com)$/.test(hostname) || (protocol === 'https:' && ncm.sources.allowsHost(hostname));
  }
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

app.post('/api/timing', (req, res) => {
  const kind = String(req.body?.kind || '');
  const phase = String(req.body?.phase || '').slice(0, 20);
  const action = String(req.body?.action || '').slice(0, 24);
  const earMs = Number(req.body?.earMs);
  if (!['chat', 'control', 'next'].includes(kind)) return res.status(400).json({ ok: false });
  if (!Number.isFinite(earMs) || earMs < 0 || earMs > 180000) return res.status(400).json({ ok: false });
  console.log(`[interact] ear kind=${kind} phase=${phase || '-'} ear=${Math.round(earMs)}ms${action ? ` action=${action}` : ''}`);
  res.json({ ok: true });
});

// 网页放歌失败的原因（「这首暂时放不了」）：只记字段白名单，不记地址。
app.post('/api/play-diag', (req, res) => {
  const body = req.body ?? {};
  const pick = (key, max = 120) => String(body[key] ?? '').replace(/\s+/g, ' ').slice(0, max);
  const num = (key) => (Number.isFinite(Number(body[key])) ? Math.round(Number(body[key])) : '');
  console.log(`[play-fail] song=${pick('songId', 20)} src=${pick('src', 8)} msg=${pick('message', 40)} cause=${pick('cause', 40)}`
    + ` causeMsg=${pick('causeMessage')} mediaError=${num('mediaError')} network=${num('networkState')} ready=${num('readyState')}`
    + ` startAt=${num('startAt')} at=${num('currentTime')} preloaded=${body.preloaded === true} handoff=${body.handoff === true} ms=${num('ms')}`);
  res.json({ ok: true });
});

app.get('/api/now', (_req, res) => res.json({ ok: true, episode: currentEpisode }));

app.get('/api/tts/stream/:id.mp3', async (req, res) => {
  await liveTtsManager.handle(String(req.params.id || ''), res);
});

// 多设备接力（server/handoff.js）：设备上报放到哪；一台开始响，其他设备收到 WS handoff 自己停。
app.post('/api/playback', (req, res) => {
  const result = handoffStore.report(req.body ?? {});
  if (result.taken) broadcast({ kind: 'handoff', deviceId: result.state.deviceId, deviceName: result.state.deviceName });
  res.json({ ok: result.ok !== false });
});
app.get('/api/playback', async (_req, res) => {
  const state = handoffStore.get();
  if (!state?.song) return res.json({ ok: true, state: null });
  state.position = handoffStore.position();
  // 网易云直链会过期：接着放之前刷新一次（不搜索，只取直链）。
  const ep = { queue: [state.song, ...state.queue] };
  await ncm.withNcmSource('refresh', () => refreshEpisodeUrls(ep, { cache: services.cache,
    songUrl: (...args) => services.ncm.songUrl(...args), signal: AbortSignal.timeout(4000) })).catch(() => {});
  res.json({ ok: true, state });
});

app.get('/api/settings', (_req, res) => {
  res.json({ ok: true, settings: publicSettings() });
});

app.patch('/api/settings', (req, res) => {
  try {
    const settings = updateSettings(req.body ?? {});
    // 预生成节目可能来自旧模型 / 旧推荐模式，切换后丢弃并按新设置补一份。
    episodeBuffer.invalidate();
    filler.invalidate();
    setTimeout(ensureNext, 20);
    res.json({ ok: true, settings: publicSettings(settings) });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message ?? error) });
  }
});

app.patch('/api/settings/credentials', (req, res) => {
  try {
    updateSecrets(req.body ?? {});
    episodeBuffer.invalidate();
    filler.invalidate();
    res.json({ ok: true, settings: publicSettings() });
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

app.post('/api/settings/test-pc5090-tts', async (_req, res) => {
  try {
    const timing = await testPc5090Connection();
    const fileName = 'pc5090-tts-settings-test.mp3';
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

app.get('/api/weather', (_req, res) => res.json({ ok: true, weather: getWeather() }));

// 歌词兜底：备节目时后台取的歌词靠 WS 推，推丢了（或点歌后才现取）前端再来要一次
app.get('/api/lyric', async (req, res) => {
  const id = String(req.query.id || '');
  if (!/^(\d{1,15}|[a-z]{2,4}\d{1,20})$/.test(id)) return res.status(400).json({ ok: false, error: 'bad id' });
  try {
    const lyric = await services.ncm.lyric(id, { signal: AbortSignal.timeout(5000) });
    res.json({ ok: true, lyric: lyric || '' });
  } catch {
    res.status(502).json({ ok: false, lyric: '' });
  }
});

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
    episodeBuffer.invalidate();
    ncm.withNcmSource('pool', () => ensureDiscoveryPool({ force: true }))
      .then((result) => {
        if (result?.refreshed) {
          episodeBuffer.invalidate();
        }
      })
      .catch((error) => console.warn('[discovery]', error.message))
      .finally(() => { setTimeout(ensureNext, 20); });
    console.log(`[口味曲库] 歌单 ${result.playlistId}：新增 ${result.added}，共 ${result.total} 首`);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message ?? error) });
  }
});

app.post('/api/events', (req, res) => {
  try {
    const event = logEvent(req.body ?? {});
    if (['dislike', 'explicit_dislike'].includes(event.type)) {
      if (event.song?.title) banStore.add(event.song);
      noteTasteChanged();
    }
    res.json({ ok: true, event: { id: event.id, type: event.type, at: event.at } });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message ?? error) });
  }
});

// 给 CLI / 健康检查：服务在线 + 首期是否预热好 + 天气
app.get('/api/bans', (_req, res) => {
  res.json({ ok: true, songs: banStore.list() });
});

app.post('/api/bans/remove', (req, res) => {
  const songs = banStore.remove({ title: req.body?.title, artist: req.body?.artist });
  noteTasteChanged();
  res.json({ ok: true, songs });
});

app.post('/api/outputs/alias', (req, res) => {
  try {
    roomStore.set(req.body?.id, req.body?.alias);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || '没能改名' });
  }
});

app.post('/api/exclusive/play', async (req, res) => {
  try {
    const result = await playExclusive({
      uid: String(req.body?.uid || ''),
      url: String(req.body?.url || ''),
      volume: req.body?.volume,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.warn('[exclusive]', error.message);
    res.status(400).json({ ok: false, error: error.message || '没能单独送到音箱' });
  }
});

app.post('/api/exclusive/control', async (req, res) => {
  try {
    const result = await controlExclusive(String(req.body?.command || ''), req.body?.value);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ ok: false, error: '没能控制音箱' });
  }
});

app.post('/api/exclusive/stop', async (_req, res) => {
  await stopExclusive();
  res.json({ ok: true, ...exclusiveStatus() });
});

async function remoteDjTrack(userInput = '', { signal, epoch } = {}) {
  const episode = await episodeBuffer.runForeground((laneSignal) => buildEpisode({
    userInput, briefSay: true, resolveLimit: 1, epoch,
    signal: signal ? AbortSignal.any([laneSignal, signal]) : laneSignal,
  }));
  signal?.throwIfAborted();
  const track = episodeTrack(episode);
  if (!track) return null;
  track.say = shortenSay(track.say, 45);
  track.url = episode.queue.find((item) => item.type === 'song')?.meta.remoteUrl || track.url;
  track.episode = episode;
  await attachLyric(track, { signal });
  return track;
}

async function attachLyric(track, { signal } = {}) {
  signal?.throwIfAborted();
  if (!track) return track;
  if (!track.lyric && track.id) {
    const controller = new AbortController();
    const lyricSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      track.lyric = await withAbort(services.ncm.lyric(track.id, { signal: lyricSignal }), lyricSignal).catch(() => '');
      signal?.throwIfAborted();
    } finally { clearTimeout(timer); controller.abort(); }
  }
  track.lyric = lyricLines(track.lyric, 2).join('\n');
  return track;
}

async function sendRemoteTrack(res, where, track, query, { signal } = {}) {
  const check = () => {
    signal?.throwIfAborted();
    if (track.episode && track.episode.epoch !== episodeBuffer.snapshot().epoch) throw new Error('节目已更新，请重试');
  };
  check();
  if (isBoardTarget(where)) {
    forgetHeadless();
    await services.stopExclusive();
    check();
    const { episode, ...body } = track;
    return res.json({ ok: true, mode: 'board', ...body });
  }
  const menu = await services.listOutputs({ fresh: true });
  check();
  const played = await playInRoom({
    song: track,
    where,
    query: query || `${track.title} ${track.artist}`,
    signal,
    items: menu.items,
    io: {
      selectOutput: services.selectOutput,
      stopExclusive: services.stopExclusive,
      playExclusive: services.playExclusive,
      materialize: services.materializeAudio,
      playFile: services.playDefaultFile,
    },
  });
  check();
  if (!played.ok) return res.status(played.status || 502).json({ ok: false, error: played.error });
  if (track.episode) {
    const claimId = randomUUID();
    episodeBuffer.adopt(track.episode, claimId);
    episodeBuffer.start(track.episode.id, claimId);
  }
  return res.json({
    ok: true,
    mode: 'room',
    say: track.say || '',
    name: played.name,
    title: played.title || track.title,
    artist: played.artist || track.artist,
  });
}

async function sendRemoteDj(res, where, userInput = '') {
  activeRemote?.controller.abort(new Error('这次请求已被新的请求替换'));
  const task = { controller: new AbortController(), epoch: episodeBuffer.snapshot().epoch };
  activeRemote = task;
  const { signal } = task.controller;
  const closed = () => { if (!res.writableEnded) task.controller.abort(); };
  res.once('close', closed);
  try {
    const track = await remoteDjTrack(userInput, { signal, epoch: task.epoch });
    signal.throwIfAborted();
    if (!track?.url) return res.status(404).json({ ok: false, error: '这期没选出能放的歌' });
    return await sendRemoteTrack(res, where, track, `${track.title} ${track.artist}`, { signal });
  } finally {
    res.removeListener('close', closed);
    if (activeRemote === task) activeRemote = null;
  }
}

// 家里小智点歌。只接受本机和新盒子。没点歌名就走 Claudio 原来的 DJ。
app.post('/api/remote/play', async (req, res) => {
  if (!remoteCallerAllowed(req.ip, config.remoteAllow)) {
    return res.status(403).json({ ok: false, error: '这台机器不能点歌' });
  }
  activeRemote?.controller.abort(new Error('这次请求已被新的请求替换'));
  try {
    let where = String(req.body?.where || '').trim();
    if (!where) where = '开发板';
    const raw = String(req.body?.query ?? req.body?.input ?? '');
    const asked = libraryRequest(raw);
    if (asked.recommend) {
      return await sendRemoteDj(res, where, djUserInput(raw) || '');
    }
    const query = asked.query;
    const found = await resolvePlayRequest(query, {
      resolve: services.ncm.resolve, epoch: episodeBuffer.snapshot().epoch,
    });
    if (!found.ok) return res.status(found.status || 404).json({ ok: false, error: found.error });
    if (where) {
      if (found.mode !== 'track') return res.status(400).json({ ok: false, error: '要说歌名' });
      const named = {
        say: '',
        title: found.song.title,
        artist: found.song.artist,
        genre: found.song.genre || '',
        id: found.song.id || '',
        url: found.song.url,
      };
      await attachLyric(named);
      return sendRemoteTrack(res, where, named, query);
    }
    if (clients.size === 0) {
      return res.status(409).json({ ok: false, error: '要说放到哪：客厅的 A9、卧室，或者开发板' });
    }
    const id = randomUUID();
    const ack = remoteAcks.expect(id);
    const message = found.mode === 'next'
      ? { kind: 'remotePlay', id, mode: 'next' }
      : { kind: 'remotePlay', id, mode: 'track', episode: found.episode };
    broadcast(message);
    const result = await ack;
    if (!result.ok) return res.status(409).json({ ok: false, error: result.error || '没能开始放' });
    if (found.mode === 'next') return res.json({ ok: true, mode: 'next' });
    return res.json({
      ok: true,
      mode: 'track',
      title: found.song.title,
      artist: found.song.artist,
    });
  } catch (error) {
    console.warn('[remote]', error.message);
    const busy = /local llm|deepseek|claude|超时|timeout/i.test(String(error.message || ''));
    return res.status(500).json({ ok: false, error: busy ? 'DJ 这会儿没编出来' : '点歌失败' });
  }
});

app.post('/api/remote/control', async (req, res) => {
  if (!remoteCallerAllowed(req.ip, config.remoteAllow)) {
    return res.status(403).json({ ok: false, error: '这台机器不能点歌' });
  }
  const parsed = normalizeControl(req.body ?? {});
  if (!parsed.ok) return res.status(parsed.status || 400).json({ ok: false, error: parsed.error });
  activeRemote?.controller.abort(new Error('这次请求已被新的请求替换'));
  if (clients.size === 0 && parsed.control.action === 'next' && !headlessStatus().playing) {
    try {
      const where = String(req.body?.where || '').trim() || '开发板';
      return await sendRemoteDj(res, where);
    } catch (error) {
      console.warn('[remote]', error.message);
      return res.status(500).json({ ok: false, error: 'DJ 这会儿没编出来' });
    }
  }
  if (clients.size === 0) {
    const outcome = await controlHeadless({
      action: parsed.control.action,
      value: parsed.control.actionValue,
      where: String(req.body?.where || '').trim(),
      listOutputs: () => listOutputs({ fresh: true }),
      io: {
        selectOutput,
        stopExclusive,
        playExclusive,
        controlExclusive,
        materialize: materializeAudio,
        playFile: playDefaultFile,
        resolveNext: (query, excludeIds) => services.ncm.resolveNext({ query, excludeIds }),
      },
    });
    if (!outcome.ok) return res.status(outcome.status || 409).json({ ok: false, error: outcome.error });
    const { ok, ...body } = outcome;
    return res.json({ ok: true, ...body });
  }
  const id = randomUUID();
  const ack = remoteAcks.expect(id);
  broadcast({ kind: 'remoteControl', id, control: parsed.control });
  const result = await ack;
  if (!result.ok) return res.status(409).json({ ok: false, error: result.error || '没能控制' });
  return res.json({ ok: true, control: parsed.control });
});

app.get('/api/exclusive', (_req, res) => {
  res.json({ ok: true, ...exclusiveStatus() });
});

app.post('/api/voice', async (req, res) => {
  try {
    const bytes = decodeVoiceAudio(req.body?.audioBase64);
    const text = await transcribeAudio(bytes, String(req.body?.mime || 'audio/webm'));
    res.json({ ok: true, text });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || '没听清，再说一次' });
  }
});

app.get('/api/outputs', async (_req, res) => {
  try {
    res.json({ ok: true, ...(await services.listOutputs()) });
  } catch (error) {
    console.warn('[output]', error.message);
    res.status(500).json({ ok: false, error: '暂时列不出播放设备' });
  }
});

app.post('/api/outputs', async (req, res) => {
  try {
    const result = await services.selectOutput(String(req.body?.id || ''));
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    console.warn('[output]', error.message);
    res.status(500).json({ ok: false, error: '没能切换播放设备' });
  }
});

// 网页（web/，两版同一份）先问这个，决定露出哪些控件、加载哪个播放引擎（web/boot.js）
app.get('/api/mode', (_req, res) => res.json({
  mode: 'personal',
  features: { settings: true, dislike: true, prev: true, stop: true, outputs: true, sleep: true, voice: true, meter: true, webFonts: true, drive: true, driveSync: true },
  version: appVersion(),
}));
app.get('/api/status', (_req, res) => res.json({
  ok: true, nextReady: Boolean(episodeBuffer.snapshot().buffered), buffered: episodeBuffer.snapshot().buffered, epoch: episodeBuffer.snapshot().epoch, generating: episodeBuffer.snapshot().generating, weather: getWeather(),
  next: slimEp(episodeBuffer.snapshot().next), current: slimEp(currentEpisode),
  llm: (() => {
    const settings = getSettings();
    return {
      provider: settings.llm.provider,
      model: settings.llm.models[settings.llm.provider],
    };
  })(),
  tts: (() => {
    const { tts } = getSettings();
    return { provider: tts.provider, model: tts.provider === 'pc5090' ? tts.pc5090.voice : tts.fish.model };
  })(),
  ncm: {
    base: config.ncm.base,
    level: getSettings().playback.quality,
  },
  // 设备菜单、单独送音箱都靠 macOS 的音频系统
  features: { outputs: process.platform === 'darwin' },
}));

app.post('/api/fav', (req, res) => {
  const { title, artist, remove = false, discoveryType } = req.body ?? {};
  if (!title) return res.status(400).json({ ok: false, error: '缺少歌名' });
  if (remove) {
    const result = favoritesStore.forgetSong({ title, artist });
    state.removeFav({ title, artist });
    logEvent({ type: 'unfavorite', song: { title, artist }, source: 'button', discoveryType });
    noteTasteChanged();
    return res.json({ ok: true, removed: result.removed });
  }
  const count = state.addFav({ title, artist });
  logEvent({ type: 'favorite', song: { title, artist }, source: 'button', discoveryType });
  const remembered = artist ? favoritesStore.rememberSong({ title, artist }) : null;
  noteTasteChanged();
  console.log(`[收藏] ${title} — ${artist}（曲库 ${remembered?.total ?? count} 首，${remembered?.added ? '新记下' : '已在库里'}）`);
  res.json({ ok: true, count, added: remembered?.added ?? 0 });
});

app.get('/api/next', async (req, res) => {
  const claimId = String(req.query.claimId || '');
  if (!claimId) return res.status(400).json({ ok: false, error: '缺少领取编号' });
  try {
    const ep = await takeEpisode(claimId);
    if (!ep) return res.status(202).json({ ok: false, busy: true });
    res.json({ ok: true, claimId, episode: ep });
  } catch (error) {
    res.status(500).json({ ok: false, error: clientError(error) });
  }
});
app.post('/api/sleep', (_req, res) => { episodeBuffer.idle(); res.json({ ok: true }); });
// 驾驶模式开关（网页开着时每隔一会儿再报一次）
// 开驾驶模式时备好的节目不作废（作废了按「下一首」要等现场重新生成），只把口播改成一句、重新合成；
// 之后新备的节目按驾驶模式写。关掉时已改短的就短着放，后面的照常。
app.post('/api/drive', (req, res) => {
  if (driveState.set(req.body?.on === true) && driveState.on()) {
    episodeBuffer.reviseSays(oneSentence, (say) => ttsText(say, toneFor('drive')));
  }
  res.json({ ok: true, on: driveState.on() });
});
app.post('/api/episode/release', (req, res) => res.json({ ok: true, released: episodeBuffer.release(String(req.body?.claimId || '')) }));
app.post('/api/episode/started', (req, res) => {
  try {
    const ep = episodeBuffer.start(req.body?.id, req.body?.claimId);
    res.json({ ok: true, id: ep.id });
  } catch (error) { res.status(409).json({ ok: false, error: clientError(error) }); }
});
app.get('/api/episode/:id/voice', (req, res) => res.json(episodeBuffer.getVoice(req.params.id)));
app.get('/api/filler', async (req, res) => {
  try {
    const item = await filler.take(String(req.query.exclude || '').split(',').filter(Boolean));
    res.json(item ? { ok: true, item } : { ok: false, error: '暂时没有可用的垫场歌' });
  } catch { res.json({ ok: false, error: '暂时没有可用的垫场歌' }); }
});
app.get('/media/:id', (req, res) => {
  const info = services.cache.info(req.params.id);
  if (!info) return res.status(404).end();
  services.cache.resolve(req.params.id);
  res.type(info.contentType).sendFile(info.file);
});
app.post('/api/outputs/bluetooth-settings', async (_req, res) => {
  try {
    const result = await services.openBluetoothSettings();
    res.status(result?.ok === false ? 500 : 200).json(result || { ok: true });
  }
  catch { res.status(500).json({ ok: false, error: '没能打开蓝牙设置' }); }
});

// 注：后端播放引擎（`/api/player/*` + server/player.js）已于 2026-06-07 移除——播放回到前端（浏览器/窗口用 <audio> 放歌）。
//     后端只当大脑 + API：聊天/选歌走 /api/chat，换歌走 /api/next。

// ── WS /stream：推 now-playing / 字幕 / 状态 ──
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/stream' });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ kind: 'hello', epoch: episodeBuffer.snapshot().epoch, buffered: episodeBuffer.snapshot().buffered, episode: currentEpisode, nextReady: Boolean(episodeBuffer.snapshot().buffered) }));
  ensureNext();
  episodeBuffer.retryVoices();
  void filler.fill();
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg?.kind === 'remoteAck') remoteAcks.receive(msg);
  });
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// 5090 语音档冷启动约 2 分钟，界面据此显示「语音启动中」。
pc5090LaneEvents.on('status', (status) => {
  ttsLaneState = status.state;
  broadcast({ kind: 'ttsLane', ...status });
  if (status.state === 'ready') episodeBuffer.retryVoices();
});
const voiceRetryController = new AbortController();
const voiceRetryTimer = setInterval(async () => {
  if (!clients.size) return;
  // 重连隧道并探测健康，不为定时检查切换 GPU 档位。
  if (getSettings().tts.provider === 'pc5090' && ttsLaneState !== 'ready') {
    await services.probeTtsLane({ signal: voiceRetryController.signal }).catch(() => {});
  }
  if (voiceRetryController.signal.aborted || !clients.size) return;
  episodeBuffer.retryVoices(); ensureNext(); void filler.fill();
}, 60000);
voiceRetryTimer.unref();

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const ws of clients) {
    try { ws.send(s); } catch { clients.delete(ws); }
  }
}

// 8099 名额服务顺带给公用版念一句短口播：只在语音用 5090 且老板这边闲着时（见 pc5090.synthesizeIfIdle）
void ncm.sources.ready();
if (process.env.CLAUDIO_NO_LISTEN !== '1') ncm.startSharedLimitServer(undefined, {
  tts: (text) => (getSettings().tts.provider === 'pc5090' ? synthesizeGuestLine(text, { timeout: 20_000 }) : null),
});
if (process.env.CLAUDIO_NO_LISTEN !== '1') server.listen(config.port, config.host || undefined, () => {
  console.log(`🎙️  Claudio on http://${config.host || 'localhost'}:${config.port}  (TTS=${getSettings().tts.provider}, NCM=${config.ncm.base})`);
  startWeather(); // 后台拉天气 + 每 30 分钟刷新（注入选歌 prompt）
  // 定期检查只更新发现池，新池从下一期生效。
  setInterval(() => {
    ncm.withNcmSource('pool', () => ensureDiscoveryPool()).catch((error) => console.warn('[discovery]', error.message));
  }, 60 * 60 * 1000).unref();
  warmPc5090();
  ncm.withNcmSource('pool', () => ensureDiscoveryPool())
    .then((result) => {
      if (!result?.refreshed) return;
      episodeBuffer.invalidate();
      setTimeout(ensureNext, 20);
    })
    .catch((error) => console.warn('[discovery]', error.message));
  ensureNext(); // 启动即预热第一期；发现池若刚重建，这一期会被丢掉并按新池重做
  // 节律默认关闭（老板：只手动触发）；SCHEDULER_ENABLED=1 才开 07:00 规划 / 09:00 早间 / 整点情绪
  if (config.scheduler.enabled) {
    startScheduler({ onTrigger: onScheduled });
    console.log('[scheduler] 已启用');
  } else {
    console.log('[scheduler] 未启用（只手动触发；.env SCHEDULER_ENABLED=1 可开）');
  }
});

function shutdown(signal) {
  console.log(`[runtime] 收到 ${signal}，正在关闭 Claudio`);
  episodeBuffer.dispose();
  activeChat?.controller.abort();
  activeRemote?.controller.abort();
  filler.invalidate();
  clearInterval(voiceRetryTimer);
  voiceRetryController.abort();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 1500).unref();
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

export { app, server, wss, episodeBuffer, favoritesStore, filler, onScheduled };
export function closeRuntime() {
  clearInterval(voiceRetryTimer);
  voiceRetryController.abort();
  episodeBuffer.dispose();
  activeChat?.controller.abort();
  activeRemote?.controller.abort();
  filler.invalidate();
  for (const job of cachedDownloads.values()) job.controller.abort();
}
