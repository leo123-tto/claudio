// 公用版播放引擎：一个 <audio> 顺序放（口播和歌共用），队列空了就让 DJ 接着排。
// 界面和个人版同一份（index.html / styles.css / ui.js）；这里只管公用版的播放、门口、绑定、配额、最近听过。
import { parseLrc, createLyricView, startLyricClock, LYRIC_LEAD } from './lyrics.js';
import { createCovers, createChatStrip, wireImmersive, MASCOT, fmtTime, paintProgress, seekFraction, paintHeart, onEnter } from './ui.js';

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
  // 能不能点歌看 canAsk（绑了，或者能借老板的网易云）；老服务没这个字段时退回看 bound
  const canAsk = me.canAsk ?? me.bound;
  $('moodInput').placeholder = canAsk ? '想听点什么' : '绑定网易云后可以点歌';
  $('bindTip').classList.toggle('hidden', Boolean(canAsk));
  $('memState').textContent = me.prefs?.length ? me.prefs.join('、') : '还没记什么';
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
    if (error.status !== 401 || error.code !== 'no_device') $('gateMsg').textContent = error.message;
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

function qualityText(song) {
  if (!song?.level) return '';
  if (song.level === 'lossless') return '无损';
  const k = Math.round((song.bitrate || 0) / 1000);
  return k ? `${k}K` : '';
}
function setNowPlaying(song, title = '') {
  $('nowTitle').textContent = song?.title || title;
  $('nowMeta').textContent = song?.artist || '';
  const q = qualityText(song);
  $('nowState').textContent = q;
  $('nowState').classList.toggle('hidden', !q);
  $('nowState').classList.toggle('lossless', song?.level === 'lossless');
  covers.paintThumbs(sized(song?.cover, 600));
  covers.setBackdrop(sized(song?.cover, 600));
  document.title = song?.title ? `${song.title} · Claudio` : 'Claudio';
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
function showDj(text, hold = 0) {
  clearTimeout(djTimer);
  if (!text) return;
  $('djSay').textContent = text;
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
    const out = await api('/api/chat', { method: 'POST', body: { text } });
    if (typeof out.remaining === 'number') me.remaining = out.remaining;
    renderMe();
    if (out.needBind) { if (text) showStage(current ? 'lyric' : 'none'); return startQr(); }
    if (text && out.say) chatStrip.add('dj', out.say);
    setNotice(out.notice || '');
    if (out.songs.length) {
      retries = 0;
      if (out.voice || out.say) Object.assign(out.songs[0], { voice: out.voice || '', say: out.say || '' });
      // 点歌或空档时最多等 4 秒口播；正在放时预取的那批还早，后台慢慢取
      const voiceReady = prefetchVoice(out.songs[0]);
      if (text || !current) await Promise.race([voiceReady, new Promise((r) => setTimeout(r, 4000))]);
      queue = text ? out.songs : [...queue, ...out.songs];
      if (text || !current) { wantPlay = true; playNext(); }
    } else if (text) {
      if (out.say) showDj(out.say, 8000);
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
// 太吵的母带压下来，偏轻的歌原样放。音量走 Web Audio 的 GainNode；音频都是同源 /media，接进 Web Audio 不会变哑。
// AudioContext 要在点击里建。音量滑块乘在上面。
function loudnessVolume(gain) {
  if (typeof gain !== 'number') return 1;
  return Math.max(0.2, Math.min(1, 10 ** ((gain + 4) / 20)));
}

let audioCtx = null;
let gainNode = null;
let loudness = 1;
// iOS / iPadOS 锁屏或切后台会挂起 AudioContext，接进去的歌会断声：那里先不接，原生播放（响度不统一，音量用实体键）。
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
document.body.classList.toggle('ios', IOS);
function ensureAudioGraph() {
  if (IOS) return;
  if (audioCtx) {
    if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
    return;
  }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    audioCtx = new Ctx();
    gainNode = audioCtx.createGain();
    audioCtx.createMediaElementSource(audio).connect(gainNode).connect(audioCtx.destination);
    applyVolume();
  } catch {
    audioCtx = null;
    gainNode = null;
  }
}
function applyVolume() {
  const v = loudness * (IOS ? 1 : Number($('vol').value) / 100);
  if (gainNode) { gainNode.gain.value = v; audio.volume = 1; } else audio.volume = v;
}
function applyLoudness(gain) { loudness = loudnessVolume(gain); applyVolume(); }
$('vol').value = Number(store.get('dj_vol') ?? 100);
$('vol').addEventListener('input', () => { store.set('dj_vol', $('vol').value); applyVolume(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && audioCtx && audioCtx.state !== 'running' && !audio.paused) audioCtx.resume().catch(() => {});
});

// 口播：服务端给了 voice 就先在后台取成 blob（老板那边不闲会回 204，就没有）；轮到这首时取好了就先念、念完放歌，
// 没取好就直接放歌，不等。口播和歌用同一个 <audio>（iOS 上第二个音频元素不一定让自动出声）。
let mode = 'song';
let voiceTimer = null;
async function prefetchVoice(song) {
  if (!song?.voice || song.voiceUrl) return;
  try {
    const res = await fetch(`/api/voice/${encodeURIComponent(song.voice)}`, { credentials: 'same-origin' });
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
  if (current.voiceUrl) {
    mode = 'voice';
    showDj(current.say || '');
    audio.src = current.voiceUrl;
    applyLoudness(null);
    voiceTimer = setTimeout(() => { if (wantPlay) startSong(); }, 15000); // 念不完也不卡歌（按了暂停就不切）
    try { await audio.play(); } catch (error) { startSong(error); }
  } else {
    if (current.say) showDj(current.say, 6000); else showStage('lyric');
    await startSong();
  }
  if (queue.length === 0) ask('');
}

async function startSong(blocked) {
  clearTimeout(voiceTimer);
  if (!current) return;
  if (mode === 'voice') showStage('lyric');
  mode = 'song';
  audio.src = current.url;
  applyLoudness(current.gain);
  current.retried = false;
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
    api('/api/play/started', { method: 'POST', body: { id: current.id, title: current.title, artist: current.artist, cover: current.cover } }).catch(() => {});
  }
});
audio.addEventListener('pause', () => setPlaying(false));
audio.addEventListener('ended', () => (mode === 'voice' ? startSong() : playNext()));
audio.addEventListener('timeupdate', () => {
  if (mode !== 'song') return;
  paintProgress({ fill: $('barFill'), cur: $('curTime'), dur: $('durTime') }, audio.currentTime, audio.duration);
});
audio.addEventListener('seeked', () => { lyricView?.setTime(audio.currentTime + LYRIC_LEAD); lyricView?.recenter(); });
$('bar').addEventListener('click', (event) => {
  if (mode !== 'song' || !audio.duration || !Number.isFinite(audio.duration)) return;
  audio.currentTime = seekFraction($('bar'), event) * audio.duration;
});

audio.addEventListener('error', async () => {
  if (!current) return;
  if (mode === 'voice') return startSong();
  if (!current.retried) {
    current.retried = true;
    // 直链过期就让后台重取；这台浏览器放不了无损（FLAC）就要普通档。再出错由这里的下一次 error 换下一首。
    audio.src = `/media/${current.id}?fresh=1${current.level === 'lossless' ? '&q=exhigh' : ''}`;
    audio.play().catch(() => {});
    return;
  }
  playNext();
});

$('playBtn').addEventListener('click', () => {
  ensureAudioGraph();
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
$('nextBtn').addEventListener('click', () => { ensureAudioGraph(); wantPlay = true; playNext(); });
function send() {
  const text = $('moodInput').value.trim();
  if (!text) return;
  ensureAudioGraph();
  $('moodInput').value = '';
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
    li.append(img, play, fav);
    list.append(li);
  }
}

async function playFromHistory(song) {
  ensureAudioGraph();
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

$('memBtn').addEventListener('click', async () => {
  await api('/api/memory/clear', { method: 'POST' }).catch(() => {});
  me.prefs = [];
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
