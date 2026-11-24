import { resolveAirPlayMode, resolveAudioEngine } from './airplay.js';
import { executePlayerAction } from './player-actions.js';
import { classifyPlaybackFault } from './playback-fault.js';
import { SAY_LEAD_S } from './say-sync.js';
import { attachVoice } from './voice-stream.js';
import { deviceIdentity } from './handoff.js';
import { listenForAnswer, withoutAsk, REC_ASK_TAIL, REC_STASHED_LINE } from './rec-ask.js';
import { envelopeValue, equalPower, crossfadeDuration, mediaDeadline, waitForPlaying, waitForCanPlay } from './transitions.js';
import { parseLrc, createLyricView, startLyricClock, LYRIC_LEAD } from './lyrics.js';
import { typewriter, renderStatic } from './subtitle.js';
import { createCovers, createChatStrip, wireImmersive, BUBBLE_LINE, fmtTime, paintProgress, seekFraction, paintHeart, onEnter, paintQuality } from './ui.js';

// Claudio · 点阵电台播放器
// 两路音乐与独立口播混音；声音编排不依赖窗口绘制。
const $ = (id) => document.getElementById(id);
const el = {};
[
  'nowTitle', 'nowMeta', 'nowState', 'nowQuality',
  'prevBtn', 'playBtn', 'nextBtn', 'stopBtn', 'dislikeBtn', 'favBtn', 'vol',
  'curTime', 'durTime', 'bar', 'barFill', 'queueCount',
  'liveTag', 'lanePill', 'laneText', 'chatMode', 'chatModeTag', 'chatModeExit', 'driveListen', 'connMsg', 'stream', 'nowPlaying', 'moodInput', 'voiceBtn', 'sleepBtn', 'sleepBadge', 'sendBtn', 'connState',
  'meter', 'bdA', 'bdB', 'chat', 'chatLog', 'chatToggle', 'memoryPanel', 'memoryText',
  'fullscreenBtn', 'airplayBtn',
  'settingsBtn', 'settingsBackdrop', 'settingsClose', 'settingsResult', 'saveSettingsBtn',
  'providerSeg', 'ttsSeg', 'modeSeg', 'themeSeg', 'llmWarn',
  'localBaseUrl', 'localModel', 'localLlmApiKey', 'claudeModelSelect', 'deepseekModelSelect', 'deepseekApiKey',
  'testModelBtn', 'modelResult',
  'pc5090BaseUrl', 'pc5090Voice', 'fishApiKey', 'fishModelSelect', 'fishVoiceId', 'fishBalance', 'fishBalanceVal',
  'testTtsBtn', 'ttsResult', 'ttsPreview',
  'audioQualitySelect', 'toneExtensionField', 'toneExtensionLabel', 'toneExtensionSelect', 'talkSelect', 'favoritesCount', 'favoritePlaylistInput', 'importFavoritesBtn', 'favoritesImportResult', 'banList',
  'profileSummary', 'refreshProfileBtn',
].forEach((id) => (el[id] = $(id)));
const progressEls = { fill: el.barFill, cur: el.curTime, dur: el.durTime };

let settingsPayload = null;
let exclusiveSink = null;
let exclusiveTimer = null;
let exclusiveGen = 0;
let exclusiveHolder = null, exclusiveRequest = null;
let exclusiveResumeIdx = -1;
let chooseOutput = async () => {};
const exclusiveClock = {
  currentTime: 0,
  duration: NaN,
  paused: true,
  readyState: 0,
  listeners: new Map(),
  addEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    list.push(fn);
    this.listeners.set(type, list);
  },
  removeEventListener(type, fn) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== fn));
  },
  emit(type) {
    for (const fn of this.listeners.get(type) || []) fn();
  },
};
let earOrigin = 0;
let earKind = '';

function beginEar(kind) {
  earOrigin = performance.now();
  earKind = kind;
}

function clearEar() {
  earOrigin = 0;
  earKind = '';
}

function reportEar(kind, phase, { action = '', clear = false } = {}) {
  if (!earOrigin) return;
  const earMs = Math.round(performance.now() - earOrigin);
  const reportedKind = kind || earKind;
  if (clear) clearEar();
  if (!reportedKind) return;
  fetch('/api/timing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: reportedKind, phase, earMs, action }),
  }).catch(() => {});
}

// ── 设置：大脑 / 语音 / 推荐 / 音质 / 曲库 / 记忆 ──
const PROVIDER_NAMES = { local: '本地盒子', claude: 'Claude', deepseek: 'DeepSeek' };
const OPTION_LABELS = {
  sonnet: 'Sonnet', opus: 'Opus',
  'deepseek-flash': 'V4.1 Flash', 'deepseek-v4-pro': 'V4 Pro',
  s1: 'S1', 's2-pro': 'S2-Pro',
  standard: '标准', higher: '较高', exhigh: '极高', lossless: '无损', hires: 'Hi-Res',
};
const FISH_RECHARGE = 'https://fish.audio/zh-CN/app/developers/';
const seconds = (ms) => (ms / 1000).toFixed(1);

function showResult(node, text, kind = '') {
  node.textContent = text;
  node.className = `result ${kind}`.trim();
}
async function sendJson(url, method, body, fallback) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const data = await (await fetch(url, init)).json();
  if (!data.ok) throw new Error(data.error || fallback);
  return data;
}

// 分段按钮：同一组里只有一个 aria-checked=true
function segValue(box) {
  return box.querySelector('[aria-checked="true"]')?.dataset.value || '';
}
function segSelect(box, value) {
  box.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === value)));
}
function onSeg(box, handler) {
  box.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || button.getAttribute('aria-checked') === 'true') return;
    segSelect(box, button.dataset.value);
    handler(button.dataset.value);
  });
}
function fillSelect(select, ids, selected) {
  const list = !selected || ids.includes(selected) ? ids : [selected, ...ids];
  select.replaceChildren(...list.map((id) => new Option(OPTION_LABELS[id] || id, id)));
  select.value = list.includes(selected) ? selected : list[0];
}
// 每组分段按钮对应的面板：[data-for=分段 id][data-pane=值]
function syncPanes(box) {
  const value = segValue(box);
  document.querySelectorAll(`[data-for="${box.id}"]`).forEach((pane) => pane.classList.toggle('hidden', pane.dataset.pane !== value));
}
function syncSettingsPanes() {
  syncPanes(el.providerSeg);
  syncPanes(el.ttsSeg);
  const provider = segValue(el.providerSeg);
  el.llmWarn.classList.toggle('hidden', settingsPayload?.availability?.[provider] !== false);
  el.llmWarn.textContent = provider === 'claude' ? '没找到 claude 命令' : '还没填 API Key';
}
function paintCredentials() {
  const { credentials } = settingsPayload;
  for (const [input, ready] of [
    [el.localLlmApiKey, credentials.local],
    [el.deepseekApiKey, credentials.deepseek],
    [el.fishApiKey, credentials.fish],
  ]) {
    input.value = '';
    input.placeholder = ready ? '已配置 · 留空不改' : '未配置';
  }
}
function paintSettings() {
  const { llm, tts, recommendation, playback, options } = settingsPayload;
  segSelect(el.providerSeg, llm.provider);
  el.localBaseUrl.value = llm.local.baseUrl;
  el.localModel.value = llm.models.local;
  fillSelect(el.claudeModelSelect, options.claudeModels, llm.models.claude);
  fillSelect(el.deepseekModelSelect, options.deepseekModels, llm.models.deepseek);
  segSelect(el.ttsSeg, tts.provider);
  el.pc5090BaseUrl.value = tts.pc5090.baseUrl;
  el.pc5090Voice.value = tts.pc5090.voice;
  fillSelect(el.fishModelSelect, options.fishModels, tts.fish.model);
  el.fishVoiceId.value = tts.fish.referenceId || '';
  segSelect(el.modeSeg, recommendation.mode);
  fillSelect(el.audioQualitySelect, options.audioQualities, playback.quality);
  // 本地语气扩展：数据目录里有那个文件才出现，名字也由文件定
  const extension = settingsPayload.toneExtension;
  el.toneExtensionField.classList.toggle('hidden', !extension);
  el.toneExtensionLabel.textContent = extension?.label || '';
  el.toneExtensionSelect.value = settingsPayload.voice?.toneExtension === false ? 'off' : 'on';
  el.talkSelect.value = settingsPayload.voice?.talk || 'normal';
  paintCredentials();
  syncSettingsPanes();
  loadFishCredit();
}

// Fish 余额只在设置里看：有 Key 才查，低于 $1 标红，点一下去充值
async function loadFishCredit() {
  el.fishBalance.classList.add('hidden');
  if (segValue(el.ttsSeg) !== 'fish' || !settingsPayload?.credentials.fish) return;
  try {
    const j = await (await fetch('/api/fish-credit')).json();
    const credit = j.ok && j.credit != null ? Number(j.credit) : NaN;
    el.fishBalanceVal.textContent = Number.isFinite(credit) ? `$${credit.toFixed(2)}` : '读不到';
    el.fishBalance.classList.toggle('low', Number.isFinite(credit) && credit < 1);
    el.fishBalance.title = Number.isFinite(credit) ? '去充值' : String(j.error || '');
    el.fishBalance.classList.remove('hidden');
  } catch { /* 余额只是参考，读不到就不显示 */ }
}
async function loadSettings() {
  try {
    const data = await (await fetch('/api/settings')).json();
    if (!data.ok) throw new Error(data.error || '读取失败');
    settingsPayload = data.settings;
    paintSettings();
  } catch (error) {
    showResult(el.settingsResult, `设置读取失败：${error.message}`, 'error');
  }
}
async function saveSettings({ quiet = false } = {}) {
  newGeneration({ preserveMusic: true });
  if (!settingsPayload) {
    showResult(el.settingsResult, '设置还没读到，稍后再试', 'error');
    return false;
  }
  try {
    // 密钥先存：空串 = 保持原值，界面不回显
    await sendJson('/api/settings/credentials', 'PATCH', {
      deepseekApiKey: el.deepseekApiKey.value,
      fishApiKey: el.fishApiKey.value,
      localLlmApiKey: el.localLlmApiKey.value,
    }, '密钥保存失败');
    const data = await sendJson('/api/settings', 'PATCH', {
      llm: {
        provider: segValue(el.providerSeg),
        models: {
          local: el.localModel.value,
          claude: el.claudeModelSelect.value,
          deepseek: el.deepseekModelSelect.value,
        },
        local: { baseUrl: el.localBaseUrl.value },
      },
      tts: {
        provider: segValue(el.ttsSeg),
        fish: { model: el.fishModelSelect.value, referenceId: el.fishVoiceId.value },
        pc5090: { baseUrl: el.pc5090BaseUrl.value, voice: el.pc5090Voice.value },
      },
      recommendation: { mode: segValue(el.modeSeg) },
      playback: { quality: el.audioQualitySelect.value },
      voice: { talk: el.talkSelect.value, ...(settingsPayload.toneExtension ? { toneExtension: el.toneExtensionSelect.value !== 'off' } : {}) },
    }, '保存失败');
    settingsPayload = data.settings;
    paintSettings();
    if (!quiet) showResult(el.settingsResult, '已保存，从下一次推荐开始生效', 'ok');
    return true;
  } catch (error) {
    showResult(el.settingsResult, `保存失败：${error.message}`, 'error');
    return false;
  }
}
async function loadProfileSummary() {
  el.profileSummary.textContent = '正在读取…';
  try {
    const data = await (await fetch('/api/profile')).json();
    if (!data.ok) throw new Error(data.error || '读取失败');
    const profile = data.profile;
    const artists = profile.topArtists.filter((item) => item.score > 0).slice(0, 6)
      .map((item) => `${item.artist} ${item.score > 0 ? '+' : ''}${item.score}`).join(' · ');
    const memories = profile.stableMemories.slice(-5).map((item) => `• ${item.value}`).join('\n');
    el.profileSummary.textContent = [
      artists ? `目前偏好的歌手方向：${artists}` : '还没有足够的真实听歌行为，先从口味档案开始。',
      memories || '稳定记忆尚在积累；模型推断需要至少两次独立证据才会确认。',
      profile.pendingMemoryCount ? `另有 ${profile.pendingMemoryCount} 条候选记忆等待更多证据。` : '',
    ].filter(Boolean).join('\n');
  } catch (error) {
    el.profileSummary.textContent = `画像读取失败：${error.message}`;
  }
}
async function loadBans() {
  if (!el.banList) return;
  try {
    const data = await (await fetch('/api/bans')).json();
    const songs = Array.isArray(data.songs) ? data.songs : [];
    el.banList.replaceChildren();
    if (!songs.length) {
      el.banList.textContent = '还没有禁播的歌。';
      return;
    }
    for (const song of songs) {
      const row = document.createElement('div');
      row.className = 'ban-row';
      const label = document.createElement('span');
      label.textContent = song.artist ? `${song.title} — ${song.artist}` : song.title;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '恢复';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await fetch('/api/bans/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: song.title, artist: song.artist }),
          });
        } catch { /* 下次打开再读 */ }
        loadBans();
      });
      row.append(label, button);
      el.banList.append(row);
    }
  } catch {
    el.banList.textContent = '禁播清单读不出来。';
  }
}
async function loadFavoritesSummary() {
  try {
    const data = await (await fetch('/api/favorites')).json();
    if (!data.ok) throw new Error(data.error || '读取失败');
    el.favoritesCount.textContent = `${data.total} 首`;
  } catch {
    el.favoritesCount.textContent = '读取失败';
  }
}
function openSettings() {
  el.settingsBackdrop.classList.remove('hidden');
  el.settingsBackdrop.setAttribute('aria-hidden', 'false');
  showResult(el.settingsResult, '');
  loadSettings();
  loadFavoritesSummary();
  loadProfileSummary();
  loadBans();
  idleHider.refresh();
}
function closeSettings() {
  el.ttsPreview.pause();
  el.settingsBackdrop.classList.add('hidden');
  el.settingsBackdrop.setAttribute('aria-hidden', 'true');
  idleHider.refresh();
}
el.settingsBtn.addEventListener('click', openSettings);
el.settingsClose.addEventListener('click', closeSettings);
el.settingsBackdrop.addEventListener('click', (event) => { if (event.target === el.settingsBackdrop) closeSettings(); });
onSeg(el.providerSeg, syncSettingsPanes);
onSeg(el.ttsSeg, () => { syncSettingsPanes(); loadFishCredit(); });
el.fishBalance.addEventListener('click', () => window.open(FISH_RECHARGE, '_blank', 'noopener'));
el.saveSettingsBtn.addEventListener('click', () => saveSettings());
el.refreshProfileBtn.addEventListener('click', loadProfileSummary);
el.importFavoritesBtn.addEventListener('click', async () => {
  const playlist = el.favoritePlaylistInput.value.trim();
  if (!playlist) return showResult(el.favoritesImportResult, '请先粘贴网易云歌单链接或歌单 ID。', 'error');
  el.importFavoritesBtn.disabled = true;
  showResult(el.favoritesImportResult, '正在读取歌单并合并…', 'pending');
  try {
    const data = await sendJson('/api/favorites/import', 'POST', { playlist }, '导入失败');
    el.favoritePlaylistInput.value = '';
    el.favoritesCount.textContent = `${data.total} 首`;
    showResult(el.favoritesImportResult, `导入完成：读取 ${data.received} 首，新增 ${data.added} 首，跳过重复 ${data.duplicates} 首。`, 'ok');
  } catch (error) {
    showResult(el.favoritesImportResult, `导入失败：${error.message}`, 'error');
  } finally {
    el.importFavoritesBtn.disabled = false;
  }
});
el.testModelBtn.addEventListener('click', async () => {
  el.testModelBtn.disabled = true;
  showResult(el.modelResult, '正在测速…', 'pending');
  try {
    if (!await saveSettings({ quiet: true })) throw new Error('设置没存上');
    const { timing } = await sendJson('/api/settings/test', 'POST', undefined, '测速失败');
    showResult(el.modelResult, `${PROVIDER_NAMES[timing.provider] || timing.provider} · 首字 ${seconds(timing.firstTextMs)} 秒 · 完成 ${seconds(timing.totalMs)} 秒`, 'ok');
    el.modelResult.title = timing.model;
  } catch (error) {
    showResult(el.modelResult, `测速失败：${error.message}`, 'error');
  } finally {
    el.testModelBtn.disabled = false;
  }
});
// 5090 冷启动要两分钟左右：等的时候给等待态，不是错误
el.testTtsBtn.addEventListener('click', async () => {
  const provider = segValue(el.ttsSeg);
  el.testTtsBtn.disabled = true;
  el.ttsPreview.pause();
  el.ttsPreview.classList.add('hidden');
  showResult(el.ttsResult, provider === 'pc5090' ? '合成中，冷启动要等约两分钟…' : '合成中…', 'pending');
  try {
    if (!await saveSettings({ quiet: true })) throw new Error('设置没存上');
    const endpoint = provider === 'fish' ? '/api/settings/test-fish' : '/api/settings/test-pc5090-tts';
    const data = await sendJson(endpoint, 'POST', undefined, '试听失败');
    el.ttsPreview.src = data.audioUrl;
    el.ttsPreview.classList.remove('hidden');
    const { firstAudioMs, totalMs, hasVoice } = data.timing;
    showResult(el.ttsResult, `开口 ${seconds(firstAudioMs)} 秒 · 完成 ${seconds(totalMs)} 秒${hasVoice ? '' : ' · 未设音色'}`, 'ok');
    try { await el.ttsPreview.play(); } catch { /* WebView 阻止自动播放时保留手动播放控件 */ }
    if (provider === 'fish') loadFishCredit();
  } catch (error) {
    showResult(el.ttsResult, `试听失败：${error.message}`, 'error');
  } finally {
    el.testTtsBtn.disabled = false;
  }
});

// ── 外观 ──
function applyTheme(theme) {
  const apply = () => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('claudio-theme', theme);
    segSelect(el.themeSeg, theme);
    readMeterColors();
    lyricView?.recenter();
  };
  // 支持的浏览器用 View Transitions 做柔和揭示，不支持则即时切换（零风险回退）
  if (document.startViewTransition) document.startViewTransition(apply);
  else apply();
}
const savedTheme = localStorage.getItem('claudio-theme') === 'light' ? 'light' : 'dark';
document.documentElement.dataset.theme = savedTheme;
segSelect(el.themeSeg, savedTheme);
onSeg(el.themeSeg, applyTheme);

