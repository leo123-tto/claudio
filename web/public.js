// 公用版播放引擎：一个 <audio> 顺序放（口播和歌共用），队列空了就让 DJ 接着排。
// 界面和个人版同一份（index.html / styles.css / ui.js）；这里只管公用版的播放、门口、绑定、配额、最近听过。
import { parseLrc, createLyricView, startLyricClock, LYRIC_LEAD } from './lyrics.js';
import { listenForAnswer, ANSWER_FALLBACK_MS } from './rec-ask.js';
import { createCovers, createChatStrip, wireImmersive, MASCOT, fmtTime, paintProgress, seekFraction, paintHeart, onEnter, paintQuality } from './ui.js';

const $ = (id) => document.getElementById(id);
const audio = document.createElement('audio');
audio.preload = 'auto';
document.body.append(audio);
let me = null;
let queue = [];
let current = null;
let fetching = false;
let heartbeatTimer = null;
let qrTimer = null;
// 这次打开网页卡顿过、降到 320k 了（见「卡顿自动降档」）；同一个标签页刷新还算
let smooth = (() => { try { return sessionStorage.getItem('dj_smooth') === '1'; } catch { return false; } })();
let srcChangedAt = 0;
let seekedAt = 0;
let stalls = 0;
let inStall = false;
let stallTimer = null;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || '请求没成功'), { status: res.status, code: data.error });
  return data;
}

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* 无痕窗口存不了就算了 */ } },
};

function show(view) {
  for (const id of ['loading', 'gate', 'app']) $(id).classList.toggle('hidden', id !== view);
}

function setNotice(text) { $('notice').textContent = text || ''; }

// 头像那里个人版是「Claudio 记得的事」，公用版没有
document.querySelector('.avatar')?.removeAttribute('title');
$('moodInput').placeholder = '想听点什么';

function renderMe() {
  $('quotaTag').textContent = me ? `今天还剩 ${me.remaining}` : '';
  $('meName').textContent = me.name || 'Claudio';
  $('ncmState').textContent = me.bound ? (me.nickname || '已绑定') + (me.vip ? ' · 会员' : '') : (me.canAsk ? '未绑定' : '未绑定，只放免费歌');
  $('ncmBtn').textContent = me.bound ? '解绑' : '扫码绑定';
  $('devState').textContent = `${me.devices} / ${me.maxDevices}`;
  $('pairBtn').disabled = me.devices >= me.maxDevices;
  // 能不能点歌看 canAsk（绑了，或者有运营者配置的默认音源）；老服务没这个字段时退回看 bound
  const canAsk = me.canAsk ?? me.bound;
  $('moodInput').placeholder = canAsk ? '想听点什么' : '绑定网易云后可以点歌';
  $('bindTip').classList.toggle('hidden', Boolean(canAsk));
  // 笔记本里的条数（个人版的记忆面板也走同一个说法）；老服务没这个字段时退回老 prefs
  $('memState').textContent = typeof me.notesCount === 'number'
    ? (me.notesCount ? `她记着你 ${me.notesCount} 件事` : '还没记什么')
    : (me.prefs?.length ? me.prefs.join('、') : '还没记什么');
  // 音质只有绑定的会员能选（别的一直是 320k）
  $('qualityGroup').classList.toggle('hidden', !(me.bound && me.vip));
  for (const b of $('qualitySeg').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.value === (me.quality || 'lossless')));
  for (const b of $('talkSeg').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.value === (me.talk || 'normal')));
  // 本地语气扩展：服务端数据目录里有那份文件才出现，名字也由文件定
  $('adultGroup').classList.toggle('hidden', !me.adultLabel);
  $('adultTitle').textContent = me.adultLabel || '';
  for (const b of $('adultSeg').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.value === (me.adult ? 'on' : 'off')));
}

async function load() {
  show('loading');
  const hash = location.pathname === '/join' ? location.hash.slice(1) : '';
  // 邀请链接只能用一次：在微信里打开会把微信内置浏览器绑成这台设备，先提醒一下
  let wechatOk = false;
  try { wechatOk = sessionStorage.getItem('dj_wechat_ok') === '1'; } catch { /* 读不到当没确认 */ }
  if (hash && /MicroMessenger/i.test(navigator.userAgent) && !wechatOk) {
    show('gate');
    $('pairForm').classList.add('hidden');
    $('gateMsg').textContent = '邀请链接只能用一次。想在 Safari / Chrome 里听，点右上角「在浏览器打开」；就在微信里听，点下面。';
    $('wechatGo').classList.remove('hidden');
    $('wechatGo').onclick = () => {
      try { sessionStorage.setItem('dj_wechat_ok', '1'); } catch { /* 存不了也照走 */ }
      $('wechatGo').classList.add('hidden');
      $('pairForm').classList.remove('hidden');
      load();
    };
    return;
  }
  if (hash) {
    history.replaceState(null, '', '/');
    try {
      await api('/api/join', { method: 'POST', body: { token: hash } });
    } catch (error) {
      show('gate');
      $('gateMsg').textContent = error.message;
      return;
    }
  }
  try {
    me = await api('/api/me');
  } catch (error) {
    show('gate');
    // 没加入、或旧设备失效（cookie 过期 / 被移除，回 invalid 等）都安静地等输入，不报「链接或配对码不对」；
    // 账号停用 / 到期、后台连不上这类才说。错的配对码和无效邀请链接在上面各自的地方报。
    const quiet = error.status === 401 && !['disabled', 'expired'].includes(error.code);
    $('gateMsg').textContent = quiet ? '' : error.message;
    return;
  }
  renderMe();
  show('app');
}

