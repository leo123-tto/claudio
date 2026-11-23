/**
 * parseLrc(text) → [{ t: seconds|null, text }] | null；正 offset 让歌词提前。
 * createLyricView(host, { onLine }?) → render / setTime / recenter / clear / destroy。
 * setTime 返回当前行号（未开始、静态歌词为 -1）；host 重建后销毁旧 view，再绑定新 host。
 * startLyricClock({ getTime, isActive, onTick }) → { refresh, stop }。
 * 播放/暂停/换歌后调用 refresh；隐藏或暂停时不保留 RAF，回到前台自动恢复。
 */
export const LYRIC_LEAD = 0.25;

const creditWord = '(?:作词|作曲|词曲|填词|编曲|制作人?|制作统筹|监制|混音|母带|录音|和声|吉他|贝斯|鼓|弦乐|钢琴|键盘|乐器|配唱|出品|发行|封面|企划|统筹|音乐总监|音乐制作|录制|OP|SP)(?:\\s*[（(][^）)]*[）)])?(?:设计|指导|工程师|工作室|公司|人|师|团队|总监|制作)?';
const credits = new RegExp(`^(?:${creditWord}(?:\\s*[/、&＆]\\s*${creditWord})*\\s*[:：]|(?:lyrics|composed|produced|arranged|mixed|mastered)\\s+by\\b|未经著作权人许可)`, 'i');

export function parseLrc(text) {
  if (!text) return null;
  const source = String(text);
  const offsets = [...source.matchAll(/\[offset\s*:\s*([+-]?\d+)\s*\]/gi)];
  const offset = offsets.length ? Number(offsets.at(-1)[1]) / 1000 : 0;
  const timed = [], untimed = [];
  for (const line of source.split(/\r?\n/)) {
    const body = line.replace(/\[[^\]]*\]/g, '').trim();
    if (!body || credits.test(body)) continue;
    const stamps = [...line.matchAll(/\[(\d+):([0-5]?\d)(?:[.:](\d+))?\]/g)];
    if (!stamps.length) { untimed.push({ t: null, text: body }); continue; }
    for (const stamp of stamps) {
      timed.push({ t: Number(stamp[1]) * 60 + Number(stamp[2]) + Number(`0.${stamp[3] || 0}`) - offset, text: body });
    }
  }
  // 混合文件只播放带时间的正文；无时间轴时才展示静态正文。
  return timed.length ? timed.sort((a, b) => a.t - b.t) : untimed.length ? untimed : null;
}

export function createLyricView(container, { onLine } = {}) {
  if (!container) throw new TypeError('需要歌词容器');
  const doc = container.ownerDocument;
  let lines = [], nodes = [], current = -1, lastTime = 0, destroyed = false;
  const inner = doc.createElement('div');
  inner.className = 'lyric-inner';
  container.classList.add('lyric-view');
  container.replaceChildren(inner);

  function center(instant = false) {
    if (destroyed || !container.clientHeight) return;
    const node = nodes[Math.max(current, 0)];
    if (!node) return;
    inner.style.transitionDuration = instant ? '0ms' : '600ms';
    inner.style.transform = `translate3d(0, ${container.clientHeight / 2 - node.offsetTop - node.offsetHeight / 2}px, 0)`;
    if (instant) {
      // 确认瞬移已提交，下次逐行切换仍有缓动。
      void inner.offsetHeight;
      inner.style.transitionDuration = '';
    }
  }

  function setTime(t) {
    if (destroyed) return -1;
    lastTime = Number.isFinite(t) ? t : 0;
    let next = -1;
    // render 接收 parseLrc 的有序结果；二分查找也能处理同时间的多行。
    let lo = 0, hi = lines.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (lines[mid].t != null && lines[mid].t <= lastTime) { next = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (next !== current) {
      current = next;
      nodes.forEach((node, i) => {
        const distance = current < 0 ? 4 : Math.abs(i - current);
        node.classList.toggle('active', i === current);
        node.classList.toggle('near', distance === 1);
        node.classList.toggle('far', distance === 2);
      });
      center();
      onLine?.(current, lines[current]?.text || '');
    }
    return current;
  }

  function render(value) {
    if (destroyed) return;
    lines = Array.isArray(value) ? value : [];
    current = -1;
    nodes = lines.map((line, i) => {
      const node = doc.createElement('div');
      node.className = 'lyric-line';
      node.dataset.lyric = i;
      node.textContent = line.text;
      return node;
    });
    container.classList.toggle('lyric-static', lines.length > 0 && lines.every((line) => line.t == null));
    inner.replaceChildren(...nodes);
    if (!nodes.length) {
      const empty = doc.createElement('div');
      empty.className = 'lyric-empty';
      empty.textContent = '暂无歌词';
      inner.replaceChildren(empty);
      inner.style.transform = '';
    } else { setTime(lastTime); recenter(); }
  }

  function recenter() { center(true); }
  function clear() { render(null); }
  const Observer = doc.defaultView?.ResizeObserver;
  const observer = Observer ? new Observer(recenter) : null;
  observer?.observe(container);
  doc.defaultView?.addEventListener('resize', recenter);
  function destroy() {
    destroyed = true;
    observer?.disconnect();
    doc.defaultView?.removeEventListener('resize', recenter);
  }
  return { render, setTime, recenter, clear, destroy };
}

export function startLyricClock({ getTime, isActive, onTick, document: doc = globalThis.document,
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis), cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis) }) {
  let frame = null, stopped = false;
  const running = () => !stopped && doc?.visibilityState === 'visible' && isActive();
  function tick() {
    frame = null;
    if (!running()) return;
    const t = Number(getTime());
    onTick((Number.isFinite(t) ? t : 0) + LYRIC_LEAD);
    if (running()) frame = requestFrame(tick);
  }
  function refresh() {
    if (frame != null && !running()) { cancelFrame(frame); frame = null; }
    if (frame == null && running() && requestFrame) frame = requestFrame(tick);
  }
  function stop() {
    stopped = true;
    if (frame != null) cancelFrame(frame);
    frame = null;
    doc?.removeEventListener('visibilitychange', refresh);
  }
  doc?.addEventListener('visibilitychange', refresh);
  refresh();
  return { refresh, stop };
}