// ── 封面 / 曲目头：缩略图、宽窗大图、迷你条共用一张；背景另起两层交叉淡入 ──
const covers = createCovers({ imgs: [...document.querySelectorAll('.cover-img')], bdA: el.bdA, bdB: el.bdB });
const paintThumbs = covers.paintThumbs;
const setBackdrop = covers.setBackdrop;
function setNowPlaying(title, { artist = '', facts = '', cover = '', quality = null } = {}) {
  el.nowTitle.textContent = title;
  el.nowMeta.textContent = [artist, facts].filter(Boolean).join(' · ');
  paintQuality(el.nowQuality, quality);
  paintThumbs(cover);
}

// ── 对话条：这次打开以来，老板说了什么、Claudio 答了什么（只在界面里，不落盘）──
const chatStrip = createChatStrip({ chat: el.chat, log: el.chatLog, toggle: el.chatToggle, onChange: () => idleHider.refresh() });
const logChat = chatStrip.add;
const setChatOpen = chatStrip.setOpen;

// ── 语音通道提示：5090 冷启动约两分钟，顶栏据此显示 ──
let laneTimer = null;
let laneStarting = false;
function showLane(state, message = '') {
  const texts = { starting: '5090 语音启动中', busy: '5090 在忙', ready: '语音就绪' };
  if (!(state in texts) && state !== 'error') return;
  clearTimeout(laneTimer);
  laneStarting = state === 'starting';
  // 聊天还在等口播开口：5090 冷启动要两分钟，这次不等了先放歌；起来了或出错，从现在起再给正常的等待
  if (watchdog && !responseHeard) {
    if (laneStarting && streamPending) skipChatVoice();
    else armWatchdog(CHAT_VOICE_WAIT_MS, true);
  }
  el.lanePill.dataset.state = state;
  el.laneText.textContent = texts[state] || String(message || '语音出错').slice(0, 40);
  el.lanePill.title = state === 'error' ? String(message || '') : '';
  el.lanePill.classList.remove('hidden');
  const holdMs = { ready: 2500, busy: 8000, error: 8000 }[state] ?? 240000; // 忙碌短显；启动中最多保留 4 分钟
  laneTimer = setTimeout(() => { laneStarting = false; el.lanePill.classList.add('hidden'); }, holdMs);
}

// （已去掉中/外切换：默认中文女声口播，选歌不限语言、看情况混搭）

// ── 播放引擎 ──
const MUSIC_LEAD = 6; // 口播结束前多少秒，下一首歌以背景音垫进来（老板要 5~6 秒）
const BG_VOL = 0.13; // 口播/交互时音乐压到的背景音量（约 13%，让口播更突出）
const SAY_GAIN = 1.25; // 口播增益：TTS 人声 RMS 比音乐低，用 GainNode 放大到 1.25x 提响（element.volume 上限 1.0 做不到）
// 聊天模式（事项 24）：聊着天时歌压到 CHAT_BED，没人说话 CHAT_IDLE_MS 后回到正常音量。数从 /api/mode 来
const MODE_CFG = globalThis.claudioMode || {};
const CHAT_MODE = Boolean(MODE_CFG.features?.chatMode);
const CHAT_BED = Math.min(1, Math.max(0, Number(MODE_CFG.chat?.bed ?? 0.25)));
const CHAT_IDLE_MS = Math.max(5000, Number(MODE_CFG.chat?.idleMs ?? 45000));
const chatState = { on: false, bed: false, timer: null };
// iPhone / iPad 的 Safari 不让网页改 <audio> 的音量。直连输出（没接 WebAudio）时压低和交叉淡入都不生效，
// 所以：念口播时先停歌、念完从原处接着放；换歌不重叠，上一首放完再接下一首（volumeFixed）。
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IOS_GAP_S = 0.3; // 上一首还剩这么多秒时接下一首（尾巴几乎是静音）
const SLEEP_CHOICES = [15, 30, 45, 60, 90]; // 睡眠定时可选分钟
const SLEEP_FADE_MS = 8000; // 到点淡出时长
const SLEEP_KEY = 'claudio-sleep'; // 刷新后定时还在
const musicA = new Audio(), musicB = new Audio(), voice = new Audio();
const mediaTracks = [musicA, musicB, voice];
// 口播放慢到 0.9 倍、不变调（2026-11-22 老板听样本定：5090 的音色念得偏快）
const VOICE_RATE = 0.9;
voice.defaultPlaybackRate = VOICE_RATE;
voice.playbackRate = VOICE_RATE;
// 口播的逻辑地址：边收边播时 <audio> 的 src 是 blob:，比较要看这个。
let voiceSrc = '';
let voiceFeed = null;
function setVoiceSource(url, { preload = false } = {}) {
  if (voiceSrc === url) return;
  voice.pause();
  voiceFeed?.abort();
  voiceSrc = url;
  voiceFeed = attachVoice(voice, url, { onFallback: (why) => console.warn('[voice] 边收边播没开成，改直接放：', why) });
  if (preload && voiceFeed.mode === 'direct') voice.load();
  voice.playbackRate = VOICE_RATE;
}
voice.preservesPitch = true;
mediaTracks.forEach((a) => (a.preload = 'auto'));
let active = musicA, idle = musicB;
const hasWebkitPicker = typeof musicA.webkitShowPlaybackTargetPicker === 'function';
const AUDIO_ENGINE = (() => {
  let stored = '';
  try { stored = localStorage.getItem('claudio-audio') || ''; } catch {}
  const engine = resolveAudioEngine(location.search, stored);
  try { localStorage.setItem('claudio-audio', engine); } catch {}
  return engine;
})();
const AIRPLAY_MODE = resolveAirPlayMode({
  webAudio: AUDIO_ENGINE === 'webaudio',
  webkitPicker: hasWebkitPicker,
  outputMenu: !hasWebkitPicker,
});

// 歌曲直链跨域，走后端 /proxy 转成同源才能做真频谱；口播 /tts 本就同源不变
const proxyUrl = (u) => (typeof u === 'string' && /^https?:\/\//.test(u) && !u.startsWith(location.origin)) ? `/proxy?url=${encodeURIComponent(u)}` : u;

// WebAudio 真频谱：AudioContext + AnalyserNode 接三条音轨。须在用户手势内激活（autoplay 同款限制）；
// 三个 MediaElementSource 都汇入同一 analyser → destination，交叉淡入两轨同响时是混合频谱（正合适）。
let actx = null, analyser = null, freqData = null;
const sourced = new WeakSet(); // 记录已建过 MediaElementSource 的轨：同一 audio 元素重复 createMediaElementSource 会抛错，只建一次
const gains = new WeakMap();   // track → GainNode：音量走 gain。关键——Safari（WebKit）里音频一旦接入 WebAudio 图，element.volume 对输出无效，必须用 GainNode 控音量
const volMap = new WeakMap();  // track → 意向音量 0~1：读音量的真源（element.volume 被 gain 接管后不再可靠）
function trackVol(track) { return volMap.has(track) ? volMap.get(track) : track.volume; }
function volumeFixed() { return IS_IOS && !gains.get(musicA); }
function setTrackVol(track, v) {
  v = Math.max(0, v); // 允许 >1：GainNode 可放大（用于口播提响）；element.volume 回退路径下方再夹到 ≤1
  volMap.set(track, v);
  const g = gains.get(track);
  if (g) { try { g.gain.value = Math.min(v, 4); } catch {} if (track.volume !== 1) track.volume = 1; } // 走 gain（可 >1）；元素音量设满
  else track.volume = Math.min(1, v); // WebAudio 未起（或建图失败）→ 退回元素音量（上限 1.0）
}
function initAudio() {
  // AirPlay 必须让 HTMLMediaElement 保持原生直连输出；接进 WebAudio 后，
  // WebKit 的播放目标选择器可能能选设备却没有声音。直连模式仍保留音量、ducking、淡入淡出，
  // 波形自动使用已有的拟态回退。
  if (AIRPLAY_MODE.directMedia) return;
  if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    actx = new AC();
    analyser = actx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.8;
    freqData = new Uint8Array(analyser.frequencyBinCount);
    analyser.connect(actx.destination); // 先连输出再逐个接源——任一源创建后立即有声路径，不致静音双音轨皇冠
    for (const t of mediaTracks) {
      if (sourced.has(t)) continue; // 已建过源的轨不重复建（防部分失败后重入抛 InvalidStateError、FFT 永久退化）
      const src = actx.createMediaElementSource(t);
      const g = actx.createGain();
      g.gain.value = trackVol(t); // 继承当前意向音量（默认 1）
      src.connect(g).connect(analyser); // source → gain → analyser → destination：音量走 gain，Safari 里才真生效
      gains.set(t, g);
      t.volume = 1; // 元素音量交给 gain，自身设满
      sourced.add(t);
    }
  } catch (e) {
    console.warn('[audio] FFT 初始化失败，退回音量波形', e.message);
    actx = null; analyser = null;
  }
}
let queue = [], idx = -1;
let activeEpisode = null;
let started = false, busy = false, crossing = false;
let masterVol = 1;
let sleepEnd = null, sleepAfterTrack = false, sleepTimer = null, sleepBadgeTimer = null;
let ducked = false; // 只有语音可播后才压低音乐
let overlaying = false; // 口播独占 voice，active 始终是当前显示的音乐
let streamingActive = false; // 本次交互是否走流式（WS sayReady/episode 驱动）
let streamPending = null; // 流式中后到的完整 episode（歌）
let sayEnded = false; // 口播是否已念完（在等歌）
let streamDone = false; // finishAfterSay 是否已执行（WS 与 HTTP 可能都触发，防重）
let responseHeard = false; // 本轮口播已出声，HTTP 失败不截断正在念的回复
let watchdog = null; // 看门狗：duck/overlay 后必须有界时间内接管或强制恢复，兜住所有失败路径
let sayOnEnd = null; // 当前 overlay 监听的 AbortController，重入时 abort，防泄漏与错时触发
const favs = new Set(JSON.parse(localStorage.getItem('claudio-favs') || '[]'));
const handledEpisodeActions = new Set();
const songSessions = new Map();
const lastSongStarts = new Map();

function reportListeningEvent(type, extra = {}) {
  fetch('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, ...extra }),
  }).catch(() => {});
}

function closeSongSession(reason = 'skip', track = active) {
  const session = songSessions.get(track);
  if (!session) return;
  songSessions.delete(track);
  const currentTime = Number(session.track.currentTime || 0);
  const duration = Number(session.track.duration || 0);
  if (reason !== 'skip' && reason !== 'completed') return;
  reportListeningEvent(reason === 'completed' ? 'play_completed' : 'skip', {
    song: session.song, listenedSec: currentTime, durationSec: duration,
    listenRatio: duration > 0 ? Math.min(1, currentTime / duration) : (reason === 'completed' ? 1 : 0),
    discoveryType: session.discoveryType,
  });
}

function startSongSession(item, track = active) {
  closeSongSession('completed', track);
  const song = { title: item.meta.title, artist: item.meta.artist };
  const key = `${song.title}|${song.artist}`;
  const discoveryType = item.meta.discoveryType || 'adjacent';
  // 换设备接着放的那首不算重听、也不算新开一首。
  if (!item.handoff && lastSongStarts.has(key)) reportListeningEvent('replay', { song, source: 'player', discoveryType });
  lastSongStarts.set(key, Date.now());
  songSessions.set(track, { song, track, discoveryType, progressSent: false });
  if (!item.handoff) reportListeningEvent('play_started', { song, discoveryType, source: 'player' });
}

function reportProgress(track, clock = track) {
  const session = songSessions.get(track);
  const { currentTime, duration } = clock;
  if (!session || session.progressSent || !(duration > 0) || currentTime / duration < 0.35) return;
  session.progressSent = true;
  reportListeningEvent('play_progress', {
    song: session.song, listenedSec: currentTime, durationSec: duration,
    listenRatio: currentTime / duration, discoveryType: session.discoveryType,
  });
}

const fmt = fmtTime;
const setState = (s) => { el.nowState.textContent = s; el.nowState.title = s; }; // 小状态条放不下的长句，悬停可读
// 播放 / 暂停图标由 CSS 按 body.playing 切换
const setPlayIcon = (p) => {
  document.body.classList.toggle('playing', p);
  el.playBtn.title = p ? '暂停' : '播放';
};
// 歌曲与口播各自的目标音量；直连输出时人声最终夹到 1。
const songVol = () => (chatBedOn() ? CHAT_BED : 1) * masterVol;
const sayVol = () => SAY_GAIN * masterVol;

// 每次用户接管都在点击时换代，旧请求和延迟回调不能再改播放器。
let playbackGen = 0;
let playbackController = new AbortController();
let paused = false, stopped = true;
let latestEpoch = 0;
const requests = { chat: null, claim: null, filler: null, voice: null };
const pendingTimers = new Set();
const pausedWork = new Map();
const envelopes = new Map();
const slots = new Map();
let musicFade = null;
let pendingEpisode = null, claimId = null, claimRetry = 0;
let claimTask = null, serverGeneration = 0;
const heldClaims = new Set();
const episodeClaims = new WeakMap();
const failedItems = new WeakSet();
let claimPoll = null, voicePoll = null;
let fillerItem = null, fillerPromise = null;
const recentFillers = [];
let voiceContext = null;
let currentRequestId = null, chatVoiceUrl = null, chatVoiceFailed = false;
let firstStartTimer = null;
let switching = false;
const uuid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const alive = (gen) => gen === playbackGen && !playbackController.signal.aborted;

let lyricView = null, displayedSong = null;
let subtitleCancel = null;
function musicElementForItem(item) {
  return [musicA, musicB].find((track) => {
    const slot = slots.get(track);
    return item && slot?.item === item && !slot.loading;
  }) || null;
}
function displayedSongClock() {
  return exclusiveSink?.uid ? exclusiveClock : musicElementForItem(displayedSong);
}
function currentSongItem() {
  const item = exclusiveSink?.uid ? queue[idx] : displayedSong || slots.get(active)?.item;
  return item?.type === 'song' ? item : null;
}
const lyricClock = startLyricClock({
  getTime: () => displayedSongClock()?.currentTime || 0,
  isActive: () => {
    const clock = displayedSongClock();
    return Boolean(displayedSong && lyricView && clock && !clock.paused && !overlaying && !paused && !stopped);
  },
  onTick: (t) => lyricView?.setTime(t),
});
function bindLyrics(host, song) {
  lyricView?.destroy();
  lyricView = null;
  displayedSong = song;
  if (host) {
    lyricView = createLyricView(host);
    lyricView.render(parseLrc(song?.meta.lyric));
    lyricView.setTime((displayedSongClock()?.currentTime || 0) + LYRIC_LEAD);
    lyricView.recenter();
    fetchMissingLyric(host, song);
  }
  lyricClock.refresh();
}
function fetchMissingLyric(host, song) {
  const meta = song?.meta;
  if (!meta?.id || meta.lyric || meta.lyricFetched) return;
  meta.lyricFetched = true;
  fetch(`/api/lyric?id=${encodeURIComponent(meta.id)}`).then((r) => r.json()).then((data) => {
    if (!data?.lyric || meta.lyric) return;
    meta.lyric = data.lyric;
    if (displayedSong === song && host.isConnected && !overlaying) bindLyrics(host, song);
  }).catch(() => {});
}
function cancelSubtitle() {
  subtitleCancel?.();
  subtitleCancel = null;
}
function showSubtitle(box, text, clock, duration = clock?.duration) {
  cancelSubtitle();
  subtitleCancel = typewriter(box, text, clock, { duration });
}
function clearStageView() {
  cancelSubtitle();
  lyricView?.destroy();
  lyricView = null; displayedSong = null;
  lyricClock.refresh();
}
function refreshLyrics() {
  if (!overlaying) lyricView?.setTime((displayedSongClock()?.currentTime || 0) + LYRIC_LEAD);
  lyricClock.refresh();
}
function recoverStage() {
  cancelSubtitle();
  // 垫歌失败不打断还在念的人声字幕。
  if (overlaying && voiceContext) showSubtitle(el.stream.querySelector('.bubble'), voiceContext.text, voice);
  else refreshLyrics();
}