$('pairForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = $('pairCode').value.replace(/\D/g, '');
  if (code.length !== 6) { $('gateMsg').textContent = '配对码是 6 位数字'; return; }
  try {
    await api('/api/pair/redeem', { method: 'POST', body: { code } });
    $('gateMsg').textContent = '';
    load();
  } catch (error) { $('gateMsg').textContent = error.message; }
});

// ---- 正在放：封面、背景、音质 ----
const covers = createCovers({ imgs: [...document.querySelectorAll('.cover-img')], bdA: $('bdA'), bdB: $('bdB') });
const sized = (url, size) => (url ? `${url}?param=${size}y${size}` : '');

// 状态条是个人版的（正在播放 / 正在念口播）；公用版只标音质
$('nowState').classList.add('hidden');
function setNowPlaying(song, title = '') {
  $('nowTitle').textContent = song?.title || title;
  $('nowMeta').textContent = song?.artist || '';
  paintQuality($('nowQuality'), song?.quality);
  covers.paintThumbs(sized(song?.cover, 600));
  covers.setBackdrop(sized(song?.cover, 600));
  document.title = song?.title ? `${song.title} · Claudio` : 'Claudio';
  try { window.dispatchEvent(new CustomEvent('claudio:now', { detail: song?.id ? song : null })); } catch { /* 好友互荐（friends.js）出错不影响放歌 */ }
}

setNowPlaying(null, '按下播放，或者说说想听什么');

// ---- 舞台：歌词 / DJ 的话，同一时间亮一个（和个人版同样的 .line 结构）----
$('stream').innerHTML = '<div class="line song" id="lyricLine"><div class="lyric" id="lyricBox"></div></div>'
  + '<div class="line" id="djLine"><span class="who">Claudio</span><div class="bubble" id="djSay"></div></div>';
