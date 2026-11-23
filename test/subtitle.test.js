import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTimeline, progressAtTime, createSubtitleState, advanceSubtitle,
  typewriter, renderStatic,
} from '../web/subtitle.js';

test('known duration maps Unicode code points proportionally and holds punctuation longer', () => {
  const plain = createTimeline('你😀好呀');
  assert.equal(plain.chars.length, 4);
  assert.equal(progressAtTime(plain, 2, 8), 1);
  assert.equal(progressAtTime(plain, 4, 8), 2);
  assert.equal(progressAtTime(plain, 8, 8), 4);
  const punctuated = createTimeline('甲，乙');
  // The comma occupies more audio time than a spoken character.
  assert.ok(progressAtTime(punctuated, 1.5, 3) < 2);
  assert.ok(progressAtTime(punctuated, 1.5, 3) > 1);
  assert.equal(progressAtTime(punctuated, 3, 3), 3);
  assert.ok(progressAtTime(createTimeline('a.b'), 2, 3) < 2);
});

test('Infinity, NaN and absent durations estimate speech without invalid positions', () => {
  const timeline = createTimeline('今天听一首轻松的歌');
  for (const duration of [undefined, Infinity, NaN, 0, -1]) {
    const position = progressAtTime(timeline, 1, duration);
    assert.ok(Number.isFinite(position));
    assert.ok(position > 0 && position < timeline.chars.length);
  }
  assert.equal(progressAtTime(timeline, NaN, 8), 0);
  assert.equal(progressAtTime(createTimeline(''), 3, Infinity), 0);
});

test('late shorter or longer duration preserves position and converges without going backwards', () => {
  for (const duration of [4, 20]) {
    let state = createSubtitleState('甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉');
    state = advanceSubtitle(state, 1, NaN);
    const before = state.progress;
    state = advanceSubtitle(state, 1, duration);
    assert.equal(state.progress, before, 'metadata must not jump to another word');
    state = advanceSubtitle(state, 1.01, duration);
    assert.ok(state.progress >= before);
    assert.ok(state.progress - before < 0.2);
    let previous = state.progress;
    for (let time = 1.1; time <= duration; time += 0.1) {
      state = advanceSubtitle(state, time, duration);
      assert.ok(state.progress >= previous);
      previous = state.progress;
    }
    state = advanceSubtitle(state, duration, duration);
    assert.equal(state.progress, 20);
  }
});

test('paused clocks freeze position and duration correction until resumed', () => {
  let state = createSubtitleState('甲乙丙丁戊己庚辛', 8);
  state = advanceSubtitle(state, 2, 8);
  assert.equal(state.progress, 2);
  const paused = advanceSubtitle(state, 3, 20, true);
  assert.equal(paused.progress, 2);
  state = advanceSubtitle(paused, 2, 20);
  assert.equal(state.progress, 2);
  state = advanceSubtitle(state, 3, 20);
  assert.ok(state.progress > 2);
});

test('unknown duration keeps a final tail beyond the estimate and can correct late metadata', () => {
  const text = '甲乙丙丁戊己庚辛';
  let state = createSubtitleState(text);
  state = advanceSubtitle(state, 5, Infinity);
  assert.ok(state.progress < 8);
  const before = state.progress;
  state = advanceSubtitle(state, 5, 10);
  assert.equal(state.progress, before);
  state = advanceSubtitle(state, 7, 10);
  assert.ok(state.progress >= before && state.progress < 8);
  state = advanceSubtitle(state, 10, 10);
  assert.equal(state.progress, 8);
  assert.ok(progressAtTime(createTimeline(text), 1000, Infinity) < 8);
  assert.ok(progressAtTime(createTimeline(text), 20, Infinity) > progressAtTime(createTimeline(text), 10, Infinity), '尾部继续缓慢显现，不能卡在固定上限');
});