function later(fn, ms, { gen = playbackGen, automatic = true, key } = {}) {
  const timer = setTimeout(() => {
    pendingTimers.delete(timer);
    if (!alive(gen)) return;
    if (automatic && paused) { pausedWork.set(key || timer, fn); return; }
    fn();
  }, ms);
  pendingTimers.add(timer);
  return timer;
}
function gated(key, fn) {
  if (paused) { pausedWork.set(key, fn); return; }
  fn();
}
function releaseClaim(holder, { notify = true } = {}) {
  if (!holder?.claimId || holder.started || holder.released) return;
  holder.released = true; heldClaims.delete(holder);
  if (exclusiveHolder === holder) stopExclusiveClient();
  for (const [track, slot] of slots) {
    if (slot.holder === holder && slot.loading) { slot.controller?.abort(); track.pause(); slots.delete(track); }
  }
  if (!notify) return;
  const source = serverGeneration;
  const send = async (attempt = 0) => {
    if (source !== serverGeneration) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch('/api/episode/release', {
        method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimId: holder.claimId }),
      });
      if (!res.ok) throw new Error('释放节目失败');
    } catch {
      // 换歌、停止后也要补发；服务重启后不再发送旧编号。
      if (attempt < 2 && source === serverGeneration) setTimeout(() => send(attempt + 1), 1000 * (attempt + 1));
    } finally { clearTimeout(timer); }
  };
  void send();
}
function abandonPending(options) {
  releaseClaim(pendingEpisode, options);
  // 取消中的 claim 也可能已在服务端领取，按同一 ID 释放。
  if (claimId && claimId !== pendingEpisode?.claimId) releaseClaim({ claimId }, options);
  pendingEpisode = null;
  claimId = null;
  claimTask = null;
  clearTimeout(claimPoll); clearTimeout(voicePoll);
  claimPoll = voicePoll = null;
}
function newGeneration({ preservePending = false, preserveMusic = false } = {}) {
  cancelSubtitle();
  const restoreStage = overlaying;
  applyEnvelopes();
  playbackGen += 1;
  playbackController.abort();
  playbackController = new AbortController();
  for (const request of Object.values(requests)) request?.abort();
  for (const key of Object.keys(requests)) requests[key] = null;
  for (const timer of pendingTimers) clearTimeout(timer);
  pendingTimers.clear(); pausedWork.clear(); switching = false;
  if (preserveMusic && paused) {
    for (const track of [...resumeTracks]) {
      if (track === active && slots.get(track)?.item?.type === 'song') {
        track.pause(); resumeVolumes.set(track, songVol());
      } else { resumeTracks.delete(track); resumeVolumes.delete(track); }
    }
  } else { resumeTracks.clear(); resumeVolumes.clear(); }
  fillerPromise = null;
  if (!preservePending) { abandonPending(); for (const holder of [...heldClaims]) releaseClaim(holder); }
  else { clearTimeout(claimPoll); claimPoll = null; } // 计时器上面已清掉，变量也清，不然再也不领下一期
  // 留着的下一期正等着念段间口播：口播停掉，节目留着，之后照常再念
  const keep = preservePending && voiceContext?.holder && voiceContext.holder === pendingEpisode;
  if (voiceContext && !voiceContext.holder?.started && !keep) releaseClaim(voiceContext.holder);
  sayOnEnd?.abort(); sayOnEnd = null;
  voiceContext = null; slots.delete(voice);
  releaseHeldMusic({ resume: preserveMusic });
  const tail = musicFade?.old;
  envelopes.clear(); musicFade = null; crossing = false;
  for (const track of [musicA, musicB]) {
    if (slots.get(track)?.loading) { track.pause(); slots.delete(track); }
    if (track === tail || (track !== active && !track.paused)) {
      track.pause(); closeSongSession('skip', track); slots.delete(track);
    }
  }
  if (!voice.paused) rampVolume(voice, 0, 350, () => voice.pause());
  if (!paused && !active.paused && !active.ended) rampVolume(active, songVol(), 300);
  disarmWatchdog();
  currentRequestId = null; chatVoiceUrl = null; chatVoiceFailed = false;
  streamingActive = false; streamPending = null; streamDone = false; sayEnded = false; responseHeard = false;
  overlaying = false; ducked = false;
  busy = false; lockUI(false);
  if (restoreStage) restoreAfterOverlay();
  lyricClock.refresh();
  return playbackGen;
}
function observeEpoch(epoch, keepClaim = false) {
  if (!Number.isFinite(epoch) || epoch <= latestEpoch) return;
  latestEpoch = epoch;
  fillerItem = null; requests.filler?.abort(); requests.filler = null; fillerPromise = null;
  if (!stopped) prefetchFiller();
  requests.claim?.abort(); requests.voice?.abort();
  requests.claim = requests.voice = null;
  if (!keepClaim) {
    if (pendingEpisode && pendingEpisode.episode.epoch < epoch) abandonPending();
    else if (!pendingEpisode) abandonPending();
  }
  for (const holder of [...heldClaims]) if (holder.episode.epoch < epoch) releaseClaim(holder);
  if (voiceContext?.holder && !voiceContext.holder.started && voiceContext.holder.episode.epoch < epoch) {
    releaseClaim(voiceContext.holder);
    sayOnEnd?.abort(); voice.pause(); voiceContext = null; unduck();
    resumeTracks.delete(voice); resumeVolumes.delete(voice); envelopes.delete(voice);
  }
  if (!keepClaim && started && !stopped && !pendingEpisode) scheduleClaim(0);
}
function observeServerEpoch(epoch) {
  if (!Number.isFinite(epoch) || epoch >= latestEpoch) { observeEpoch(epoch); return; }
  // 重启后的服务不认识旧领取，丢弃即可，不能发回释放。
  serverGeneration += 1;
  latestEpoch = epoch;
  requests.chat?.abort(); requests.claim?.abort(); requests.voice?.abort(); requests.filler?.abort();
  requests.chat = requests.claim = requests.voice = requests.filler = null;
  abandonPending({ notify: false });
  for (const holder of [...heldClaims]) releaseClaim(holder, { notify: false });
  if (voiceContext?.holder?.released) {
    sayOnEnd?.abort(); voice.pause(); voiceContext = null; unduck();
    resumeTracks.delete(voice); resumeVolumes.delete(voice); envelopes.delete(voice);
  }
  fillerItem = null; fillerPromise = null; emptyStreak = 0; claimRetry = 0;
  if (currentRequestId) { failChat('电台已重新连接，音乐继续'); busy = false; lockUI(false); }
  if (started && !stopped) {
    prefetchFiller(); scheduleClaim(0);
    if (!soundingMusic()) ensureFiller();
  }
}
function acceptEpisode(ep) {
  observeEpoch(ep?.epoch);
  return ep && (!Number.isFinite(ep.epoch) || ep.epoch >= latestEpoch);
}
function markStarted(holder) {
  if (!holder || holder.started || holder.released || !acceptEpisode(holder.episode)) return;
  holder.started = true; heldClaims.delete(holder);
  const gen = playbackGen;
  const send = async (retry = false) => {
    if (!alive(gen)) return;
    try {
      const res = await fetch('/api/episode/started', {
        method: 'POST', signal: playbackController.signal,
        headers: { 'Content-Type': 'application/json' },
        // recAsk：朋友推荐那期由网页问「要听吗」、歌真响了再报 played（旧网页不带，服务端照旧开口就算已播）
        body: JSON.stringify({ id: holder.episode.id, claimId: holder.claimId, ...(holder.episode.friendRec ? { recAsk: true } : {}) }),
      });
      if (!res.ok) throw new Error('确认播放失败');
    } catch {
      if (!retry && alive(gen)) later(() => send(true), 700, { automatic: false });
    }
  };
  send();
}
async function requestJson(kind, url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const parent = playbackController.signal;
  const cancel = () => controller.abort();
  parent.addEventListener('abort', cancel, { once: true });
  requests[kind] = controller;
  const timer = setTimeout(cancel, timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const data = await res.json();
    if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError');
    return { res, data };
  } finally {
    clearTimeout(timer); parent.removeEventListener('abort', cancel);
    if (requests[kind] === controller) requests[kind] = null;
  }
}
function loadEpisode(ep, holder = null) {
  if (holder?.released || !acceptEpisode(ep) || !ep.queue?.length) return;
  if (paused) { pausedWork.set('episode', () => loadEpisode(ep, holder)); return; }
  if (exclusiveSink?.uid) {
    activeEpisode = ep; queue = ep.queue; idx = -1;
    renderStream(ep);
    if (holder) episodeClaims.set(ep, holder);
    playIndex(0);
    return;
  }
  enterEpisodeSmooth(ep, holder);
}
function isPlaybackPaused() {
  return paused || (exclusiveSink?.uid ? exclusiveClock.paused : stopped);
}

function stopExclusiveClient() {
  exclusiveGen += 1;
  exclusiveRequest?.abort(); exclusiveRequest = null; exclusiveHolder = null;
  clearInterval(exclusiveTimer);
  exclusiveTimer = null; exclusiveClock.paused = true;
  lyricClock.refresh();
  fetch('/api/exclusive/stop', { method: 'POST' }).catch(() => {});
}

function validExclusiveHolder(holder) {
  return !holder || (!holder.released && (holder.started || holder.episode.epoch >= latestEpoch));
}

async function playExclusiveUrl(url, volume, holder = null) {
  const gen = ++exclusiveGen;
  exclusiveRequest?.abort();
  const controller = new AbortController(), parent = playbackController.signal;
  const cancel = () => controller.abort();
  exclusiveRequest = controller; exclusiveHolder = holder;
  parent.addEventListener('abort', cancel, { once: true });
  clearInterval(exclusiveTimer);
  exclusiveTimer = null;
  exclusiveClock.paused = true;
  try {
    if (!exclusiveSink?.uid || !validExclusiveHolder(holder)) return { ok: false, stale: true };
    const res = await fetch('/api/exclusive/play', {
      signal: controller.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: exclusiveSink.uid, url, volume }),
    });
    const data = await res.json();
    if (controller.signal.aborted || gen !== exclusiveGen || !validExclusiveHolder(holder)) return { ok: false, stale: true };
    return data;
  } finally {
    parent.removeEventListener('abort', cancel);
    if (exclusiveRequest === controller) exclusiveRequest = null;
  }
}

function watchExclusive(playToken, onEnded, holder = null) {
  const gen = exclusiveGen;
  clearInterval(exclusiveTimer);
  exclusiveTimer = setInterval(async () => {
    let data;
    try { data = await (await fetch('/api/exclusive')).json(); } catch { return; }
    if (gen !== exclusiveGen || !validExclusiveHolder(holder) || !data || data.token !== playToken) return;
    exclusiveClock.currentTime = Number(data.seconds) || 0;
    if (Number(data.duration) > 0) exclusiveClock.duration = Number(data.duration);
    exclusiveClock.paused = paused || ['paused', 'idle', 'ended', 'error'].includes(data.event);
    if (data.event === 'playing' && !paused) {
      exclusiveClock.readyState = 3;
      exclusiveClock.paused = false;
      exclusiveClock.emit('playing');
      markStarted(holder);
      if (!overlaying) setPlayIcon(true);
    } else if (data.event === 'paused' && !overlaying) {
      setPlayIcon(false);
    }
    if (!overlaying) updateExclusiveProgress();
    lyricClock.refresh();
    if (data.event === 'ended' || data.event === 'error') {
      clearInterval(exclusiveTimer);
      exclusiveTimer = null;
      onEnded(data);
    }
  }, 400);
}

function updateExclusiveProgress() {
  const duration = exclusiveClock.duration;
  const currentTime = exclusiveClock.currentTime;
  paintProgress(progressEls, currentTime, duration);
  const item = queue[idx];
  if (item?.type === 'song') reportProgress(active, exclusiveClock);
}

function skipExclusiveItem(item, i, errorText) {
  if (idx !== i) return;
  cancelSubtitle();
  if (item?.type === 'song') {
    const fault = classifyPlaybackFault({
      httpStatus: /失效/.test(errorText || '') ? 410 : 0,
      mediaError: /读不出/.test(errorText || '') ? 3 : 4,
    });
    closeSongSession('skip');
    setState(fault.text);
    reportListeningEvent('play_failed', {
      song: { title: item.meta.title, artist: item.meta.artist },
      value: fault.reason,
      source: 'player',
    });
  } else {
    setState(errorText || '没能单独送到音箱');
  }
  playIndex(i + 1);
}

function playExclusiveIndex(item, i) {
  const gen = playbackGen, holder = episodeClaims.get(activeEpisode);
  // 一只播放器不能同时垫歌和念口播，所以音箱上是先念完再放歌。
  overlaying = false;
  onItemStart(item, i);
  if (item.type === 'song') setState('正在送到音箱…');
  const volume = item.type === 'tts' ? 1 : masterVol;
  const playing = playExclusiveUrl(item.url, volume, holder), token = exclusiveGen;
  const current = () => alive(gen) && token === exclusiveGen && validExclusiveHolder(holder) && idx === i;
  playing.then((data) => {
    if (!current() || data?.stale) return;
    if (!data?.ok) {
      skipExclusiveItem(item, i, data?.error || '');
      return;
    }
    if (paused) {
      fetch('/api/exclusive/control', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'pause' }) }).catch(() => {});
      pausedWork.set('exclusive', () => playExclusiveIndex(item, i));
      return;
    }
    try { mediaTracks.forEach((track) => track.pause()); } catch { /* 本机音轨停掉，声音只留在音箱 */ }
    cancelBlend();
    exclusiveClock.currentTime = 0;
    exclusiveClock.duration = Number(data.duration) || NaN;
    exclusiveClock.readyState = data.event === 'playing' ? 3 : 0;
    exclusiveClock.paused = false;
    refreshLyrics();
    if (item.type === 'tts') showSubtitle(el.stream.querySelector(`.line[data-idx="${i}"] .bubble`), item.text, exclusiveClock);
    exclusiveClock.emit('playing');
    if (data.event === 'playing') markStarted(holder);
    setPlayIcon(true);
    watchExclusive(data.token, (status) => {
      if (idx !== i) return;
      if (status?.event === 'error') {
        skipExclusiveItem(item, i, status.error || '');
        return;
      }
      if (item.type === 'song') closeSongSession('completed');
      playIndex(i + 1);
    }, holder);
    if (item.type === 'song') prefetchFiller();
  }).catch(() => { if (current()) skipExclusiveItem(item, i, ''); });
}

function applyOutputResult(data) {
  if (!data || data.ok === false) return;
  const nextUid = data.exclusive && data.uid ? String(data.uid) : '';
  const prevUid = exclusiveSink?.uid || '';
  if (!nextUid) {
    const leaving = Boolean(prevUid);
    exclusiveSink = null;
    refreshLyrics();
    if (leaving) stopExclusiveClient();
    if (leaving && started && queue[idx]) playIndex(idx);
    return;
  }
  const changed = !data.unchanged && prevUid !== nextUid;
  if (changed) {
    newGeneration();
    mediaTracks.forEach((track) => track.pause());
  }
  exclusiveSink = { uid: nextUid, id: data.outputId || '', name: data.name || '' };
  refreshLyrics();
  if (changed && started && queue[idx]) playIndex(idx);
}

function playIndex(i, options = {}) {
  if (paused) { pausedWork.set('advance', () => playIndex(i, options)); return; }
  if (stopped) return;
  if (i >= queue.length) {
    if (activeEpisode?.intent === 'chat' || activeEpisode?.intent === 'control') {
      if (activeEpisode.intent === 'control') applyEpisodeAction(activeEpisode);
      return;
    }
    continueRadio();
    return;
  }
  i = Math.max(0, i);
  const item = queue[i];
  if (failedItems.has(item)) { playIndex(i + 1, options); return; }
  if (exclusiveSink?.uid) { idx = i; playExclusiveIndex(item, i); return; }
  if (item.type === 'tts') {
    startSayOverlay(item.url, item.text, () => activeEpisode);
    return;
  }
  startMusic(item, i, { episode: activeEpisode, ...options });
}

// 摆出一首歌的界面：标题 / 封面 / 背景 / 收藏态 / 歌词。开新一首（onItemStart）和口播念完回到原来那首（restoreAfterOverlay）共用。
function showSong(item, i) {
  // 垫歌可以先出声，口播舞台仍保留到人声结束。
  if (overlaying) return;
  setNowPlaying(item.meta.title, {
    artist: item.meta.artist,
    facts: [item.meta.year, item.meta.genre].filter(Boolean).join(' · '),
    cover: item.meta.cover,
    quality: item.meta.quality,
  });
  setBackdrop(item.meta.cover);
  setState('正在播放');
  el.favBtn.classList.toggle('fav-on', favs.has(songKey(item.meta)));
  el.dislikeBtn.classList.remove('dislike-on');
  cancelSubtitle();
  highlightLine(i);
  bindLyrics(el.stream.querySelector(`.line[data-idx="${i}"] .lyric`), item);
  el.nowPlaying.textContent = `Now playing: ${item.meta.title} — ${item.meta.artist}`;
  // 好友互荐（friends.js）：正在放的这首，朋友推荐来的带上是谁
  try {
    window.dispatchEvent(new CustomEvent('claudio:now', { detail: { id: item.meta.id, title: item.meta.title, artist: item.meta.artist, cover: item.meta.cover || '',
      ...(item.meta.friendRec ? { rec: { id: item.meta.friendRec, from: item.meta.friendFrom } } : {}) } }));
  } catch { /* 好友界面出错也不影响放歌 */ }
}

function onItemStart(item, i) {
  if (item.type === 'song') {
    // 朋友推荐的歌真响了才算已播（报幕时还不知道放不放：要先问「要听吗」）
    if (item.meta?.friendRec && !item.friendPlayed) { item.friendPlayed = true; friendAction('played', item.meta.friendRec); }
    startSongSession(item);
    showSong(item, i);
  } else {
    clearStageView();
    setNowPlaying('CLAUDIO');
    setState('正在念口播');
    highlightLine(i);
    logChat('claudio', item.text);
    // 当前口播逐字流式出（配合念稿节奏）；renderStream 已渲染该 bubble，这里清空重打
    const box = el.stream.querySelector(`.line[data-idx="${i}"] .bubble`);
    if (box && item.text) {
      // 音箱返回后才有新口播时钟，不能先读上一首歌的进度。
      if (exclusiveSink?.uid) box.replaceChildren();
      else showSubtitle(box, item.text, voice);
    }
  }
}

// 音量由真实经过时间计算，窗口恢复或媒体事件到来时立即补到当前值。
function rampVolume(track, to, ms, done, targetRatio) {
  const from = trackVol(track);
  const toRatio = targetRatio ?? (masterVol ? to / masterVol : (done ? 0 : track === voice ? SAY_GAIN : musicLevel()));
  envelopes.set(track, { from, to, fromRatio: masterVol ? from / masterVol : 0, toRatio,
    start: performance.now(), duration: ms, done, gen: playbackGen });
  applyEnvelopes();
}
function applyEnvelopes() {
  const now = performance.now();
  for (const [track, env] of [...envelopes]) {
    if (!alive(env.gen)) { envelopes.delete(track); continue; }
    if (paused && !env.pauseFade) continue;
    setTrackVol(track, envelopeValue(env, now));
    if (now - env.start >= env.duration) {
      envelopes.delete(track);
      env.done?.();
    }
  }
  const fade = musicFade;
  if (fade && alive(fade.gen) && !paused) {
    const k = Math.max(0, Math.min(1, (now - fade.start) / fade.duration));
    const power = equalPower(k);
    const level = musicTarget();
    setTrackVol(fade.old, fade.oldLevel * power.old * masterVol);
    setTrackVol(fade.next, level * power.new);
    if (k >= 1) {
      musicFade = null; crossing = false;
      fade.old.pause(); closeSongSession(fade.reason, fade.old);
    }
  }
}
setInterval(() => { applyEnvelopes(); if (!paused && !stopped) onTimeUpdate(); }, 30);
document.addEventListener('visibilitychange', () => { applyEnvelopes(); if (!paused && !stopped) onTimeUpdate(); });