let lyricView = null;
let djTimer = null;
const lyricClock = startLyricClock({
  getTime: () => audio.currentTime || 0,
  isActive: () => Boolean(lyricView && mode === 'song' && current && !audio.paused),
  onTick: (t) => lyricView?.setTime(t),
});
function showStage(which) {
  const lyric = which === 'lyric';
  for (const [id, on] of [['lyricLine', lyric], ['djLine', which === 'dj']]) {
    const line = $(id);
    if (on && !line.classList.contains('active')) {
      line.classList.remove('enter');
      void line.offsetWidth;
      line.classList.add('enter');
    }
    line.classList.toggle('active', on);
  }
  if (lyric) { lyricView?.recenter(); lyricClock.refresh(); }
}
// DJ 说一句：念口播时一直亮着，聊天回话亮几秒再回歌词
// 她提起了一件旧事：小角标，点开是那条记忆和你的原话。
function renderDjMemory(ref) {
  const host = $('djLine');
  host.querySelector('.say-memory')?.remove();
  if (!ref) return;
  const wrap = document.createElement('div');
  wrap.className = 'say-memory';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'say-memory-btn';
  btn.textContent = '她想起了你说的那件事';
  const detail = document.createElement('div');
  detail.className = 'say-memory-detail hidden';
  const date = new Date(ref.at);
  detail.textContent = [ref.text, ref.quote ? `你的原话：${ref.quote}` : '',
    Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`]
    .filter(Boolean).join('\n');
  btn.addEventListener('click', (event) => { event.stopPropagation(); detail.classList.toggle('hidden'); });
  wrap.append(btn, detail);
  host.appendChild(wrap);
}

function showDj(text, hold = 0, ref = null) {
  clearTimeout(djTimer);
  if (!text) return;
  $('djSay').textContent = text;
  renderDjMemory(ref);
  showStage('dj');
  if (hold) djTimer = setTimeout(() => { if (mode === 'song' && current) showStage('lyric'); }, hold);
}
function bindLyrics(song) {
  lyricView?.destroy();
  lyricView = null;
  $('lyricBox').className = 'lyric';
  $('lyricBox').textContent = [song.title, song.artist].filter(Boolean).join(' · ');
  api(`/api/lyric?id=${encodeURIComponent(song.id)}`).then(({ lrc }) => {
    const lines = parseLrc(lrc);
    if (current !== song || !lines) return;
    lyricView = createLyricView($('lyricBox'));
    lyricView.render(lines);
    lyricView.setTime((audio.currentTime || 0) + LYRIC_LEAD);
    lyricView.recenter();
    lyricClock.refresh();
  }).catch(() => {});
}

// ---- 对话条、沉浸歌词（和个人版同一份）----
const SHEETS = ['accountBackdrop', 'historyBackdrop', 'qrBackdrop'];
const sheetOpen = () => SHEETS.some((id) => !$(id).classList.contains('hidden'));
const chatStrip = createChatStrip({ chat: $('chat'), log: $('chatLog'), toggle: $('chatToggle'), onChange: () => immersive.idleHider.refresh() });
const immersive = wireImmersive({
  button: $('fullscreenBtn'),
  isInteractionActive: () => sheetOpen() || chatStrip.isOpen(),
  onError: () => setNotice('全屏没切过去，再点一次'),
  beforeToggle: () => chatStrip.setOpen(false),
  onChange: () => {
    lyricView?.recenter();
    requestAnimationFrame(() => lyricView?.recenter());
  },
});

// ---- 播放 ----
function startHeartbeat(takeover = false) {
  const beat = async (take) => {
    try {
      await api('/api/play/heartbeat', { method: 'POST', body: { takeover: take } });
      setNotice('');
    } catch (error) {
      if (error.status === 409 || error.status === 503) {
        wantPlay = false;
        audio.pause();
        stopHeartbeat();
        setNotice(error.message);
        if (error.status === 409) $('playBtn').dataset.takeover = '1';
      } else if (error.status === 401) load();
    }
  };
  stopHeartbeat();
  beat(takeover);
  heartbeatTimer = setInterval(() => beat(false), 30_000);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

// 自动接着放（text 为空）没要到歌时自己过一会儿再要，不停在「正在找下一首」；用户按了暂停、额度用完就不再要。
const RETRY_MS = [5000, 15000, 30000, 60000];
let retries = 0;
let retryTimer = null;
let wantPlay = false;
function retryLater() {
  clearTimeout(retryTimer);
  const wait = RETRY_MS[Math.min(retries, RETRY_MS.length - 1)];
  retries += 1;
  retryTimer = setTimeout(() => {
    if (!wantPlay || queue.length) return;
    if (current) ask(''); else playNext();
  }, wait);
  return Math.round(wait / 1000);
}

async function ask(text = '') {
  if (fetching) return;
  clearTimeout(retryTimer);
  fetching = true;
  $('moodInput').disabled = true;
  if (text) { chatStrip.add('user', text); showDj('…'); $('djSay').classList.add('typing'); }
  try {
    const out = await api('/api/chat', { method: 'POST', body: { text, drive: document.body.classList.contains('drive-on'), smooth, ahead: Boolean(current),
      ...(text && chatEnabled() ? { chatMode: true } : {}) } });
    if (typeof out.remaining === 'number') me.remaining = out.remaining;
    renderMe();
    if (out.needBind) { if (text) showStage(current ? 'lyric' : 'none'); return startQr(); }
    if (text && out.say) chatStrip.add('dj', out.say);
    setNotice(out.notice || '');
    if (text && out.songs.length && out.when === 'next' && current) {
      // 聊天模式里她自己推的：排在这首后面，回话现在就念
      retries = 0;
      queue = [...out.songs, ...queue];
      if (out.say) showDj(out.say, 8000);
      speakReply(out);
    } else if (out.songs.length) {
      if (text && chatState.active) setBed(false); // 听众要的歌：念完按正常音量放
      retries = 0;
      if (out.voice || out.say) Object.assign(out.songs[0], { voice: out.voice || '', say: out.say || '',
        ...(out.memoryRef ? { memoryRef: out.memoryRef } : {}) });
      // 点歌或空档时最多等 4 秒口播；正在放时预取的那批还早，后台慢慢取
      const voiceReady = prefetchVoice(out.songs[0]);
      for (const song of out.songs.slice(1)) prefetchVoice(song); // 后面几首的报幕是后台现写的，慢慢取
      if (text || !current) await Promise.race([voiceReady, new Promise((r) => setTimeout(r, 4000))]);
      queue = text ? out.songs : [...queue, ...out.songs];
      if (text || !current) { wantPlay = true; playNext(); }
    } else if (text) {
      if (out.say) { showDj(out.say, 8000, out.memoryRef || null); if (chatState.active) speakReply(out); }
      else if (chatState.active && out.intent === 'chat' && !out.notice) { showStage(current ? 'lyric' : 'none'); nod(); }
      else {
        showStage(current ? 'lyric' : 'none');
        if (!out.notice) setNotice('这次没找到能放的歌，换个说法试试');
      }
    } else {
      const wait = retryLater();
      if (!current) setNotice(`${(out.notice || '这次没要到能放的歌').replace(/[。？！.?!]+$/, '')}，${wait} 秒后再试`);
    }
  } catch (error) {
    if (text) showStage(current ? 'lyric' : 'none');
    if (error.status === 401) return load();
    if (!text && error.code !== 'quota') {
      const wait = retryLater();
      // 正在放的时候预取失败不打扰，悄悄重试
      if (!current) setNotice(`${error.message.replace(/[。？！.?!]+$/, '')}，${wait} 秒后再试`);
    } else setNotice(error.message);
  } finally {
    $('djSay').classList.remove('typing');
    fetching = false;
    $('moodInput').disabled = false;
  }
}

// 响度统一：网易云的 gain 是把这首拉到 -18 LUFS 要加的分贝。目标按 -14 LUFS 放，只往下压（最大就是 1），
// 太吵的母带压下来，偏轻的歌原样放。只往下压，所以直接用 audio.volume（音量滑块乘在上面），不接 Web Audio：
// 歌直接从音乐 CDN 取，有的 CDN 不给跨域头，接进 Web Audio 会变哑。iOS 不给改音量（响度不统一，音量用实体键）。
function loudnessVolume(gain) {
  if (typeof gain !== 'number') return 1;
  return Math.max(0.2, Math.min(1, 10 ** ((gain + 4) / 20)));
}

let loudness = 1;
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
document.body.classList.toggle('ios', IOS);
function applyVolume() {
  audio.volume = loudness * (IOS ? 1 : (Number($('vol').value) / 100) * bedLevel);
  talk.volume = IOS ? 1 : Number($('vol').value) / 100;
}
function applyLoudness(gain) { loudness = loudnessVolume(gain); applyVolume(); }
$('vol').value = Number(store.get('dj_vol') ?? 100);
$('vol').addEventListener('input', () => { store.set('dj_vol', $('vol').value); applyVolume(); });

// ---- 聊天模式（事项 24）----
// 聊着天时歌压到 CHAT_BED，45 秒没人说话回到正常音量。回话另开一路 <audio> 念（电脑、安卓）；
// iPhone 不让网页改音量、第二路也不一定让出声：念回话时先停歌，念完从原处接着放。
const MODE_CFG = globalThis.claudioMode || {};
const CHAT_MODE = Boolean(MODE_CFG.features?.chatMode);
const CHAT_BED = Math.min(1, Math.max(0, Number(MODE_CFG.chat?.bed ?? 0.25)));
const CHAT_IDLE_MS = Math.max(5000, Number(MODE_CFG.chat?.idleMs ?? 45000));
const talk = new Audio();
const chatState = { active: false, bed: false, timer: null };
let bedLevel = 1, bedRamp = null;
let speaking = false, replySeq = 0;
let held = null, inlineUrl = '';
function chatEnabled() { return CHAT_MODE && store.get('dj_chat') !== 'off'; }
function paintChatSeg() {
  for (const b of $('chatSeg').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.value === (chatEnabled() ? 'on' : 'off')));
}
function paintChatMode() {
  $('chatMode').classList.toggle('hidden', !chatState.active);
  $('chatMode').classList.toggle('dim', !chatState.bed);
  $('driveListen').classList.toggle('hidden', !chatState.active);
}
function rampBed(target) {
  clearInterval(bedRamp);
  const from = bedLevel, start = performance.now(), ms = target < from ? 1200 : 2000;
  bedRamp = setInterval(() => {
    const k = Math.min(1, (performance.now() - start) / ms);
    bedLevel = from + (target - from) * k;
    applyVolume();
    if (k >= 1) clearInterval(bedRamp);
  }, 40);
}
function setBed(on) {
  chatState.bed = on;
  clearTimeout(chatState.timer); chatState.timer = null;
  if (on) {
    chatState.timer = setTimeout(() => {
      if (fetching || speaking) { setBed(true); return; } // 还在等她回话、她还在念
      setBed(false);
    }, CHAT_IDLE_MS);
  }
  rampBed(on ? CHAT_BED : 1);
  paintChatMode();
}
function touchChat() { if (chatState.active) setBed(true); }
function enterChat() {
  if (!chatEnabled()) return;
  if (!chatState.active) { chatState.active = true; chatStrip.setOpen(true); }
  setBed(true);
}
function exitChat() {
  setBed(false);
  chatState.active = false;
  replySeq += 1;
  talk.pause();
  if (mode === 'chatvoice') finishInline();
  speaking = false;
  paintChatMode();
  chatStrip.setOpen(false);
}
function nod() {
  const avatar = document.querySelector('.stage-head .avatar');
  if (!avatar) return;
  avatar.classList.remove('nod'); void avatar.offsetWidth; avatar.classList.add('nod');
}
// 回话的语音：老板那边 5090 空着才念（204 就只出字），最多等 20 秒；等的时候又说了一句，旧的就不念了
async function speakReply(out) {
  if (!out.voice) return;
  const seq = ++replySeq;
  const holder = { voice: out.voice };
  await Promise.race([prefetchVoice(holder), new Promise((r) => setTimeout(r, 20_000))]);
  if (!holder.voiceUrl) return;
  if (seq !== replySeq || !chatState.active || mode === 'voice') { URL.revokeObjectURL(holder.voiceUrl); return; }
  if (IOS) { speakInline(holder.voiceUrl); return; }
  talk.pause();
  talk.src = holder.voiceUrl;
  speaking = true;
  const done = () => { if (talk.src !== holder.voiceUrl) return; speaking = false; URL.revokeObjectURL(holder.voiceUrl); touchChat(); };
  talk.onended = done; talk.onerror = done;
  talk.play().catch(done);
}
// iPhone：同一个 <audio> 先念回话，念完把歌接回原处（直链支持跳转；跳不了就从头放这首）
function speakInline(url) {
  held = current && mode === 'song' ? { song: current, src: audio.currentSrc || audio.src, at: audio.currentTime, playing: !audio.paused } : null;
  mode = 'chatvoice'; speaking = true; inlineUrl = url;
  srcChangedAt = Date.now();
  audio.src = url;
  applyLoudness(null);
  audio.play().catch(() => finishInline());
}
function finishInline() {
  if (mode !== 'chatvoice') return;
  mode = 'song'; speaking = false;
  if (inlineUrl) URL.revokeObjectURL(inlineUrl);
  inlineUrl = '';
  const h = held; held = null;
  touchChat();
  if (!h || current !== h.song) return;
  setSrc(h.src, h.at);
  applyLoudness(h.song.gain);
  showStage('lyric');
  if (h.playing && wantPlay) audio.play().catch(() => {});
}
$('chatModeExit').addEventListener('click', (event) => { event.stopPropagation(); exitChat(); });
$('driveListen').addEventListener('click', exitChat);
$('moodInput').addEventListener('input', touchChat);

// 口播：服务端给了 voice 就先在后台取成 blob（老板那边不闲会回 204，就没有）；轮到这首时取好了就先念、念完放歌，
// 没取好就直接放歌，不等。
// 后台现写的报幕，字在响应头 X-Say 里，取到就换掉模板句（没语音也有字）。口播和歌用同一个 <audio>（iOS 上第二个音频元素不一定让自动出声）。
let mode = 'song';
let voiceTimer = null;
// 推荐问句的等待状态：一次只等一条（answering），答「要听」的记下来避免重复问（wanted）
let answering = false;
const wanted = new Set();
/** 等了一会儿没回应时念的一句，和服务端 voice.js 的 REC_STASHED_LINE 保持一致。 */
const REC_STASHED_LINE = '那先给你存着，想听随时问我。';
async function prefetchVoice(song) {
  if (!song?.voice || song.voiceUrl) return;
  try {
    const res = await fetch(`/api/voice/${encodeURIComponent(song.voice)}`, { credentials: 'same-origin', signal: AbortSignal.timeout(90_000) });
    const say = res.headers.get('X-Say');
    if (say) song.say = decodeURIComponent(say);
    if (res.status === 200) song.voiceUrl = URL.createObjectURL(await res.blob());
  } catch { /* 不念就不念 */ }
}

function resetProgress() {
  $('barFill').style.width = '0';
  $('curTime').textContent = '0:00';
  $('durTime').textContent = current?.duration ? fmtTime(current.duration / 1000) : '0:00';
}

async function playNext() {
  clearTimeout(voiceTimer);
  if (mode === 'chatvoice') { mode = 'song'; held = null; speaking = false; touchChat(); }
  if (current?.voiceUrl) URL.revokeObjectURL(current.voiceUrl);
  current = queue.shift() || null;
  if (!current) {
    setNowPlaying(null, '正在找下一首…');
    showStage('none');
    return ask('');
  }
  setNowPlaying(current);
  resetProgress();
  renderFav();
  bindLyrics(current);
  if (current.voiceUrl && !speaking) {
    mode = 'voice';
    showDj(current.say || '', 0, current.memoryRef || null);
    audio.src = current.voiceUrl;
    applyLoudness(null);
    // 推荐的歌：报完幕要停下来问一句，等他回答；其它歌念不完就切（按了暂停就不切）
    voiceTimer = setTimeout(() => { if (wantPlay) voiceEnded(); }, current.friendRec ? ANSWER_FALLBACK_MS : 15000);
    try { await audio.play(); } catch (error) { startSong(error); }
  } else {
    if (current.say) showDj(current.say, 6000, current.memoryRef || null); else showStage('lyric');
    await startSong();
  }
  if (queue.length === 0) ask('');
}

// 口播放完（或兜底超时）之后：普通歌直接切，朋友推荐的要先问一句「要听吗」
function voiceEnded() {
  const rec = current?.friendRec;
  if (!rec) return startSong();
  clearTimeout(voiceTimer);
  void answerForRec(rec);
}

// 开麦听 5 秒：说了听就立刻切；说了不听、或者没出声，就把这首暂存起来（还能问回来）。
async function answerForRec(rec) {
  if (answering) return;
  answering = true;
  let reply = { answer: 'none', text: '' };
  try { reply = await listenForAnswer(); } catch { /* 没麦克风也当没回应 */ }
  answering = false;
  if (current?.friendRec?.id !== rec.id) return; // 等待期间已经换歌了
  if (reply.answer === 'yes') {
    wanted.add(rec.id);
    return startSong();
  }
  // 暂存：告诉用户一句，然后把这首从队列里跳过（不播），记录留给「刚才谁推荐了什么」
  showDj(REC_STASHED_LINE, 6000, null);
  sayStashed();
  void dropRec(rec.id);
  current = null;
  await playNext();
}

// 暂存时念一句：有系统语音就用它，没有就只显示文字（不额外走服务端 TTS，省一次合成）
function sayStashed() {
  try {
    const synth = globalThis.speechSynthesis;
    if (!synth) return;
    const utter = new SpeechSynthesisUtterance(REC_STASHED_LINE);
    utter.lang = 'zh-CN';
    utter.volume = 0.9;
    synth.speak(utter);
  } catch { /* 念不了就算了，文字已经显示 */ }
}

// 丢弃记录：公用版走 /api/friends/drop，个人版走 owner 口（由各自页面实现 dropRec）
async function dropRec(id) {
  try {
    await fetch('/api/friends/drop', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rec: id }),
    });
  } catch { /* 存不上也不影响跳过这首 */ }
}

async function startSong(blocked) {
  clearTimeout(voiceTimer);
  if (!current) return;
  if (mode === 'voice') showStage('lyric');
  mode = 'song';
  const song = current;
  // 这次卡过、降到 320k 了：队列里早先取的无损歌换成 320k 的再放
  if ((smooth || me?.quality === 'smooth') && song.level === 'lossless') await refetch(song, { q: 'exhigh' }).catch(() => {});
  if (current !== song) return;
  setSrc(song.direct || song.url);
  applyLoudness(song.gain);
  song.ladder = null;
  try {
    if (blocked?.name === 'NotAllowedError') throw blocked;
    await audio.play();
  } catch (error) {
    // 浏览器要先有一次点击才肯出声（autoplay 规矩），不是坏了
    if (error?.name === 'NotAllowedError') setNotice('浏览器要先点一下才能出声，点 ▶ 开始');
  }
}

function setPlaying(on) {
  document.body.classList.toggle('playing', on);
  $('liveTag').textContent = on ? 'ON AIR' : 'OFF AIR';
  $('liveTag').classList.toggle('on', on);
  lyricClock.refresh();
}
setPlaying(false);

audio.addEventListener('playing', () => {
  setPlaying(true);
  if (!heartbeatTimer) startHeartbeat($('playBtn').dataset.takeover === '1');
  delete $('playBtn').dataset.takeover;
  if (mode === 'song' && current && !current.reported) {
    current.reported = true;
    api('/api/play/started', { method: 'POST', body: { id: current.id, title: current.title, artist: current.artist, cover: current.cover, ...(current.rec ? { rec: current.rec.id } : {}) } }).catch(() => {});
  }
});
audio.addEventListener('pause', () => setPlaying(false));
audio.addEventListener('ended', () => (mode === 'voice' ? voiceEnded() : mode === 'chatvoice' ? finishInline() : playNext()));
audio.addEventListener('timeupdate', () => {
  if (mode !== 'song') return;
  paintProgress({ fill: $('barFill'), cur: $('curTime'), dur: $('durTime') }, audio.currentTime, audio.duration);
});
audio.addEventListener('seeked', () => { lyricView?.setTime(audio.currentTime + LYRIC_LEAD); lyricView?.recenter(); });
$('bar').addEventListener('click', (event) => {
  if (mode !== 'song' || !audio.duration || !Number.isFinite(audio.duration)) return;
  audio.currentTime = seekFraction($('bar'), event) * audio.duration;
});

// 放不了时按顺序退：① 重取直链再放（多半是过期了）② 走家里的同源代理，同一档 ③ 代理要 320k（这台浏览器多半放不了 FLAC）
// 没有直链的歌只有 ②（无损的直接 ③）。都不行换下一首
function fallbacks(song) {
  const ladder = song.direct ? ['direct', 'proxy'] : [];
  if (song.level === 'lossless') ladder.push('low');
  else if (!song.direct) ladder.push('proxy');
  return ladder;
}
audio.addEventListener('error', async () => {
  if (mode === 'chatvoice') return finishInline();
  if (!current) return;
  if (mode === 'voice') return startSong();
  const song = current;
  const at = audio.currentTime || 0;
  song.ladder ??= fallbacks(song);
  const step = song.ladder.shift();
  if (step === 'direct') {
    try { await refetch(song, { fresh: true, ...(smooth ? { q: 'exhigh' } : {}) }); } catch { /* 下一次 error 走代理 */ }
    if (current !== song) return;
    setSrc(song.direct || `/media/${song.id}?fresh=1`, at);
    return audio.play().catch(() => {});
  }
  if (step === 'proxy' || step === 'low') {
    const low = step === 'low' || smooth;
    setSrc(`/media/${song.id}?fresh=1${low ? '&q=exhigh' : ''}`, at);
    // 退到普通档后实际音质不知道了，不标（不猜）
    if (step === 'low') paintQuality($('nowQuality'), null);
    return audio.play().catch(() => {});
  }
  playNext();
});

function setSrc(url, at = 0) {
  srcChangedAt = Date.now();
  audio.src = url;
  if (at > 1) audio.addEventListener('loadedmetadata', () => { audio.currentTime = at; }, { once: true });
}

// 重取这首的直链（fresh：直链过期；q=exhigh：要 320k），音质标签按实际拿到的改
async function refetch(song, { fresh = false, q = '' } = {}) {
  const params = new URLSearchParams({ ...(fresh ? { fresh: '1' } : {}), ...(q ? { q } : {}) });
  const info = await api(`/api/song/${encodeURIComponent(song.id)}?${params}`);
  Object.assign(song, { direct: info.direct || '', url: info.url || song.url, level: info.level || '', bitrate: info.bitrate || 0, gain: info.gain ?? null, quality: info.quality || null });
  if (current === song) paintQuality($('nowQuality'), song.quality);
}

// ---- 卡顿自动降档 ----
// 放歌时缓冲（waiting，或 stalled 时手上已经没数据）超过 2 次，或者一次缓冲超过 5 秒：这次打开网页后面都要 320k。
// 刚换歌 / 拖进度的那一下不算；按了暂停不算。
function onStall() {
  if (mode !== 'song' || !current?.reported || audio.paused || inStall) return;
  if (Date.now() - Math.max(srcChangedAt, seekedAt) < 1500) return;
  inStall = true;
  stalls += 1;
  if (stalls > 2) return downgrade();
  clearTimeout(stallTimer);
  stallTimer = setTimeout(() => { if (inStall) downgrade(); }, 5000);
}
audio.addEventListener('waiting', onStall);
audio.addEventListener('stalled', () => { if (audio.readyState < 3) onStall(); });
audio.addEventListener('playing', () => { inStall = false; clearTimeout(stallTimer); });
audio.addEventListener('seeking', () => { seekedAt = Date.now(); });

// chosen：账号面板里自己选了流畅（不提示、不记成这次卡过）
async function downgrade({ chosen = false } = {}) {
  clearTimeout(stallTimer);
  if (!chosen) {
    if (smooth) return;
    smooth = true;
    try { sessionStorage.setItem('dj_smooth', '1'); } catch { /* 存不了就只管这一页 */ }
  }
  const song = current;
  if (!song || song.level !== 'lossless') return;
  if (!chosen) setNotice('网络有点卡，这次先换成流畅（320k）');
  const at = audio.currentTime || 0;
  try { await refetch(song, { q: 'exhigh' }); } catch { return; }
  if (current !== song || mode !== 'song') return;
  const playing = !audio.paused;
  song.ladder = null;
  setSrc(song.direct || song.url, at);
  applyLoudness(song.gain);
  if (playing || wantPlay) audio.play().catch(() => {});
}

$('playBtn').addEventListener('click', () => {
  wantPlay = true;
  if (!current) return playNext();
  if (audio.paused) {
    if ($('playBtn').dataset.takeover === '1') startHeartbeat(true);
    audio.play().catch(() => {});
  } else {
    wantPlay = false;
    clearTimeout(retryTimer);
    audio.pause();
    stopHeartbeat();
    api('/api/play/stop', { method: 'POST' }).catch(() => {});
  }
});
$('nextBtn').addEventListener('click', () => { wantPlay = true; playNext(); });
function send() {
  const text = $('moodInput').value.trim();
  if (!text) return;
  $('moodInput').value = '';
  enterChat();
  ask(text);
}
$('sendBtn').addEventListener('click', send);
onEnter($('moodInput'), send);

// ---- 红心、最近听过 ----
function renderFav({ pulse = false } = {}) {
  paintHeart($('favBtn'), Boolean(current?.liked), { pulse });
  $('favBtn').disabled = !current;
}
renderFav();

async function toggleFav(song) {
  const on = !song.liked;
  try {
    const out = await api('/api/fav', { method: 'POST', body: { id: song.id, title: song.title, artist: song.artist, cover: song.cover, on } });
    song.liked = out.liked;
    if (on && !out.synced) setNotice('已记下红心。绑定网易云后会同步到你的「我喜欢的音乐」');
  } catch (error) { setNotice(error.message); }
}

$('favBtn').addEventListener('click', async () => {
  if (!current) return;
  await toggleFav(current);
  renderFav({ pulse: true });
});

async function renderHistory() {
  const list = $('historyList');
  list.textContent = '';
  let songs = [];
  try { songs = (await api('/api/history')).songs; } catch (error) { setNotice(error.message); }
  $('historyEmpty').classList.toggle('hidden', songs.length > 0);
  for (const song of songs) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = sized(song.cover, 120) || MASCOT;
    img.onerror = () => { img.onerror = null; img.src = MASCOT; };
    const play = document.createElement('button');
    play.className = 'history-play';
    play.type = 'button';
    const t = document.createElement('span');
    t.textContent = song.title;
    const a = document.createElement('span');
    a.className = 'dim';
    a.textContent = song.artist;
    play.append(t, a);
    play.addEventListener('click', () => playFromHistory(song));
    const fav = document.createElement('button');
    fav.type = 'button';
    fav.className = 'icon-btn heart';
    fav.setAttribute('aria-label', '红心');
    fav.innerHTML = '<svg class="ico"><use href="#i-heart"/></svg>';
    paintHeart(fav, Boolean(song.liked));
    fav.addEventListener('click', async () => {
      await toggleFav(song);
      paintHeart(fav, Boolean(song.liked));
      if (current?.id === song.id) { current.liked = song.liked; renderFav(); }
    });
    // 推荐给好友（开了好友才露出来，点了交给 friends.js）
    const rec = document.createElement('button');
    rec.type = 'button';
    rec.className = 'icon-btn rec-btn';
    rec.setAttribute('aria-label', '推荐给好友');
    rec.innerHTML = '<svg class="ico"><use href="#i-share"/></svg>';
    rec.dataset.song = JSON.stringify({ id: song.id, title: song.title, artist: song.artist, cover: song.cover || '' });
    li.append(img, play, fav, rec);
    list.append(li);
  }
}

async function playFromHistory(song) {
  try {
    const info = await api(`/api/song/${song.id}`);
    closeSheet('historyBackdrop');
    wantPlay = true;
    queue.unshift({ ...song, ...info, say: '', voice: '' });
    playNext();
  } catch (error) { setNotice(error.message); closeSheet('historyBackdrop'); }
}

// ---- 面板 ----
function openSheet(id) { chatStrip.setOpen(false); $(id).classList.remove('hidden'); immersive.idleHider.refresh(); }
function closeSheet(id) {
  if (id === 'qrBackdrop') clearInterval(qrTimer);
  $(id).classList.add('hidden');
  immersive.idleHider.refresh();
}
for (const id of SHEETS) {
  $(id).addEventListener('click', (event) => {
    if (event.target === $(id) || event.target.closest('[data-close]')) closeSheet(id);
  });
}
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const open = SHEETS.filter((id) => !$(id).classList.contains('hidden'));
  if (!open.length && !chatStrip.isOpen()) return;
  event.preventDefault();
  open.forEach(closeSheet);
  chatStrip.setOpen(false);
});

$('historyBtn').addEventListener('click', () => { openSheet('historyBackdrop'); renderHistory(); });
$('accountBtn').addEventListener('click', () => { $('pairShow').classList.add('hidden'); openSheet('accountBackdrop'); });

$('pairBtn').addEventListener('click', async () => {
  try {
    const { code } = await api('/api/pair/create', { method: 'POST' });
    $('pairShow').textContent = code;
    $('pairShow').classList.remove('hidden');
  } catch (error) { setNotice(error.message); }
});

// 选了就记在服务端（换设备也算）。选流畅：正在放的无损歌立刻换 320k；选无损：这次卡顿降档也不算了，从下一首起要无损
$('qualitySeg').addEventListener('click', async (event) => {
  const value = event.target.closest('button')?.dataset.value;
  if (!value || value === me.quality) return;
  try {
    await api('/api/quality', { method: 'POST', body: { quality: value } });
  } catch (error) { return setNotice(error.message); }
  me.quality = value;
  renderMe();
  if (value === 'smooth') return downgrade({ chosen: true });
  smooth = false;
  stalls = 0;
  try { sessionStorage.removeItem('dj_smooth'); } catch { /* 无痕窗口 */ }
});

// 聊天模式开关：记在这台设备上，默认开
$('chatSeg').addEventListener('click', (event) => {
  const value = event.target.closest('button')?.dataset.value;
  if (!value) return;
  store.set('dj_chat', value);
  if (value === 'off') exitChat();
  paintChatSeg();
});
paintChatSeg();

// 口播频率、本地语气扩展：选了就记在服务端（换设备也算）
$('talkSeg').addEventListener('click', async (event) => {
  const value = event.target.closest('button')?.dataset.value;
  if (!value || value === me.talk) return;
  try { await api('/api/talk', { method: 'POST', body: { level: value } }); } catch (error) { return setNotice(error.message); }
  me.talk = value;
  renderMe();
});
$('adultSeg').addEventListener('click', async (event) => {
  const value = event.target.closest('button')?.dataset.value;
  if (!value || (value === 'on') === Boolean(me.adult)) return;
  try { await api('/api/adult', { method: 'POST', body: { on: value === 'on' } }); } catch (error) { return setNotice(error.message); }
  me.adult = value === 'on';
  renderMe();
});

$('memBtn').addEventListener('click', async () => {
  await api('/api/memory/clear', { method: 'POST' }).catch(() => {});
  me.prefs = [];
  me.notesCount = 0;
  renderMe();
});

$('logoutBtn').addEventListener('click', async () => {
  if (!confirm('这台设备退出后要重新配对才能用，确定吗？')) return;
  audio.pause();
  stopHeartbeat();
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  closeSheet('accountBackdrop');
  load();
});

$('ncmBtn').addEventListener('click', async () => {
  if (me.bound) {
    if (!confirm('解绑后会删掉这里保存的网易云登录，确定吗？')) return;
    await api('/api/ncm/unbind', { method: 'POST' }).catch(() => {});
    me = await api('/api/me');
    return renderMe();
  }
  closeSheet('accountBackdrop');
  startQr();
});

const QR_TEXT = { 801: '用网易云音乐 App 扫码', 802: '已扫码，在手机上点确认', 800: '二维码过期了，关掉重来' };
async function startQr() {
  openSheet('qrBackdrop');
  $('qrImg').removeAttribute('src');
  $('qrMsg').textContent = '…';
  try {
    const { img } = await api('/api/ncm/qr', { method: 'POST' });
    $('qrImg').src = img;
    $('qrMsg').textContent = QR_TEXT[801];
  } catch (error) {
    $('qrMsg').textContent = error.message;
    return;
  }
  const started = Date.now();
  clearInterval(qrTimer);
  qrTimer = setInterval(async () => {
    if (Date.now() - started > 180_000) { clearInterval(qrTimer); $('qrMsg').textContent = QR_TEXT[800]; return; }
    try {
      const out = await api('/api/ncm/qr/status');
      if (out.code === 803) {
        clearInterval(qrTimer);
        $('qrMsg').textContent = `已绑定 ${out.nickname || ''}`;
        me = await api('/api/me');
        renderMe();
        setTimeout(() => closeSheet('qrBackdrop'), 1200);
      } else if (out.code === 800) {
        clearInterval(qrTimer);
        $('qrMsg').textContent = QR_TEXT[800];
      } else {
        $('qrMsg').textContent = QR_TEXT[out.code] || `网易云返回 ${out.code}：${out.message || '登录没成功'}`;
        if (!QR_TEXT[out.code]) clearInterval(qrTimer);
      }
    } catch (error) { $('qrMsg').textContent = error.message; }
  }, 3000);
}
$('bindTip').addEventListener('click', () => startQr());

load();
