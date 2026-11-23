import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindowMode, createIdleHider, getMode } from '../web/window-mode.js';

class Events {
  handlers = new Map();
  addEventListener(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.handlers.get(type)?.delete(fn); }
  emit(type, values = {}) {
    const event = { preventDefault() { this.defaultPrevented = true; }, ...values };
    this.handlers.get(type)?.forEach((fn) => fn(event));
    return event;
  }
  count() { return [...this.handlers.values()].reduce((sum, items) => sum + items.size, 0); }
}

function fakeDocument() {
  const doc = new Events();
  const classes = new Set();
  doc.body = {
    style: { cursor: 'crosshair' },
    classList: {
      toggle(name, value) { if (value) classes.add(name); else classes.delete(name); },
      add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
  };
  doc.fullscreenElement = null;
  doc.documentElement = {
    async requestFullscreen() { doc.fullscreenElement = this; doc.emit('fullscreenchange'); },
  };
  doc.exitFullscreen = async () => { doc.fullscreenElement = null; doc.emit('fullscreenchange'); };
  return doc;
}

// 等待外部全屏事件的队列处理完毕。
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('import has no browser requirement or singleton side effects', () => {
  assert.equal(getMode(), 'normal');
});

test('browser Fullscreen API and external Escape synchronize mode and classes', async () => {
  const doc = fakeDocument();
  const controller = createWindowMode({ document: doc }).start();
  await controller.toggleFullscreen();
  assert.equal(controller.getMode(), 'fullscreen');
  await doc.exitFullscreen();
  await settle();
  assert.equal(controller.getMode(), 'normal');
  assert.equal(doc.body.classList.contains('fullscreen'), false);
  await controller.toggleFullscreen();
  await controller.dispose();
  assert.equal(doc.fullscreenElement, null);
  assert.equal(doc.count(), 0);
});

test('browser without page fullscreen (iPhone Safari) or a rejected request still enters immersive mode in-page', async () => {
  const doc = fakeDocument();
  const controller = createWindowMode({ document: doc }).start();
  const request = doc.documentElement.requestFullscreen;
  doc.documentElement.requestFullscreen = async () => { throw new Error('user gesture required'); };
  assert.equal(await controller.toggleFullscreen(), 'fullscreen');
  assert.equal(doc.body.classList.contains('fullscreen'), true);
  assert.equal(doc.fullscreenElement, null);
  doc.emit('keydown', { key: 'Escape', preventDefault() {} }); await new Promise((r) => setTimeout(r, 0));
  assert.equal(controller.getMode(), 'normal');
  doc.documentElement.requestFullscreen = undefined;
  assert.equal(await controller.toggleFullscreen(), 'fullscreen');
  assert.equal(await controller.toggleFullscreen(), 'normal');
  doc.documentElement.requestFullscreen = request;
  await controller.dispose();
});

test('F/Escape shortcuts ignore editable targets, IME, menus and modifiers', async () => {
  const doc = fakeDocument();
  let menu = false;
  const controller = createWindowMode({ document: doc, isInteractionActive: () => menu }).start();
  for (const fields of [
    { target: { isContentEditable: true } }, { target: { closest: () => ({}) } },
    { isComposing: true }, { keyCode: 229 }, { repeat: true }, { metaKey: true },
  ]) {
    assert.equal(doc.emit('keydown', { key: 'f', ...fields }).defaultPrevented, undefined);
  }
  menu = true;
  doc.emit('keydown', { key: 'f' });
  menu = false;
  doc.emit('compositionstart');
  doc.emit('keydown', { key: 'f' });
  doc.emit('compositionend');
  await settle();
  assert.equal(controller.getMode(), 'normal');
  assert.equal(doc.emit('keydown', { key: 'F' }).defaultPrevented, true);
  await settle();
  assert.equal(controller.getMode(), 'fullscreen');
  doc.activeElement = { isContentEditable: true };
  doc.emit('keydown', { key: 'Escape' });
  await settle();
  assert.equal(controller.getMode(), 'fullscreen');
  doc.activeElement = null;
  doc.emit('keydown', { key: 'Escape' });
  await settle();
  assert.equal(controller.getMode(), 'normal');
  await controller.dispose();
});

test('dispose waits for a queued transition, exits fullscreen and rejects new calls', async () => {
  const doc = fakeDocument();
  const controller = createWindowMode({ document: doc }).start();
  const entering = controller.toggleFullscreen();
  const disposing = controller.dispose();
  assert.equal(await entering, 'fullscreen');
  await disposing;
  assert.equal(controller.getMode(), 'normal');
  assert.equal(doc.fullscreenElement, null);
  await assert.rejects(controller.toggleFullscreen(), /已销毁/);
});

test('idle only hides fullscreen controls/cursor, blocks input/IME/menu and disposes', async () => {
  const doc = fakeDocument();
  const controller = createWindowMode({ document: doc });
  const timers = new Map();
  let next = 0;
  let scheduledDelay;
  let menu = false;
  const idle = createIdleHider({
    document: doc, controller,
    setTimeout(fn, delay) { scheduledDelay = delay; timers.set(++next, fn); return next; },
    clearTimeout(id) { timers.delete(id); },
    isInteractionActive: () => menu,
  });
  const tick = () => {
    const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((fn) => fn());
  };
  assert.equal(timers.size, 0);
  await controller.toggleFullscreen();
  assert.equal(scheduledDelay, 3000);
  tick();
  assert.equal(doc.body.classList.contains('controls-hidden'), true);
  assert.equal(doc.body.style.cursor, 'none');
  doc.emit('mousemove');
  assert.equal(doc.body.style.cursor, 'crosshair');
  doc.activeElement = { isContentEditable: true };
  tick();
  assert.equal(doc.body.classList.contains('controls-hidden'), false);
  doc.activeElement = null;
  doc.emit('compositionstart'); tick();
  assert.equal(doc.body.classList.contains('controls-hidden'), false);
  doc.emit('compositionend');
  menu = true; tick();
  assert.equal(doc.body.classList.contains('controls-hidden'), false);
  menu = false; tick();
  assert.equal(doc.body.classList.contains('controls-hidden'), true);
  await controller.toggleFullscreen();
  assert.equal(doc.body.classList.contains('controls-hidden'), false);
  assert.equal(doc.body.style.cursor, 'crosshair');
  idle.dispose();
  assert.equal(timers.size, 0);
  assert.equal(doc.count(), 0);
  await controller.dispose();
});