function cancelBlend() {
  musicFade = null; crossing = false;
}
// 音乐该在的音量（不含音量滑块）：念口播时压到 BG_VOL，聊天时 CHAT_BED，平常 1
function musicLevel() {
  const rest = chatBedOn() ? CHAT_BED : 1;
  return ducked ? Math.min(BG_VOL, rest) : rest;
}
function musicTarget() { return musicLevel() * masterVol; }
function soundingMusic() {
  if (exclusiveSink?.uid) return !exclusiveClock.paused || Boolean(exclusiveRequest);
  return [musicA, musicB].some((t) => t.src && !t.paused && !t.ended);
}
function setEpisodeStage(ep) {
  cancelSubtitle();
  activeEpisode = ep; queue = ep.queue || [];
  el.queueCount.textContent = `${queue.filter((q) => q.type === 'song').length} TRACKS`;
  if (overlaying && voiceContext) showSayBubble(voiceContext.text, voice);
  else renderStream(ep);
}

async function startMusic(item, i, { episode = activeEpisode, holder = null, bed = false, reason = 'completed', duration, startAt = 0 } = {}) {
  if (holder?.released || exclusiveSink?.uid || paused || stopped || !item?.url) return;
  const gen = playbackGen;
  const old = active, next = idle;
  if (slots.get(next)?.loading) return;
  // 只占空闲音乐轨；正在淡出的尾音先收尾。
  if (musicFade) {
    musicFade.old.pause(); closeSongSession(musicFade.reason, musicFade.old);
    cancelBlend();
  }
  envelopes.delete(next);
  next.pause();
  const preloaded = slots.get(next)?.prepared && slots.get(next)?.item === item;
  const startedAt = performance.now();
  const controller = new AbortController();
  slots.set(next, { item, i, episode, holder, controller, loading: true, gen });
  setTrackVol(next, 0);
  if (!preloaded) next.src = proxyUrl(item.url);
  // 换设备接着放：先设起点（浏览器会在加载后从这里开始），出声后再校一次。
  if (startAt > 0) { try { next.currentTime = startAt; } catch { /* 加载后再校 */ } }
  const signal = playbackController.signal;
  const slot = slots.get(next);
  slot.resume = () => {
    const ctx = voiceContext;
    if (bed && ctx) ctx.bedLoading = true;
    return startMusic(item, i, { episode, holder, bed, reason, duration })
      .finally(() => { if (bed && ctx) ctx.bedLoading = false; });
  };
  const cancel = () => { controller.abort(); if (slots.get(next) === slot && slot.loading) { next.pause(); slots.delete(next); } };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await waitForPlaying(next, { signal: controller.signal, timeoutMs: mediaDeadline(item.url) });
    if (!alive(gen)) return;
    if (exclusiveSink?.uid) { next.pause(); slots.delete(next); return; }
    if (holder && (holder.released || holder.episode.epoch < latestEpoch)) { next.pause(); slots.delete(next); return; }
    if (paused) {
      next.pause(); slots.delete(next);
      pausedWork.set('music', () => startMusic(item, i, { episode, holder, bed, reason, duration }));
      return;
    }
    if (slots.get(next) !== slot) return;
    if (startAt > 0 && Math.abs(next.currentTime - startAt) > 1.5) { try { next.currentTime = startAt; } catch { /* 不能拖就从头放 */ } }
    slot.loading = false;
    const oldMeta = slots.get(old)?.item?.meta;
    active = next; idle = old;
    if (episode && episode !== activeEpisode) setEpisodeStage(episode);
    idx = i;
    onItemStart(item, i);
    setPlayIcon(true);
    if (holder) markStarted(holder);
    if (voiceContext && bed) {
      voiceContext.bed = next;
      if (voiceContext.origin === 'chat' && !old.paused) {
        rampVolume(old, 0, 1200, () => { old.pause(); closeSongSession('skip', old); });
      }
    }
    const ms = duration ?? crossfadeDuration(oldMeta, item.meta);
    if (old.src && !old.paused && !old.ended && !bed && !volumeFixed()) {
      musicFade = { old, next, start: performance.now(), duration: ms, gen, reason,
        oldLevel: masterVol ? trackVol(old) / masterVol : 1 };
      crossing = true;
    } else {
      if (!bed) { old.pause(); closeSongSession(reason, old); }
      rampVolume(next, bed ? BG_VOL * masterVol : musicTarget(), bed ? 1200 : 600);
    }
    prefetchFiller();
    reportEar(earKind, 'song', { clear: true });
  } catch (error) {
    if (!alive(gen) || error.name === 'AbortError') return;
    reportPlayFailure(item, next, error, { startAt, preloaded, ms: Math.round(performance.now() - startedAt) });
    recoverStage();
    if (slots.get(next) === slot) slots.delete(next); next.pause();
    failedItems.add(item);
    reportListeningEvent('play_failed', {
      song: { title: item.meta?.title, artist: item.meta?.artist },
      discoveryType: item.meta?.discoveryType, value: 'unavailable', source: 'player',
    });
    setState('这首暂时放不了，换一首');
    const nextIndex = episode?.queue?.findIndex((q, n) => n > i && q.type === 'song') ?? -1;
    if (nextIndex >= 0) await startMusic(episode.queue[nextIndex], nextIndex, { episode, holder, bed, reason });
    else {
      if (holder) releaseClaim(holder);
      if (voiceContext?.holder === holder) voiceContext.bedFailed = true;
      if (!soundingMusic()) ensureFiller();
      requestNext();
    }
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
// 「这首暂时放不了」时把浏览器给的原因记进服务端日志（[play-fail]），下次能查。不记直链本身。
function reportPlayFailure(item, track, error, extra = {}) {
  const cause = error?.cause;
  const src = String(track.currentSrc || track.src || '');
  fetch('/api/play-diag', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      songId: item?.meta?.id, message: error?.message, cause: cause?.name || (cause?.code ? `MediaError ${cause.code}` : ''),
      causeMessage: cause?.message, mediaError: track.error?.code || 0, networkState: track.networkState, readyState: track.readyState,
      src: /\/media\//.test(src) ? 'media' : /\/proxy\?/.test(src) ? 'proxy' : src.startsWith('blob:') ? 'blob' : 'other',
      handoff: Boolean(item?.handoff), currentTime: Math.round(Number(track.currentTime) || 0), ...extra,
    }),
  }).catch(() => {});
}
function startBlend(songItem, songIdx) {
  if (volumeFixed()) return; // iPhone 压不低音量：新歌等口播念完再起，不垫在下面
  if (voiceContext?.bed || slots.get(idle)?.loading) return;
  const ctx = voiceContext;
  if (!ctx || ctx.bedLoading) return;
  if (ctx.getEpisode()?.friendRec) return; // 朋友推荐那期要先问「要听吗」：答了再起歌，不垫在口播下面
  ctx.bedLoading = true;
  startMusic(songItem, songIdx, { episode: ctx.getEpisode() || activeEpisode,
    holder: ctx.holder, bed: true, reason: ctx.origin === 'chat' ? 'skip' : 'completed' })
    .finally(() => { ctx.bedLoading = false; });
}

function onTimeUpdate() {
  if (paused || stopped || exclusiveSink?.uid) return;
  reportProgress(musicA); reportProgress(musicB);
  const item = slots.get(active)?.item;
  const { duration, currentTime } = active;
  if (item?.type === 'song' && !overlaying) {
    paintProgress(progressEls, currentTime, duration);
  }
  // 睡眠定时也在播放进度里查一次：iPhone 锁屏时计时器会被推迟，进度事件还在走。
  if (checkSleep()) return;
  if (sleepAfterTrack && item?.type === 'song' && !voiceContext?.audible) {
    // 放完这首：不预载、不领下一期，尾巴上淡出。
    const left = duration - currentTime;
    if (Number.isFinite(left) && left <= SLEEP_FADE_MS / 1000) fadeOutStop(Math.max(300, left * 1000));
    return;
  }
  if (voiceContext?.audible) {
    const outro = voiceContext.outro;
    const tail = outro.duration - outro.currentTime;
    if (voiceContext.origin === 'auto' && !voiceContext.outroFading && tail > 0 && tail <= 2) {
      voiceContext.outroFading = true;
      rampVolume(outro, 0, tail * 1000, null, 0);
    }
    if (voice.currentTime !== voiceContext.lastTime) {
      voiceContext.lastTime = voice.currentTime; voiceContext.progressAt = performance.now();
    } else if (!voice.paused && performance.now() - voiceContext.progressAt > WATCHDOG_MS) {
      failVoice(); return;
    }
    const remaining = voice.duration - voice.currentTime;
    const ep = voiceContext.getEpisode();
    const first = ep?.queue?.findIndex((q) => q.type === 'song') ?? -1;
    // 聊天点歌：口播一开口新歌就垫在下面；自动节目：口播快念完，或上一首已经放完（口播下面没声了）就垫进来。
    const leadIn = voiceContext.origin === 'chat' || (Number.isFinite(remaining) && remaining <= MUSIC_LEAD)
      || outro.paused || outro.ended;
    if (first >= 0 && leadIn && !voiceContext.bed && !voiceContext.bedFailed) {
      startBlend(ep.queue[first], first);
    }
    // iPhone 不垫歌：念的时候先把第一首加载好，念完马上能响（锁屏时空太久页面可能被挂起）
    if (first >= 0 && volumeFixed() && !slots.get(idle)?.loading && slots.get(idle)?.item !== ep.queue[first]) {
      idle.pause(); envelopes.delete(idle);
      slots.set(idle, { item: ep.queue[first], prepared: true });
      idle.src = proxyUrl(ep.queue[first].url); idle.load();
    }
  }
  if (!item || active.ended || active.paused || voiceContext?.audible || musicFade) return;
  const remain = duration - currentTime;
  if (!Number.isFinite(remain)) return;
  const following = queue.findIndex((q, n) => n > idx && q.type === 'song' && !failedItems.has(q));
  if (following >= 0) {
    if (remain <= 30 && !slots.get(idle)?.loading && slots.get(idle)?.item !== queue[following]) {
      idle.pause(); envelopes.delete(idle);
      slots.set(idle, { item: queue[following], prepared: true });
      idle.src = proxyUrl(queue[following].url); idle.load();
    }
    const span = volumeFixed() ? IOS_GAP_S : crossfadeDuration(item.meta, queue[following].meta) / 1000;
    if (remain <= span && !slots.get(idle)?.loading) {
      startMusic(queue[following], following);
    }
  } else {
    if (remain <= 30 && !pendingEpisode && !claimPoll) requestNext();
    if (pendingEpisode) maybeEnterPending(remain);
    if (remain <= 2 && ducked && !envelopes.has(active)) rampVolume(active, 0, remain * 1000, null, 0);
  }
}

for (const track of mediaTracks) {
  for (const event of ['play', 'playing', 'canplay', 'loadedmetadata', 'loadeddata', 'durationchange',
    'timeupdate', 'ended', 'error', 'pause', 'waiting', 'stalled', 'seeking', 'seeked', 'progress', 'suspend', 'ratechange']) {
    track.addEventListener(event, () => {
      applyEnvelopes();
      if (['play', 'playing', 'pause', 'ended', 'seeking', 'seeked', 'loadedmetadata'].includes(event)) refreshLyrics();
      if (event === 'playing' && track === voice) {
        el.lanePill.classList.add('hidden'); clearTimeout(laneTimer);
      }
      if (event === 'timeupdate' && track === active) onTimeUpdate();
      if (['playing', 'pause', 'seeked'].includes(event) && (track === musicA || track === musicB)) reportPlaybackSoon();
      if (event === 'timeupdate' && track === active) reportPlaybackTick();
      if (track === voice || slots.get(track)?.loading) return;
      if (event === 'ended') {
        closeSongSession('completed', track);
        if (track !== active || stopped) return;
        if (sleepAfterTrack && !voiceContext?.audible) { fadeOutStop(300); return; }
        if (checkSleep()) return;
        gated('advance', () => {
          if (voiceContext?.audible) return;
          if (pendingEpisode) maybeEnterPending(0);
          if (!voiceContext?.audible && !slots.get(idle)?.loading) playIndex(idx + 1);
        });
      }
      if (event === 'error' && track === active && !stopped) {
        recoverStage();
        const item = slots.get(track)?.item;
        if (item) reportListeningEvent('play_failed', { song: { title: item.meta.title, artist: item.meta.artist },
          discoveryType: item.meta.discoveryType, value: classifyPlaybackFault({ mediaError: track.error?.code }).reason, source: 'player' });
        closeSongSession('failed', track);
        gated('advance', () => playIndex(idx + 1));
      }
    });
  }
}

async function startExclusiveSay(sayUrl, sayText, getEpisode) {
  cancelBlend();
  overlaying = true;
  sayEnded = false;
  streamDone = false;
  exclusiveResumeIdx = idx;
  if (sayOnEnd) sayOnEnd.abort();
  const ac = new AbortController();
  sayOnEnd = ac;
  const proceed = () => {
    if (ac.signal.aborted) return;
    ac.abort();
    const ep = getEpisode();
    if (ep) finishAfterSay(ep);
    else {
      sayEnded = true;
      if (!currentRequestId) finishFailedChatVoice();
    }
  };
  let data;
  try { data = await playExclusiveUrl(sayUrl, 1); } catch { data = null; }
  if (ac.signal.aborted || data?.stale) return;
  if (!data?.ok) { proceed(); return; }
  if (paused) {
    fetch('/api/exclusive/control', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'pause' }) }).catch(() => {});
    pausedWork.set('exclusiveSay', () => startExclusiveSay(sayUrl, sayText, getEpisode));
    return;
  }
  try { mediaTracks.forEach((track) => track.pause()); } catch { /* 口播也走音箱，避免本机再出一声 */ }
  document.body.classList.remove('thinking');
  setNowPlaying('CLAUDIO');
  setState('正在念口播');
  exclusiveClock.currentTime = 0;
  exclusiveClock.duration = Number(data.duration) || NaN;
  exclusiveClock.readyState = 3;
  exclusiveClock.paused = false;
  showSayBubble(sayText, exclusiveClock);
  responseHeard = true;
  reportEar(earKind, 'voice');
  const armByDur = () => armWatchdog(((isFinite(exclusiveClock.duration) && exclusiveClock.duration > 0 ? exclusiveClock.duration : 30) + 8) * 1000, true);
  armByDur();
  watchExclusive(data.token, () => proceed());
}

async function startSayOverlay(sayUrl, sayText, getEpisode, holder = null) {
  if (holder?.released) return;
  if (paused) { pausedWork.set('say', () => startSayOverlay(sayUrl, sayText, getEpisode, holder)); return; }
  if (stopped) return;
  if (exclusiveSink?.uid) { startExclusiveSay(sayUrl, sayText, getEpisode); return; }
  if (voiceContext?.url === sayUrl) return;
  sayOnEnd?.abort();
  const ac = new AbortController();
  const parent = playbackController.signal;
  const cancel = () => ac.abort();
  parent.addEventListener('abort', cancel, { once: true });
  ac.signal.addEventListener('abort', () => parent.removeEventListener('abort', cancel), { once: true });
  sayOnEnd = ac;
  const gen = playbackGen;
  const ctx = { url: sayUrl, text: sayText, getEpisode, holder, gen, audible: false,
    origin: holder ? 'auto' : 'chat', bed: null, outro: active };
  voiceContext = ctx;
  sayEnded = false; streamDone = false;
  setVoiceSource(sayUrl);
  envelopes.delete(voice);
  setTrackVol(voice, 0);
  const proceed = () => {
    if (!alive(gen) || ctx !== voiceContext) return;
    gated('voiceEnd', () => {
      sayEnded = true; voice.pause();
      if (ctx.failed) { finishFailedChatVoice(ctx); return; }
      const ep = getEpisode();
      if (ep) finishAfterSay(ep);
      else { ctx.audible = false; overlaying = false; unduck(); }
    });
  };
  voice.addEventListener('ended', proceed, { once: true, signal: ac.signal });
  voice.addEventListener('error', () => { if (!ac.signal.aborted) failVoice(ctx); }, { once: true, signal: ac.signal });
  try {
    // 首包等待与播放启动分开计时；等冷语音时歌曲始终正常音量。
    await waitForCanPlay(voice, { signal: ac.signal, timeoutMs: laneStarting ? LANE_WAIT_MS : WATCHDOG_MS });
    if (!alive(gen) || ctx !== voiceContext) return;
    const reveal = () => {
      if (!alive(gen) || ac.signal.aborted || ctx !== voiceContext) return;
      overlaying = true; ducked = true;
      document.body.classList.remove('thinking');
      for (const music of [musicA, musicB]) if (!music.paused && !music.ended) rampVolume(music, BG_VOL * masterVol, 1200);
      setNowPlaying('CLAUDIO'); setState('正在念口播');
      showSayBubble(sayText, voice);
      later(async () => {
        try {
          await waitForPlaying(voice, { signal: ac.signal, timeoutMs: mediaDeadline(sayUrl) });
          if (!alive(gen) || ctx !== voiceContext) return;
          if (paused) { voice.pause(); pausedWork.set('voicePlay', reveal); return; }
          ctx.audible = true; ctx.lastTime = voice.currentTime; ctx.progressAt = performance.now(); responseHeard = true;
          holdMusicForVoice();
          markStarted(holder);
          if (pendingEpisode === holder) { pendingEpisode = null; claimId = null; }
          reportEar(earKind, 'voice');
          rampVolume(voice, sayVol(), 350);
          el.lanePill.classList.add('hidden'); clearTimeout(laneTimer);
          disarmWatchdog();
        } catch (error) { if (error.name !== 'AbortError' && alive(gen)) failVoice(ctx); }
      }, SAY_LEAD_S * 1000, { key: 'voiceLead' });
    };
    gated('say', reveal);
  } catch (error) {
    if (error.name !== 'AbortError' && alive(gen) && ctx === voiceContext) failVoice(ctx);
  }
}

