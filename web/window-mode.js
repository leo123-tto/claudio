/**
 * Window presentation only; this module never owns playback.
 *
 * toggleFullscreen() returns a Promise of normal | fullscreen.
 * getMode() is synchronous; onModeChange(fn) returns an unsubscribe function.
 * startWindowMode(options) starts the lazy default controller and returns it.
 * createWindowMode(options) creates an isolated, injectable controller: call
 * start() for shortcuts/external fullscreen events, dispose() to remove listeners.
 * Fullscreen uses the Fullscreen API when allowed; otherwise (iPhone Safari,
 * rejected request) the mode still switches and CSS fills the page instead.
 * createIdleHider({ controller, root, delay, isInteractionActive }) starts an idle
 * timer and returns { reveal, refresh, dispose }. It defaults to the singleton.
 */

function isEditing(target) {
  return Boolean(target?.isContentEditable
    || target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
}

// iPhone Safari 只给视频全屏、或浏览器拒绝（比如不是点出来的）时，不报错：照样进沉浸模式，只是在页面里铺满。
async function requestPageFullscreen(doc) {
  const root = doc?.documentElement;
  const request = root?.requestFullscreen || root?.webkitRequestFullscreen;
  if (!request) return false;
  try { await request.call(root); return true; } catch { return false; }
}

export function createWindowMode(options = {}) {
  const win = options.window ?? globalThis.window;
  const doc = options.document ?? win?.document;
  const listeners = new Set();
  const cleanups = [];
  let mode = 'normal';
  let pending = Promise.resolve();
  let started = false;
  let disposed = false;
  let composing = false;

  function publish(next) {
    const changed = mode !== next;
    mode = next;
    doc?.body?.classList.toggle('fullscreen', next === 'fullscreen');
    if (changed) for (const fn of listeners) {
      try { fn(next); } catch (error) { report(error); }
    }
    return next;
  }

  async function transition(target) {
    if (target === mode) return mode;
    if (doc?.fullscreenElement && target !== 'fullscreen') await doc.exitFullscreen();
    if (target === 'fullscreen' && !doc?.fullscreenElement) await requestPageFullscreen(doc);
    return publish(target);
  }

  function enqueue(action) {
    if (disposed) return Promise.reject(new Error('窗口控制器已销毁'));
    const result = pending.then(action);
    pending = result.catch(() => {});
    return result;
  }

  function report(error) {
    // 外部回调出错不能打断后续切换。
    try { options.onError?.(error); } catch { /* 忽略错误上报自身的异常。 */ }
  }
  function addEvent(target, type, fn) {
    target?.addEventListener(type, fn);
    cleanups.push(() => target?.removeEventListener(type, fn));
  }

  function start() {
    if (started || disposed) return api;
    started = true;
    addEvent(doc, 'compositionstart', () => { composing = true; });
    addEvent(doc, 'compositionend', () => { composing = false; });
    addEvent(doc, 'keydown', (event) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || composing || event.keyCode === 229
        || event.ctrlKey || event.altKey || event.metaKey || isEditing(event.target)
        || isEditing(doc?.activeElement) || options.isInteractionActive?.()) return;
      if (event.key?.toLowerCase() === 'f') {
        event.preventDefault();
        api.toggleFullscreen().catch(report);
      } else if (event.key === 'Escape' && mode !== 'normal') {
        event.preventDefault();
        enqueue(() => transition('normal')).catch(report);
      }
    });
    addEvent(doc, 'fullscreenchange', () => {
      enqueue(() => {
        if (mode === 'fullscreen' && !doc.fullscreenElement) return publish('normal');
        if (doc.fullscreenElement && mode !== 'fullscreen') return publish('fullscreen');
        return mode;
      }).catch(report);
    });
    return api;
  }

  const api = {
    start,
    getMode: () => mode,
    toggleFullscreen: () => enqueue(() => transition(mode === 'fullscreen' ? 'normal' : 'fullscreen')),
    onModeChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    dispose() {
      if (disposed) return pending;
      disposed = true;
      cleanups.splice(0).forEach((fn) => fn());
      const result = pending.then(async () => {
        if (mode !== 'normal') await transition('normal');
        listeners.clear();
      });
      pending = result.catch(() => {});
      return result;
    },
  };
  return api;
}

let singleton;
export function startWindowMode(options) {
  if (!singleton) singleton = createWindowMode(options);
  return singleton.start();
}
export const toggleFullscreen = () => startWindowMode().toggleFullscreen();
export const getMode = () => singleton?.getMode() ?? 'normal';
export const onModeChange = (fn) => startWindowMode().onModeChange(fn);

export function createIdleHider(options = {}) {
  const win = options.window ?? globalThis.window;
  const doc = options.document ?? win?.document;
  const root = options.root ?? doc?.body;
  const controller = options.controller ?? startWindowMode();
  const setTimer = options.setTimeout ?? globalThis.setTimeout;
  const clearTimer = options.clearTimeout ?? globalThis.clearTimeout;
  const delay = options.delay ?? 3000;
  const events = [];
  let timer;
  let disposed = false;
  let composing = false;
  let hidden = false;
  let cursor;
  function reveal() {
    if (hidden && root?.style) root.style.cursor = cursor;
    hidden = false;
    root?.classList.remove('controls-hidden');
  }
  const blocked = () => composing || isEditing(doc?.activeElement) || options.isInteractionActive?.();
  function refresh() {
    clearTimer(timer);
    reveal();
    if (disposed || controller.getMode() !== 'fullscreen') return;
    timer = setTimer(() => {
      if (disposed || controller.getMode() !== 'fullscreen') return;
      if (blocked()) { refresh(); return; }
      cursor = root?.style?.cursor ?? '';
      hidden = true;
      root?.classList.add('controls-hidden');
      if (root?.style) root.style.cursor = 'none';
    }, delay);
  }
  function listen(type, fn) {
    doc?.addEventListener(type, fn);
    events.push(() => doc?.removeEventListener(type, fn));
  }
  for (const type of ['mousemove', 'pointermove', 'pointerdown', 'keydown', 'focusin', 'focusout']) listen(type, refresh);
  listen('compositionstart', () => { composing = true; refresh(); });
  listen('compositionend', () => { composing = false; refresh(); });
  const unsubscribe = controller.onModeChange(refresh);
  refresh();
  return {
    reveal: refresh,
    refresh,
    dispose() {
      disposed = true;
      clearTimer(timer);
      events.forEach((fn) => fn());
      unsubscribe();
      reveal();
    },
  };
}
