// 驾驶模式：整屏只剩下一首 / 播放暂停 / 红心三个大键、大字歌名歌手、一个说话键。
// 只管界面：三个键转给原来的按钮（两版播放引擎不用改），文字走原来的点歌 / 对话（输入框 + 发送）。
// 说话：个人版转给原来的「说话」按钮（服务端转写）；公用版用浏览器自带的语音识别，没有就退回系统键盘听写。
// 进入时尽量让屏幕常亮（Wake Lock，不支持就算了）；记住上次开没开。

const STORE_KEY = 'claudio-drive';
const SYNC_EVERY = 20 * 60_000; // 服务端记的驾驶状态 2 小时失效，开着就隔一会儿再报

const store = {
  get() { try { return localStorage.getItem(STORE_KEY) === '1'; } catch { return false; } },
  set(on) { try { localStorage.setItem(STORE_KEY, on ? '1' : '0'); } catch { /* 无痕模式等：不记 */ } },
};

// 歌手：个人版的副标题是「歌手 · 年份 · 曲风」，只取歌手
export function artistOf(meta) {
  return String(meta || '').split(' · ')[0].trim();
}

export function speechRecognitionCtor(win = globalThis) {
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

export function initDrive({ features = {}, doc = document, win = window } = {}) {
  const $ = (id) => doc.getElementById(id);
  const root = $('drive');
  if (!root || !features.drive) return null;
  const src = {
    title: $('nowTitle'), meta: $('nowMeta'), quality: $('nowQuality'), fav: $('favBtn'),
    play: $('playBtn'), next: $('nextBtn'), voice: $('voiceBtn'), input: $('moodInput'), send: $('sendBtn'),
    state: $('nowState'), notice: $('notice'),
  };
  const ui = {
    title: $('driveTitle'), artist: $('driveArtist'), status: $('driveStatus'), quality: $('driveQuality'),
    fav: $('driveFav'), play: $('drivePlay'), next: $('driveNext'), mic: $('driveMic'), micText: $('driveMicText'),
    type: $('driveType'), typeInput: $('driveInput'),
  };
  let on = false;
  let wakeLock = null;
  let syncTimer = null;
  let recognition = null;
  let statusTimer = null;

  // ── 照着原界面画 ──
  function mirror() {
    ui.title.textContent = src.title?.textContent || '';
    ui.artist.textContent = artistOf(src.meta?.textContent);
    ui.quality.textContent = src.quality?.textContent || '';
    ui.quality.classList.toggle('hidden', !src.quality || src.quality.classList.contains('hidden'));
    ui.quality.classList.toggle('lossless', Boolean(src.quality?.classList.contains('lossless')));
    const liked = Boolean(src.fav?.classList.contains('fav-on'));
    ui.fav.classList.toggle('fav-on', liked);
    ui.fav.setAttribute('aria-pressed', String(liked));
    if (features.voice && src.voice) setListening(src.voice.classList.contains('voice-on'));
  }
  function say(text, { sticky = false } = {}) {
    clearTimeout(statusTimer);
    ui.status.textContent = text || '';
    if (text && !sticky) statusTimer = setTimeout(() => { ui.status.textContent = ''; }, 6000);
  }
  const watch = new MutationObserver(mirror);
  for (const node of [src.title, src.meta, src.quality, src.fav, src.voice].filter(Boolean)) {
    watch.observe(node, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }
  // 原界面的提示（公用版的浮条、个人版的状态条）也在这里出一行
  const echo = new MutationObserver(() => {
    if (!on) return;
    const text = src.notice?.textContent || '';
    if (text) say(text);
  });
  if (src.notice) echo.observe(src.notice, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  if (src.state && features.voice) {
    new MutationObserver(() => {
      const text = src.state.textContent || '';
      if (on && /没听清|麦克风|识别|听不清/.test(text)) say(text);
    }).observe(src.state, { childList: true, characterData: true, subtree: true });
  }

  // ── 三个大键：转给原按钮 ──
  ui.play.addEventListener('click', () => src.play?.click());
  ui.next.addEventListener('click', () => { src.next?.click(); say('下一首'); });
  ui.fav.addEventListener('click', () => src.fav?.click());

  // ── 说话 ──
  function setListening(listening) {
    ui.mic.classList.toggle('on', listening);
    ui.mic.setAttribute('aria-pressed', String(listening));
    ui.micText.textContent = listening ? '说完再点一下' : '点一下说话';
    if (listening) say('在听…', { sticky: true });
    else if (ui.status.textContent === '在听…') say('');
  }
  function submit(text) {
    const clean = String(text || '').trim();
    if (!clean || !src.input || !src.send) return;
    src.input.value = clean;
    src.send.click();
    say(`「${clean}」`);
  }
  function keyboardFallback(hint) {
    ui.type.classList.remove('hidden');
    ui.typeInput.value = '';
    ui.typeInput.focus();
    say(hint, { sticky: true });
  }
  ui.type.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = ui.typeInput.value;
    ui.typeInput.blur();
    ui.type.classList.add('hidden');
    submit(text);
  });
  function browserSpeech() {
    const Ctor = speechRecognitionCtor(win);
    if (!Ctor) return keyboardFallback('这个浏览器不能直接听写：点键盘上的麦克风说，说完点发送');
    if (recognition) { recognition.stop(); return; }
    const rec = new Ctor();
    rec.lang = 'zh-CN';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    let finalText = '';
    let failed = '';
    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const piece = event.results[i][0]?.transcript || '';
        if (event.results[i].isFinal) finalText += piece; else interim += piece;
      }
      if (interim) say(interim, { sticky: true });
    };
    rec.onerror = (event) => { failed = event.error || 'error'; };
    rec.onend = () => {
      recognition = null;
      setListening(false);
      if (finalText.trim()) return submit(finalText);
      if (['not-allowed', 'service-not-allowed', 'audio-capture', 'network', 'language-not-supported'].includes(failed)) {
        return keyboardFallback('浏览器听写用不了：点键盘上的麦克风说，说完点发送');
      }
      say(failed && failed !== 'aborted' ? '没听清，再点一下说' : '');
    };
    try {
      rec.start();
      recognition = rec;
      setListening(true);
    } catch {
      keyboardFallback('浏览器听写用不了：点键盘上的麦克风说，说完点发送');
    }
  }
  ui.mic.addEventListener('click', () => {
    if (features.voice && src.voice) src.voice.click(); // 个人版：原来的录音 → 服务端转写 → 点歌 / 对话
    else browserSpeech();
  });

  // ── 屏幕常亮 ──
  async function holdScreen() {
    if (!on || wakeLock || doc.visibilityState !== 'visible') return;
    try {
      wakeLock = await win.navigator.wakeLock?.request('screen') || null;
      wakeLock?.addEventListener?.('release', () => { wakeLock = null; });
    } catch { wakeLock = null; } // 不支持、省电模式拒绝：不报错
  }
  function releaseScreen() {
    const lock = wakeLock;
    wakeLock = null;
    lock?.release?.().catch(() => {});
  }
  doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible') holdScreen(); });

  // ── 告诉服务端（个人版后台备节目时口播变短）──
  function sync() {
    if (!features.driveSync) return;
    win.fetch('/api/drive', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on }),
    }).catch(() => {});
  }

  function set(next, { remember = true } = {}) {
    on = Boolean(next);
    doc.body.classList.toggle('drive-on', on);
    root.classList.toggle('hidden', !on);
    $('driveBtn')?.setAttribute('aria-pressed', String(on));
    if (remember) store.set(on);
    clearInterval(syncTimer);
    if (on) {
      mirror();
      holdScreen();
      syncTimer = setInterval(sync, SYNC_EVERY);
    } else {
      recognition?.abort();
      ui.type.classList.add('hidden');
      releaseScreen();
      say('');
    }
    sync();
  }

  $('driveBtn')?.addEventListener('click', () => set(!on));
  $('driveExit').addEventListener('click', () => set(false));
  doc.addEventListener('keydown', (event) => {
    if (on && event.key === 'Escape' && doc.activeElement !== ui.typeInput) set(false);
  });

  mirror();
  if (store.get()) set(true, { remember: false });
  return { set, isOn: () => on };
}