function failVoice(ctx = voiceContext) {
  if (ctx && ctx !== voiceContext) return;
  if (ctx?.failed) { finishFailedChatVoice(ctx); return; }
  cancelSubtitle();
  sayOnEnd?.abort(); voice.pause();
  const ep = ctx ? ctx.getEpisode() : streamPending;
  if (ctx?.holder?.episode) ctx.holder.episode.voice = { status: 'skipped' };
  if (ep) {
    ep.voice = { status: 'skipped' };
    logChat('claudio', shownSay(ep) || ctx?.text);
  } else showControlReply(ctx?.text || '语音暂时离线，先听音乐');
  voiceContext = null; overlaying = false; ducked = false;
  if (!ep) { releaseHeldMusic(); restoreAfterOverlay(); }
  disarmWatchdog();
  for (const music of [musicA, musicB]) if (!music.paused && !music.ended) rampVolume(music, songVol(), 1200);
  setState(ep && !ep.say ? '正在播放' : '语音离线，先放歌');
  if (ep) gated('voiceFailed', () => finishAfterSay(ep, ctx));
}

function finishExclusiveAfterSay(ep) {
  cancelSubtitle();
  const songs = ep && ep.queue ? ep.queue.filter((q) => q.type === 'song') : [];
  if (songs.length) {
    closeSongSession('skip');
    activeEpisode = ep;
    queue = ep.queue;
    el.queueCount.textContent = `${songs.length} TRACKS`;
    renderStream(ep);
    ducked = false;
    const firstSong = songs[0];
    playIndex(ep.queue.indexOf(firstSong));
    reportEar(earKind, 'song', { clear: true });
    return;
  }
  if (ep?.intent === 'control') applyEpisodeAction(ep);
  ducked = false;
  document.body.classList.remove('thinking');
  const resume = queue[exclusiveResumeIdx];
  if (resume?.type === 'song') {
    renderStream({ queue });
    showSong(resume, exclusiveResumeIdx);
  }
  if (resume?.type === 'song' && ep?.action !== 'pause' && ep?.action !== 'stop') playIndex(exclusiveResumeIdx);
  else setPlayIcon(ep?.action === 'pause' || ep?.action === 'stop' ? false : !isPlaybackPaused());
  reportEar(earKind, 'stay', { clear: true });
}

// 口播气泡会顶掉歌曲舞台，念完后按当前显示的音乐轨恢复。
function restoreAfterOverlay() {
  cancelSubtitle();
  const item = slots.get(active)?.item || queue[idx];
  if (item?.type !== 'song') return;
  renderStream({ queue });
  showSong(item, idx);
  if (paused) setState('已暂停');
}
function resumeBackground() {
  unduck();
  if (!exclusiveSink?.uid && !soundingMusic() && !paused && !stopped) playIndex(idx + 1);
}
function finishFailedChatVoice(ctx = voiceContext) {
  if (ctx && ctx !== voiceContext) return;
  if (exclusiveSink?.uid && overlaying && !responseHeard) stopExclusiveClient();
  sayOnEnd?.abort(); sayOnEnd = null;
  voice.pause(); envelopes.delete(voice);
  resumeTracks.delete(voice); resumeVolumes.delete(voice);
  voiceContext = null; sayEnded = true;
  resumeBackground(); restoreAfterOverlay();
  if (!soundingMusic() && !paused && !stopped) continueRadio();
}
function failChat(message) {
  currentRequestId = null; chatVoiceFailed = true;
  streamPending = null; streamingActive = false;
  disarmWatchdog(); clearEar(); document.body.classList.remove('thinking');
  setState(message);
  // 已出声的回复允许念完，但不再等一个永远不会来的节目。
  if (voiceContext?.audible && !sayEnded && !voice.ended) voiceContext.failed = true;
  else if (!(exclusiveSink?.uid && overlaying && responseHeard && !sayEnded)) finishFailedChatVoice();
}
// 没念出来的朋友推荐不问，显示的字去掉「要听吗？」
const shownSay = (ep) => (ep?.friendRec ? withoutAsk(ep.say) : ep?.say);
function friendAction(action, rec) {
  fetch(`/api/friends/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rec }) }).catch(() => {});
}
// 朋友推荐那期：报幕最后问了「要听吗」，念完开麦听 5 秒（录音交给 /api/voice 的短句识别）。上一首在底下小声接着放。
// 说了听、或者根本听不了（没麦克风、不给权限、识别不通）→ 照常放；不听 / 没听清 → 这首不放、先存着（好友里点「听」找回），电台接着往下走。
// 等的时候换歌、停止、换设备（playbackGen 变了）→ 也算没听，先存着。
async function askFriendRec(ep, ctx) {
  ep.recAnswered = 'asking';
  const gen = playbackGen;
  const signal = playbackController.signal;
  setState('在听你回答…');
  const reply = await listenForAnswer({ engine: 'record', signal });
  if (!alive(gen) || ctx !== voiceContext || stopped) { friendAction('drop', ep.friendRec.id); return; }
  if (reply.answer === 'yes' || reply.answer === 'unavailable') {
    ep.recAnswered = 'yes';
    finishAfterSay(ep, ctx);
    return;
  }
  ep.recAnswered = 'no';
  friendAction('drop', ep.friendRec.id);
  logChat('claudio', REC_STASHED_LINE);
  // 当成一期不带歌的节目收尾：口播舞台收起、上一首音量回来，放完接着领下一期
  finishAfterSay({ ...ep, queue: ep.queue.filter((q) => q.type !== 'song'), intent: 'chat' }, ctx);
}
function finishAfterSay(ep, endedContext = voiceContext) {
  if (endedContext?.holder?.released) return;
  if (paused) { pausedWork.set('finishSay', () => finishAfterSay(ep, endedContext)); return; }
  if (streamDone || stopped) return;
  if (endedContext?.bedLoading) {
    later(() => finishAfterSay(ep, endedContext), 100, { key: 'finishSay' });
    return;
  }
  if (ep?.friendRec && !ep.recAnswered && endedContext?.audible && ep.voice?.status !== 'skipped' && !exclusiveSink?.uid
    && String(ep.say || '').endsWith(REC_ASK_TAIL)) {
    void askFriendRec(ep, endedContext);
    return;
  }
  streamDone = true;
  cancelSubtitle();
  disarmWatchdog(); streamingActive = false; overlaying = false;
  sayOnEnd?.abort(); voice.pause();
  if (exclusiveSink?.uid) { finishExclusiveAfterSay(ep); return; }
  const first = ep?.queue?.findIndex((q) => q.type === 'song') ?? -1;
  const ctx = endedContext;
  voiceContext = null;
  if (first >= 0) {
    const holder = ctx?.holder;
    if (pendingEpisode === holder) { pendingEpisode = null; claimId = null; }
    ducked = false;
    releaseHeldMusic({ resume: false });
    if (ctx?.bed) {
      const bed = ctx.bed, old = bed === musicA ? musicB : musicA;
      rampVolume(old, 0, 600, () => { old.pause(); closeSongSession(ctx.origin === 'chat' ? 'skip' : 'completed', old); });
      later(() => rampVolume(bed, songVol(), 2000), 600, { key: 'unduck' });
      restoreAfterOverlay();
    } else {
      startMusic(ep.queue[first], first, { episode: ep, holder,
        reason: ctx?.origin === 'chat' || !holder ? 'skip' : 'completed', duration: 1400 });
    }
  } else {
    restoreAfterOverlay();
    if (ep?.intent === 'control') applyEpisodeAction(ep);
    if (ep?.action !== 'pause' && ep?.action !== 'stop') resumeBackground();
  }
  reportEar(earKind, 'stay', { clear: true });
}
function enterEpisodeSmooth(ep, holder = null) {
  if (holder?.released) return;
  if (!acceptEpisode(ep)) { releaseClaim(holder); return; }
  if (paused) { pausedWork.set('episode', () => enterEpisodeSmooth(ep, holder)); return; }
  const say = ep?.queue?.find((q) => q.type === 'tts');
  if (say && ep.voice?.status !== 'skipped') {
    startSayOverlay(say.url, say.text || ep.say, () => ep, holder);
  } else {
    logChat('claudio', shownSay(ep));
    if (ep.say) setState('语音离线，先放歌');
    const first = ep?.queue?.findIndex((q) => q.type === 'song') ?? -1;
    if (first >= 0) startMusic(ep.queue[first], first, { episode: ep, holder, reason: holder ? 'completed' : 'skip' });
    else { showControlReply(ep.say); if (ep.intent === 'control') applyEpisodeAction(ep); unduck(); }
  }
}
const WATCHDOG_MS = 60000; // HTTP 计划完成后，正常语音再等首包最多 60 秒。
const LANE_WAIT_MS = 250000; // 5090 冷启动首包上限 240 秒，前端留 10 秒余量。
const CHAT_VOICE_WAIT_MS = 8000; // 聊天点歌：歌和文字已到，口播最多再等 8 秒，过了先放歌
function skipChatVoice() {
  disarmWatchdog();
  chatVoiceFailed = true;
  failVoice();
}
function armWatchdog(ms = WATCHDOG_MS, force = false) {
  if (watchdog && !force) return;
  disarmWatchdog();
  watchdog = later(() => {
    watchdog = null;
    gated('watchdog', () => {
      if (voiceContext?.audible) return;
      chatVoiceFailed = true;
      failVoice();
    });
  }, ms, { key: 'watchdog' });
}
function disarmWatchdog() { clearTimeout(watchdog); pendingTimers.delete(watchdog); watchdog = null; }
// iPhone：口播出声时先停歌、记下来；念完（或念不成）从原处接着放。换了歌的就不接了。
const heldForVoice = new Set();
function holdMusicForVoice() {
  if (!volumeFixed()) return;
  if (musicFade) { musicFade.old.pause(); closeSongSession(musicFade.reason, musicFade.old); cancelBlend(); }
  for (const music of [musicA, musicB]) {
    if (music.paused || music.ended) continue;
    envelopes.delete(music); music.pause(); heldForVoice.add(music);
  }
}
function releaseHeldMusic({ resume = true } = {}) {
  const tracks = [...heldForVoice]; heldForVoice.clear();
  for (const music of tracks) {
    if (!resume || music !== active || !music.src || music.ended || stopped) continue;
    if (paused) { resumeTracks.add(music); resumeVolumes.set(music, songVol()); continue; }
    setTrackVol(music, musicTarget());
    music.play().catch(() => {});
  }
}
function unduck() {
  cancelSubtitle();
  disarmWatchdog(); document.body.classList.remove('thinking');
  ducked = false; overlaying = false;
  releaseHeldMusic();
  if (exclusiveSink?.uid) {
    const resume = queue[exclusiveResumeIdx];
    if (resume?.type === 'song') playIndex(exclusiveResumeIdx);
    return;
  }
  for (const music of [musicA, musicB]) if (!music.paused && !music.ended) rampVolume(music, songVol(), 2000);
  if (!lyricView) restoreAfterOverlay();
  refreshLyrics();
}

// 流式 sayReady 阶段还没有完整 episode，先显示口播气泡（打字机逐字出）
function showSayBubble(text, audio) {
  clearStageView();
  el.stream.innerHTML = BUBBLE_LINE;
  el.stream.scrollTop = 0;
  showSubtitle(el.stream.querySelector('.bubble'), text, audio);
  logChat('claudio', text);
}

// ── 字幕流 ──
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 「她想起了你说的那件事」：点开是她提起的那条记忆 + 老板的原话。
function memoryChip(ref) {
  const wrap = document.createElement('div');
  wrap.className = 'say-memory';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'say-memory-btn';
  btn.textContent = '她想起了你说的那件事';
  const detail = document.createElement('div');
  detail.className = 'say-memory-detail hidden';
  const date = new Date(ref.at);
  detail.innerHTML = `<p>${escapeHtml(ref.text)}</p>`
    + (ref.quote ? `<blockquote>${escapeHtml(ref.quote)}</blockquote>` : '')
    + `<time>${Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`}</time>`;
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    detail.classList.toggle('hidden');
  });
  wrap.append(btn, detail);
  return wrap;
}

function renderStream(ep) {
  clearStageView();
  el.stream.innerHTML = '';
  // 角标跟着「这一期」走，不是跟着某次渲染走：换到歌曲舞台会重新渲染（只带 queue），
  // 所以这里也认 activeEpisode 上的 memoryRef，否则角标一闪就没了。
  // 带 id 的是新一期（它没引用就不该蹭上一期的角标）；只带 queue 的是同一期的重渲染。
  const memoryRef = ep?.memoryRef || (ep?.id ? null : (activeEpisode?.memoryRef || null));
  // 角标挂在第一首歌那一行：口播念完就只剩歌，挂在口播上会跟着一起消失、就点不到了。
  // 没有歌（纯聊天回复）才挂回口播那一行。
  let chipHost = null;
  let firstSongHost = null;
  ep.queue.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'line enter' + (item.type === 'song' ? ' song' : '');
    div.dataset.idx = i;
    div.style.animationDelay = `${Math.min(i, 6) * 60}ms`; // 错峰进场
    if (item.type === 'tts') {
      div.innerHTML = `<span class="who">Vera</span><div class="bubble">${escapeHtml(item.text)}</div>`;
      if (memoryRef && !chipHost) chipHost = div;
    } else {
      if (memoryRef && !firstSongHost) firstSongHost = div;
      div.dataset.song = '1';
      div.innerHTML = `<span class="who">♪ ${escapeHtml(item.meta.title)} — ${escapeHtml(item.meta.artist)}</span><div class="lyric"></div>`;
    }
    // 进场动画结束就摘掉 enter，避免和后续 active 高亮/滚动叠加
    div.addEventListener('animationend', () => { div.classList.remove('enter'); div.style.animationDelay = ''; }, { once: true });
    el.stream.appendChild(div);
  });
  // 每次渲染只挂一个角标
  const host = firstSongHost || chipHost;
  if (memoryRef && host) host.appendChild(memoryChip(memoryRef));
}

