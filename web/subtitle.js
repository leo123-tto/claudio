/**
 * typewriter(box, text, clock, { duration } = {}) -> cancel()
 * renderStatic(box, text)
 *
 * clock only needs currentTime (seconds), duration and paused; it may be a plain
 * exclusive-output clock. No media events or wall-clock timers are required.
 * A finite duration hint is used until the clock supplies its own duration.
 * Each box owns one animation; replacing it or rendering static text cancels it.
 */

const SPEECH_RATE = 4.2; // 时长未知时，每秒估计的字符权重
const animations = new WeakMap();
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finiteDuration = value => Number.isFinite(value) && value > 0;
const audioTime = value => Number.isFinite(value) ? Math.max(0, value) : 0;

function characterWeight(char) {
  if (/[。.!！？?；;…]/u.test(char)) return 3;
  if (/[，、,:：]/u.test(char)) return 2;
  if (/\s/u.test(char)) return 0.3;
  return 1;
}

/** 按 Unicode 码点拆字，标点占更长的停顿。 */
export function createTimeline(text) {
  const chars = Array.from(String(text ?? ''));
  const boundaries = [0];
  for (const char of chars) boundaries.push(boundaries.at(-1) + characterWeight(char));
  return { chars, boundaries, total: boundaries.at(-1) };
}

function progressForWeight(timeline, weight) {
  const { chars, boundaries, total } = timeline;
  if (weight >= total) return chars.length;
  if (weight <= 0) return 0;
  let low = 0;
  let high = chars.length;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (boundaries[mid] <= weight) low = mid;
    else high = mid;
  }
  return low + (weight - boundaries[low]) / (boundaries[low + 1] - boundaries[low]);
}

function sampleUnknown(time, total) {
  if (total <= 0) return { weight: 0, speed: 0 };
  const estimated = time * SPEECH_RATE;
  const knee = total * 0.75;
  if (estimated <= knee) return { weight: estimated, speed: SPEECH_RATE };
  const remaining = total - knee;
  const decay = 1 / (1 + (estimated - knee) / remaining);
  // 未知总长时逐渐放慢，保留尾字，继续等流式音频的时长。
  const limit = total - Number.EPSILON * Math.max(1, total);
  const weight = Math.min(limit, total - remaining * decay);
  return { weight, speed: weight >= limit ? 0 : SPEECH_RATE * decay ** 2 };
}

/** 纯映射：已知时长按比例，未知时长按语速估算并保留尾部。 */
export function progressAtTime(timeline, currentTime, duration) {
  const time = audioTime(currentTime);
  const weight = finiteDuration(duration)
    ? timeline.total * clamp(time / duration, 0, 1)
    : sampleUnknown(time, timeline.total).weight;
  return progressForWeight(timeline, weight);
}

export function createSubtitleState(text, duration) {
  const timeline = createTimeline(text);
  const knownDuration = finiteDuration(duration) ? duration : null;
  const endTime = knownDuration ?? timeline.total / SPEECH_RATE;
  return {
    timeline, knownDuration, progress: 0, weight: 0,
    segment: { startTime: 0, startWeight: 0, endTime, slope: 1 },
  };
}

// 单调 Hermite 曲线：斜率为 1 时按比例，时长晚到时平滑接上。
function sampleSegment(segment, time, total) {
  const span = segment.endTime - segment.startTime;
  const remaining = total - segment.startWeight;
  if (span <= 0 || remaining <= 0) return { weight: total, speed: 0 };
  const u = clamp((time - segment.startTime) / span, 0, 1);
  const slope = segment.slope;
  const fraction = (slope - 1) * u ** 3 + (2 - 2 * slope) * u ** 2 + slope * u;
  const derivative = 3 * (slope - 1) * u ** 2 + 2 * (2 - 2 * slope) * u + slope;
  return {
    weight: segment.startWeight + remaining * fraction,
    speed: remaining * derivative / span,
  };
}

/** 纯状态推进：时长更新不倒退、不突然多显字。 */
export function advanceSubtitle(state, currentTime, duration, paused = false) {
  if (paused) return state;
  const time = audioTime(currentTime);
  let segment = state.segment;
  const sample = state.knownDuration === null
    ? sampleUnknown(time, state.timeline.total)
    : sampleSegment(segment, time, state.timeline.total);
  let weight = Math.max(state.weight, sample.weight);
  let knownDuration = state.knownDuration;
  if (finiteDuration(duration) && duration !== knownDuration) {
    knownDuration = duration;
    const remaining = state.timeline.total - weight;
    // 时长晚于终点才到时，剩余字仍随播放时间淡入，不靠墙钟抢跑。
    const endTime = Math.max(duration, time + 0.3);
    segment = {
      startTime: time, startWeight: weight, endTime,
      slope: remaining > 0 ? clamp(sample.speed * (endTime - time) / remaining, 0, 3) : 1,
    };
  }
  weight = clamp(weight, 0, state.timeline.total);
  return {
    ...state, segment, knownDuration, weight,
    progress: progressForWeight(state.timeline, weight),
  };
}

function makeSpan(box, className, text = '') {
  const span = box.ownerDocument.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

export function renderStatic(box, text) {
  if (!box) return;
  animations.get(box)?.();
  box.classList.remove('subtitle-typing');
  box.classList.add('subtitle-static');
  box.replaceChildren(makeSpan(box, 'subtitle-text', String(text ?? '')));
}

export function typewriter(box, text, clock, { duration } = {}) {
  if (!box) return () => {};
  animations.get(box)?.();
  const source = String(text ?? '');
  const readDuration = () => finiteDuration(clock?.duration) ? clock.duration : duration;
  let state = createSubtitleState(source, readDuration());
  let frame = null;
  let cancelled = false;
  let tailStart = -1;
  let tailEnd = -1;
  const prefix = makeSpan(box, 'subtitle-text');
  const tail = makeSpan(box, 'subtitle-tail');
  box.replaceChildren(prefix, tail);
  box.classList.remove('subtitle-static');
  box.classList.add('subtitle-typing');

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    if (animations.get(box) === cancel) {
      animations.delete(box);
      box.classList.remove('subtitle-typing');
    }
  };
  animations.set(box, cancel);

  function draw() {
    const { chars } = state.timeline;
    const start = Math.max(0, Math.floor(state.progress) - 2);
    const end = Math.min(chars.length, Math.ceil(state.progress));
    if (start !== tailStart || end !== tailEnd) {
      prefix.textContent = chars.slice(0, start).join('');
      tail.replaceChildren(...chars.slice(start, end).map(char => makeSpan(box, 'subtitle-char', char)));
      tailStart = start;
      tailEnd = end;
    }
    Array.from(tail.children).forEach((char, index) => {
      const position = start + index;
      char.style.opacity = String(clamp((state.progress - position) / Math.min(3, chars.length - position), 0, 1));
    });
  }

  const tick = () => {
    if (cancelled) return;
    frame = null;
    state = advanceSubtitle(state, clock?.currentTime, readDuration(), Boolean(clock?.paused));
    draw();
    if (state.progress >= state.timeline.chars.length) {
      renderStatic(box, source);
      return;
    }
    frame = requestAnimationFrame(tick);
  };
  // 首次安装显示当前播放位置，后续暂停帧保持不动。
  state = advanceSubtitle(state, clock?.currentTime, readDuration());
  draw();
  if (state.progress >= state.timeline.chars.length) renderStatic(box, source);
  else frame = requestAnimationFrame(tick);
  return cancel;
}