class FakeElement {
  constructor(document) {
    this.ownerDocument = document;
    this.children = [];
    this.style = {};
    this.classes = new Set();
    this.classList = {
      add: (...values) => values.forEach(value => this.classes.add(value)),
      remove: (...values) => values.forEach(value => this.classes.delete(value)),
      contains: value => this.classes.has(value),
    };
    this.value = '';
  }
  set textContent(value) { this.value = String(value); this.children = []; }
  get textContent() { return this.value + this.children.map(child => child.textContent).join(''); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.value = ''; this.children = children; }
}

function harness(t) {
  const oldRequest = globalThis.requestAnimationFrame;
  const oldCancel = globalThis.cancelAnimationFrame;
  const frames = new Map();
  let next = 0;
  globalThis.requestAnimationFrame = fn => { frames.set(++next, fn); return next; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  t.after(() => {
    globalThis.requestAnimationFrame = oldRequest;
    globalThis.cancelAnimationFrame = oldCancel;
  });
  const document = { createElement: () => new FakeElement(document) };
  return {
    box: new FakeElement(document), frames,
    tick() {
      const batch = [...frames.values()];
      frames.clear();
      batch.forEach(fn => fn());
    },
  };
}

test('plain exclusive-style clock drives fading chars, and pause freezes their opacity', t => {
  const { box, tick } = harness(t);
  const clock = { currentTime: 0, duration: 4, paused: false };
  const cancel = typewriter(box, '你😀好呀', clock);
  clock.currentTime = 1.5;
  tick();
  assert.equal(box.textContent, '你😀');
  const tail = box.children[1];
  assert.ok(Number(tail.children[1].style.opacity) > 0);
  assert.ok(Number(tail.children[1].style.opacity) < 1);
  const snapshot = JSON.stringify(tail.children.map(child => child.style.opacity));
  clock.paused = true;
  clock.currentTime = 2;
  tick();
  assert.equal(JSON.stringify(box.children[1].children.map(child => child.style.opacity)), snapshot);
  cancel();
});

test('cancel removes RAF and stale callbacks cannot overwrite static or replacement text', t => {
  const { box, frames, tick } = harness(t);
  const clock = { currentTime: 1, duration: 4, paused: false };
  const cancel = typewriter(box, '旧的字幕', clock);
  const stale = [...frames.values()][0];
  cancel();
  assert.equal(frames.size, 0);
  renderStatic(box, '<不会变成 HTML>😀');
  stale();
  assert.equal(box.textContent, '<不会变成 HTML>😀');
  const cancelReplacement = typewriter(box, '新的字幕', clock);
  cancel();
  clock.currentTime = 2;
  tick();
  assert.equal(box.textContent, '新的');
  cancelReplacement();
  assert.equal(frames.size, 0);
});

test('explicit duration hint and completion remove the animation loop', t => {
  const { box, frames, tick } = harness(t);
  const clock = { currentTime: 0, duration: Infinity, paused: false };
  typewriter(box, '一二三四', clock, { duration: 4 });
  clock.currentTime = 2;
  tick();
  assert.equal(box.textContent, '一二');
  clock.currentTime = 4;
  tick();
  assert.equal(box.textContent, '一二三四');
  assert.equal(frames.size, 0);
  assert.ok(box.classList.contains('subtitle-static'));
});

test('streaming animation stays alive past estimated speech until finite duration arrives', t => {
  const { box, frames, tick } = harness(t);
  const clock = { currentTime: 0, duration: Infinity, paused: false };
  const cancel = typewriter(box, '一二三四五六七八', clock);
  clock.currentTime = 5;
  tick();
  assert.equal(frames.size, 1);
  assert.ok(box.classList.contains('subtitle-typing'));
  clock.duration = 10;
  tick();
  clock.currentTime = 10;
  tick();
  assert.equal(box.textContent, '一二三四五六七八');
  assert.equal(frames.size, 0);
  assert.ok(box.classList.contains('subtitle-static'));
  cancel();
});