function highlightLine(i) {
  for (const n of el.stream.querySelectorAll('.line')) {
    n.classList.toggle('active', +n.dataset.idx === i);
  }
  el.stream.scrollTop = 0; // 换了一段内容：从头开始，别带着上一首歌词的滚动位置
  if (queue[i]?.type !== 'song') el.stream.querySelector(`.line[data-idx="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  lyricView?.recenter();
}

// ── 请求一期 ──
async function chat(input = '', mood = '') {
  // 聊天模式里一句接一句：已经领好的下一期（可能就是她刚推的歌）留着，不每句都退回去
  const gen = newGeneration({ preserveMusic: true, preservePending: Boolean(input) && chatState.on });
  if (pendingEpisode?.episode?.voice?.status === 'pending') pollPendingVoice();
  beginEar(input ? 'chat' : 'next'); initAudio();
  stopped = false; started = true;
  busy = true; lockUI(true); setState('思考中，音乐继续');
  document.body.classList.add('thinking');
  streamingActive = true;
  const requestId = uuid(); currentRequestId = requestId;
  const cur = currentSongItem();
  const nowPlaying = cur?.type === 'song' ? { type: 'song', title: cur.meta.title, artist: cur.meta.artist,
    ...(cur.meta.year ? { year: cur.meta.year } : {}), ...(cur.meta.genre ? { genre: cur.meta.genre } : {}) } : null;
  try {
    // 服务端最多 150 秒规划 + 20 秒找歌，HTTP 留出 20 秒余量。
    const { data } = await requestJson('chat', '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, mood, requestId, nowPlaying, ...(input && chatState.on ? { chatMode: true } : {}),
        sleep: sleepEnd ? { remainingMin: Math.max(1, Math.ceil((sleepEnd - Date.now()) / 60000)) } : null }),
    }, 190000);
    if (!alive(gen) || data.requestId !== currentRequestId) return;
    // 控制先执行；暂停门只管回复音频，否则“继续播放”也会被暂停。
    if (data.ok && data.episode?.intent === 'control' && acceptEpisode(data.episode)) applyEpisodeAction(data.episode);
    if (!alive(gen) || data.requestId !== currentRequestId) return;
    if (!data.ok || data.control) acceptChatResponse(data);
    else gated('chatResult', () => acceptChatResponse(data));
  } catch {
    if (!alive(gen) || currentRequestId !== requestId) return;
    if (streamPending) {
      if (streamPending && sayEnded) finishAfterSay(streamPending);
      return;
    }
    failChat('这次没等到回复，音乐继续');
  } finally {
    if (alive(gen)) { busy = false; lockUI(false); }
  }
}
function acceptChatResponse(data) {
  if (data.requestId !== currentRequestId) return;
  if (data.ok && data.control) {
    streamingActive = false; disarmWatchdog();
    if (data.control.action === 'output') {
      if (data.output?.ok) applyOutputResult(data.output);
      showControlReply(data.control.reply);
    } else {
      const acted = executeControl(data.control);
      showControlReply(acted || data.control.action !== 'favorite' ? data.control.reply : '现在没有在放歌，没法记。');
    }
    document.body.classList.remove('thinking');
    if (chatState.on) setChatBed(false); // 暂停、换歌、音量这类指令：照指令办，不再压着
    reportEar('control', 'done', { action: data.control.action, clear: true });
  } else if (data.ok && data.episode && acceptEpisode(data.episode)) {
    // 点了歌（马上换）：歌是听众要的，念完按正常音量放；只是聊天就接着压在背景
    if (data.episode.queue?.some((q) => q.type === 'song')) { if (chatState.on) setChatBed(false); } else touchChat();
    if (data.episode.queued?.length) makeRoomForPicks();
    if (!data.episode.say && !data.episode.queue?.some((q) => q.type === 'song')) {
      // 聊天里她觉得不用回：不出字、不出声，头像点一下头
      streamingActive = false; disarmWatchdog(); currentRequestId = null;
      document.body.classList.remove('thinking');
      nod(); setState(soundingMusic() ? '正在播放' : '');
      reportEar(earKind, 'stay', { clear: true });
      return;
    }
    streamPending = data.episode;
    if (chatVoiceFailed || data.episode.voice?.status === 'skipped') {
      chatVoiceFailed = true; failVoice();
    } else if (sayEnded) finishAfterSay(data.episode);
    else if (!voiceContext) {
      const say = data.episode.queue?.find((q) => q.type === 'tts');
      if (say) startChatVoice(say.url, say.text || data.episode.say);
      else if (data.episode.voice?.status === 'pending' || data.streamed) {
        showControlReply(data.episode.say);
        if (laneStarting) skipChatVoice();
        else armWatchdog(CHAT_VOICE_WAIT_MS, true);
      }
      else { showControlReply(data.episode.say); finishAfterSay(data.episode); }
    }
  } else {
    failChat('这次没准备好，音乐继续');
  }
}
// 聊天模式里 Vera 自己推的歌：服务端已把它排成下一期。这一期后面没放的歌让出来，已经领好的下一期退回去，
// 这首放完就接她推的。
function makeRoomForPicks() {
  if (pendingEpisode && !pendingEpisode.started) abandonPending();
  const cut = queue.findIndex((q, n) => n > idx && q.type === 'song');
  if (cut >= 0) queue.splice(cut);
  requestNext();
}
function nod() {
  const avatar = document.querySelector('.stage-head .avatar');
  if (!avatar) return;
  avatar.classList.remove('nod'); void avatar.offsetWidth; avatar.classList.add('nod');
}

// ── 聊天模式 ──
function chatBedOn() { return CHAT_MODE && chatState.on && chatState.bed; }
function paintChatMode() {
  if (!el.chatMode) return;
  el.chatMode.classList.toggle('hidden', !chatState.on);
  el.chatMode.classList.toggle('dim', !chatBedOn());
  el.driveListen?.classList.toggle('hidden', !chatState.on);
}
// 音量目标变了（压到背景 / 回正常）：正在放的那首慢慢过去；交叉淡入中途和口播压低时各自会读新的目标
function applyMusicLevel(ms = 2000) {
  if (overlaying || ducked || paused || stopped || musicFade) return;
  if (!active.paused && !active.ended) rampVolume(active, musicTarget(), ms);
}
function setChatBed(on) {
  const was = chatBedOn();
  chatState.bed = on;
  clearTimeout(chatState.timer); chatState.timer = null;
  if (on) {
    chatState.timer = setTimeout(() => {
      // 在等她回话或她正在念：还在聊，接着等
      if (busy || voiceContext) { setChatBed(true); return; }
      setChatBed(false);
    }, CHAT_IDLE_MS);
  }
  if (was !== chatBedOn()) applyMusicLevel(on ? 1200 : 2000);
  paintChatMode();
}
// 有人在说话（发话、按住说话、打字、她念完一句）：压到背景，重新数 45 秒
function touchChat() { if (CHAT_MODE && chatState.on) setChatBed(true); }
function enterChat() {
  if (!CHAT_MODE) return;
  if (!chatState.on) { chatState.on = true; chatStrip.setOpen(true); }
  setChatBed(true);
}
function exitChat() {
  setChatBed(false); // 先放开背景（还在聊天模式里才算得出音量变了），再退出
  chatState.on = false;
  paintChatMode();
  chatStrip.setOpen(false);
}
el.chatModeExit?.addEventListener('click', (event) => { event.stopPropagation(); exitChat(); });
el.driveListen?.addEventListener('click', exitChat);
el.moodInput.addEventListener('input', touchChat);
// 她回完话（没换歌）接着数 45 秒；自动节目的口播不算有人在聊
voice.addEventListener('ended', () => {
  if (voiceContext?.origin === 'chat' && !voiceContext.getEpisode()?.queue?.some((q) => q.type === 'song')) touchChat();
});

function startChatVoice(url, text) {
  if (!currentRequestId || chatVoiceFailed || chatVoiceUrl === url) return;
  chatVoiceUrl = url;
  startSayOverlay(url, text, () => streamPending);
}

let emptyStreak = 0;
function holdEpisode(ep, id) {
  pendingEpisode = { episode: ep, claimId: id, started: false };
  claimId = id;
  const claimed = pendingEpisode;
  heldClaims.add(claimed);
  later(() => {
    if (claimed.started || claimed.released) return;
    releaseClaim(claimed);
    if (pendingEpisode === claimed) abandonPending();
    if (!pendingEpisode) requestNext();
  }, 15 * 60000, { automatic: false });
  if (ep.voice?.status === 'pending') pollPendingVoice();
  preloadPendingVoice();
  gated('pendingEpisode', () => {
    if (!soundingMusic() && !voiceContext) maybeEnterPending(0);
    else onTimeUpdate();
  });
}
async function requestNext() {
  if (paused) { pausedWork.set('claim', requestNext); return; }
  if (stopped || sleepAfterTrack || pendingEpisode || claimTask || heldClaims.size) return;
  clearTimeout(claimPoll); claimPoll = null;
  if (!earOrigin) beginEar('next');
  const gen = playbackGen;
  const id = claimId ||= uuid();
  const task = { claimId: id, serverGeneration };
  claimTask = task;
  try {
    const { res, data } = await requestJson('claim', `/api/next?claimId=${encodeURIComponent(id)}`);
    if (!alive(gen) || claimTask !== task || claimId !== id) {
      if (task.serverGeneration === serverGeneration) releaseClaim({ claimId: id });
      return;
    }
    observeEpoch(data.epoch ?? data.episode?.epoch, true);
    if (data.ok && data.episode) {
      if (!acceptEpisode(data.episode)) { releaseClaim({ claimId: id }); claimId = null; scheduleClaim(0); return; }
      data.episode.queue = (data.episode.queue || []).filter((q) => q.type !== 'song' || q.url);
      const songs = data.episode.queue.filter((q) => q.type === 'song').length;
      emptyStreak = songs ? 0 : emptyStreak + 1;
      if (!songs) {
        releaseClaim({ claimId: id }); claimId = null;
        setState('暂时找不到可播的歌，先听音乐');
        scheduleClaim(Math.min(60000, 10000 * emptyStreak)); return;
      }
      claimRetry = 0;
      holdEpisode(data.episode, id);
      reportEar('next', 'ready');
    } else if (res.status === 202 || data.busy) {
      setState('节目准备中，先听音乐'); scheduleClaim(8000);
    } else throw new Error('领取节目失败');
  } catch {
    if (!alive(gen) || claimTask !== task || claimId !== id) {
      if (task.serverGeneration === serverGeneration) releaseClaim({ claimId: id });
      return;
    }
    setState('节目暂时没准备好，先听音乐');
    if (!soundingMusic() && !voiceContext?.audible && !paused) ensureFiller();
    scheduleClaim(Math.min(60000, 10000 * 2 ** claimRetry++));
  } finally {
    if (claimTask === task) {
      claimTask = null;
      if (!stopped && !pendingEpisode && !heldClaims.size && !claimPoll) scheduleClaim(8000);
    }
  }
}
function scheduleClaim(ms) {
  clearTimeout(claimPoll);
  claimPoll = later(() => { claimPoll = null; requestNext(); }, ms, { key: 'claimPoll' });
}
function preloadPendingVoice() {
  const holder = pendingEpisode;
  if (!holder || voiceContext || paused || streamingActive) return;
  const tts = holder.episode.queue?.find((q) => q.type === 'tts');
  if (holder.episode.voice?.status !== 'ready' && !tts) return;
  if (tts) setVoiceSource(tts.url, { preload: true });
}
function applyPreparedVoice(holder, data) {
  if (!holder || holder !== pendingEpisode || holder.episode.epoch < latestEpoch) return;
  if (data.status === 'ready' && data.url) {
    holder.episode.voice = { status: 'ready' };
    holder.episode.queue = [{ type: 'tts', url: data.url, text: data.text || holder.episode.say },
      ...holder.episode.queue.filter((q) => q.type !== 'tts')];
    preloadPendingVoice();
    gated('pendingVoice', () => { if (!soundingMusic()) maybeEnterPending(0); else onTimeUpdate(); });
  } else if (data.status === 'skipped') {
    holder.episode.voice = { status: 'skipped' };
    clearTimeout(voicePoll);
  }
}
function pollPendingVoice() {
  clearTimeout(voicePoll);
  const holder = pendingEpisode, gen = playbackGen;
  if (!holder || holder.episode.voice?.status !== 'pending') return;
  voicePoll = later(async () => {
    try {
      const { data } = await requestJson('voice', `/api/episode/${encodeURIComponent(holder.episode.id)}/voice`);
      if (alive(gen)) applyPreparedVoice(holder, data);
    } catch { /* WS 不通时继续按有限间隔查 */ }
    if (alive(gen) && pendingEpisode === holder && holder.episode.voice?.status === 'pending') pollPendingVoice();
  }, 8000, { key: 'voicePoll' });
}
function maybeEnterPending(remain = 0) {
  if (paused || stopped || streamingActive || voiceContext || slots.get(idle)?.loading || !pendingEpisode) return;
  const holder = pendingEpisode, ep = holder.episode;
  if (!acceptEpisode(ep)) { abandonPending(); requestNext(); return; }
  if (exclusiveSink?.uid) {
    if (!soundingMusic() && remain <= 0) { pendingEpisode = null; claimId = null; loadEpisode(ep, holder); }
    return;
  }
  const tts = ep.queue?.find((q) => q.type === 'tts');
  if (ep.voice?.status === 'pending' && remain > 0) return;
  // iPhone：口播一出声就停歌，所以快放完才开始念（念前有 SAY_LEAD_S 的空当），别截掉尾巴
  const sayAt = volumeFixed() ? SAY_LEAD_S + IOS_GAP_S : 8;
  if (tts && ep.voice?.status !== 'skipped' && (voice.readyState >= 3 || !slots.get(active)) && remain <= sayAt) {
    startSayOverlay(tts.url, tts.text || ep.say, () => ep, holder);
    return;
  }
  // 语音没有赶上尾声就放歌，迟到的 voiceReady 不再插入。
  const first = ep.queue?.findIndex((q) => q.type === 'song') ?? -1;
  const span = volumeFixed() ? IOS_GAP_S : crossfadeDuration(slots.get(active)?.item?.meta, ep.queue?.[first]?.meta) / 1000;
  if (remain > span || (tts && ep.voice?.status !== 'skipped' && remain > 0)) return;
  pendingEpisode = null; claimId = null; clearTimeout(voicePoll);
  ep.voice = { status: 'skipped' };
  ep.queue = ep.queue.filter((q) => q.type !== 'tts');
  logChat('claudio', shownSay(ep)); if (ep.say) setState('语音离线，先放歌');
  if (first >= 0) startMusic(ep.queue[0], 0, { episode: ep, holder });
  else { releaseClaim(holder); continueRadio(); }
}
async function prefetchFiller() {
  if (paused) { pausedWork.set('fillerPrefetch', prefetchFiller); return; }
  if (fillerItem || fillerPromise || stopped) return fillerPromise;
  const gen = playbackGen;
  const promise = (async () => {
    try {
      const { data } = await requestJson('filler', `/api/filler?exclude=${recentFillers.join(',')}`, {}, 6500);
      if (!alive(gen) || fillerPromise !== promise || !data.ok || data.item?.type !== 'song') return;
      data.item.meta = { ...data.item.meta, discoveryType: 'filler' };
      fillerItem = data.item;
    } catch { /* 垫歌源暂不可用，后台继续重试 */ }
    finally {
      if (alive(gen) && fillerPromise === promise) {
        fillerPromise = null;
        if (!fillerItem) later(prefetchFiller, 10000, { key: 'fillerRetry' });
      }
    }
  })();
  fillerPromise = promise;
  return promise;
}
async function ensureFiller() {
  const gen = playbackGen;
  if (paused || stopped || overlaying || voiceContext?.audible || slots.get(idle)?.loading || soundingMusic()) return;
  if (!fillerItem) await prefetchFiller();
  if (!alive(gen) || paused || stopped || overlaying || soundingMusic() || slots.get(idle)?.loading || voiceContext?.audible) return;
  const item = fillerItem;
  if (!item) { setState('正在找可播的音乐'); later(ensureFiller, 10000, { key: 'filler' }); return; }
  fillerItem = null;
  if (item.meta.id != null) recentFillers.push(String(item.meta.id));
  if (recentFillers.length > 30) recentFillers.shift();
  const ep = { id: `filler-${uuid()}`, epoch: latestEpoch, queue: [item], voice: { status: 'skipped' } };
  if (exclusiveSink?.uid) loadEpisode(ep);
  else startMusic(item, 0, { episode: ep, duration: 350 });
  prefetchFiller();
}
function continueRadio() {
  if (paused || stopped || switching || voiceContext?.audible) return;
  if (pendingEpisode) { maybeEnterPending(0); if (voiceContext || slots.get(idle)?.loading) return; }
  ensureFiller(); requestNext();
}
function lockUI(on) {
  // 换歌和新问题始终可用，新请求负责取消旧请求。
  el.nextBtn.disabled = false;
}

// ── 控件 ──
// 注：前端本机播放是唯一播放层。后端遥控 / 镜像模式（/api/player/*）已随后端播放引擎一并废弃，相关死代码已整段删除。
function fadeAll(ms, done) {
  for (const track of mediaTracks) {
    rampVolume(track, 0, ms, () => track.pause());
    const env = envelopes.get(track);
    if (env) env.pauseFade = true;
  }
  // 控件收尾独立于每轨包络；快速恢复时替换一轨包络也不会吞掉换歌。
  if (done) later(done, ms, { automatic: false });
}

function resumePlayback() {
  emptyStreak = 0;
  initAudio();
  // 刚打开、停过，或被别的设备接走过：先看服务端记的进度，有就接着放。
  if (!started || stopped || remoteOwner) {
    const gen = playbackGen;
    started = true;
    setState(remoteOwner ? `从 ${remoteOwner.deviceName} 接过来…` : '准备节目，先找音乐');
    fetchHandoff().then((state) => {
      if (gen !== playbackGen) return;
      if (state?.song && resumeFromHandoff(state)) return;
      remoteOwner = null;
      startFresh();
    });
    return;
  }
  started = true;
  if (stopped) { startFresh(); return; }
  const pauseDuration = pauseAt ? performance.now() - pauseAt : 0;
  paused = false;
  for (const env of envelopes.values()) env.start += pauseDuration;
  if (musicFade) musicFade.start += pauseDuration;
  if (voiceContext?.progressAt) voiceContext.progressAt += pauseDuration;
  pauseAt = 0;
  if (exclusiveSink?.uid) {
    if (exclusiveTimer) {
      exclusiveClock.paused = false;
      fetch('/api/exclusive/control', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'resume' }),
      }).catch(() => {});
      exclusiveClock.emit('playing'); setPlayIcon(true);
    }
  } else {
    for (const track of resumeTracks) {
      envelopes.delete(track);
      // 音乐按现在该在的音量接着放：暂停期间聊天背景可能已经恢复或退出了
      const target = track === voice ? (resumeVolumes.get(track) ?? sayVol()) : musicTarget();
      setTrackVol(track, 0);
      const gen = playbackGen;
      track.pause();
      waitForPlaying(track, { signal: playbackController.signal, timeoutMs: mediaDeadline(track.src) }).then(() => {
        if (alive(gen) && !paused) rampVolume(track, target, 300);
        else track.pause();
      }).catch(() => { if (alive(gen) && !paused && track === active) continueRadio(); });
    }
    setPlayIcon(true);
  }
  resumeTracks.clear(); resumeVolumes.clear();
  const work = [...pausedWork.values()]; pausedWork.clear();
  for (const fn of work) { if (paused || stopped) break; fn(); }
  setState('正在播放');
  refreshLyrics();
  preloadPendingVoice(); prefetchFiller();
  if (!soundingMusic() && !voiceContext && !slots.get(idle)?.loading) continueRadio();
}
function startFresh() {
  newGeneration();
  mediaTracks.forEach((track) => track.pause()); slots.clear(); envelopes.clear();
  stopped = false; paused = false; started = true; emptyStreak = 0; pauseAt = 0;
  setState('准备节目，先找音乐');
  prefetchFiller(); requestNext();
  firstStartTimer = later(() => { if (!soundingMusic() && !voiceContext?.audible) ensureFiller(); }, 2500, { key: 'firstStart' });
}

// ── 多设备接力（server/handoff.js）：上报放到哪；别的设备开始响就停；点播放从服务端记的进度接着放 ──
const device = deviceIdentity();
let remoteOwner = null; // 被别的设备接走时记下是谁
async function fetchHandoff() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch('/api/playback', { signal: ctrl.signal });
    const data = await res.json();
    return data?.state || null;
  } catch { return null; } finally { clearTimeout(timer); }
}
// 只接歌，不接口播：换设备接着放不重念。
function resumeFromHandoff(state) {
  const items = [state.song, ...(state.queue || [])].filter((s) => s?.meta?.title && s.url)
    .map((s) => ({ type: 'song', url: s.url, meta: { ...s.meta } }));
  if (!items.length) return false;
  items[0].handoff = true;
  // 这台原来开着的那首（被别的设备接走前停在半截）不记成跳过：歌是换到别处接着听了。
  for (const track of [musicA, musicB]) closeSongSession('handoff', track);
  newGeneration();
  mediaTracks.forEach((track) => track.pause()); slots.clear(); envelopes.clear();
  stopped = false; paused = false; started = true; emptyStreak = 0; pauseAt = 0; remoteOwner = null;
  const ep = { id: `handoff-${Date.now()}`, intent: 'recommend', say: '', queue: items, epoch: latestEpoch };
  activeEpisode = ep; queue = items; idx = -1;
  // 先占住：在响的那台马上停，不用等这边加载完才停（否则两边会同时响几秒）。
  const position = Math.max(0, Number(state.position) || 0);
  fetch('/api/playback', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: device.id, deviceName: device.name, playing: true, position,
      song: { url: items[0].url, meta: items[0].meta }, queue: items.slice(1).map((q) => ({ url: q.url, meta: q.meta })) }),
  }).catch(() => {});
  el.queueCount.textContent = `${items.length} TRACKS`;
  renderStream(ep);
  setPlayIcon(true);
  startMusic(items[0], 0, { episode: ep, reason: 'skip', startAt: position });
  return true;
}
function playbackSnapshot() {
  const item = currentSongItem();
  if (!item) return null;
  const clock = displayedSongClock() || musicElementForItem(item);
  const playing = Boolean(clock && !clock.paused && !isPlaybackPaused());
  const at = queue.indexOf(item);
  const rest = (at >= 0 ? queue.slice(at + 1) : []).filter((q) => q.type === 'song').slice(0, 6)
    .map((q) => ({ url: q.meta?.remoteUrl || q.url, meta: q.meta }));
  return { song: { url: item.meta?.remoteUrl || item.url, meta: item.meta }, position: Number(clock?.currentTime) || 0, playing, queue: rest };
}
let reportTimer = null, reportedAt = 0;
function reportPlayback() {
  clearTimeout(reportTimer); reportTimer = null; reportedAt = Date.now();
  const snap = playbackSnapshot();
  if (!snap || (remoteOwner && !snap.playing)) return;
  if (snap.playing) remoteOwner = null;
  fetch('/api/playback', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
    body: JSON.stringify({ deviceId: device.id, deviceName: device.name, ...snap }),
  }).catch(() => {});
}
function reportPlaybackSoon() { clearTimeout(reportTimer); reportTimer = setTimeout(reportPlayback, 300); }
// 每 5 秒报一次进度。挂在歌的 timeupdate 上：iPhone 锁屏时计时器会被推迟，播放进度事件还在走。
function reportPlaybackTick() { if (Date.now() - reportedAt >= 5000 && playbackSnapshot()?.playing) reportPlayback(); }
setInterval(reportPlaybackTick, 5000);
// 打开时别的设备正在放：先告诉听众，点播放就接过来。
fetchHandoff().then((state) => {
  if (!started && state?.playing && state.deviceId !== device.id) onHandoff(state);
});
function onHandoff(msg) {
  if (!msg.deviceId || msg.deviceId === device.id) return;
  remoteOwner = { deviceId: msg.deviceId, deviceName: msg.deviceName || '另一台设备' };
  if (started && !stopped && !paused) pausePlayback();
  setState(`正在 ${remoteOwner.deviceName} 上播放`);
}

let pauseAt = 0;
const resumeTracks = new Set(), resumeVolumes = new Map();
function pausePlayback() {
  if (paused || stopped) return;
  applyEnvelopes(); paused = true; pauseAt = performance.now();
  resumeTracks.clear(); resumeVolumes.clear();
  for (const [track, slot] of slots) {
    if (!slot.loading) continue;
    slot.controller?.abort(); track.pause(); slots.delete(track);
    pausedWork.set('music', slot.resume);
  }
  if (voiceContext && !voiceContext.audible && !exclusiveSink?.uid) {
    const ctx = voiceContext;
    sayOnEnd?.abort(); voice.pause(); envelopes.delete(voice); voiceContext = null;
    pausedWork.set('say', () => startSayOverlay(ctx.url, ctx.text, ctx.getEpisode, ctx.holder));
  }
  if (exclusiveSink?.uid) {
    exclusiveClock.paused = true;
    fetch('/api/exclusive/control', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'pause' }),
    }).catch(() => {});
  } else {
    for (const track of mediaTracks) {
      if (!track.paused && !track.ended) {
        resumeTracks.add(track); resumeVolumes.set(track, track === voice ? sayVol() : musicTarget());
      }
    }
    fadeAll(250);
  }
  setPlayIcon(false); setState('已暂停');
  lyricClock.refresh();
}
function switchByUser(target) {
  newGeneration(); initAudio();
  if (exclusiveSink?.uid) stopExclusiveClient();
  stopped = false; started = true; switching = true;
  const gen = playbackGen;
  for (const track of [musicA, musicB]) closeSongSession('skip', track);
  fadeAll(350, () => {
    if (!alive(gen)) return;
    switching = false;
    if (paused) { pausedWork.set('advance', () => playIndex(target)); return; }
    if (target < queue.length) playIndex(Math.max(0, target), { reason: 'skip', duration: 350 });
    else { emptyStreak = 0; continueRadio(); }
  });
}
function previousPlayback() { switchByUser(Math.max(0, idx - 1)); }
function nextPlayback() { switchByUser(idx + 1); }
function stopPlayback() {
  newGeneration();
  stopped = true; paused = false; started = false;
  cancelSubtitle(); lyricClock.refresh();
  resumeTracks.clear(); resumeVolumes.clear();
  clearSleep();
  fetch('/api/sleep', { method: 'POST' }).catch(() => {}); // 停了就让后台别再备节目，下次开播自动恢复
  for (const track of [musicA, musicB]) closeSongSession('skip', track);
  if (exclusiveSink?.uid) stopExclusiveClient();
  fadeAll(400, () => { slots.clear(); setPlayIcon(false); setState('已停止'); });
  setPlayIcon(false); document.body.classList.remove('thinking');
  el.barFill.style.width = '0';
}
function dislikeCurrent() {
  const item = currentSongItem();
  if (item?.type !== 'song') return;
  const song = { title: item.meta.title, artist: item.meta.artist };
  reportListeningEvent('dislike', { song, discoveryType: item.meta.discoveryType, source: 'button' });
  el.dislikeBtn.classList.add('dislike-on');
  nextPlayback(); setState('记住了，以后不放这首。');
}

function favoriteCurrent({ toggle = false } = {}) {
  const item = currentSongItem();
  if (!item || item.type !== 'song') return false;
  const k = songKey(item.meta);
  if (toggle && favs.has(k)) favs.delete(k); else favs.add(k);
  paintHeart(el.favBtn, favs.has(k), { pulse: true }); // 收藏瞬间心跳
  localStorage.setItem('claudio-favs', JSON.stringify([...favs]));
  fetch('/api/fav', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: item.meta.title, artist: item.meta.artist, discoveryType: item.meta.discoveryType,
      ...(!favs.has(k) ? { remove: true } : item.meta.friendRec ? { friendRec: item.meta.friendRec } : {}) }),
  }).catch(() => {});
  return true;
}

function setMasterVolume(percent) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  const previous = masterVol;
  masterVol = value / 100;
  const scale = previous ? masterVol / previous : 0;
  for (const env of envelopes.values()) { env.from = env.fromRatio * masterVol; env.to = env.toRatio * masterVol; }
  for (const track of mediaTracks) {
    const target = track === voice ? sayVol() : musicTarget();
    setTrackVol(track, previous ? trackVol(track) * scale : (stopped || paused || track.paused ? 0 : target));
  }
  for (const [track, volume] of resumeVolumes) resumeVolumes.set(track, previous ? volume * scale : (track === voice ? sayVol() : musicTarget()));
  el.vol.value = String(value);
  el.vol.style.setProperty('--v', `${value}%`); // 滑条左半段的填充
  if (exclusiveSink?.uid) {
    fetch('/api/exclusive/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'volume', value: masterVol }),
    }).catch(() => {});
  }
  applyEnvelopes();
  setState(`音量 ${Math.round(value)}%`);
}

function executeControl(control) {
  return executePlayerAction(control, {
    pause: pausePlayback,
    resume: resumePlayback,
    next: nextPlayback,
    previous: previousPlayback,
    stop: stopPlayback,
    favorite: () => favoriteCurrent(),
    dislike: dislikeCurrent,
    getVolume: () => Math.round(masterVol * 100),
    setVolume: setMasterVolume,
  });
}

function applyEpisodeAction(ep) {
  if (!ep?.id || ep.action === 'none' || handledEpisodeActions.has(ep.id)) return false;
  handledEpisodeActions.add(ep.id);
  if (handledEpisodeActions.size > 80) handledEpisodeActions.delete(handledEpisodeActions.values().next().value);
  return executeControl(ep);
}

function showControlReply(text) {
  if (!text) return;
  logChat('claudio', text);
  if (queue[idx]?.type === 'song') return; // 正在放歌：回复只进对话条，大屏留给歌词（顶掉了就要等下一期才回来）
  clearStageView();
  el.stream.innerHTML = BUBBLE_LINE;
  renderStatic(el.stream.querySelector('.bubble'), text);
  el.stream.scrollTop = 0;
}

el.playBtn.addEventListener('click', () => {
  if (!started || !queue.length || isPlaybackPaused()) resumePlayback();
  else pausePlayback();
});
if (navigator.mediaSession?.setActionHandler) {
  for (const [action, handler] of Object.entries({ play: resumePlayback, pause: pausePlayback,
    nexttrack: nextPlayback, previoustrack: previousPlayback, stop: stopPlayback })) {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* 旧 WebKit 只支持部分动作 */ }
  }
}
el.prevBtn.addEventListener('click', previousPlayback);
el.nextBtn.addEventListener('click', nextPlayback);
el.stopBtn.addEventListener('click', stopPlayback);
el.dislikeBtn.addEventListener('click', dislikeCurrent);
el.favBtn.addEventListener('click', () => favoriteCurrent({ toggle: true }));
el.vol.addEventListener('input', () => setMasterVolume(+el.vol.value));
// ── AirPlay 投放：由 WebKit 的 HTMLMediaElement 系统播放目标选择器控制同一条网页音轨。
// 音轨保持原生直连，避免接进 WebAudio 后出现“选到音箱但无声”。
if (el.airplayBtn) {
  if (!AIRPLAY_MODE.visible) {
    el.airplayBtn.style.display = 'none';
  } else if (AIRPLAY_MODE.outputMenu) {
    // 设备菜单靠 macOS 的音频系统；服务跑在 Linux 盒子上时不显示。
    el.airplayBtn.style.display = 'none';
    fetch('/api/status').then((res) => res.json()).catch(() => ({})).then((status) => {
      if (status?.features?.outputs === false) return;
      el.airplayBtn.style.display = '';
      setupOutputMenu();
    });
  } else if (AIRPLAY_MODE.webkitPicker) {
    el.airplayBtn.addEventListener('click', () => {
      try { active.webkitShowPlaybackTargetPicker(); } catch (e) { console.warn('[airplay]', e && e.message); }
    });
    [musicA, musicB].forEach((t) => t.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', () => {
      if (t === active) el.airplayBtn.classList.toggle('casting', !!t.webkitCurrentPlaybackTargetIsWireless);
    }));
  }
}

function setupOutputMenu() {
  const menu = document.createElement('div');
  menu.className = 'output-menu hidden';
  menu.id = 'outputMenu';
  menu.setAttribute('role', 'menu');
  document.body.appendChild(menu);
  const place = () => {
    const rect = el.airplayBtn.getBoundingClientRect();
    // 按钮在窗口下半部，下面放不下就翻到按钮上方
    const flip = rect.bottom + 8 + menu.offsetHeight > innerHeight && rect.top - 8 - menu.offsetHeight > 8;
    menu.style.top = `${Math.round(flip ? rect.top - 8 - menu.offsetHeight : rect.bottom + 8)}px`;
    menu.style.left = `${Math.max(8, Math.round(rect.right - menu.offsetWidth))}px`;
  };
  const close = () => { menu.classList.add('hidden'); idleHider.refresh(); };
  const paint = (data, { pending = '', error = '' } = {}) => {
    const items = Array.isArray(data?.items) ? data.items : [];
    const selected = items.find((item) => item.selected && item.kind === 'airplay');
    el.airplayBtn.classList.toggle('casting', Boolean(selected));
    menu.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'output-note';
      empty.textContent = error || '没有找到播放设备';
      menu.appendChild(empty);
    }
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'output-row';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `output-item${item.selected ? ' selected' : ''}`;
      button.innerHTML = `<span>${escapeHtml(item.name)}</span><small>${escapeHtml(item.detail || '')}</small>`;
      button.addEventListener('click', () => chooseOutput(item.id));
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'output-rename';
      rename.textContent = '改名';
      rename.addEventListener('click', async (event) => {
        event.stopPropagation();
        const alias = window.prompt('给这台设备起个房间名，例如客厅。留空则恢复原名。', item.alias || '');
        if (alias == null) return;
        try {
          const res = await fetch('/api/outputs/alias', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: item.id, alias }),
          });
          const saved = await res.json();
          if (!saved.ok) {
            paint(menu._data, { error: saved.error || '没能改名' });
            return;
          }
        } catch {
          paint(menu._data, { error: '没能改名' });
          return;
        }
        open();
      });
      row.append(button, rename);
      menu.appendChild(row);
    }
    const bluetooth = document.createElement('button');
    bluetooth.type = 'button'; bluetooth.className = 'output-item'; bluetooth.textContent = '蓝牙…';
    bluetooth.addEventListener('click', async () => {
      try {
        const data = await (await fetch('/api/outputs/bluetooth-settings', { method: 'POST' })).json();
        if (!data.ok) paint(menu._data, { error: '没能打开蓝牙设置' });
      } catch { paint(menu._data, { error: '没能打开蓝牙设置' }); }
    });
    menu.appendChild(bluetooth);
    if (pending || error || data?.note) {
      const note = document.createElement('div');
      note.className = 'output-note';
      note.textContent = pending || error || data.note;
      menu.appendChild(note);
    }
    place();
  };
  chooseOutput = async (id) => {
    const gen = newGeneration();
    voice.pause();
    for (const track of [musicA, musicB]) rampVolume(track, paused ? 0 : songVol(), 300);
    paint(menu._data, { pending: '正在切换…' });
    try {
      const res = await fetch('/api/outputs', {
        signal: playbackController.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!alive(gen)) return;
      if (!data.ok) paint(menu._data, { error: data.error || '没能切换' });
      else {
        menu._data = data;
        applyOutputResult(data);
        paint(data);
      }
    } catch {
      paint(menu._data, { error: '没能切换播放设备' });
    }
  };
  const open = async () => {
    menu.classList.remove('hidden');
    idleHider.refresh();
    place();
    paint(menu._data, { pending: '正在找音箱…' });
    try {
      const res = await fetch('/api/outputs');
      const data = await res.json();
      menu._data = data;
      paint(data, { error: data.ok === false ? (data.error || '没有找到播放设备') : '' });
    } catch {
      paint(null, { error: '没有找到播放设备' });
    }
  };
  el.airplayBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (menu.classList.contains('hidden')) open();
    else close();
  });
  document.addEventListener('click', (event) => {
    if (!menu.contains(event.target) && event.target !== el.airplayBtn) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.classList.contains('hidden')) {
      event.preventDefault(); close();
    }
  });
  window.addEventListener('resize', () => { if (!menu.classList.contains('hidden')) place(); });
}
el.sendBtn.addEventListener('click', () => {
  const v = el.moodInput.value.trim(); if (!v) return; el.moodInput.value = '';
  logChat('user', v);
  enterChat();
  chat(v);
});
let voiceRecorder = null;
let voiceChunks = [];
let voiceStopTimer = null;
function voiceMime() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  return ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type)) || '';
}
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      resolve(text.includes(',') ? text.slice(text.indexOf(',') + 1) : text);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
async function toggleVoice() {
  if (voiceRecorder && voiceRecorder.state === 'recording') {
    voiceRecorder.stop();
    return;
  }
  const recordingGen = playbackGen;
  const recordingSignal = playbackController.signal;
  if (!navigator.mediaDevices?.getUserMedia) {
    setState('这台设备录不了音');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
  } catch {
    setState('需要允许麦克风');
    return;
  }
  const mime = voiceMime();
  voiceChunks = [];
  try {
    voiceRecorder = mime ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 16000 }) : new MediaRecorder(stream, { audioBitsPerSecond: 16000 }); // 办公室上行限速，一句话压到十几 KB
  } catch {
    stream.getTracks().forEach((track) => track.stop());
    setState('这台设备录不了音');
    return;
  }
  el.voiceBtn.classList.add('voice-on');
  setState('在听，再说一句，点一下送出');
  voiceRecorder.addEventListener('dataavailable', (event) => {
    if (event.data && event.data.size) voiceChunks.push(event.data);
  });
  voiceRecorder.addEventListener('stop', async () => {
    clearTimeout(voiceStopTimer);
    el.voiceBtn.classList.remove('voice-on');
    stream.getTracks().forEach((track) => track.stop());
    if (!alive(recordingGen)) { voiceRecorder = null; return; }
    const blob = new Blob(voiceChunks, { type: voiceRecorder.mimeType || mime || 'audio/webm' });
    voiceRecorder = null;
    if (blob.size < 800) {
      setState('没听清，再说一次');
      return;
    }
    setState('在听写…');
    try {
      const audioBase64 = await blobToBase64(blob);
      if (!alive(recordingGen)) return;
      const res = await fetch('/api/voice', {
        signal: recordingSignal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBase64, mime: blob.type }),
      });
      const data = await res.json();
      if (!alive(recordingGen)) return;
      if (!data.ok || !data.text) {
        setState(data.error || '没听清，再说一次');
        return;
      }
      el.moodInput.value = '';
      logChat('user', data.text);
      enterChat();
      chat(data.text);
    } catch {
      if (alive(recordingGen)) setState('没听清，再说一次');
    }
  });
  enterChat();
  voiceRecorder.start();
  clearTimeout(voiceStopTimer);
  voiceStopTimer = setTimeout(() => {
    if (voiceRecorder && voiceRecorder.state === 'recording') voiceRecorder.stop();
  }, 20000);
}
if (el.voiceBtn) el.voiceBtn.addEventListener('click', () => { toggleVoice().catch(() => setState('需要允许麦克风')); });
onEnter(el.moodInput, () => el.sendBtn.click());
el.bar.addEventListener('click', (e) => {
  if (overlaying || exclusiveSink?.uid) return; // 口播叠加期 active 是旧歌；音箱播放不跟网页进度条跳
  if (!isFinite(active.duration)) return;
  active.currentTime = seekFraction(el.bar, e) * active.duration;
  refreshLyrics();
});
const songKey = (m) => `${m.title}|${m.artist}`;

// ── 睡眠定时（到点淡出停止 + 晚安）──
// 可见反馈：开=高亮 class + 右上角剩余分钟徽标。emoji 的 color 改不动（旧版「按了没反应」的根因），必须靠 class/徽标。
function updateSleepBadge() {
  const on = Boolean(sleepEnd || sleepAfterTrack);
  el.sleepBtn.classList.toggle('sleep-on', on);
  if (sleepEnd) {
    const rem = Math.max(1, Math.ceil((sleepEnd - Date.now()) / 60000));
    el.sleepBadge.textContent = String(rem);
    el.sleepBtn.title = `睡眠定时 · 剩 ${rem} 分钟`;
  } else {
    el.sleepBadge.textContent = '';
    el.sleepBtn.title = sleepAfterTrack ? '睡眠定时 · 放完这首' : '睡眠定时';
  }
}
function saveSleep() {
  try {
    if (sleepEnd) localStorage.setItem(SLEEP_KEY, String(sleepEnd));
    else localStorage.removeItem(SLEEP_KEY);
  } catch {}
}
function clearSleep() {
  sleepEnd = null; sleepAfterTrack = false;
  clearTimeout(sleepTimer); clearInterval(sleepBadgeTimer);
  saveSleep(); updateSleepBadge();
}
function armSleep(end) {
  clearSleep();
  sleepEnd = end; saveSleep();
  sleepTimer = setTimeout(checkSleep, Math.max(0, end - Date.now()));
  sleepBadgeTimer = setInterval(() => { if (!checkSleep()) updateSleepBadge(); }, 30000);
  updateSleepBadge();
}
function checkSleep() {
  if (!sleepEnd || Date.now() < sleepEnd) return false;
  fadeOutStop();
  return true;
}
// 到点：淡出停播，退回已领的节目，并让后台别再备节目、别再合成口播。
function fadeOutStop(ms = SLEEP_FADE_MS) {
  clearSleep();
  fetch('/api/sleep', { method: 'POST' }).catch(() => {});
  if (stopped) return;
  newGeneration(); stopped = true; paused = false; started = false;
  lyricClock.refresh();
  if (exclusiveSink?.uid) { stopExclusiveClient(); setPlayIcon(false); setState('晚安'); return; }
  for (const track of [musicA, musicB]) closeSongSession('completed', track);
  fadeAll(ms, () => { setPlayIcon(false); setState('晚安'); });
}

function setupSleepMenu() {
  const menu = document.createElement('div');
  menu.className = 'output-menu hidden';
  menu.setAttribute('role', 'menu');
  document.body.appendChild(menu);
  const close = () => { menu.classList.add('hidden'); idleHider.refresh(); };
  const place = () => {
    const rect = el.sleepBtn.getBoundingClientRect();
    const flip = rect.bottom + 8 + menu.offsetHeight > innerHeight && rect.top - 8 - menu.offsetHeight > 8;
    menu.style.top = `${Math.round(flip ? rect.top - 8 - menu.offsetHeight : rect.bottom + 8)}px`;
    menu.style.left = `${Math.max(8, Math.round(rect.right - menu.offsetWidth))}px`;
  };
  const item = (label, onPick, selected = false) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `output-item${selected ? ' selected' : ''}`;
    button.setAttribute('role', 'menuitem');
    button.textContent = label;
    button.addEventListener('click', () => { close(); onPick(); });
    menu.appendChild(button);
  };
  const open = () => {
    menu.innerHTML = '';
    for (const min of SLEEP_CHOICES) {
      item(`${min} 分钟`, () => {
        armSleep(Date.now() + min * 60000);
        setState(`${min} 分钟后停`);
        if (!started || stopped) { started = true; chat(); }
      });
    }
    item('放完这首', () => {
      clearSleep(); sleepAfterTrack = true; updateSleepBadge();
      setState('放完这首就停');
    }, sleepAfterTrack);
    if (sleepEnd || sleepAfterTrack) item('取消定时', () => { clearSleep(); setState('已取消睡眠定时'); });
    menu.classList.remove('hidden');
    idleHider.refresh();
    place();
  };
  el.sleepBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (menu.classList.contains('hidden')) open();
    else close();
  });
  document.addEventListener('click', (event) => {
    if (!menu.contains(event.target) && !el.sleepBtn.contains(event.target)) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.classList.contains('hidden')) { event.preventDefault(); close(); }
  });
  window.addEventListener('resize', () => { if (!menu.classList.contains('hidden')) place(); });
}
setupSleepMenu();
try {
  const saved = Number(localStorage.getItem(SLEEP_KEY));
  if (saved > Date.now() + 1000) armSleep(saved);
  else localStorage.removeItem(SLEEP_KEY);
} catch {}

// ── 点阵电平（舞台右上角）：歌曲和口播共用。优先读 WebAudio 真频谱，拿不到就按音量拟态 ──
const meterCtx = el.meter.getContext('2d');
const METER_PITCH = 5; // 点距（CSS px）
let meterColors = { lit: '#f2f2f2', peak: '#d71921' };
let meterLevels = [];
let meterStill = false; // 已经画过一帧静止画面，空闲时不再重画
function readMeterColors() {
  const css = getComputedStyle(document.documentElement);
  meterColors = {
    lit: css.getPropertyValue('--fg').trim() || '#f2f2f2',
    peak: css.getPropertyValue('--red').trim() || '#d71921',
  };
  meterStill = false;
}
function sizeMeter() {
  const dpr = devicePixelRatio || 1;
  const w = Math.round(el.meter.clientWidth * dpr);
  const h = Math.round(el.meter.clientHeight * dpr);
  if (el.meter.width === w && el.meter.height === h) return;
  el.meter.width = w;
  el.meter.height = h;
  meterStill = false;
}
new ResizeObserver(sizeMeter).observe(el.meter);
sizeMeter();
readMeterColors();

function meterTargets(cols) {
  const targets = new Array(cols).fill(0);
  const tracks = mediaTracks.filter((t) => !t.paused && t.src && t.readyState > 2 && !t.ended);
  const sounding = tracks.length > 0 || Boolean(exclusiveSink?.uid && !exclusiveClock.paused);
  if (analyser && tracks.length) {
    analyser.getByteFrequencyData(freqData);
    const span = freqData.length * 0.7; // 取低~中频段（能量集中区），右端不至于死寂
    for (let i = 0; i < cols; i++) targets[i] = Math.min(1, (freqData[Math.floor((i / cols) * span)] / 255) * 1.25);
  } else if (sounding) {
    const amp = Math.min(1, tracks.length ? Math.max(...tracks.map(trackVol)) : masterVol);
    const t = performance.now();
    for (let i = 0; i < cols; i++) {
      const shape = (1 - i / cols) * 0.65 + 0.35; // 低频(左)大、高频(右)小
      const wob = 0.35 + 0.65 * Math.abs(Math.sin(t / (170 + i * 7) + i * 0.7));
      targets[i] = amp * shape * wob * (0.65 + Math.random() * 0.35);
    }
  }
  return { targets, sounding };
}
function drawMeter() {
  requestAnimationFrame(drawMeter);
  if (document.hidden) return;
  const w = el.meter.width, h = el.meter.height;
  if (!w || !h) return;
  const pitch = METER_PITCH * (devicePixelRatio || 1);
  const cols = Math.max(1, Math.floor(w / pitch));
  const rows = Math.max(1, Math.floor(h / pitch));
  if (meterLevels.length !== cols) { meterLevels = new Array(cols).fill(0); meterStill = false; }
  const { targets, sounding } = meterTargets(cols);
  // 思考中、还没出声：底行一颗红点来回扫（Nothing Glyph 的味道）
  const thinking = !sounding && document.body.classList.contains('thinking');
  const sweep = Math.floor(performance.now() / 70) % Math.max(1, 2 * cols - 2);
  const scanCol = thinking ? (sweep < cols ? sweep : 2 * cols - 2 - sweep) : -1;
  const resting = !sounding && !thinking && meterLevels.every((v) => v < 0.02);
  if (resting && meterStill) return;
  meterStill = resting;

  const dim = new Path2D(), lit = new Path2D(), peak = new Path2D();
  const radius = pitch * 0.26;
  const ox = (w - cols * pitch) / 2, oy = (h - rows * pitch) / 2;
  for (let c = 0; c < cols; c++) {
    meterLevels[c] += (targets[c] - meterLevels[c]) * 0.28;
    const on = Math.round(meterLevels[c] * rows);
    for (let r = 0; r < rows; r++) { // r = 0 是最底下一行
      const x = ox + (c + 0.5) * pitch, y = oy + (rows - r - 0.5) * pitch;
      const path = (r === 0 && c === scanCol) ? peak : r < on ? (r === on - 1 ? peak : lit) : dim;
      path.moveTo(x + radius, y);
      path.arc(x, y, radius, 0, Math.PI * 2);
    }
  }
  meterCtx.clearRect(0, 0, w, h);
  meterCtx.fillStyle = meterColors.lit;
  meterCtx.globalAlpha = 0.14;
  meterCtx.fill(dim);
  meterCtx.globalAlpha = 0.9;
  meterCtx.fill(lit);
  meterCtx.globalAlpha = 1;
  meterCtx.fillStyle = meterColors.peak;
  meterCtx.fill(peak);
}
drawMeter();

// ── WS（带断线指数退避重连）──
let ws = null;
let wsRetry = 0;
function wsAlive() { return ws && ws.readyState === WebSocket.OPEN; }

function setConn(ok) {
  el.connState.textContent = ok ? 'CONNECTED' : 'OFFLINE';
  el.liveTag.textContent = ok ? 'ON AIR' : 'OFFLINE';
  el.liveTag.classList.toggle('on', ok);
  el.connMsg.textContent = ok ? 'Connected to Claudio server' : 'Disconnected';
}

function applyLyrics(msg) {
  const tracks = Array.isArray(msg.tracks) ? msg.tracks : [];
  if (!tracks.length || !msg.id) return;
  const patch = (list) => {
    if (!Array.isArray(list)) return;
    for (const track of tracks) {
      for (const item of list) {
        if (item?.type === 'song' && item.meta?.title === track.title && item.meta?.artist === track.artist) {
          item.meta.lyric = track.lyric || '';
        }
      }
    }
  };
  if (streamPending?.id === msg.id) patch(streamPending.queue);
  if (pendingEpisode?.episode.id === msg.id) patch(pendingEpisode.episode.queue);
  if (activeEpisode?.id === msg.id) {
    patch(activeEpisode.queue);
    if (queue !== activeEpisode.queue) patch(queue);
    const current = displayedSong;
    const match = current?.type === 'song'
      && tracks.find((track) => track.title === current.meta.title && track.artist === current.meta.artist);
    if (match && !overlaying) {
      bindLyrics(el.stream.querySelector('.line.active .lyric'), current);
    }
  }
}

function ackRemote(id, ok, error = '') {
  if (!id || !wsAlive()) return;
  try { ws.send(JSON.stringify({ kind: 'remoteAck', id, ok, error })); } catch { /* 服务端会按超时失败 */ }
}

function handleRemote(msg) {
  if (msg.kind === 'remotePlay') {
    if (!started) {
      ackRemote(msg.id, false, '电脑上的 Claudio 还没点过播放');
      return;
    }
    if (msg.mode === 'next') {
      ackRemote(msg.id, true);
      nextPlayback();
      return;
    }
    if (msg.episode?.queue?.length) {
      newGeneration(); stopped = false; loadEpisode(msg.episode);
      ackRemote(msg.id, true);
      return;
    }
    ackRemote(msg.id, false, '没有可放的歌');
    return;
  }
  if (msg.kind === 'remoteControl' && msg.control) {
    const acted = executeControl(msg.control);
    ackRemote(msg.id, acted, acted ? '' : '现在做不到');
  }
}

function handleWS(e) {
  let msg; try { msg = JSON.parse(e.data); } catch { return; }
  if (msg.kind === 'hello') { observeServerEpoch(msg.epoch); return; }
  if (msg.kind === 'handoff') { onHandoff(msg); return; }
  if (msg.kind === 'scheduled') {
    if (!msg.claimId || !msg.episode) return;
    if (pendingEpisode?.claimId === msg.claimId) return;
    const occupied = Boolean(pendingEpisode);
    const valid = acceptEpisode(msg.episode);
    if (occupied || !started || stopped || !valid) {
      releaseClaim({ claimId: msg.claimId });
      return;
    }
    // 定时节目已在服务端领取，替换尚未完成的普通领取。
    requests.claim?.abort(); requests.claim = null;
    abandonPending();
    holdEpisode(msg.episode, msg.claimId);
    el.connMsg.textContent = '定时节目已就绪';
    return;
  }
  if (msg.kind === 'episodesInvalidated') {
    observeEpoch(msg.epoch);
    if (!stopped && !pendingEpisode) scheduleClaim(0);
    return;
  }
  observeEpoch(msg.epoch ?? msg.episode?.epoch);
  if (msg.kind === 'remotePlay' || msg.kind === 'remoteControl') { handleRemote(msg); return; }
  if (msg.kind === 'nextReady' && started && !stopped) {
    el.connMsg.textContent = '下一期已就绪';
    if (!pendingEpisode && (!exclusiveSink?.uid || exclusiveClock.paused)) { clearTimeout(claimPoll); claimPoll = null; gated('claimReady', requestNext); }
  }
  // 驾驶模式开关变了：服务端把备好的下一段口播改短、重新合成；这里换掉手上那份的旧口播，等新的或直接放歌
  if (msg.kind === 'sayRevised' && pendingEpisode?.episode.id === msg.episodeId && !pendingEpisode.started) {
    const ep = pendingEpisode.episode;
    ep.say = msg.say;
    ep.queue = ep.queue.filter((q) => q.type !== 'tts');
    ep.voice = { status: msg.voice === 'pending' ? 'pending' : 'skipped' };
    if (ep.voice.status === 'pending') pollPendingVoice(); else clearTimeout(voicePoll);
  }
  if (msg.kind === 'voiceReady' && pendingEpisode?.episode.id === msg.episodeId) {
    applyPreparedVoice(pendingEpisode, { ...msg, status: 'ready' });
  }
  // 只有当前聊天的回包可以接入口播，其他服务端路径不能冒充回复。
  if (msg.kind === 'sayDraft' && msg.requestId === currentRequestId && msg.origin === 'chat' && !stopped && !voiceContext && !streamPending) {
    logChat('claudio', msg.say, { draft: true });
    setState('选歌中…');
  }
  if (['sayReady', 'episode', 'sayFailed'].includes(msg.kind)) {
    if (!currentRequestId || msg.requestId !== currentRequestId || msg.origin !== 'chat' || stopped) return;
    if (msg.kind === 'episode' && msg.episode?.intent === 'control' && acceptEpisode(msg.episode)) applyEpisodeAction(msg.episode);
    gated(`chat-${msg.kind}`, () => {
      if (msg.requestId !== currentRequestId) return;
      if (msg.kind === 'sayReady' && msg.url) startChatVoice(msg.url, msg.say || msg.text);
      if (msg.kind === 'episode' && msg.episode && acceptEpisode(msg.episode)) {
        streamPending = msg.episode;
        if (chatVoiceFailed || msg.episode.voice?.status === 'skipped') failVoice();
        else if (sayEnded) finishAfterSay(msg.episode);
      }
      if (msg.kind === 'sayFailed') { chatVoiceFailed = true; failVoice(); }
    });
  }
  if (msg.kind === 'lyrics') applyLyrics(msg);
  if (msg.kind === 'ttsLane') showLane(msg.state, msg.message);
  if (msg.kind === 'ttsError') { setState('语音失败，音乐继续'); showLane('error', '语音暂时不可用'); }
}

function connectWS() {
  // https 页面（经 Tailscale serve）只能连 wss://，写死 ws:// 会被浏览器拦下，页面一直显示 OFFLINE。
  try { ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/stream`); }
  catch { setConn(false); scheduleReconnect(); return; }
  ws.onopen = () => { setConn(true); wsRetry = 0; };
  ws.onmessage = handleWS;
  ws.onclose = () => { setConn(false); scheduleReconnect(); };
  ws.onerror = () => { setConn(false); }; // 紧跟的 onclose 负责重连，避免双触发
}
function scheduleReconnect() {
  wsRetry = Math.min(wsRetry + 1, 6);
  const delay = Math.min(30000, 1000 * 2 ** (wsRetry - 1)); // 1s,2s,4s,…,30s 上限
  setTimeout(connectWS, delay);
}
// 点头像看 Claudio 记下的关于你的事（长期记忆，透明可见）
function closeMemory() { el.memoryPanel.classList.add('hidden'); idleHider.refresh(); }
document.querySelector('.avatar')?.addEventListener('click', async () => {
  if (!el.memoryPanel.classList.contains('hidden')) { closeMemory(); return; }
  try {
    const book = await (await fetch('/api/notebook')).json().catch(() => null);
    const notes = (book?.notes || []);
    el.memoryText.innerHTML = '';
    if (notes.length) {
      const labels = { person: '人', habit: '习惯', song: '歌', event: '事' };
      for (const key of ['person', 'habit', 'song', 'event']) {
        const list = notes.filter((note) => note.kind === key && note.status !== 'muted');
        if (!list.length) continue;
        const head = document.createElement('div');
        head.className = 'memory-kind';
        head.textContent = labels[key];
        el.memoryText.appendChild(head);
        const ul = document.createElement('ul');
        for (const note of list.slice(-8)) {
          const li = document.createElement('li');
          li.textContent = note.text;
          ul.appendChild(li);
        }
        el.memoryText.appendChild(ul);
      }
    } else if (!book?.migrated) {
      // 还没迁到笔记本：先照旧显示 memory.md
      const j = await (await fetch('/api/memory')).json();
      const mem = (j.ok && (j.memory || '')).trim();
      el.memoryText.textContent = mem || '还没记下什么，多陪我聊聊就慢慢懂你了。';
    } else {
      el.memoryText.textContent = '还没记下什么，多陪我聊聊就慢慢懂你了。';
    }
    const link = document.createElement('a');
    link.className = 'memory-open';
    link.href = '/notebook';
    link.textContent = '打开笔记本：改、删、别再提 →';
    el.memoryText.appendChild(link);
    el.memoryPanel.classList.remove('hidden');
    idleHider.refresh();
  } catch {}
});
el.memoryPanel.addEventListener('click', closeMemory);
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const panelOpen = !el.settingsBackdrop.classList.contains('hidden')
    || !el.memoryPanel.classList.contains('hidden') || el.chat.classList.contains('open');
  if (!panelOpen) return;
  event.preventDefault();
  closeSettings();
  closeMemory();
  setChatOpen(false);
});

// 窗口模式只管呈现，音乐仍由播放引擎持有。
const isInteractionActive = () => Boolean(
  document.querySelector('.output-menu:not(.hidden), [popover]:popover-open, [role="menu"][data-open="true"]')
  || !el.settingsBackdrop.classList.contains('hidden')
  || !el.memoryPanel.classList.contains('hidden')
  || el.chat.classList.contains('open')
);
const immersive = wireImmersive({
  button: el.fullscreenBtn,
  isInteractionActive,
  onError: () => setState('窗口切换失败，请重试'),
  beforeToggle: () => { closeSettings(); closeMemory(); setChatOpen(false); },
  onChange: () => {
    lyricView?.recenter();
    requestAnimationFrame(() => lyricView?.recenter());
  },
});
const idleHider = immersive.idleHider;
window.addEventListener('pagehide', () => {
  reportPlayback();
  clearStageView(); lyricClock.stop();
  immersive.dispose().catch(() => {});
}, { once: true });

connectWS();
