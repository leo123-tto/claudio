import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import * as airplay from '../web/airplay.js';
import * as actions from '../web/player-actions.js';
import * as faults from '../web/playback-fault.js';
import * as saySync from '../web/say-sync.js';

const appSource = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '');
// 在同一个 VM 中执行真实媒体等待逻辑，让其超时也使用测试时钟。
const transitionSource = readFileSync(new URL('../web/transitions.js', import.meta.url), 'utf8')
  .replace(/^export /gm, '');
// 模块隔离自己的内部变量，RAF 与媒体时钟仍留在同一个 VM。
function visualModule(file, names) {
  const source = readFileSync(new URL(`../web/${file}.js`, import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  return `const { ${names} } = (() => { ${source}\nreturn { ${names} }; })();`;
}
const visualSource = [
  visualModule('lyrics', 'parseLrc, createLyricView, startLyricClock, LYRIC_LEAD'),
  visualModule('subtitle', 'typewriter, renderStatic'),
  visualModule('window-mode', 'startWindowMode, toggleFullscreen, onModeChange, createIdleHider'),
  visualModule('ui', 'createCovers, createChatStrip, wireImmersive, BUBBLE_LINE, fmtTime, paintProgress, seekFraction, paintHeart, onEnter'),
  visualModule('voice-stream', 'attachVoice'),
  visualModule('handoff', 'deviceIdentity'),
].join('\n');
const hooks = `
globalThis.__engine = {
  chat, requestNext, startMusic, loadEpisode, pausePlayback, resumePlayback, startSayOverlay, failVoice,
  stopPlayback, fadeOutStop, favoriteCurrent, dislikeCurrent, handleWS, trackVol, nextPlayback, setMasterVolume,
  showSong, showSubtitle, displayedSongClock, musicElementForItem, refreshLyrics,
  applyOutputResult, saveSettings, prefetchFiller, ensureFiller,
  setSettingsPayload(payload) { settingsPayload = payload; },
  get settingsPayload() { return settingsPayload; },
  get exclusiveClock() { return exclusiveClock; },
  get displayedSong() { return displayedSong; },
  // 模拟两轨交接时 active 仍指向旧轨的瞬间，不改变真实播放入口。
  setActive(track) { active = track; },
  setQueueIndex(i) { idx = i; },
  get heldClaims() { return [...heldClaims]; },
  prepare() { stopped = false; started = true; paused = false; },
  get active() { return active; },
  get idle() { return idle; },
  get voice() { return voice; },
  snapshot() {
    return { queue, idx, started, stopped, paused, ducked, overlaying,
      currentRequestId, activeEpisode, streamPending, claimId, pendingEpisode, voiceContext };
  },
};`;

const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

class FakeEvents {
  listeners = new Map();
  addEventListener(type, listener, options = {}) {
    if (options.signal?.aborted) return;
    const entry = { listener, once: options.once };
    const entries = this.listeners.get(type) || new Set();
    entries.add(entry);
    this.listeners.set(type, entries);
    options.signal?.addEventListener('abort', () => entries.delete(entry), { once: true });
  }
  removeEventListener(type, listener) {
    const entries = this.listeners.get(type);
    for (const entry of entries || []) if (entry.listener === listener) entries.delete(entry);
  }
  emit(type, extra = {}) {
    const event = { type, target: this, stopPropagation() {}, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const entry of [...(this.listeners.get(type) || [])]) {
      if (entry.once) this.listeners.get(type).delete(entry);
      entry.listener.call(this, event);
    }
    this[`on${type}`]?.(event);
  }
}

class FakeElement extends FakeEvents {
  constructor(id = '') {
    super();
    this.id = id;
    this.dataset = {};
    this.attributes = new Map();
    this.children = [];
    this.queries = new Map();
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => this.classes.add(name)),
      remove: (...names) => names.forEach(name => this.classes.delete(name)),
      contains: name => this.classes.has(name),
      toggle: (name, force = !this.classes.has(name)) => {
        if (force) this.classes.add(name); else this.classes.delete(name);
        return force;
      },
    };
    this.style = { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } };
    this.value = '';
    this.textContent = '';
    this.clientWidth = 100;
    this.clientHeight = 25;
    this.scrollHeight = 0;
  }
  get className() { return [...this.classes].join(' '); }
  set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  set innerHTML(value) {
    this.html = value; this.text = ''; this.children = []; this.queries.clear();
    const line = value.match(/^<div class="(line[^"]*)">([\s\S]*)<\/div>$/);
    if (line) {
      const child = this.ownerDocument.createElement('div');
      child.className = line[1]; child.innerHTML = line[2];
      this.appendChild(child);
    } else {
      for (const match of value.matchAll(/<(span|div) class="([^"]*)">([^<]*)<\/(?:span|div)>/g)) {
        const child = this.ownerDocument.createElement(match[1]);
        child.className = match[2]; child.textContent = match[3]; this.appendChild(child);
      }
    }
  }
  get innerHTML() { return this.html || ''; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  querySelector(selector) {
    if (selector.startsWith('.')) return this.querySelectorAll(selector)[0] || null;
    if (!this.queries.has(selector)) {
      const child = new FakeElement(); child.ownerDocument = this.ownerDocument;
      this.queries.set(selector, child);
    }
    return this.queries.get(selector);
  }
  querySelectorAll(selector) {
    const [head, ...tail] = selector.split(' ');
    const matches = node => {
      const names = [...head.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
      const index = head.match(/\[data-idx="(\d+)"\]/)?.[1];
      return names.length && names.every(name => node.classList.contains(name))
        && (index === undefined || String(node.dataset.idx) === index);
    };
    const found = [];
    for (const child of this.children) {
      if (matches(child)) {
        if (tail.length) found.push(...child.querySelectorAll(tail.join(' ')));
        else found.push(child);
      }
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
  contains(child) { return child === this || this.children.some(node => node.contains(child)); }
  getBoundingClientRect() { return { top: 0, bottom: 20, left: 0, right: 100, width: 100 }; }
  scrollIntoView() {}
  focus() {}
  click() { this.emit('click'); }
  getContext() { return { clearRect() {}, fill() {} }; }
}

function createClock() {
  let now = 1000, nextId = 1;
  const timers = new Map();
  const schedule = (fn, ms, interval = 0) => {
    const id = nextId++;
    timers.set(id, { fn, at: now + Math.max(0, Number(ms) || 0), interval });
    return id;
  };
  return {
    now: () => now,
    setTimeout: (fn, ms) => schedule(fn, ms),
    setInterval: (fn, ms) => schedule(fn, ms, Math.max(1, Number(ms) || 0)),
    clear: id => timers.delete(id),
    jump(ms) { now += ms; },
    async advance(ms) {
      const target = now + ms;
      for (let runs = 0; ; runs++) {
        assert.ok(runs < 20000, '测试时钟出现无限定时循环');
        const entry = [...timers].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!entry) break;
        const [id, timer] = entry;
        now = Math.max(now, timer.at);
        if (timer.interval) timer.at = now + timer.interval; else timers.delete(id);
        timer.fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

function createHarness() {
  const clock = createClock();
  const audios = [], calls = [], routes = [], frames = [];
  const elements = new Map(), storage = new Map();
  const element = id => {
    if (!elements.has(id)) {
      const node = new FakeElement(id); node.ownerDocument = document;
      elements.set(id, node);
    }
    return elements.get(id);
  };
  class FakeAudio extends FakeElement {
    constructor() {
      super();
      this.paused = true;
      this.ended = false;
      this.readyState = 0;
      this.currentTime = 0;
      this.duration = 180;
      this.volume = 1;
      this.playCalls = 0;
      this.plays = [];
      audios.push(this);
    }
    set src(value) {
      this.attributes.set('src', value);
      this.readyState = 0; this.currentTime = 0; this.ended = false;
    }
    get src() { return this.getAttribute('src') || ''; }
    get currentSrc() { return this.src; }
    play() {
      this.playCalls += 1;
      this.paused = false;
      const pending = deferred();
      const { resolve, reject } = pending;
      pending.settled = false;
      pending.resolve = () => { pending.settled = true; resolve(); };
      pending.reject = error => { pending.settled = true; reject(error); };
      this.plays.push(pending);
      return pending.promise;
    }
    resolvePlay() { this.plays.at(-1)?.resolve(); }
    playing() { this.paused = false; this.readyState = 3; this.emit('playing'); }
    canplay() { this.readyState = 3; this.emit('canplay'); }
    pause() {
      if (this.paused) return;
      this.paused = true;
      // 浏览器会拒绝被 pause() 中断、尚未完成的 play() Promise。
      for (const pending of this.plays) {
        if (!pending.settled) pending.reject(new DOMException('播放被暂停打断', 'AbortError'));
      }
      this.emit('pause');
    }
    load() {}
  }
  const document = new FakeEvents();
  Object.assign(document, {
    hidden: true, visibilityState: 'hidden', body: new FakeElement('body'), documentElement: new FakeElement('html'),
    getElementById: element, createElement: () => {
      const node = new FakeElement(); node.ownerDocument = document; return node;
    },
    querySelector: () => null, querySelectorAll: () => [],
  });
  const window = new FakeEvents();
  Object.assign(window, { document, innerWidth: 440, innerHeight: 760, open() {} });
  document.defaultView = window;
  for (const id of ['settingsBackdrop', 'memoryPanel']) element(id).classList.add('hidden');
  element('ttsPreview').pause = () => {};
  document.documentElement.requestFullscreen = async () => {
    document.fullscreenElement = document.documentElement; document.emit('fullscreenchange');
  };
  document.exitFullscreen = async () => { document.fullscreenElement = null; document.emit('fullscreenchange'); };
  const cancelledFrames = new Set();
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    send() {}
  }
  const context = vm.createContext({
    ...airplay, ...actions, ...faults, ...saySync,
    document, window, Audio: FakeAudio, WebSocket: FakeWebSocket,
    AbortController, DOMException, URL, URLSearchParams,
    console: { warn() {}, error() {}, log() {} },
    performance: { now: clock.now },
    Date: class extends Date { static now() { return clock.now(); } },
    crypto: { randomUUID: (() => { let id = 0; return () => `request-${++id}`; })() },
    setTimeout: clock.setTimeout, setInterval: clock.setInterval,
    clearTimeout: clock.clear, clearInterval: clock.clear,
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
    cancelAnimationFrame: id => cancelledFrames.add(id),
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    location: { origin: 'http://localhost:8080', host: 'localhost:8080' },
    devicePixelRatio: 1, innerHeight: 760,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    ResizeObserver: class { observe() {} },
    Path2D: class { rect() {} moveTo() {} arc() {} },
    Image: class { set src(value) { this.onload?.(); } },
    Option: class extends FakeElement {},
    navigator: {},
    fetch: async (url, init = {}) => {
      const call = { url: String(url), ...init };
      calls.push(call);
      const index = routes.findIndex(route => typeof route.match === 'function'
        ? route.match(call) : call.url.startsWith(route.match));
      if (index >= 0) {
        const [{ handle }] = routes.splice(index, 1);
        return typeof handle === 'function' ? handle(call) : handle;
      }
      if (call.url.startsWith('/api/filler')) return response({ ok: false });
      if (call.url === '/api/events' || call.url === '/api/timing'
        || call.url === '/api/fav' || call.url.startsWith('/api/episode/')) return response({ ok: true });
      throw new Error(`未配置的测试接口：${call.url}`);
    },
  });
  new vm.Script(`${transitionSource}\n${visualSource}\n${appSource}\n${hooks}`, { filename: 'player-engine.vm.js' })
    .runInContext(context, { timeout: 2000 });
  return {
    engine: context.__engine, audios, calls, frames, element, clock, storage, document,
    window, cancelledFrames,
    visible() { document.hidden = false; document.visibilityState = 'visible'; document.emit('visibilitychange'); },
    frame() {
      const end = frames.length;
      for (let i = this.frameIndex || 0; i < end; i++) if (!cancelledFrames.has(i + 1)) frames[i]();
      this.frameIndex = end;
    },
    route(match, handle) { routes.push({ match, handle }); },
    ws(message) { context.__engine.handleWS({ data: JSON.stringify(message) }); },
  };
}

const song = (title = '测试歌曲') => ({
  type: 'song', url: `/media/${encodeURIComponent(title)}.mp3`,
  meta: { id: title, title, artist: '测试歌手', lyric: '' },
});
const episode = (title = '测试歌曲') => ({
  id: `episode-${title}`, epoch: 0, intent: 'recommend', say: '',
  voice: { status: 'skipped' }, queue: [song(title)],
});
async function playSong(harness, title = '原来的歌') {
  const { engine, clock } = harness;
  engine.prepare();
  const ep = episode(title), incoming = engine.idle;
  const pending = engine.startMusic(ep.queue[0], 0, { episode: ep });
  incoming.playing(); incoming.resolvePlay();
  await pending;
  await clock.advance(700);
  return incoming;
}
async function playProgram(harness, ep) {
  harness.engine.prepare();
  const incoming = harness.engine.idle;
  harness.engine.loadEpisode(ep);
  incoming.playing(); incoming.resolvePlay();
  await flush();
  await harness.clock.advance(700);
  return incoming;
}
function listeningEvents(harness) {
  return harness.calls.filter(call => call.url === '/api/events').map(call => JSON.parse(call.body));
}
const withVoice = (ep, status = 'ready') => ({
  ...ep, say: '下一段口播', voice: { status },
  queue: status === 'ready' ? [{ type: 'tts', url: `/tts/${ep.id}.mp3`, text: '下一段口播' }, ...ep.queue] : ep.queue,
});
function pendingChat(harness, input = '换个心情') {
  const pending = deferred();
  harness.route('/api/chat', pending.promise);
  const done = harness.engine.chat(input);
  const call = harness.calls.findLast(item => item.url === '/api/chat');
  return { ...pending, done, call, requestId: JSON.parse(call.body).requestId };
}

test('播放器只创建两路音乐与一路独立口播元素', () => {
  const { audios, engine } = createHarness();
  assert.equal(audios.length, 3);
  assert.equal(new Set([engine.active, engine.idle, engine.voice]).size, 3);
  assert.ok(audios.every(audio => audio.preload === 'auto'));
});

test('音乐必须同时等到 playing 事件与 play() 成功才接管和确认节目', async t => {
  for (const first of ['playing', 'play']) {
    await t.test(`${first} 先到`, async () => {
      const h = createHarness(), { engine } = h;
      engine.prepare();
      const previous = engine.active, incoming = engine.idle, ep = episode();
      const done = engine.startMusic(ep.queue[0], 0, {
        episode: ep, holder: { episode: ep, claimId: 'claim-test', started: false },
      });
      if (first === 'playing') incoming.playing(); else incoming.resolvePlay();
      await flush();
      assert.equal(engine.active, previous);
      assert.equal(engine.snapshot().idx, -1);
      assert.equal(h.calls.filter(call => call.url === '/api/episode/started').length, 0);
      if (first === 'playing') incoming.resolvePlay(); else incoming.playing();
      await done;
      assert.equal(engine.active, incoming);
      assert.equal(engine.snapshot().queue[0].meta.title, '测试歌曲');
      assert.equal(h.calls.filter(call => call.url === '/api/episode/started').length, 1);
    });
  }
});

test('等待 chat 响应时原歌曲保持音量，不提前 duck 或启动口播', async () => {
  const h = createHarness(), music = await playSong(h);
  const pending = pendingChat(h);
  await h.clock.advance(5000);
  assert.equal(music.paused, false);
  assert.equal(h.engine.trackVol(music), 1);
  assert.equal(h.engine.snapshot().ducked, false);
  assert.equal(h.engine.voice.playCalls, 0);
  pending.resolve(response({ ok: true, requestId: pending.requestId, control: { action: 'none', reply: '收到' } }));
  await pending.done;
});

test('chat 的 HTTP 与 WS 都忽略不匹配或缺失的 requestId', async () => {
  const h = createHarness(), pending = pendingChat(h);
  for (const requestId of [undefined, 'old-request']) {
    h.ws({ kind: 'sayReady', origin: 'chat', requestId, url: '/tts/stale.mp3', say: '迟到口播' });
    h.ws({ kind: 'episode', origin: 'chat', requestId, episode: episode('迟到歌曲') });
  }
  h.ws({ kind: 'sayReady', origin: 'auto', requestId: pending.requestId, url: '/tts/other-origin.mp3', say: '其他来源' });
  await flush();
  assert.equal(h.engine.voice.src, '');
  assert.equal(h.engine.snapshot().streamPending, null);
  pending.resolve(response({ ok: true, requestId: 'old-request', episode: episode('迟到歌曲') }));
  await pending.done;
  assert.equal(h.audios.reduce((total, audio) => total + audio.playCalls, 0), 0);
  assert.equal(h.engine.snapshot().activeEpisode, null);

  h.ws({ kind: 'sayReady', origin: 'chat', requestId: pending.requestId, url: '/tts/current.mp3', say: '当前口播' });
  await flush();
  assert.equal(h.engine.voice.src, '/tts/current.mp3');
});

test('HTTP chat 响应缺少 requestId 时也不能接管播放器', async () => {
  const h = createHarness(), pending = pendingChat(h);
  pending.resolve(response({ ok: true, episode: episode('无请求标识的歌') }));
  await pending.done;
  assert.equal(h.audios.reduce((total, audio) => total + audio.playCalls, 0), 0);
  assert.equal(h.engine.snapshot().activeEpisode, null);
});

test('stop 会取消请求，迟到 HTTP 与 WS 都不能重新出声', async () => {
  const h = createHarness(), pending = pendingChat(h);
  h.engine.stopPlayback();
  assert.equal(pending.call.signal.aborted, true);
  pending.resolve(response({ ok: true, requestId: pending.requestId, episode: episode('停止后的歌') }));
  await pending.done;
  h.ws({ kind: 'sayReady', origin: 'chat', requestId: pending.requestId, url: '/tts/late.mp3', say: '停止后的话' });
  h.ws({ kind: 'episode', origin: 'chat', requestId: pending.requestId, episode: episode('停止后的歌') });
  await h.clock.advance(1000);
  assert.equal(h.engine.snapshot().stopped, true);
  assert.ok(h.audios.every(audio => audio.paused && audio.playCalls === 0));
  assert.equal(h.engine.snapshot().activeEpisode, null);
});

test('领取节目返回 202 时重试复用同一个 claimId', async () => {
  const h = createHarness();
  h.engine.prepare();
  h.route('/api/next', response({ ok: false, busy: true, epoch: 1 }, 202));
  h.route('/api/next', response({ ok: false, busy: true, epoch: 1 }, 202));
  await h.engine.requestNext();
  await h.clock.advance(8000);
  const claims = h.calls.filter(call => call.url.startsWith('/api/next?'));
  assert.equal(claims.length, 2);
  assert.equal(new URL(claims[0].url, 'http://localhost').searchParams.get('claimId'),
    new URL(claims[1].url, 'http://localhost').searchParams.get('claimId'));
});

test('暂停期间到达的 chat 结果保留待播，恢复后再播放', async () => {
  const h = createHarness(), pending = pendingChat(h);
  h.engine.pausePlayback();
  pending.resolve(response({ ok: true, requestId: pending.requestId, episode: episode('暂停时准备的歌') }));
  await pending.done;
  await h.clock.advance(1000);
  assert.equal(h.engine.snapshot().paused, true);
  assert.equal(h.audios.reduce((total, audio) => total + audio.playCalls, 0), 0);
  h.engine.resumePlayback();
  await flush();
  assert.equal(h.audios.reduce((total, audio) => total + audio.playCalls, 0), 1);
  const incoming = h.audios.find(audio => audio.playCalls);
  incoming.playing(); incoming.resolvePlay();
  await flush();
  assert.equal(h.engine.snapshot().queue[0].meta.title, '暂停时准备的歌');
});

test('隐藏窗口且完全没有 rAF 回调时睡眠淡出仍按时完成', async () => {
  const h = createHarness(), music = await playSong(h);
  assert.ok(h.frames.length > 0, '绘制回调应已排队，但测试不会执行它们');
  h.engine.fadeOutStop();
  await h.clock.advance(4000);
  assert.ok(h.engine.trackVol(music) > 0.45 && h.engine.trackVol(music) < 0.55);
  await h.clock.advance(4100);
  assert.equal(h.engine.trackVol(music), 0);
  assert.ok(h.audios.every(audio => audio.paused));
  assert.equal(h.element('nowState').textContent, '晚安');
});

test('取消收藏会 POST remove:true，并清除本机收藏态', async () => {
  const h = createHarness();
  await playSong(h, '收藏测试');
  assert.equal(h.engine.favoriteCurrent({ toggle: true }), true);
  assert.equal(h.engine.favoriteCurrent({ toggle: true }), true);
  const favorites = h.calls.filter(call => call.url === '/api/fav');
  assert.equal(favorites.length, 2);
  assert.ok(favorites.every(call => call.method === 'POST'));
  assert.deepEqual(JSON.parse(favorites[1].body), {
    title: '收藏测试', artist: '测试歌手', remove: true,
  });
  assert.deepEqual(JSON.parse(h.storage.get('claudio-favs')), []);
  assert.equal(h.element('favBtn').classList.contains('fav-on'), false);
});

test('收藏跟随正在展示的音轨，即使 queue[idx] 临时指向口播', async () => {
  const h = createHarness();
  const ep = { ...episode('屏幕上的歌'), queue: [song('屏幕上的歌'), { type: 'tts', url: '/tts/talk.mp3', text: '口播' }] };
  await playProgram(h, ep);
  h.engine.setQueueIndex(1);
  h.engine.favoriteCurrent({ toggle: true });
  h.engine.favoriteCurrent({ toggle: true });
  assert.deepEqual(JSON.parse(h.calls.findLast(call => call.url === '/api/fav').body), {
    title: '屏幕上的歌', artist: '测试歌手', remove: true,
  });
});

test('交叉淡入歌词按展示歌曲查找音轨，不读取残留的 active 或尚在加载的槽位', async () => {
  const h = createHarness(); h.visible();
  const second = song('下一首歌词');
  second.meta.lyric = '[00:00]新歌开头\n[00:10]新歌此刻\n[02:40]旧轨时间';
  const ep = { ...episode('第一首'), queue: [song('第一首'), second] };
  const previous = await playProgram(h, ep), incoming = h.engine.idle;
  previous.currentTime = previous.duration - 3;
  previous.emit('timeupdate');
  assert.equal(h.engine.musicElementForItem(second), null, '加载中的槽位不能当歌词时钟');
  incoming.playing(); incoming.resolvePlay(); await flush();
  assert.equal(previous.paused, false, '交叉淡入时两轨应同时播放');
  assert.equal(h.engine.displayedSong.meta.title, second.meta.title);
  incoming.currentTime = 12;
  h.engine.setActive(previous);
  assert.equal(h.engine.displayedSongClock(), incoming);
  h.frame();
  assert.equal(h.element('stream').querySelector('.lyric-line.active').textContent, '新歌此刻');
  h.engine.setActive(incoming);
});

async function playTalk(h) {
  const pending = pendingChat(h, '聊两句');
  const ep = { id: 'chat-talk', epoch: 0, intent: 'chat', say: '这是一段还没念完的测试口播。',
    voice: { status: 'pending' }, queue: [] };
  pending.resolve(response({ ok: true, requestId: pending.requestId, origin: 'chat', episode: ep, streamed: true }));
  await pending.done;
  h.ws({ kind: 'sayReady', origin: 'chat', requestId: pending.requestId, url: '/tts/talk.mp3', say: ep.say });
  h.engine.voice.duration = 12;
  h.engine.voice.canplay(); await flush();
  await h.clock.advance(800);
  h.engine.voice.playing(); h.engine.voice.resolvePlay(); await flush();
  return h.element('stream').querySelector('.bubble');
}

test('next/stop 取消同一个字幕，已排队的迟到帧不能写回旧 box', async t => {
  for (const action of ['nextPlayback', 'stopPlayback']) await t.test(action, async () => {
    const h = createHarness(); await playSong(h);
    const box = await playTalk(h);
    h.engine.voice.currentTime = 3; h.frame();
    assert.ok(box.classList.contains('subtitle-typing'));
    assert.ok(box.textContent.length > 0);
    const lateTicks = h.frames.slice();
    h.engine[action]();
    assert.equal(box.classList.contains('subtitle-typing'), false);
    const before = box.textContent;
    h.engine.voice.currentTime = 11;
    for (const tick of lateTicks) tick();
    assert.equal(box.textContent, before);
    assert.notEqual(h.element('stream').querySelector('.bubble'), box);
  });
});

test('聊天口播结束后不换歌，歌词重新绑定原音轨的实时位置', async () => {
  const h = createHarness(); h.visible();
  const item = song('继续听的歌');
  item.meta.lyric = '[00:00]开头\n[00:20]口播前\n[00:50]恢复此刻';
  const ep = { ...episode('继续听的歌'), queue: [item] };
  const music = await playProgram(h, ep);
  music.currentTime = 24; h.engine.refreshLyrics();
  const oldView = h.element('stream').querySelector('.lyric');
  const bubble = await playTalk(h);
  assert.equal(h.engine.displayedSong, null, '口播覆盖期间不保留歌词舞台');
  assert.equal(h.element('stream').querySelector('.lyric'), null);
  music.currentTime = 57; h.engine.voice.currentTime = 9; h.frame();
  h.ws({ kind: 'lyrics', id: ep.id, tracks: [{ title: item.meta.title, artist: item.meta.artist,
    lyric: '[00:00]开头\n[00:20]口播前\n[00:50]晚到的恢复歌词' }] });
  assert.equal(h.element('stream').querySelector('.lyric'), null, '晚到歌词不能顶掉口播');
  h.engine.voice.ended = true; h.engine.voice.emit('ended'); await flush();
  assert.equal(h.engine.active, music);
  assert.equal(music.playCalls, 1, '恢复歌词不能重新播放音乐');
  assert.equal(h.engine.displayedSongClock(), music);
  assert.notEqual(h.element('stream').querySelector('.lyric'), oldView);
  assert.equal(h.element('stream').querySelector('.lyric-line.active').textContent, '晚到的恢复歌词');
  assert.equal(bubble.classList.contains('subtitle-typing'), false);
});

test('口播尾部垫歌只切音乐槽位，字幕留到念完后再绑定垫歌歌词', async () => {
  const h = createHarness(); h.visible();
  const previous = await playSong(h), pending = pendingChat(h);
  const ep = withVoice(episode('垫入的新歌'));
  ep.queue[1].meta.lyric = '[00:00]新歌开头\n[00:05]垫歌当前位置';
  pending.resolve(response({ ok: true, requestId: pending.requestId, episode: ep })); await pending.done;
  h.engine.voice.duration = 10;
  h.engine.voice.canplay(); await flush(); await h.clock.advance(800);
  h.engine.voice.playing(); h.engine.voice.resolvePlay(); await flush();
  h.engine.voice.currentTime = 4;
  previous.emit('timeupdate'); await flush();
  const bed = h.engine.idle;
  bed.playing(); bed.resolvePlay(); await flush();
  assert.equal(h.engine.active, bed);
  assert.equal(h.element('nowTitle').textContent, 'CLAUDIO');
  assert.equal(h.engine.displayedSong, null);
  const bubble = h.element('stream').querySelector('.bubble');
  assert.ok(bubble.classList.contains('subtitle-typing'));
  bed.currentTime = 6;
  h.engine.voice.currentTime = 10; h.engine.voice.ended = true; h.engine.voice.emit('ended'); await flush();
  assert.equal(h.engine.displayedSongClock(), bed);
  assert.equal(h.element('stream').querySelector('.lyric-line.active').textContent, '垫歌当前位置');
  assert.equal(bubble.classList.contains('subtitle-typing'), false);
});

test('口播尾部垫歌加载失败，字幕取消旧帧后仍随正在念的人声继续', async () => {
  const h = createHarness(), previous = await playSong(h), pending = pendingChat(h);
  const ep = withVoice(episode('不可播的垫歌'));
  ep.say = ep.queue[0].text = '这是一段人声还在继续，垫歌失败也应该继续显示的口播。';
  pending.resolve(response({ ok: true, requestId: pending.requestId, episode: ep })); await pending.done;
  h.engine.voice.duration = 10;
  h.engine.voice.canplay(); await flush(); await h.clock.advance(800);
  h.engine.voice.playing(); h.engine.voice.resolvePlay(); await flush();
  h.engine.voice.currentTime = 4;
  previous.emit('timeupdate'); await flush();
  const bubble = h.element('stream').querySelector('.bubble');
  h.engine.idle.emit('error'); await flush();
  assert.equal(h.engine.voice.paused, false);
  assert.equal(bubble.classList.contains('subtitle-typing'), true);
  const before = bubble.textContent;
  h.engine.voice.currentTime = 7; h.frame();
  assert.ok(bubble.textContent.length > before.length);
});

test('音箱歌词与口播都使用 exclusiveClock，口播结束重建歌曲歌词', async () => {
  const h = createHarness(); h.visible(); h.engine.prepare();
  h.engine.applyOutputResult({ exclusive: true, uid: 'fake-speaker', unchanged: true });
  const ep = episode('音箱上的歌'); ep.queue[0].meta.lyric = '[00:00]开头\n[00:30]音箱此刻';
  h.route('/api/exclusive/play', response({ ok: true, event: 'playing', token: 'music', duration: 180 }));
  h.engine.loadEpisode(ep); await flush();
  h.engine.exclusiveClock.currentTime = 35; h.frame();
  assert.equal(h.engine.displayedSongClock(), h.engine.exclusiveClock);
  assert.equal(h.element('stream').querySelector('.lyric-line.active').textContent, '音箱此刻');
  const pending = pendingChat(h, '说两句');
  const chatEp = { id: 'speaker-chat', epoch: 0, intent: 'chat', say: '音箱正在念的这一段口播', voice: { status: 'pending' }, queue: [] };
  pending.resolve(response({ ok: true, requestId: pending.requestId, episode: chatEp })); await pending.done;
  h.route('/api/exclusive/play', response({ ok: true, event: 'playing', token: 'say', duration: 12 }));
  h.ws({ kind: 'sayReady', origin: 'chat', requestId: pending.requestId, url: '/tts/speaker.mp3', say: chatEp.say });
  await flush();
  const bubble = h.element('stream').querySelector('.bubble');
  h.engine.exclusiveClock.currentTime = 6; h.frame();
  assert.ok(bubble.textContent.length > 0, '本机 voice 没播放，音箱字幕仍随音箱时钟推进');
  assert.equal(h.engine.voice.playCalls, 0);
  h.route('/api/exclusive', response({ ok: true, event: 'ended', token: 'say', seconds: 12, duration: 12 }));
  h.route('/api/exclusive/play', response({ ok: true, event: 'playing', token: 'resumed-music', duration: 180 }));
  await h.clock.advance(400);
  h.engine.exclusiveClock.currentTime = 42; h.frame();
  assert.equal(h.element('stream').querySelector('.lyric-line.active').textContent, '音箱此刻');
  assert.equal(bubble.classList.contains('subtitle-typing'), false);
});

test('音箱队列口播等待新时钟，不能按上一首歌的进度提前闪出整段字幕', async () => {
  const h = createHarness(); h.engine.prepare();
  h.engine.applyOutputResult({ exclusive: true, uid: 'fake-speaker', unchanged: true });
  h.engine.exclusiveClock.currentTime = 180;
  h.engine.exclusiveClock.duration = 180;
  h.engine.exclusiveClock.paused = false;
  const pending = deferred(), ep = withVoice(episode('音箱队列'));
  h.route('/api/exclusive/play', pending.promise);
  h.engine.loadEpisode(ep);
  const bubble = h.element('stream').querySelector('.bubble');
  assert.equal(bubble.textContent, '', '服务端返回前保持空字幕，不能借用旧歌曲时间');
  pending.resolve(response({ ok: true, event: 'playing', token: 'queued-say', duration: 12 })); await flush();
  assert.equal(bubble.textContent, '');
  assert.equal(bubble.classList.contains('subtitle-typing'), true);
  h.engine.exclusiveClock.currentTime = 6; h.frame();
  assert.ok(bubble.textContent.length > 0 && bubble.textContent.length < ep.say.length);
});

test('自然切歌采用等功率淡入淡出，隐藏十分钟后按实际时间完成并记录 completed', async () => {
  const h = createHarness();
  const ep = { ...episode('第一首'), queue: [song('第一首'), song('第二首')] };
  const previous = await playProgram(h, ep), incoming = h.engine.idle;
  previous.currentTime = previous.duration - 3;
  previous.emit('timeupdate');
  assert.equal(incoming.playCalls, 1);
  incoming.playing(); incoming.resolvePlay();
  await flush();
  await h.clock.advance(1500);
  assert.ok(Math.abs(h.engine.trackVol(previous) - Math.SQRT1_2) < 0.02);
  assert.ok(Math.abs(h.engine.trackVol(incoming) - Math.SQRT1_2) < 0.02);
  assert.ok(Math.abs(h.engine.trackVol(previous) ** 2 + h.engine.trackVol(incoming) ** 2 - 1) < 0.0001);

  // 模拟窗口被冻结：不补跑定时器，也不执行任何绘制帧。
  h.clock.jump(10 * 60000);
  h.document.hidden = false;
  h.document.emit('visibilitychange');
  await flush();
  assert.equal(previous.paused, true);
  assert.equal(h.engine.trackVol(previous), 0);
  assert.equal(h.engine.trackVol(incoming), 1);
  const firstEvents = listeningEvents(h).filter(event => event.song?.title === '第一首');
  assert.equal(firstEvents.filter(event => event.type === 'play_completed').length, 1);
  assert.equal(firstEvents.filter(event => event.type === 'skip').length, 0);
});

test('claim 成功带新 epoch 时不误释放，音乐真正开始后才确认 started', async () => {
  const h = createHarness(), ep = { ...episode('领取成功'), epoch: 7 };
  h.engine.prepare();
  h.route('/api/next', response({ ok: true, epoch: 7, episode: ep }));
  const incoming = h.engine.idle;
  await h.engine.requestNext();
  assert.equal(incoming.playCalls, 1);
  assert.equal(h.calls.filter(call => call.url === '/api/episode/release').length, 0);
  assert.equal(h.calls.filter(call => call.url === '/api/episode/started').length, 0);
  incoming.playing(); await flush();
  assert.equal(h.calls.filter(call => call.url === '/api/episode/started').length, 0);
  incoming.resolvePlay(); await flush();
  const startedCalls = h.calls.filter(call => call.url === '/api/episode/started');
  assert.equal(startedCalls.length, 1);
  const claimCall = h.calls.find(call => call.url.startsWith('/api/next?'));
  assert.deepEqual(JSON.parse(startedCalls[0].body), {
    id: ep.id,
    claimId: new URL(claimCall.url, 'http://localhost').searchParams.get('claimId'),
  });
  assert.equal(h.calls.filter(call => call.url === '/api/episode/release').length, 0);
});

test('定时节目复用 claim 生命周期，首次真正出声才发送带 claimId 的 started', async () => {
  const h = createHarness(), ep = { ...withVoice(episode('定时音乐')), epoch: 3 };
  h.engine.prepare();
  h.ws({ kind: 'scheduled', claimId: 'scheduled-claim', episode: ep, epoch: 3 });
  assert.equal(h.engine.snapshot().pendingEpisode.claimId, 'scheduled-claim');
  assert.equal(h.engine.heldClaims.length, 1);
  h.engine.voice.duration = 15;
  h.engine.voice.canplay(); await flush(); await h.clock.advance(800);
  assert.equal(h.calls.filter(call => call.url === '/api/episode/started').length, 0);
  h.engine.voice.playing(); h.engine.voice.resolvePlay(); await flush();
  assert.deepEqual(JSON.parse(h.calls.find(call => call.url === '/api/episode/started').body), {
    id: ep.id, claimId: 'scheduled-claim',
  });
  assert.equal(h.engine.heldClaims.length, 0);
  h.engine.stopPlayback();
  assert.equal(h.calls.some(call => call.url === '/api/episode/release'), false);
});

test('已有待播时立即释放另一份定时 claim，重复广播不释放正在持有的同一份', async () => {
  const h = createHarness(); await playSong(h);
  h.ws({ kind: 'scheduled', claimId: 'first-scheduled', episode: episode('第一份定时'), epoch: 0 });
  h.ws({ kind: 'scheduled', claimId: 'first-scheduled', episode: episode('第一份定时'), epoch: 0 });
  h.ws({ kind: 'scheduled', claimId: 'other-scheduled', episode: episode('另一份定时'), epoch: 0 });
  const releases = h.calls.filter(call => call.url === '/api/episode/release');
  assert.deepEqual(releases.map(call => JSON.parse(call.body)), [{ claimId: 'other-scheduled' }]);
  assert.equal(h.engine.snapshot().pendingEpisode.claimId, 'first-scheduled');
  h.engine.stopPlayback();
  assert.deepEqual(JSON.parse(h.calls.findLast(call => call.url === '/api/episode/release').body), { claimId: 'first-scheduled' });
});

test('定时节目 pending 语音有轮询补偿，暂停满十五分钟释放未开声的 claim', async () => {
  const h = createHarness(); await playSong(h);
  const ep = withVoice(episode('定时待语音'), 'pending');
  h.route(`/api/episode/${encodeURIComponent(ep.id)}/voice`, response({ status: 'ready', url: '/tts/scheduled-ready.mp3', text: ep.say }));
  h.ws({ kind: 'scheduled', claimId: 'pending-scheduled', episode: ep, epoch: 0 });
  await h.clock.advance(8000);
  assert.equal(h.engine.snapshot().pendingEpisode.episode.voice.status, 'ready');
  assert.equal(h.engine.voice.src, '/tts/scheduled-ready.mp3');
  assert.equal(h.engine.voice.playCalls, 0);
  h.engine.pausePlayback();
  h.clock.jump(15 * 60000); await h.clock.advance(0);
  assert.equal(h.engine.heldClaims.length, 0);
  assert.equal(h.engine.snapshot().pendingEpisode, null);
  assert.deepEqual(JSON.parse(h.calls.findLast(call => call.url === '/api/episode/release').body), { claimId: 'pending-scheduled' });
});

test('定时节目替换在途领取时取消旧请求，迟到回包不能覆盖定时 holder', async () => {
  const h = createHarness(); await playSong(h);
  const pending = deferred(); h.route('/api/next', pending.promise);
  const done = h.engine.requestNext();
  const call = h.calls.findLast(call => call.url.startsWith('/api/next?'));
  h.ws({ kind: 'scheduled', claimId: 'scheduled-wins', episode: episode('定时优先'), epoch: 0 });
  assert.equal(call.signal.aborted, true);
  pending.resolve(response({ ok: true, episode: episode('迟到普通领取') })); await done;
  assert.equal(h.engine.snapshot().pendingEpisode.claimId, 'scheduled-wins');
  assert.equal(h.engine.heldClaims.length, 1);
});

test('停止状态或旧 epoch 的定时节目只释放，不出声', () => {
  const h = createHarness();
  h.ws({ kind: 'scheduled', claimId: 'while-stopped', episode: episode('停止时定时'), epoch: 0 });
  h.engine.prepare();
  h.ws({ kind: 'episodesInvalidated', epoch: 2 });
  h.ws({ kind: 'scheduled', claimId: 'old-epoch', episode: episode('旧定时'), epoch: 0 });
  assert.deepEqual(h.calls.filter(call => call.url === '/api/episode/release').map(call => JSON.parse(call.body)),
    [{ claimId: 'while-stopped' }, { claimId: 'old-epoch' }]);
  assert.equal(h.engine.snapshot().pendingEpisode, null);
  assert.ok(h.audios.every(audio => audio.playCalls === 0));
});

test('窗口按钮只有一套模式控制，全屏 F/Esc 与三秒隐藏控制栏均不影响音轨', async () => {
  const h = createHarness(), music = await playSong(h);
  h.element('fullscreenBtn').click(); await flush();
  assert.equal(h.document.body.classList.contains('fullscreen'), true);
  assert.equal(h.element('fullscreenBtn').getAttribute('aria-pressed'), 'true');
  await h.clock.advance(3000);
  assert.equal(h.document.body.classList.contains('controls-hidden'), true);
  h.document.emit('pointermove');
  assert.equal(h.document.body.classList.contains('controls-hidden'), false);
  h.document.emit('keydown', { key: 'Escape' }); await flush();
  assert.equal(h.document.body.classList.contains('fullscreen'), false);
  h.document.emit('keydown', { key: 'f' }); await flush();
  assert.equal(h.document.body.classList.contains('fullscreen'), true);
  assert.equal(h.engine.active, music);
  assert.equal(music.playCalls, 1);
  h.window.emit('pagehide'); await flush();
  assert.equal(h.document.body.classList.contains('fullscreen'), false);
});

test('取消加载中的下一首后，空闲轨能立刻被新一轮切歌复用', async () => {
  const h = createHarness();
  const ep = { ...episode('当前歌曲'), queue: [song('当前歌曲'), song('下一首')] };
  const previous = await playProgram(h, ep), incoming = h.engine.idle;
  previous.currentTime = previous.duration - 3;
  previous.emit('timeupdate');
  assert.equal(incoming.playCalls, 1);
  const abandonedPlay = incoming.plays[0];
  h.engine.nextPlayback();
  await h.clock.advance(400);
  assert.equal(incoming.playCalls, 2, '取消后同一空闲轨应能重新加载');
  abandonedPlay.resolve();
  await flush();
  assert.equal(h.engine.active, previous, '旧 play Promise 迟到不能接管新槽位');
  incoming.playing(); incoming.resolvePlay();
  await flush();
  assert.equal(h.engine.active, incoming);
  assert.equal(h.engine.snapshot().queue[h.engine.snapshot().idx].meta.title, '下一首');
});

test('旧 epoch 的领取结果正在加载时失效，不能出声且不阻塞新 epoch', async () => {
  const h = createHarness(), stale = { ...episode('旧节目'), epoch: 1 };
  h.engine.prepare();
  h.route('/api/next', response({ ok: true, epoch: 1, episode: stale }));
  const previous = h.engine.active, incoming = h.engine.idle;
  await h.engine.requestNext();
  const abandonedPlay = incoming.plays[0];
  h.ws({ kind: 'episodesInvalidated', epoch: 2 });
  abandonedPlay.resolve(); incoming.emit('playing');
  await flush();
  assert.equal(incoming.paused, true);
  assert.equal(h.engine.trackVol(incoming), 0);
  assert.equal(h.engine.active, previous);
  assert.equal(h.calls.filter(call => call.url === '/api/episode/started').length, 0);
  assert.equal(h.calls.filter(call => call.url === '/api/episode/release').length, 1);

  const fresh = { ...episode('新节目'), epoch: 2 };
  h.route('/api/next', response({ ok: true, epoch: 2, episode: fresh }));
  await h.engine.requestNext();
  assert.equal(incoming.playCalls, 2);
  incoming.playing(); incoming.resolvePlay(); await flush();
  assert.equal(h.engine.snapshot().activeEpisode.id, fresh.id);
  const startedCalls = h.calls.filter(call => call.url === '/api/episode/started');
  assert.equal(startedCalls.length, 1);
  assert.equal(JSON.parse(startedCalls[0].body).id, fresh.id);
});

test('下一期语音按 ready、pending、skipped 状态进入歌曲尾声', async t => {
  await t.test('ready 只预载，进入八秒尾声才启动口播', async () => {
    const h = createHarness(), music = await playSong(h);
    const ep = withVoice(episode('有口播的下一首'));
    h.route('/api/next', response({ ok: true, episode: ep }));
    await h.engine.requestNext();
    h.engine.voice.canplay();
    music.currentTime = music.duration - 10;
    music.emit('timeupdate'); await flush();
    assert.equal(h.engine.voice.playCalls, 0);
    assert.equal(h.engine.snapshot().ducked, false);
    assert.equal(h.engine.trackVol(music), 1);
    music.currentTime = music.duration - 8;
    music.emit('timeupdate'); await flush();
    await h.clock.advance(800);
    assert.equal(h.engine.voice.playCalls, 1);
    assert.equal(h.calls.filter(call => call.url === '/api/episode/started').length, 0);
    h.engine.voice.playing(); h.engine.voice.resolvePlay(); await flush();
    assert.equal(h.calls.filter(call => call.url === '/api/episode/started').length, 1);
  });

  await t.test('pending 中途变 ready 也不能提前打断当前歌曲', async () => {
    const h = createHarness(), music = await playSong(h);
    const ep = withVoice(episode('稍后才有语音'), 'pending');
    h.route('/api/next', response({ ok: true, episode: ep }));
    await h.engine.requestNext();
    h.ws({ kind: 'voiceReady', episodeId: ep.id, epoch: 0, url: '/tts/prepared.mp3', text: ep.say });
    h.engine.voice.canplay(); await flush();
    assert.equal(h.engine.voice.src, '/tts/prepared.mp3');
    assert.equal(h.engine.voice.playCalls, 0);
    assert.equal(h.engine.snapshot().ducked, false);
    assert.equal(h.engine.active, music);
    music.currentTime = music.duration - 8;
    music.emit('timeupdate'); await flush();
    await h.clock.advance(800);
    assert.equal(h.engine.voice.playCalls, 1);
  });

  await t.test('pending 到歌曲结束仍未就绪就跳过口播，迟到 ready 不能插入', async () => {
    const h = createHarness(), music = await playSong(h);
    const ep = withVoice(episode('不等迟到语音'), 'pending'), incoming = h.engine.idle;
    h.route('/api/next', response({ ok: true, episode: ep }));
    await h.engine.requestNext();
    music.currentTime = music.duration - 7;
    music.emit('timeupdate'); await flush();
    assert.equal(h.engine.voice.playCalls, 0);
    assert.equal(incoming.playCalls, 0);
    music.currentTime = music.duration; music.ended = true; music.paused = true;
    music.emit('ended'); await flush();
    assert.equal(incoming.playCalls, 1);
    incoming.playing(); incoming.resolvePlay(); await flush();
    h.ws({ kind: 'voiceReady', episodeId: ep.id, epoch: 0, url: '/tts/too-late.mp3', text: ep.say });
    await flush();
    assert.equal(h.engine.voice.playCalls, 0);
    assert.equal(h.engine.voice.src, '');
    assert.equal(h.engine.snapshot().queue[0].meta.title, '不等迟到语音');
  });

  await t.test('skipped 不等待语音，在三秒尾声直接接歌', async () => {
    const h = createHarness(), music = await playSong(h), incoming = h.engine.idle;
    h.route('/api/next', response({ ok: true, episode: episode('直接接歌') }));
    await h.engine.requestNext();
    music.currentTime = music.duration - 4;
    music.emit('timeupdate'); await flush();
    assert.equal(incoming.playCalls, 0);
    music.currentTime = music.duration - 3;
    music.emit('timeupdate'); await flush();
    assert.equal(incoming.playCalls, 1);
    assert.equal(h.engine.voice.playCalls, 0);
  });
});

test('首次启动等 2.5 秒才垫歌，垫歌期间下一期就绪也不提前切走', async () => {
  const h = createHarness();
  h.route('/api/filler', response({ ok: true, item: song('首启垫歌') }));
  h.route('/api/next', response({ ok: false, busy: true, epoch: 0 }, 202));
  h.engine.resumePlayback(); await flush();
  await h.clock.advance(2499);
  assert.equal(h.audios.reduce((total, audio) => total + audio.playCalls, 0), 0);
  await h.clock.advance(1);
  const filler = h.audios.find(audio => audio.playCalls);
  assert.ok(filler, '2.5 秒到时应开始加载垫歌');
  filler.playing(); filler.resolvePlay(); await flush();
  await h.clock.advance(700);
  const ep = withVoice(episode('自动准备的节目'));
  h.route('/api/next', response({ ok: true, episode: ep }));
  h.ws({ kind: 'nextReady', epoch: 0 }); await flush();
  h.engine.voice.canplay();
  await h.clock.advance(1000);
  assert.equal(h.engine.active, filler);
  assert.equal(h.engine.snapshot().activeEpisode.queue[0].meta.title, '首启垫歌');
  assert.equal(h.engine.snapshot().pendingEpisode.episode.id, ep.id);
  assert.equal(h.audios.filter(audio => audio !== h.engine.voice).reduce((total, audio) => total + audio.playCalls, 0), 1);
  assert.equal(h.engine.voice.playCalls, 0);
  assert.equal(h.engine.snapshot().ducked, false);
});

test('暂停后不足 250ms 就恢复仍会调用 play，不会被旧暂停淡出再次停住', async () => {
  const h = createHarness(), music = await playSong(h);
  const before = music.playCalls;
  h.engine.pausePlayback();
  await h.clock.advance(100);
  h.engine.resumePlayback(); await flush();
  assert.equal(music.playCalls, before + 1);
  music.playing(); music.resolvePlay(); await flush();
  await h.clock.advance(500);
  assert.equal(music.paused, false);
  assert.equal(h.engine.snapshot().paused, false);
  assert.equal(h.engine.trackVol(music), 1);
});

test('口播结束时垫入歌曲仍在加载，加载完成后能恢复主音量', async () => {
  const h = createHarness(), previous = await playSong(h), pending = pendingChat(h);
  const ep = withVoice(episode('跨口播结束的垫歌'));
  pending.resolve(response({ ok: true, requestId: pending.requestId, episode: ep }));
  await pending.done;
  h.engine.voice.duration = 10;
  h.engine.voice.canplay(); await flush();
  await h.clock.advance(800);
  h.engine.voice.playing(); h.engine.voice.resolvePlay(); await flush();
  h.engine.voice.currentTime = 4;
  const incoming = h.engine.idle;
  previous.emit('timeupdate'); await flush();
  assert.equal(incoming.playCalls, 1);
  h.engine.voice.currentTime = 10; h.engine.voice.ended = true; h.engine.voice.paused = true;
  h.engine.voice.emit('ended');
  await h.clock.advance(300);
  assert.equal(h.engine.active, previous);
  incoming.playing(); incoming.resolvePlay(); await flush();
  await h.clock.advance(3000);
  assert.equal(h.engine.active, incoming);
  assert.equal(h.engine.trackVol(incoming), 1, '不能永久留在 13% 背景音量');
  assert.equal(previous.paused, true);
  assert.equal(h.engine.voice.paused, true);
  assert.equal(h.engine.snapshot().ducked, false);
  assert.equal(h.audios.filter(audio => audio !== h.engine.voice).reduce((total, audio) => total + audio.playCalls, 0), 2);
});

test('sayFailed 在 HTTP 前后到达都只接歌一次', async t => {
  for (const when of ['beforeHTTP', 'afterHTTP']) {
    await t.test(when, async () => {
      const h = createHarness();
      await playSong(h);
      const pending = pendingChat(h), ep = withVoice(episode('语音失败后接歌'), 'pending');
      const failed = { kind: 'sayFailed', origin: 'chat', requestId: pending.requestId };
      if (when === 'beforeHTTP') h.ws(failed);
      pending.resolve(response({ ok: true, requestId: pending.requestId, episode: ep }));
      await pending.done;
      if (when === 'afterHTTP') h.ws(failed);
      await flush();
      const incoming = h.engine.idle;
      assert.equal(incoming.playCalls, 1);
      incoming.playing(); incoming.resolvePlay(); await flush();
      h.ws(failed);
      h.ws({ kind: 'episode', origin: 'chat', requestId: pending.requestId, episode: ep });
      await h.clock.advance(2000);
      assert.equal(h.engine.snapshot().queue[h.engine.snapshot().idx].meta.title, '语音失败后接歌');
      assert.equal(h.audios.filter(audio => audio !== h.engine.voice).reduce((total, audio) => total + audio.playCalls, 0), 2);
      assert.equal(h.engine.voice.playCalls, 0);
      assert.equal(listeningEvents(h).filter(event => event.type === 'play_started' && event.song.title === '语音失败后接歌').length, 1);
    });
  }
});

test('暂停加载中的音乐不会被当作播放失败，恢复后仍由一条主音乐轨接管', async t => {
  for (const waitingFor of ['playing 与 play()', 'play() Promise', 'playing 事件']) {
    await t.test(`还在等待 ${waitingFor}`, async () => {
      const h = createHarness();
      const ep = { ...episode('暂停前歌曲'), queue: [song('暂停前歌曲'), song('加载中歌曲')] };
      const previous = await playProgram(h, ep), incoming = h.engine.idle;
      previous.currentTime = previous.duration - 3;
      previous.emit('timeupdate');
      assert.equal(incoming.playCalls, 1);
      if (waitingFor === 'play() Promise') incoming.playing();
      if (waitingFor === 'playing 事件') incoming.resolvePlay();
      await flush();

      h.engine.pausePlayback();
      await h.clock.advance(300);
      assert.ok(h.audios.every(audio => audio.paused));
      assert.equal(listeningEvents(h).filter(event => event.type === 'play_failed').length, 0,
        '用户暂停不能降低歌曲或音源的可用性判断');

      h.engine.resumePlayback(); await flush();
      previous.playing(); previous.resolvePlay();
      incoming.playing(); incoming.resolvePlay(); await flush();
      await h.clock.advance(3500);
      assert.equal(h.engine.active, incoming);
      assert.equal(h.engine.snapshot().queue[h.engine.snapshot().idx].meta.title, '加载中歌曲');
      assert.equal(h.engine.trackVol(incoming), 1);
      assert.equal(previous.paused, true);
      assert.equal(h.audios.filter(audio => audio !== h.engine.voice && !audio.paused).length, 1);
      assert.equal(listeningEvents(h).filter(event => event.type === 'play_failed').length, 0);
    });
  }
});

test('暂停后点击 Next 并在 350ms 内恢复，仍执行 Next 而不吞掉动作', async () => {
  const h = createHarness();
  const ep = { ...episode('被换掉的歌'), queue: [song('被换掉的歌'), song('快速恢复后的下一首')] };
  const previous = await playProgram(h, ep), incoming = h.engine.idle;
  h.engine.pausePlayback();
  await h.clock.advance(50);
  h.engine.nextPlayback();
  await h.clock.advance(100);
  h.engine.resumePlayback(); await flush();
  // 如果恢复曾短暂重开原曲，也让它完成启动；Next 的收尾仍必须发生。
  if (!previous.paused) { previous.playing(); previous.resolvePlay(); await flush(); }
  await h.clock.advance(400);
  assert.equal(incoming.playCalls, 1, 'Next 的延迟收尾不能被恢复替换包络吞掉');
  incoming.playing(); incoming.resolvePlay(); await flush();
  await h.clock.advance(500);
  assert.equal(h.engine.active, incoming);
  assert.equal(h.engine.snapshot().queue[h.engine.snapshot().idx].meta.title, '快速恢复后的下一首');
  assert.equal(previous.paused, true);
  assert.equal(h.engine.snapshot().paused, false);
});

test('上一轮已经听过口播，新 chat 完全失败仍清掉 requestId 与 thinking', async () => {
  const h = createHarness(), music = await playSong(h), first = pendingChat(h, '先聊一句');
  const ep = {
    id: 'chat-without-song', epoch: 0, intent: 'chat', say: '听到了', voice: { status: 'ready' },
    queue: [{ type: 'tts', url: '/tts/first-chat.mp3', text: '听到了' }],
  };
  first.resolve(response({ ok: true, requestId: first.requestId, episode: ep }));
  await first.done;
  h.engine.voice.canplay(); await flush();
  await h.clock.advance(800);
  h.engine.voice.playing(); h.engine.voice.resolvePlay(); await flush();
  h.engine.voice.ended = true; h.engine.voice.paused = true;
  h.engine.voice.emit('ended');
  await h.clock.advance(2100);
  assert.equal(h.engine.active, music);

  const second = pendingChat(h, '这一轮网络失败');
  second.reject(new Error('测试网络中断'));
  await second.done;
  assert.equal(h.engine.snapshot().currentRequestId, null);
  assert.equal(h.document.body.classList.contains('thinking'), false);
  assert.equal(music.paused, false);
});


test('静音再恢复主音量时，进行中的音乐包络不会永久留在零音量', async () => {
  const h = createHarness();
  h.engine.prepare();
  const ep = episode('音量恢复');
  const pending = h.engine.startMusic(ep.queue[0], 0, { episode: ep });
  h.engine.idle.resolvePlay(); h.engine.idle.playing();
  await pending;
  await h.clock.advance(150);
  h.engine.setMasterVolume(0);
  await h.clock.advance(150);
  assert.equal(h.engine.trackVol(h.engine.active), 0);
  h.engine.setMasterVolume(50);
  await h.clock.advance(800);
  assert.equal(h.engine.trackVol(h.engine.active), 0.5);
});

test('E1：流式口播后的 HTTP 或网络失败会收尾，再继续原队列', async t => {
  for (const failure of ['HTTP', 'network']) for (const when of ['speaking', 'ended', 'loading']) {
    await t.test(`${failure} / ${when}`, async () => {
      const h = createHarness();
      const ep = { ...episode('原队列'), queue: [song('原队列'), song('后续歌曲')] };
      const music = await playProgram(h, ep), pending = pendingChat(h);
      const endedListeners = h.engine.voice.listeners.get('ended')?.size || 0;
      const errorListeners = h.engine.voice.listeners.get('error')?.size || 0;
      h.ws({ kind: 'sayReady', origin: 'chat', requestId: pending.requestId, url: '/tts/failed-chat.mp3', say: '已经说出的回复' });
      if (when !== 'loading') {
        h.engine.voice.canplay(); await flush(); await h.clock.advance(800);
        h.engine.voice.playing(); h.engine.voice.resolvePlay(); await flush();
      }
      const endVoice = () => {
        h.engine.voice.ended = true; h.engine.voice.paused = true; h.engine.voice.emit('ended');
      };
      if (when === 'ended') endVoice();
      if (failure === 'HTTP') pending.resolve(response({ ok: false, requestId: pending.requestId, error: '回复解析失败' }, 500));
      else pending.reject(new Error('连接中断'));
      await pending.done;
      assert.equal(h.engine.snapshot().currentRequestId, null);
      if (when === 'speaking') {
        assert.equal(h.engine.voice.paused, false, '已出声的口播应当念完');
        endVoice();
      }
      await h.clock.advance(2100);
      assert.equal(h.engine.snapshot().voiceContext, null);
      assert.equal(h.engine.voice.listeners.get('ended')?.size || 0, endedListeners);
      assert.equal(h.engine.voice.listeners.get('error')?.size || 0, errorListeners);
      assert.equal(h.engine.trackVol(music), 1);
      assert.equal(h.document.body.classList.contains('thinking'), false);
      const next = h.engine.idle;
      music.ended = true; music.paused = true; music.emit('ended');
      assert.equal(next.playCalls, 1, '失败口播不得阻塞后续歌曲');
      next.playing(); next.resolvePlay(); await flush();
      assert.equal(h.engine.snapshot().queue[h.engine.snapshot().idx].meta.title, '后续歌曲');
      h.ws({ kind: 'sayReady', origin: 'chat', requestId: pending.requestId, url: '/tts/late.mp3', say: '迟到回复' });
      assert.notEqual(h.engine.voice.src, '/tts/late.mp3');
    });
  }
});

test('E1：失败口播念完且原队列已尽时继续垫歌', async () => {
  const h = createHarness();
  h.route('/api/filler', response({ ok: true, item: song('失败后的垫歌') }));
  const music = await playSong(h), pending = pendingChat(h);
  h.ws({ kind: 'sayReady', origin: 'chat', requestId: pending.requestId, url: '/tts/fail.mp3', say: '一段回复' });
  h.engine.voice.canplay(); await flush(); await h.clock.advance(800);
  h.engine.voice.playing(); h.engine.voice.resolvePlay(); await flush();
  music.ended = true; music.paused = true; music.emit('ended');
  pending.reject(new Error('连接断开')); await pending.done;
  h.engine.voice.ended = true; h.engine.voice.paused = true; h.engine.voice.emit('ended');
  await flush();
  assert.equal(h.engine.idle.playCalls, 1);
  h.engine.idle.playing(); h.engine.idle.resolvePlay(); await flush();
  assert.equal(h.engine.snapshot().activeEpisode.queue[0].meta.title, '失败后的垫歌');
});

test('E2：epoch 失效停止未出声的音箱 claim，拒绝迟到响应与轮询', async t => {
  for (const phase of ['download', 'watch']) await t.test(phase, async () => {
    const h = createHarness(); h.engine.prepare();
    h.engine.applyOutputResult({ exclusive: true, uid: 'fake-speaker', unchanged: true });
    const pending = deferred(), ep = episode('失效音箱节目');
    h.route('/api/next', response({ ok: true, episode: ep }));
    h.route('/api/exclusive/play', phase === 'download' ? pending.promise : response({ ok: true, event: 'starting', token: 'old', duration: 180 }));
    await h.engine.requestNext(); await flush();
    const play = h.calls.find(call => call.url === '/api/exclusive/play');
    if (phase === 'watch') {
      h.route(call => call.url === '/api/exclusive', pending.promise);
      await h.clock.advance(400);
    }
    h.route('/api/exclusive/stop', response({ ok: true }));
    h.ws({ kind: 'episodesInvalidated', epoch: 1 });
    assert.equal(h.calls.filter(call => call.url === '/api/exclusive/stop').length, 1);
    if (phase === 'download') assert.equal(play.signal.aborted, true);
    pending.resolve(response({ ok: true, event: 'playing', token: 'old', duration: 180, seconds: 30 }));
    await flush();
    assert.equal(h.engine.exclusiveClock.paused, true);
    assert.equal(h.calls.filter(call => call.url === '/api/episode/started').length, 0);
    assert.equal(h.engine.heldClaims.length, 0);
  });
});

test('E3：暂停时输入继续或停止，控制回复立即执行', async t => {
  for (const action of ['resume', 'stop']) await t.test(action, async () => {
    const h = createHarness(), music = await playSong(h);
    h.engine.pausePlayback(); await h.clock.advance(300);
    const pending = pendingChat(h, action === 'resume' ? '继续播放' : '停');
    pending.resolve(response({ ok: true, requestId: pending.requestId, control: { action, reply: '收到' } }));
    await pending.done;
    assert.equal(h.engine.snapshot().paused, false);
    assert.equal(h.engine.snapshot().stopped, action === 'stop');
    if (action === 'resume') {
      assert.equal(music.playCalls, 2);
      music.playing(); music.resolvePlay(); await flush(); await h.clock.advance(400);
      assert.equal(music.paused, false);
    } else {
      await h.clock.advance(500);
      assert.ok(h.audios.every(audio => audio.paused));
    }
  });
});

test('E4：暂停后保存设置或发聊天，恢复仍从原歌曲位置和音量继续', async t => {
  for (const operation of ['settings', 'chat']) for (const wait of [100, 300]) {
    await t.test(`${operation} / pause ${wait}ms`, async () => {
      const h = createHarness(), music = await playSong(h);
      h.engine.setMasterVolume(65); music.currentTime = 67;
      h.engine.pausePlayback(); await h.clock.advance(wait);
      if (operation === 'settings') {
        const settings = {
          llm: { provider: 'local', local: { baseUrl: '' }, models: { local: 'fake', claude: 'sonnet', deepseek: 'deepseek-flash' } },
          tts: { provider: 'pc5090', pc5090: { baseUrl: '', voice: 'fake' }, fish: { model: 's1' } },
          recommendation: { mode: 'fake' }, playback: { quality: 'standard' }, credentials: {},
          options: { claudeModels: ['sonnet'], deepseekModels: ['deepseek-flash'], fishModels: ['s1'], audioQualities: ['standard'] },
        };
        h.engine.setSettingsPayload(settings);
        h.route('/api/settings/credentials', response({ ok: true }));
        h.route('/api/settings', response({ ok: true, settings }));
        assert.equal(await h.engine.saveSettings(), true);
      } else {
        const pending = pendingChat(h, '说句话');
        pending.resolve(response({ ok: true, requestId: pending.requestId, control: { action: 'none', reply: '收到' } }));
        await pending.done;
      }
      await h.clock.advance(400);
      assert.equal(music.paused, true);
      h.engine.resumePlayback(); await flush();
      assert.equal(music.playCalls, 2);
      assert.equal(music.currentTime, 67);
      music.playing(); music.resolvePlay(); await flush(); await h.clock.advance(600);
      assert.equal(h.engine.active, music);
      assert.equal(h.engine.trackVol(music), 0.65);
      assert.equal(h.audios.filter(audio => audio !== h.engine.voice && !audio.paused).length, 1);
    });
  }
});

test('E5：音箱恢复后持有新 claim，直到当前队列结束才切换', async () => {
  const h = createHarness(); h.engine.prepare();
  h.engine.applyOutputResult({ exclusive: true, uid: 'fake-speaker', unchanged: true });
  h.route('/api/exclusive/play', response({ ok: true, event: 'playing', token: 'original', duration: 180 }));
  const original = { ...episode('音箱原歌曲'), queue: [song('音箱原歌曲'), song('音箱第二首')] };
  h.engine.loadEpisode(original); await flush();
  h.engine.exclusiveClock.currentTime = 30;
  h.route('/api/exclusive/control', response({ ok: true })); h.engine.pausePlayback();
  h.route('/api/exclusive/control', response({ ok: true }));
  h.engine.resumePlayback(); await flush();
  const next = episode('稍后再播的节目');
  h.route('/api/next', response({ ok: true, episode: next }));
  await h.engine.requestNext();
  assert.equal(h.engine.snapshot().activeEpisode.id, original.id);
  assert.equal(h.engine.snapshot().pendingEpisode.episode.id, next.id);
  assert.equal(h.calls.filter(call => call.url === '/api/exclusive/play').length, 1);
  h.route(call => call.url === '/api/exclusive', response({ ok: true, event: 'ended', token: 'original', seconds: 180 }));
  h.route('/api/exclusive/play', response({ ok: true, event: 'playing', token: 'second', duration: 180 }));
  await h.clock.advance(400);
  assert.equal(h.engine.snapshot().queue[h.engine.snapshot().idx].meta.title, '音箱第二首');
  assert.equal(h.engine.snapshot().pendingEpisode.episode.id, next.id);
  h.route(call => call.url === '/api/exclusive', response({ ok: true, event: 'ended', token: 'second', seconds: 180 }));
  h.route('/api/exclusive/play', response({ ok: true, event: 'playing', token: 'next', duration: 180 }));
  await h.clock.advance(400);
  assert.equal(h.engine.snapshot().activeEpisode.id, next.id);
});

test('E5：音箱启动中和暂停后迟到的 playing 轮询都不能让待播节目抢先接管', async t => {
  for (const phase of ['starting', 'paused']) await t.test(phase, async () => {
    const h = createHarness(); h.engine.prepare();
    h.engine.applyOutputResult({ exclusive: true, uid: 'fake-speaker', unchanged: true });
    const ep = episode('尚未换掉的音箱歌'), late = deferred();
    h.route('/api/exclusive/play', response({ ok: true, event: phase === 'starting' ? 'starting' : 'playing', token: 'original', duration: 180 }));
    h.engine.loadEpisode(ep); await flush();
    h.route(call => call.url === '/api/exclusive', late.promise);
    await h.clock.advance(400);
    if (phase === 'paused') {
      h.route('/api/exclusive/control', response({ ok: true })); h.engine.pausePlayback();
    }
    late.resolve(response({ ok: true, event: phase === 'starting' ? 'starting' : 'playing', token: 'original', seconds: 0, duration: 180 }));
    await flush();
    if (phase === 'paused') {
      assert.equal(h.engine.exclusiveClock.paused, true);
      assert.equal(h.document.body.classList.contains('playing'), false);
    } else {
      h.route('/api/next', response({ ok: true, episode: episode('后来的音箱节目') }));
      await h.engine.requestNext();
      assert.equal(h.engine.snapshot().activeEpisode.id, ep.id);
      assert.equal(h.calls.filter(call => call.url === '/api/exclusive/play').length, 1);
    }
  });
});

test('E5：音箱点下一首仍能立即换节目，旧轮询不会复活旧歌曲', async () => {
  const h = createHarness(); h.engine.prepare();
  h.engine.applyOutputResult({ exclusive: true, uid: 'fake-speaker', unchanged: true });
  h.route('/api/exclusive/play', response({ ok: true, event: 'playing', token: 'original', duration: 180 }));
  h.engine.loadEpisode(episode('主动换掉的音箱歌')); await flush();
  const late = deferred(); h.route(call => call.url === '/api/exclusive', late.promise);
  await h.clock.advance(400);
  h.route('/api/exclusive/stop', response({ ok: true }));
  h.route('/api/next', response({ ok: true, episode: episode('主动换到的音箱歌') }));
  h.route('/api/exclusive/play', response({ ok: true, event: 'playing', token: 'next', duration: 180 }));
  h.engine.nextPlayback(); await h.clock.advance(350);
  assert.equal(h.calls.filter(call => call.url === '/api/exclusive/stop').length, 1);
  assert.equal(h.engine.snapshot().activeEpisode.id, 'episode-主动换到的音箱歌');
  late.resolve(response({ ok: true, event: 'ended', token: 'original', seconds: 180 })); await flush();
  assert.equal(h.engine.snapshot().activeEpisode.id, 'episode-主动换到的音箱歌');
  assert.equal(h.calls.filter(call => call.url === '/api/exclusive/play').length, 2);
});

test('E6：音箱首启和队列耗尽都用垫歌，并保留 filler 统计来源', async () => {
  const h = createHarness();
  h.engine.applyOutputResult({ exclusive: true, uid: 'fake-speaker', unchanged: true });
  h.route('/api/filler', response({ ok: true, item: song('音箱垫歌一') }));
  h.route('/api/next', response({ ok: false, busy: true }, 202));
  h.engine.resumePlayback(); await flush(); await h.clock.advance(2499);
  assert.equal(h.calls.filter(call => call.url === '/api/exclusive/play').length, 0);
  h.route('/api/exclusive/play', response({ ok: true, event: 'playing', token: 'filler-1', duration: 180 }));
  h.route('/api/filler', response({ ok: true, item: song('音箱垫歌二') }));
  await h.clock.advance(1);
  assert.equal(h.calls.filter(call => call.url === '/api/exclusive/play').length, 1);
  assert.equal(h.audios.reduce((sum, audio) => sum + audio.playCalls, 0), 0);
  h.route(call => call.url === '/api/exclusive', response({ ok: true, event: 'ended', token: 'filler-1', seconds: 180 }));
  h.route('/api/exclusive/play', response({ ok: true, event: 'playing', token: 'filler-2', duration: 180 }));
  h.route('/api/next', response({ ok: false, busy: true }, 202));
  await h.clock.advance(400);
  assert.equal(h.calls.filter(call => call.url === '/api/exclusive/play').length, 2);
  assert.equal(h.engine.snapshot().queue[0].meta.title, '音箱垫歌二');
  const events = listeningEvents(h).filter(event => ['play_started', 'play_completed', 'replay'].includes(event.type));
  assert.ok(events.length >= 3);
  assert.ok(events.every(event => event.discoveryType === 'filler'));
});

test('E6：音箱垫歌在取回前暂停或停止，不得迟到出声', async t => {
  for (const action of ['pausePlayback', 'stopPlayback']) await t.test(action, async () => {
    const h = createHarness(), pending = deferred();
    h.engine.applyOutputResult({ exclusive: true, uid: 'fake-speaker', unchanged: true });
    h.route('/api/filler', pending.promise);
    h.route('/api/next', response({ ok: false, busy: true }, 202));
    h.engine.resumePlayback(); await flush(); await h.clock.advance(2500);
    h.route('/api/exclusive/stop', response({ ok: true }));
    h.route('/api/exclusive/control', response({ ok: true }));
    h.engine[action]();
    pending.resolve(response({ ok: true, item: song('迟到音箱垫歌') })); await flush();
    assert.equal(h.calls.filter(call => call.url === '/api/exclusive/play').length, 0);
  });
});

test('E6：音箱等待垫歌时暂停再恢复，仍会在垫歌取回后出声', async () => {
  const h = createHarness(), pending = deferred();
  h.engine.applyOutputResult({ exclusive: true, uid: 'fake-speaker', unchanged: true });
  h.route('/api/filler', pending.promise);
  h.route('/api/next', response({ ok: false, busy: true }, 202));
  h.engine.resumePlayback(); await flush(); await h.clock.advance(2500);
  h.route('/api/exclusive/control', response({ ok: true })); h.engine.pausePlayback();
  h.route('/api/exclusive/control', response({ ok: true })); h.engine.resumePlayback();
  h.route('/api/exclusive/play', response({ ok: true, event: 'playing', token: 'filler', duration: 180 }));
  pending.resolve(response({ ok: true, item: song('恢复后取回的垫歌') })); await flush();
  assert.equal(h.calls.filter(call => call.url === '/api/exclusive/play').length, 1);
  assert.equal(h.engine.snapshot().queue[0].meta.title, '恢复后取回的垫歌');
});

test('E7：音箱未出声就暂停并重启服务，恢复后不会等待已丢弃的音箱播放', async () => {
  const h = createHarness(); h.engine.prepare();
  h.engine.applyOutputResult({ exclusive: true, uid: 'fake-speaker', unchanged: true });
  h.route('/api/next', response({ ok: true, episode: { ...episode('重启前音箱'), epoch: 7 } }));
  h.route('/api/exclusive/play', response({ ok: true, event: 'starting', token: 'old', duration: 180 }));
  await h.engine.requestNext(); await flush();
  h.route('/api/exclusive/control', response({ ok: true })); h.engine.pausePlayback();
  h.route('/api/exclusive/stop', response({ ok: true }));
  h.ws({ kind: 'hello', epoch: 0 }); await h.clock.advance(0);
  h.route('/api/next', response({ ok: true, episode: episode('重启后音箱') }));
  h.route('/api/exclusive/play', response({ ok: true, event: 'playing', token: 'new', duration: 180 }));
  h.engine.resumePlayback(); await flush();
  assert.equal(h.engine.snapshot().activeEpisode.id, 'episode-重启后音箱');
  assert.equal(h.calls.filter(call => call.url === '/api/exclusive/play').length, 2);
  assert.equal(h.calls.filter(call => call.url === '/api/episode/release').length, 0);
});

test('E7：hello epoch 回退丢弃旧待播 claim，直接领取新服务节目且不释放旧 ID', async () => {
  const h = createHarness(), music = await playSong(h);
  const stale = { ...episode('重启前待播'), epoch: 7 };
  h.route('/api/next', response({ ok: true, epoch: 7, episode: stale }));
  await h.engine.requestNext();
  const oldId = h.engine.snapshot().claimId;
  assert.equal(h.engine.snapshot().pendingEpisode.episode.id, stale.id);
  assert.equal(h.engine.heldClaims.length, 1);

  const fresh = { ...episode('重启后待播'), epoch: 0 };
  h.route('/api/next', response({ ok: true, epoch: 0, episode: fresh }));
  h.ws({ kind: 'hello', epoch: 0 });
  await h.clock.advance(0);
  assert.equal(h.engine.snapshot().pendingEpisode?.episode.id, fresh.id,
    '新服务 epoch 较低也应自动重领并接受节目');
  assert.notEqual(h.engine.snapshot().claimId, oldId);
  assert.equal(h.engine.heldClaims.length, 1);
  assert.equal(h.engine.heldClaims[0].episode.id, fresh.id);
  assert.equal(h.engine.active, music);
  assert.equal(music.paused, false);
  assert.equal(h.calls.some(call => call.url === '/api/episode/release'), false,
    '旧服务的 claim 不得发给新服务释放');

  h.engine.stopPlayback();
  const releases = h.calls.filter(call => call.url === '/api/episode/release').map(call => JSON.parse(call.body));
  assert.equal(releases.length, 1);
  assert.notEqual(releases[0].claimId, oldId, '后续 stop 也不能释放已丢弃的旧 ID');
});

test('E7：hello epoch 回退取消正在加载的旧 holder，迟到 play 不得确认旧节目', async () => {
  const h = createHarness(), stale = { ...episode('重启前加载'), epoch: 7 };
  h.engine.prepare();
  h.route('/api/next', response({ ok: true, epoch: 7, episode: stale }));
  const previous = h.engine.active, incoming = h.engine.idle;
  await h.engine.requestNext();
  const abandonedPlay = incoming.plays[0];
  assert.equal(h.engine.snapshot().pendingEpisode, null);
  assert.equal(h.engine.heldClaims.length, 1);

  h.route('/api/next', response({ ok: false, busy: true, epoch: 0 }, 202));
  h.ws({ kind: 'hello', epoch: 0 });
  await h.clock.advance(0);
  abandonedPlay.resolve(); incoming.emit('playing');
  await flush();
  assert.equal(h.engine.heldClaims.length, 0, '已离开 pending 的加载 holder 也必须丢弃');
  assert.equal(incoming.paused, true);
  assert.equal(h.engine.trackVol(incoming), 0);
  assert.equal(h.engine.active, previous);
  assert.equal(h.calls.filter(call => call.url === '/api/episode/started').length, 0);
  assert.equal(h.calls.filter(call => call.url === '/api/episode/release').length, 0);
  assert.equal(h.calls.filter(call => call.url.startsWith('/api/next?')).length, 2,
    '旧 holder 不得阻塞新服务领取');
});

test('E7：hello epoch 回退取消在途领取，新 claim 不受旧 HTTP 回包影响', async () => {
  const h = createHarness();
  h.ws({ kind: 'episodesInvalidated', epoch: 7 });
  h.engine.prepare();
  const pending = deferred();
  h.route('/api/next', pending.promise);
  const done = h.engine.requestNext();
  const oldCall = h.calls.findLast(call => call.url.startsWith('/api/next?'));
  const oldId = new URL(oldCall.url, 'http://localhost').searchParams.get('claimId');

  const fresh = { ...episode('重启后领取'), epoch: 0 };
  h.route('/api/next', response({ ok: true, epoch: 0, episode: fresh }));
  h.ws({ kind: 'hello', epoch: 0 });
  await h.clock.advance(0);
  assert.equal(oldCall.signal.aborted, true);
  const newCall = h.calls.findLast(call => call.url.startsWith('/api/next?'));
  assert.notEqual(new URL(newCall.url, 'http://localhost').searchParams.get('claimId'), oldId);

  pending.resolve(response({ ok: true, epoch: 7, episode: { ...episode('旧服务迟到领取'), epoch: 7 } }));
  await done;
  const incoming = h.engine.idle;
  incoming.playing(); incoming.resolvePlay(); await flush();
  assert.equal(h.engine.snapshot().activeEpisode?.id, fresh.id);
  const started = h.calls.filter(call => call.url === '/api/episode/started').map(call => JSON.parse(call.body));
  assert.deepEqual(started, [{ id: fresh.id,
    claimId: new URL(newCall.url, 'http://localhost').searchParams.get('claimId') }]);
  assert.equal(h.calls.filter(call => call.url === '/api/episode/release').length, 0);
});

test('E7：重启会取消旧聊天，迟到回包不能把 epoch 拉回旧服务', async () => {
  const h = createHarness(), music = await playSong(h);
  h.ws({ kind: 'hello', epoch: 7 });
  const pending = pendingChat(h), fresh = episode('新服务待播');
  h.route('/api/next', response({ ok: true, episode: fresh }));
  h.ws({ kind: 'hello', epoch: 0 }); await h.clock.advance(0);
  assert.equal(pending.call.signal.aborted, true);
  assert.equal(h.engine.snapshot().currentRequestId, null);
  pending.resolve(response({ ok: true, requestId: pending.requestId, episode: { ...episode('旧服务聊天'), epoch: 7 } }));
  await pending.done;
  assert.equal(h.engine.snapshot().pendingEpisode.episode.id, fresh.id);
  assert.equal(h.engine.active, music);
  assert.equal(h.engine.idle.playCalls, 0);
});

test('E7：旧垫歌 HTTP 已返回但 continuation 迟到时，仍不能覆盖新服务任务', async () => {
  const h = createHarness();
  h.ws({ kind: 'episodesInvalidated', epoch: 7 }); h.engine.prepare();
  const newer = deferred();
  h.route('/api/filler', { ok: true, status: 200, json: async () => {
    const restart = n => queueMicrotask(() => n ? restart(n - 1) : h.ws({ kind: 'hello', epoch: 0 }));
    restart(3);
    return { ok: true, item: song('旧服务垫歌') };
  } });
  h.route('/api/filler', newer.promise);
  await h.engine.prefetchFiller(); await flush();
  const filling = h.engine.ensureFiller(); await flush();
  assert.equal(h.engine.idle.playCalls, 0, '新来源未返回时，不能先播旧服务垫歌');
  newer.resolve(response({ ok: true, item: song('新服务垫歌') }));
  await filling; await flush();
  const incoming = h.engine.idle;
  incoming.playing(); incoming.resolvePlay(); await flush();
  assert.equal(h.engine.snapshot().activeEpisode.queue[0].meta.title, '新服务垫歌');
});

test('E7：低 epoch 的普通广播不冒充重启，hello epoch 相同保留现有待播', async () => {
  const h = createHarness(); await playSong(h);
  const held = { ...episode('仍有效的待播'), epoch: 7 };
  h.route('/api/next', response({ ok: true, epoch: 7, episode: held }));
  await h.engine.requestNext();
  const oldId = h.engine.snapshot().claimId;
  h.ws({ kind: 'nextReady', epoch: 0 });
  h.ws({ kind: 'hello', epoch: 7 });
  await h.clock.advance(0);
  assert.equal(h.engine.snapshot().pendingEpisode.episode.id, held.id);
  assert.equal(h.engine.snapshot().claimId, oldId);
  assert.equal(h.engine.heldClaims.length, 1);
  assert.equal(h.calls.filter(call => call.url.startsWith('/api/next?')).length, 1);
  assert.equal(h.calls.filter(call => call.url === '/api/episode/release').length, 0);
});


test('G1：首启空buffer、离线语音、轮询撞nextReady后仍在首段垫歌尾声接入已领取节目', async () => {
  const h = createHarness(), waiting = deferred(), ep = episode('首个领取节目');
  h.route('/api/filler', response({ ok: true, item: song('首段垫歌') }));
  h.route('/api/next', response({ ok: false, busy: true, epoch: 0 }, 202));
  h.engine.resumePlayback(); await flush();
  await h.clock.advance(2600);
  const filler = h.engine.idle;
  filler.playing(); filler.resolvePlay(); await flush();
  await h.clock.advance(700);
  h.route('/api/next', waiting.promise);
  await h.clock.advance(4700);
  h.ws({ kind: 'nextReady', buffered: 1, epoch: 0 });
  waiting.resolve(response({ ok: true, episode: ep })); await flush();
  assert.equal(h.engine.snapshot().pendingEpisode?.episode.id, ep.id);
  filler.currentTime = filler.duration - 17; filler.emit('seeking'); filler.emit('timeupdate');
  assert.equal(h.engine.idle.playCalls, 0);
  filler.currentTime = filler.duration - 3; filler.emit('timeupdate'); await flush();
  const incoming = h.engine.idle;
  assert.equal(incoming.src, ep.queue[0].url);
  assert.equal(incoming.playCalls, 1);
  incoming.playing(); incoming.resolvePlay(); await flush();
  filler.currentTime = filler.duration; filler.ended = true; filler.paused = true; filler.emit('ended');
  assert.equal(h.engine.snapshot().activeEpisode.id, ep.id);
  assert.equal(h.calls.filter(call => call.url === '/api/episode/started').length, 1);
});

test('G2：聊天点歌等待时自动节目不能接管，原歌结束用垫歌直到点歌回复到达', async () => {
  const h = createHarness(), music = await playSong(h), pending = pendingChat(h, '播放晴天');
  const auto = withVoice(episode('自动选歌'));
  h.route('/api/next', response({ ok: true, episode: auto }));
  await h.engine.requestNext();
  h.engine.voice.canplay();
  music.currentTime = music.duration - 8; music.emit('timeupdate'); await flush();
  await h.clock.advance(800);
  assert.equal(h.engine.snapshot().voiceContext, null, '自动口播不能抢走聊天上下文');
  h.route('/api/filler', response({ ok: true, item: song('等待点歌的垫歌') }));
  music.currentTime = music.duration; music.ended = true; music.paused = true; music.emit('ended'); await flush();
  const filler = h.engine.idle;
  assert.equal(filler.src, song('等待点歌的垫歌').url);
  filler.playing(); filler.resolvePlay(); await flush(); await h.clock.advance(700);
  const requested = episode('晴天');
  pending.resolve(response({ ok: true, requestId: pending.requestId, episode: requested })); await pending.done;
  const incoming = h.engine.idle;
  assert.equal(incoming.src, requested.queue[0].url);
  incoming.playing(); incoming.resolvePlay(); await flush();
  assert.equal(h.engine.snapshot().activeEpisode.id, requested.id);
  assert.equal(h.engine.voice.playCalls, 0);
});

test('G3：切到音箱后收藏、不喜欢和聊天nowPlaying都指向音箱当前歌', async t => {
  for (const action of ['favorite', 'dislike', 'chat']) await t.test(action, async () => {
    const h = createHarness(); await playSong(h, '本机旧歌');
    h.route('/api/exclusive/play', response({ ok: true, event: 'playing', token: 'speaker-a', duration: 180 }));
    h.engine.applyOutputResult({ exclusive: true, uid: 'fake-speaker' }); await flush();
    h.route('/api/exclusive/play', response({ ok: true, event: 'playing', token: 'speaker-b', duration: 180 }));
    h.engine.loadEpisode(episode('音箱新歌')); await flush();
    if (action === 'favorite') {
      h.engine.favoriteCurrent();
      assert.equal(JSON.parse(h.calls.findLast(call => call.url === '/api/fav').body).title, '音箱新歌');
    } else if (action === 'dislike') {
      h.engine.dislikeCurrent();
      assert.equal(listeningEvents(h).findLast(event => event.type === 'dislike').song.title, '音箱新歌');
    } else {
      const pending = pendingChat(h, '这首是什么歌');
      assert.equal(JSON.parse(pending.call.body).nowPlaying.title, '音箱新歌');
      pending.resolve(response({ ok: true, requestId: pending.requestId, control: { action: 'none', reply: '收到' } }));
      await pending.done;
    }
  });
});

test('G4：模型控制节目越过暂停门执行一次，只有音频等恢复', async t => {
  for (const via of ['HTTP', 'WS']) for (const action of ['resume', 'volume_up']) await t.test(`${via} / ${action}`, async () => {
    const h = createHarness(), music = await playSong(h);
    h.engine.setMasterVolume(50);
    h.engine.pausePlayback(); await h.clock.advance(300);
    const pending = pendingChat(h, '我回来了，帮我把刚才的音乐继续放起来');
    const ep = { ...withVoice({ ...episode('模型控制'), queue: [] }), intent: 'control', action };
    const data = { ok: true, requestId: pending.requestId, origin: 'chat', episode: ep };
    if (via === 'WS') {
      h.ws({ kind: 'episode', ...data }); await flush();
      assert.equal(h.engine.snapshot().paused, action !== 'resume');
      assert.equal(h.element('vol').value, action === 'volume_up' ? '60' : '50');
    }
    pending.resolve(response(data)); await pending.done;
    h.ws({ kind: 'episode', ...data }); await flush();
    assert.equal(h.engine.snapshot().paused, action !== 'resume');
    assert.equal(h.element('vol').value, action === 'volume_up' ? '60' : '50', 'HTTP/WS重复不能重复动作');
    if (action === 'resume') {
      assert.equal(music.playCalls, 2);
      music.playing(); music.resolvePlay(); await flush();
    } else assert.equal(h.engine.voice.playCalls, 0, '暂停期间不能播放控制回复的音频');
  });
});


test('G1：HTTP解析完成到领取回调之间的nextReady不能重复领取或替换holder', async t => {
  for (const turns of [1, 2, 3]) await t.test(`延迟${turns}个微任务`, async () => {
    const h = createHarness(); await playSong(h);
    const ep = episode('只领取一次');
    h.route('/api/next', { ok: true, status: 200, json: async () => {
      const notify = n => queueMicrotask(() => n ? notify(n - 1) : h.ws({ kind: 'nextReady', epoch: 0 }));
      notify(turns);
      return { ok: true, episode: ep };
    } });
    await h.engine.requestNext(); await flush();
    assert.equal(h.calls.filter(call => call.url.startsWith('/api/next?')).length, 1);
    assert.equal(h.engine.heldClaims.length, 1);
    assert.equal(h.engine.snapshot().pendingEpisode?.episode.id, ep.id);
  });
});

test('G1：已在服务端领取后被停止、换代或epoch取代，迟到响应仍补发释放', async t => {
  for (const reason of ['stop', 'chat', 'epoch', 'scheduled']) await t.test(reason, async () => {
    const h = createHarness(); await playSong(h);
    const pending = deferred(); h.route('/api/next', pending.promise);
    const done = h.engine.requestNext();
    const call = h.calls.findLast(call => call.url.startsWith('/api/next?'));
    const id = new URL(call.url, 'http://localhost').searchParams.get('claimId');
    let chat;
    if (reason === 'stop') h.engine.stopPlayback();
    if (reason === 'chat') chat = pendingChat(h, '换个心情');
    if (reason === 'epoch') h.ws({ kind: 'episodesInvalidated', epoch: 1 });
    if (reason === 'scheduled') h.ws({ kind: 'scheduled', claimId: 'replacement', episode: episode('定时替代'), epoch: 0 });
    const releasedBefore = h.calls.filter(call => call.url === '/api/episode/release').length;
    pending.resolve(response({ ok: true, episode: episode('已被取代的领取') })); await done;
    const releases = h.calls.filter(call => call.url === '/api/episode/release').slice(releasedBefore);
    assert.ok(releases.some(call => JSON.parse(call.body).claimId === id), '回包迟到也必须释放服务端可能已授予的领取');
    if (chat) {
      chat.resolve(response({ ok: true, requestId: chat.requestId, control: { action: 'none', reply: '收到' } })); await chat.done;
    }
  });
});

test('G1：领取超时后复用同一claimId轮询，nextReady撞在途轮询也不停止', async () => {
  const h = createHarness(); await playSong(h);
  h.route('/api/next', call => new Promise((resolve, reject) => {
    call.signal.addEventListener('abort', () => reject(new DOMException('已取消', 'AbortError')), { once: true });
  }));
  const first = h.engine.requestNext();
  h.ws({ kind: 'nextReady', epoch: 0 });
  await h.clock.advance(10000); await first;
  h.route('/api/next', response({ ok: false, busy: true }, 202));
  await h.clock.advance(10000);
  h.route('/api/next', response({ ok: true, episode: episode('超时重领成功') }));
  await h.clock.advance(8000);
  const calls = h.calls.filter(call => call.url.startsWith('/api/next?'));
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map(call => call.url)).size, 1);
  assert.equal(h.engine.snapshot().pendingEpisode?.episode.id, 'episode-超时重领成功');
  assert.equal(h.calls.filter(call => call.url === '/api/episode/release').length, 0, '超时仍在重领时不能释放同一claim');
});

test('G1：空节目或无URL节目都释放，连续失败后仍继续轮询', async () => {
  const h = createHarness(); await playSong(h);
  h.route('/api/next', response({ ok: true, episode: { ...episode('空节目'), queue: [] } }));
  h.route('/api/next', response({ ok: true, episode: { ...episode('无直链'), queue: [{ type: 'song', meta: song().meta }] } }));
  h.route('/api/next', response({ ok: true, episode: episode('第三次可播') }));
  await h.engine.requestNext();
  await h.clock.advance(10000);
  await h.clock.advance(20000);
  assert.equal(h.calls.filter(call => call.url === '/api/episode/release').length, 2);
  assert.equal(h.engine.snapshot().pendingEpisode?.episode.id, 'episode-第三次可播');
});


test('G1：释放请求失败会跨播放换代补发，服务重启后不发旧编号', async t => {
  for (const restart of [false, true]) await t.test(restart ? '服务已重启' : '停止后仍补发', async () => {
    const h = createHarness(); await playSong(h);
    h.route('/api/next', response({ ok: true, episode: { ...episode('释放失败'), epoch: 7 } }));
    await h.engine.requestNext();
    const id = h.engine.snapshot().claimId;
    h.route('/api/episode/release', () => { throw new Error('短暂断线'); });
    h.engine.stopPlayback(); await flush();
    if (restart) h.ws({ kind: 'hello', epoch: 0 });
    await h.clock.advance(1000);
    const releases = h.calls.filter(call => call.url === '/api/episode/release');
    assert.equal(releases.length, restart ? 1 : 2);
    assert.ok(releases.every(call => JSON.parse(call.body).claimId === id));
  });
});


test('G2：失败的口播上下文尚无节目时，不能借用另一份streamPending完成点歌', async () => {
  const h = createHarness(); await playSong(h);
  const pending = pendingChat(h, '播放晴天'), requested = withVoice(episode('晴天'), 'pending');
  pending.resolve(response({ ok: true, requestId: pending.requestId, episode: requested })); await pending.done;
  // 独立检查失败归属：空上下文不能兜底到另一份已返回的节目。
  const loading = h.engine.startSayOverlay('/tts/other-context.mp3', '另一段口播', () => null);
  const ctx = h.engine.snapshot().voiceContext;
  h.engine.failVoice(ctx); await loading; await flush();
  assert.equal(h.engine.snapshot().streamPending.voice.status, 'pending');
  assert.equal(h.engine.idle.playCalls, 0);
  h.ws({ kind: 'sayFailed', origin: 'chat', requestId: pending.requestId }); await flush();
  assert.equal(h.engine.idle.src, requested.queue[0].url);
  h.engine.idle.playing(); h.engine.idle.resolvePlay(); await flush();
  assert.equal(h.engine.snapshot().activeEpisode.id, requested.id);
});

test('多设备接力：被别的设备接走就停；再接回来从服务端进度放，不记跳过、不记重听、不重念口播', async () => {
  const h = createHarness();
  const first = await playSong(h, '接力的歌');
  first.currentTime = 20;
  h.ws({ kind: 'handoff', deviceId: 'phone', deviceName: 'iPhone Safari' });
  assert.equal(h.engine.snapshot().paused, true);
  assert.equal(h.element('nowState').textContent, '正在 iPhone Safari 上播放');
  h.route(call => call.url === '/api/playback' && !call.method, response({ ok: true, state: {
    deviceId: 'phone', deviceName: 'iPhone Safari', playing: true, position: 61,
    song: song('接力的歌'), queue: [song('后面一首')] } }));
  const before = listeningEvents(h).length;
  h.engine.resumePlayback();
  await flush();
  const claim = h.calls.findLast(call => call.url === '/api/playback' && call.method === 'POST' && JSON.parse(call.body).playing);
  assert.ok(claim, '接过来时先占住');
  assert.equal(JSON.parse(claim.body).position, 61);
  const incoming = h.audios.find(audio => audio !== first && audio !== h.engine.voice && audio.plays.length);
  incoming.playing(); incoming.resolvePlay();
  await flush(); await h.clock.advance(700);
  assert.ok(Math.abs(incoming.currentTime - 61) < 0.5, `从 61 秒接着放，实际 ${incoming.currentTime}`);
  assert.deepEqual(Array.from(h.engine.snapshot().queue, item => item.meta.title), ['接力的歌', '后面一首']);
  assert.ok(h.engine.snapshot().queue.every(item => item.type === 'song'));
  const after = listeningEvents(h).slice(before);
  assert.deepEqual(after.filter(event => ['skip', 'replay', 'play_started'].includes(event.type)), []);
});
