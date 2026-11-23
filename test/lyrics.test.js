import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLrc, createLyricView, startLyricClock, LYRIC_LEAD } from '../web/lyrics.js';

test('LRC 多时间戳排序，小数精度及正负 offset 对整个文件生效', () => {
  assert.deepEqual(parseLrc('[00:20.12][00:05.003]重复\n[00:10:5]中间\n[offset:+250]'), [
    { t: 4.753, text: '重复' }, { t: 10.25, text: '中间' }, { t: 19.87, text: '重复' },
  ]);
  assert.deepEqual(parseLrc('[offset:-500]\n[00:00]开头'), [{ t: 0.5, text: '开头' }]);
  assert.equal(parseLrc('[offset:1000]\n[00:00]提前')[0].t, -1);
});

test('过滤制作署名、版权和元数据；保留正文及无时间轴静态回退', () => {
  const names = ['作词', '作曲', '编曲', '制作人', '监制', '混音', '母带', '录音', '和声', '吉他', '贝斯', '鼓', '弦乐', '出品', '发行', '封面设计', '企划', '统筹', 'OP', 'SP', '作词 / 作曲', '钢琴'];
  const english = ['Lyrics by', 'Composed by', 'Produced by', 'Arranged by', 'Mixed by', 'Mastered by'];
  assert.equal(parseLrc([...names.map((s) => `[00:00]${s}：某人`), ...english.map((s) => `${s} Somebody`), '[ti:歌名]', '未经著作权人许可不得翻唱'].join('\n')), null);
  assert.deepEqual(parseLrc('我为你作词\n第二行'), [{ t: null, text: '我为你作词' }, { t: null, text: '第二行' }]);
  assert.deepEqual(parseLrc('非同步说明\n[00:01]正文'), [{ t: 1, text: '正文' }]);
  assert.equal(parseLrc(''), null);
});

function fakeDocument() {
  const events = new EventTarget();
  const doc = Object.assign(events, { visibilityState: 'visible' });
  doc.defaultView = new EventTarget();
  doc.createElement = () => {
    const classes = new Set();
    return {
      ownerDocument: doc, dataset: {}, style: {}, children: [], clientHeight: 300, offsetHeight: 40, offsetTop: 0,
      classList: { add: (...names) => names.forEach((s) => classes.add(s)), toggle: (s, on) => on ? classes.add(s) : classes.delete(s), contains: (s) => classes.has(s) },
      replaceChildren(...nodes) { this.children = nodes; nodes.forEach((node, i) => { node.offsetTop = i * 40; }); },
    };
  };
  return doc;
}

test('歌词 view 用 class 调整距离，支持 seek、隐藏恢复、重新绑定和静态歌词', () => {
  const doc = fakeDocument(), host = doc.createElement('div'), changes = [];
  const view = createLyricView(host, { onLine: (...args) => changes.push(args) });
  view.render(parseLrc('[00:01]一\n[00:02]二\n[00:03]三\n[00:04]四'));
  assert.equal(view.setTime(2.5), 1);
  const inner = host.children[0];
  assert.equal(inner.children[1].classList.contains('active'), true);
  assert.equal(inner.children[0].classList.contains('near'), true);
  assert.equal(inner.children[3].classList.contains('far'), true);
  assert.equal(inner.children[1].style.opacity, undefined);
  assert.equal(inner.style.transform, 'translate3d(0, 90px, 0)');
  host.clientHeight = 0;
  view.setTime(4);
  host.clientHeight = 400;
  view.recenter();
  assert.equal(inner.style.transform, 'translate3d(0, 60px, 0)');
  assert.equal(view.setTime(0), -1);
  assert.deepEqual(changes.at(-1), [-1, '']);
  view.render(parseLrc('纯音乐文字'));
  assert.equal(host.classList.contains('lyric-static'), true);
  assert.equal(view.setTime(100), -1);
  view.clear();
  assert.equal(inner.children[0].textContent, '暂无歌词');
  view.destroy();
  assert.equal(view.setTime(10), -1);
  const next = createLyricView(doc.createElement('div'));
  next.render(parseLrc('[00:00]新容器'));
  assert.equal(next.setTime(1), 0);
  next.destroy();
});

test('歌词时钟只在可见且播放时调度，refresh 和 visibility 可唤醒，stop 清理', () => {
  const doc = fakeDocument(), frames = new Map(), ticks = [];
  let sequence = 0, active = false;
  const clock = startLyricClock({ document: doc, getTime: () => 3, isActive: () => active, onTick: (t) => ticks.push(t),
    requestFrame: (cb) => { frames.set(++sequence, cb); return sequence; }, cancelFrame: (id) => frames.delete(id) });
  assert.equal(frames.size, 0);
  active = true; clock.refresh();
  const step = () => { const [id, cb] = frames.entries().next().value; frames.delete(id); cb(); };
  step(); assert.deepEqual(ticks, [3 + LYRIC_LEAD]);
  doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(frames.size, 0);
  doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(frames.size, 1);
  active = false; step(); assert.equal(frames.size, 0);
  active = true; clock.refresh(); clock.stop();
  assert.equal(frames.size, 0);
  doc.dispatchEvent(new Event('visibilitychange')); assert.equal(frames.size, 0);
});
