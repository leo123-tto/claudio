// 两版（个人版 / 公用版）共用的界面部件：封面和背景、对话条、沉浸歌词。只管画和交互，不碰播放。
import { startWindowMode, toggleFullscreen, onModeChange, createIdleHider } from './window-mode.js';

export const MASCOT = '/mascot.png';

// 先把图拉下来再换，换的瞬间不闪；拉不到就退回吉祥物 / 点阵底
export function whenLoaded(url, done) {
  const probe = new Image();
  probe.onload = () => done(true);
  probe.onerror = () => done(false);
  probe.src = url;
}

// 缩略图、宽窗大图共用一张；背景另起两层交叉淡入
export function createCovers({ imgs, bdA, bdB }) {
  let thumbToken = 0;
  let backdropToken = 0;
  let backdropFront = null;
  function paintThumbs(url) {
    const token = ++thumbToken;
    const apply = (src) => {
      if (token !== thumbToken) return;
      for (const img of imgs) {
        if (img.getAttribute('src') === src) continue;
        img.src = src;
        img.classList.remove('fade');
        void img.offsetWidth; // 重新触发淡入
        img.classList.add('fade');
      }
    };
    if (url) whenLoaded(url, (ok) => apply(ok ? url : MASCOT));
    else apply(MASCOT);
  }
  function setBackdrop(url) {
    const token = ++backdropToken;
    if (url && backdropFront?.dataset.url === url) return;
    const clear = () => {
      bdA.classList.remove('on');
      bdB.classList.remove('on');
      backdropFront = null;
    };
    if (!url) { clear(); return; }
    whenLoaded(url, (ok) => {
      if (token !== backdropToken) return;
      if (!ok) { clear(); return; }
      const incoming = backdropFront === bdA ? bdB : bdA;
      incoming.dataset.url = url;
      incoming.style.backgroundImage = `url(${JSON.stringify(url)})`;
      incoming.classList.add('on');
      backdropFront?.classList.remove('on');
      backdropFront = incoming;
    });
  }
  return { paintThumbs, setBackdrop };
}

// 对话条：这次打开以来说了什么（只在界面里，不落盘）。role 是 'user' 或别的（DJ）。
export function createChatStrip({ chat, log, toggle, onChange = () => {} }) {
  const entries = [];
  function paint() {
    chat.classList.toggle('hidden', !entries.length);
    log.replaceChildren(...entries.map(({ role, text }) => {
      const row = document.createElement('div');
      row.className = `msg ${role === 'user' ? 'me' : 'dj'}`;
      row.textContent = text;
      return row;
    }));
    log.scrollTop = log.scrollHeight;
  }
  function add(role, text, { draft = false } = {}) {
    const clean = String(text || '').trim();
    if (!clean) return;
    const last = entries[entries.length - 1];
    if (last?.draft && role !== 'user') { last.text = clean; last.draft = draft; paint(); return; } // 草稿换成定稿
    if (last && last.role === role && last.text === clean) return; // 同一句口播会从两处进来，只记一次
    entries.push({ role, text: clean, draft });
    if (entries.length > 80) entries.shift();
    paint();
  }
  function setOpen(open) {
    chat.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? '收起对话' : '展开对话');
    log.scrollTop = log.scrollHeight;
    onChange();
  }
  const isOpen = () => chat.classList.contains('open');
  log.addEventListener('click', () => { if (!isOpen()) setOpen(true); });
  toggle.addEventListener('click', () => setOpen(!isOpen()));
  document.addEventListener('click', (event) => { if (!chat.contains(event.target)) setOpen(false); });
  return { add, setOpen, isOpen };
}

// 沉浸歌词：全屏键 / F；控制条 3 秒不动就藏；轻点空白处退出，控制条藏着时第一下只把它叫出来（手机上没有鼠标移动可用）。
export function wireImmersive({ button, isInteractionActive, onError, beforeToggle = () => {}, onChange = () => {} }) {
  const windowMode = startWindowMode({ isInteractionActive, onError });
  const idleHider = createIdleHider({ root: document.body, delay: 3000, controller: windowMode, isInteractionActive });
  const run = (action) => action().catch(onError);
  button.addEventListener('click', () => {
    beforeToggle();
    run(toggleFullscreen);
  });
  let tapRevealsControls = false;
  document.addEventListener('pointerdown', () => {
    tapRevealsControls = document.body.classList.contains('controls-hidden');
  }, true);
  document.addEventListener('click', (event) => {
    if (windowMode.getMode() !== 'fullscreen' || tapRevealsControls) return;
    if (event.target?.closest?.('button, input, a, .transport, .sheet-backdrop')) return;
    run(toggleFullscreen);
  });
  const unsubscribe = onModeChange((mode) => {
    button.setAttribute('aria-pressed', String(mode === 'fullscreen'));
    onChange(mode);
  });
  return {
    windowMode,
    idleHider,
    dispose() {
      unsubscribe(); idleHider.dispose();
      return windowMode.dispose();
    },
  };
}

// 舞台上的一行 DJ 气泡（口播 / 回话）
export const BUBBLE_LINE = '<div class="line active enter"><span class="who">Claudio</span><div class="bubble"></div></div>';

export const fmtTime = (s) => (isFinite(s) && s >= 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');

// 进度条：已放 / 总长；duration 无效时不画
export function paintProgress({ fill, cur, dur }, currentTime, duration) {
  if (!(Number.isFinite(duration) && duration > 0)) return;
  fill.style.width = `${(currentTime / duration) * 100}%`;
  cur.textContent = fmtTime(currentTime);
  dur.textContent = fmtTime(duration);
}
// 点在进度条哪里（0–1）
export function seekFraction(bar, event) {
  const r = bar.getBoundingClientRect();
  return Math.max(0, Math.min(1, (event.clientX - r.left) / r.width));
}

// 红心：亮 / 灭；点亮那一下跳一跳
export function paintHeart(button, on, { pulse = false } = {}) {
  button.classList.toggle('fav-on', on);
  button.setAttribute('aria-pressed', String(on));
  if (on && pulse) { button.classList.remove('fav-pulse'); void button.offsetWidth; button.classList.add('fav-pulse'); }
}

// 输入框回车发送；拼音输入法选字时的回车不算（WebKit 会在 compositionend 之后才派发这个 keydown）
export function onEnter(input, fn) {
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); fn(); } });
}
