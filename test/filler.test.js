import test from 'node:test';
import assert from 'node:assert/strict';
import { fillerCandidates, createFillerService } from '../server/filler.js';
import { styleConstraints } from '../server/style-request.js';
const song=(id)=>({id,title:`歌${id}`,artist:'歌手',url:`https://m.126.net/${id}`,playable:true});
test('filler排除last30、禁播、current/buffer/claim、caller且优先cache',()=>{
  const result=fillerCandidates({favorites:[1,2,3,4,5,6].map(song),played:[song(1)],banned:[song(2)],held:[song(3)],exclude:['4'],cached:id=>id===6});
  assert.deepEqual(result.map(s=>s.id),[6,5]);
});
test('filler不用大脑或语音，只保护prepared，重复取排除caller',async()=>{
  let cached=[];const service=createFillerService({candidates:()=>[song(1),song(2)],resolve:async s=>s,cache:{has:id=>id===2,ensure:async s=>cached.push(s.id)}});
  const item=await service.take();assert.equal(item.meta.id,2);assert.equal(item.meta.discoveryType,'filler');assert.equal(item.url,'/media/2');assert.deepEqual(service.pins(),[2]);
  assert.equal((await service.take(['2'])).meta.id,1);assert.deepEqual(service.pins(),[1]);assert.deepEqual([...new Set(cached)],[1,2]);service.invalidate();
});
test('filler六秒预算主动取消，失效后旧结果不回写',async()=>{
  let inner;const service=createFillerService({timeout:10,candidates:()=>[{title:'挂起',artist:'甲'}],resolve:(_,opts)=>{inner=opts.signal;return new Promise(()=>{});},cache:{has:()=>false,ensure:()=>assert.fail()}});
  assert.equal(await service.take(),null);assert.equal(inner.aborted,true);service.invalidate();
});
test('等待垫歌期间新buffer占用该歌时重新排除',async()=>{
  let done;let available=[{title:'甲',artist:'乙'}];
  const service=createFillerService({candidates:()=>available,resolve:()=>new Promise(resolve=>{done=resolve;}),cache:{has:()=>false,ensure:async()=>{}}});
  const work=service.take();available=[];done({...song(1),title:'甲',artist:'乙'});assert.equal(await work,null);service.invalidate();
});
test('最近30首按歌曲去重，不被started/completed成对事件挤成15首',()=>{
  const played=Array.from({length:30},(_,i)=>[song(i+1),song(i+1)]).flat();
  const result=fillerCandidates({favorites:[song(1),song(30),song(31)],played});assert.deepEqual(result.map(s=>s.id),[31]);
});

test('前八首不可播时，在同一预算内继续找到第九首', async (t) => {
  const service = createFillerService({
    candidates: () => Array.from({ length: 9 }, (_, i) => ({ id: i + 1, title: `歌${i + 1}`, artist: '歌手' })),
    resolve: async (candidate) => candidate.id === 9 ? song(9) : { ...candidate, playable: false },
    cache: { has: () => false, ensure: async () => {} },
  });
  t.after(() => service.invalidate());
  assert.equal((await service.take())?.meta.id, 9);
});

test('整批被限流时一轮最多解析八首，下一轮继续后续候选', async (t) => {
  const resolved = [];
  const service = createFillerService({
    candidates: () => Array.from({ length: 20 }, (_, i) => song(i + 1)),
    resolve: async (candidate) => {
      resolved.push(candidate.id);
      return { ...candidate, playable: false, rateLimited: true };
    },
    cache: { has: () => false, ensure: () => assert.fail('不可播的歌不下载') },
  });
  t.after(() => service.invalidate());
  assert.equal(await service.take(), null);
  assert.deepEqual(resolved, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(await service.take(), null);
  assert.deepEqual(resolved, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
});

test('首批部分可播时继续解析，仍补齐八首reserve', async (t) => {
  const resolved = [];
  const downloaded = new Set();
  const service = createFillerService({
    candidates: () => Array.from({ length: 20 }, (_, i) => song(i + 1)),
    resolve: async (candidate) => {
      resolved.push(candidate.id);
      return candidate.id <= 8 && candidate.id % 2 === 0 ? { ...candidate, playable: false } : candidate;
    },
    cache: { has: (id) => downloaded.has(id), ensure: async (candidate) => downloaded.add(candidate.id) },
  });
  t.after(() => service.invalidate());
  await service.fill();
  assert.deepEqual(resolved, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual([...downloaded], [1, 3, 5, 7, 9, 10, 11, 12]);
  await service.fill();
  assert.equal(resolved.length, 12);
});

test('前八首耗尽预算后，下一轮从第九首继续', async (t) => {
  const service = createFillerService({
    timeout: 10,
    candidates: () => Array.from({ length: 9 }, (_, i) => ({ id: i + 1, title: `歌${i + 1}`, artist: '歌手' })),
    resolve: async (candidate) => candidate.id === 9 ? song(9) : new Promise(() => {}),
    cache: { has: () => false, ensure: async () => {} },
  });
  t.after(() => service.invalidate());
  // 假时钟：只有计时器到点时时间才走到它的到期时刻，慢机器卡顿不会提前吃掉第二轮的预算
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  let clock = realNow();
  Date.now = () => clock;
  globalThis.setTimeout = (fn, delay = 0, ...args) => {
    const due = clock + delay;
    return realSetTimeout(() => { clock = Math.max(clock, due); fn(...args); }, delay);
  };
  t.after(() => { Date.now = realNow; globalThis.setTimeout = realSetTimeout; });
  assert.equal(await service.take(), null);
  assert.equal((await service.take())?.meta.id, 9);
});

test('候选带旧URL但未完整缓存时，刷新后才返回', async (t) => {
  const service = createFillerService({
    candidates: () => [song(1)],
    resolve: async (candidate) => ({ ...candidate, url: 'https://m.126.net/fresh-1' }),
    cache: { has: () => false, ensure: async () => {} },
  });
  t.after(() => service.invalidate());
  assert.equal((await service.take())?.url, 'https://m.126.net/fresh-1');
});

test('未完成缓存的reserve再次取出前也要刷新URL', async (t) => {
  let revision = 0;
  const service = createFillerService({
    candidates: () => [{ id: 1, title: '歌1', artist: '歌手' }],
    resolve: async () => ({ ...song(1), url: `https://m.126.net/fresh-${++revision}` }),
    cache: { has: () => false, ensure: async () => {} },
  });
  t.after(() => service.invalidate());
  assert.equal((await service.take())?.url, 'https://m.126.net/fresh-1');
  assert.equal((await service.take())?.url, 'https://m.126.net/fresh-2');
});

test('完整本地缓存即使没有远端URL也能直接取出', async (t) => {
  const service = createFillerService({
    candidates: () => [{ id: 1, title: '歌1', artist: '歌手' }],
    resolve: () => assert.fail('完整缓存不用解析'),
    cache: { has: (id) => id === 1, ensure: async () => {} },
  });
  t.after(() => service.invalidate());
  assert.equal((await service.take())?.url, '/media/1');
});

test('下载确认链接失效后，不再返回该reserve', async (t) => {
  const service = createFillerService({
    candidates: () => [song(1), song(2)],
    resolve: async (candidate) => candidate,
    cache: { has: () => false, ensure: async (candidate) => {
      if (candidate.id === 1) throw new Error('这首的播放链接失效了');
    } },
  });
  t.after(() => service.invalidate());
  await service.fill();
  assert.equal((await service.take())?.meta.id, 2);
});

test('解析改名后仍按原候选判断资格，并按解析id排除caller', async (t) => {
  const original = { title: '别名', artist: '歌手简称' };
  let available = [original];
  const service = createFillerService({
    candidates: () => available,
    resolve: async () => ({ ...song(77), title: '正式歌名', artist: '歌手全名' }),
    cache: { has: () => false, ensure: async () => {} },
  });
  t.after(() => service.invalidate());
  assert.equal((await service.take())?.meta.title, '正式歌名');
  assert.equal(await service.take(['77']), null);
  available = [];
  assert.equal(await service.take(), null);
});

test('reserve凑够八首完整缓存后，定时fill不再轮转下载整库', async (t) => {
  const downloaded = new Set();
  let available = Array.from({ length: 20 }, (_, i) => song(i + 1));
  const service = createFillerService({
    candidates: () => available,
    resolve: async (candidate) => candidate,
    cache: { has: (id) => downloaded.has(id), ensure: async (candidate) => downloaded.add(candidate.id) },
  });
  t.after(() => service.invalidate());
  await service.fill();
  await service.fill();
  await service.fill();
  assert.deepEqual([...downloaded], [1, 2, 3, 4, 5, 6, 7, 8]);
  available = available.slice(1);
  await service.fill();
  assert.deepEqual([...downloaded], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('已有八首未完整缓存时，先刷新它们而不继续下载新候选', async (t) => {
  const downloaded = new Set();
  const service = createFillerService({
    candidates: () => Array.from({ length: 20 }, (_, i) => song(i + 1)),
    resolve: async (candidate) => candidate,
    cache: { has: () => false, ensure: async (candidate) => downloaded.add(candidate.id) },
  });
  t.after(() => service.invalidate());
  await service.fill();
  await service.fill();
  await service.fill();
  assert.deepEqual([...downloaded], [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('reserve入库补取原始LRC，完整缓存的take不再请求歌词', async (t) => {
  let calls = 0;
  const service = createFillerService({
    candidates: () => [{ ...song(1), lyric: '旧歌词' }],
    resolve: () => assert.fail('完整缓存不用解析'),
    lyric: async (id, { signal }) => {
      assert.equal(id, 1);
      assert.equal(signal.aborted, false);
      calls += 1;
      return '[00:01.00]第一句\n[00:02.00]第二句\n[00:03.00]第三句';
    },
    cache: { has: () => true, ensure: async () => {} },
  });
  t.after(() => service.invalidate());
  await service.fill();
  assert.equal((await service.take())?.meta.lyric, '[00:01.00]第一句\n[00:02.00]第二句\n[00:03.00]第三句');
  assert.equal((await service.take())?.meta.lyric, '[00:01.00]第一句\n[00:02.00]第二句\n[00:03.00]第三句');
  assert.equal(calls, 1);
});

test('歌词失败留空，不影响可播歌曲入库', async (t) => {
  for (const [name, failure] of [
    ['同步抛错', () => { throw new Error('歌词不可用'); }],
    ['异步失败', async () => { throw new Error('歌词不可用'); }],
  ]) {
    await t.test(name, async (t) => {
      const service = createFillerService({
        candidates: () => [{ ...song(1), lyric: '旧歌词' }],
        resolve: async (candidate) => candidate,
        lyric: failure,
        cache: { has: () => true, ensure: async () => {} },
      });
      t.after(() => service.invalidate());
      const item = await service.take();
      assert.equal(item?.meta.id, 1);
      assert.equal(item.meta.lyric, '');
    });
  }
});

test('八首歌词并行等待，挂死请求三秒真正abort且仍返回可播歌曲', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = [];
  const finishLate = [];
  let notify;
  const started = new Promise((resolve) => { notify = resolve; });
  const service = createFillerService({
    candidates: () => Array.from({ length: 8 }, (_, i) => song(i + 1)),
    resolve: () => assert.fail('完整缓存不用解析'),
    lyric: (_, { signal }) => {
      signals.push(signal);
      if (signals.length === 8) notify();
      return new Promise((resolve) => { finishLate.push(resolve); });
    },
    cache: { has: () => true, ensure: async (_, { signal }) => assert.equal(signal.aborted, false) },
  });
  t.after(() => service.invalidate());
  const work = service.take();
  await Promise.race([started, work]);
  assert.equal(signals.length, 8);
  t.mock.timers.tick(2999);
  assert.equal(signals.some((signal) => signal.aborted), false);
  t.mock.timers.tick(1);
  const item = await work;
  assert.equal(signals.every((signal) => signal.aborted), true);
  assert.equal(item?.meta.id, 1);
  assert.equal(item.meta.lyric, '');
  for (const finish of finishLate) finish('[00:01]迟到歌词');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await service.take())?.meta.lyric, '');
  assert.equal(signals.length, 8);
});

test('歌词等待服从fill剩余预算，不再额外耗三秒', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  let inner;
  let notify;
  const started = new Promise((resolve) => { notify = resolve; });
  const service = createFillerService({
    timeout: 1000,
    candidates: () => [song(1)],
    resolve: async (candidate) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      return candidate;
    },
    lyric: (_, { signal }) => {
      inner = signal;
      notify();
      return new Promise(() => {});
    },
    cache: { has: () => false, ensure: async () => {} },
  });
  t.after(() => service.invalidate());
  const work = service.take();
  t.mock.timers.tick(800);
  await Promise.race([started, work]);
  assert.ok(inner);
  t.mock.timers.tick(199);
  assert.equal(inner.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(inner.aborted, true);
  assert.equal((await work)?.meta.lyric, '');
});

test('invalidate立即取消歌词等待，旧结果不覆盖新reserve', async (t) => {
  let available = [song(1)];
  let inner;
  let finishOld;
  let notify;
  const started = new Promise((resolve) => { notify = resolve; });
  const service = createFillerService({
    candidates: () => available,
    resolve: async (candidate) => candidate,
    lyric: (id, { signal }) => {
      if (id === 2) return Promise.resolve('[00:01]新歌词');
      inner = signal;
      notify();
      return new Promise((resolve) => { finishOld = resolve; });
    },
    cache: { has: () => true, ensure: async () => {} },
  });
  t.after(() => service.invalidate());
  const oldWork = service.take();
  await Promise.race([started, oldWork]);
  assert.ok(inner);
  service.invalidate();
  assert.equal(inner.aborted, true);
  assert.equal(await oldWork, null);
  available = [song(2)];
  assert.equal((await service.take())?.meta.lyric, '[00:01]新歌词');
  finishOld('[00:01]过期歌词');
  await new Promise((resolve) => setImmediate(resolve));
  const item = await service.take();
  assert.equal(item?.meta.id, 2);
  assert.equal(item.meta.lyric, '[00:01]新歌词');
  assert.deepEqual(service.pins(), [2]);
});

const defer = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
function styleFiller(t, options = {}) {
  const state = {
    available: Array.from({ length: options.count ?? 20 }, (_, i) => ({ ...song(i + 1), genre: i < 8 ? '摇滚' : '钢琴' })),
    constraints: styleConstraints('钢琴'), limited: false,
    cached: new Set(), resolved: [], lyrics: [], downloads: [],
    ...options.state,
  };
  state.service = createFillerService({
    candidates: () => state.available,
    style: () => state.constraints,
    limited: () => state.limited,
    resolve: async (candidate, context) => {
      state.resolved.push(candidate.id);
      return options.resolve ? options.resolve(candidate, context, state) : candidate;
    },
    lyric: async (id, context) => {
      state.lyrics.push(id);
      return options.lyric ? options.lyric(id, context, state) : '[00:01]歌词';
    },
    cache: {
      has: (id) => state.cached.has(id),
      ensure: async (candidate, context) => {
        state.downloads.push(candidate.id);
        if (options.ensure) await options.ensure(candidate, context, state);
        else state.cached.add(candidate.id);
      },
    },
  });
  t.after(() => state.service.invalidate());
  return state;
}
async function reserveIds(service) {
  const ids = [];
  for (let i = 0; i < 13; i += 1) {
    const item = await service.take(ids.map(String));
    if (!item) return ids.sort((a, b) => a - b);
    ids.push(item.meta.id);
  }
  assert.fail('reserve超过八首');
}

test('无曲风、只有情绪或排除项时维持缓存优先且只补八首', async (t) => {
  for (const text of ['', '安静一点', '不要摇滚']) {
    await t.test(text || '无约束', async (t) => {
      const state = styleFiller(t, { state: { constraints: styleConstraints(text), cached: new Set([2]) }, ensure: async () => {} });
      assert.equal((await state.service.take())?.meta.id, 2);
      assert.deepEqual(state.downloads, [1, 2, 3, 4, 5, 6, 7, 8]);
      assert.equal(state.resolved.length, 7);
    });
  }
});

test('同轮未落盘的曲风命中优先于完整缓存的冲突歌', async (t) => {
  const state = styleFiller(t, {
    count: 12,
    state: { cached: new Set([1]) },
    resolve: async (candidate) => ({ ...candidate, genre: candidate.id === 2 ? '钢琴' : '摇滚' }),
    ensure: async () => {},
  });
  const item = await state.service.take();
  assert.equal(item?.meta.id, 2);
  assert.equal(item.url, song(2).url);
  assert.equal(state.resolved.length, 7);
});

test('完整缓存的冲突歌立即返回，不为偏好另起fill', async (t) => {
  const state = styleFiller(t, { state: { constraints: [] } });
  await state.service.fill();
  state.constraints = styleConstraints('钢琴');
  assert.equal((await state.service.take())?.meta.id, 1);
  assert.equal(state.resolved.length, 8);
  assert.deepEqual(state.service.pins(), [1]);
});

test('有真实曲风时忽略标题和自报标签，未知优先于冲突且同档缓存优先', async (t) => {
  const state = styleFiller(t, {
    count: 4,
    state: { cached: new Set([1, 3]) },
    ensure: async () => {},
  });
  state.available = [
    { ...song(1), title: '钢琴', genre: '摇滚', tags: ['钢琴'], mood: '钢琴', instrument: '钢琴' },
    { ...song(2), genre: '' }, { ...song(3), genre: '' }, { ...song(4), genre: '摇滚' },
  ];
  assert.equal((await state.service.take())?.meta.id, 3);
  assert.equal((await state.service.take(['3']))?.meta.id, 1);
});

test('全部冲突时仍返回可播垫歌，不冷场', async (t) => {
  const state = styleFiller(t, { count: 8 });
  assert.equal((await state.service.take())?.meta.id, 1);
  assert.deepEqual(state.resolved, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('前八首冲突只额外寻找第九到十二首，reserve仍为八首且不反复找', async (t) => {
  const state = styleFiller(t);
  await state.service.fill();
  assert.deepEqual(state.resolved, Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal((await state.service.take())?.meta.id, 9);
  assert.deepEqual(await reserveIds(state.service), [5, 6, 7, 8, 9, 10, 11, 12]);
  await state.service.fill();
  await state.service.fill();
  assert.equal(state.resolved.length, 12);
});

test('hunt在歌词和下载前丢弃未知、冲突及不可播命中', async (t) => {
  const state = styleFiller(t, { resolve: async (candidate) => {
    if (candidate.id === 9) return { ...candidate, genre: '' };
    if (candidate.id === 10) return { ...candidate, genre: '摇滚' };
    if (candidate.id === 11) return { ...candidate, playable: false };
    return candidate;
  } });
  await state.service.fill();
  assert.deepEqual(state.lyrics, [1, 2, 3, 4, 5, 6, 7, 8, 12]);
  assert.deepEqual(state.downloads, state.lyrics);
  assert.deepEqual(await reserveIds(state.service), [2, 3, 4, 5, 6, 7, 8, 12]);
  assert.equal(state.resolved.length, 12);
});

test('hunt先淘汰冲突而保留未知，caller排除后仍只有八首', async (t) => {
  const state = styleFiller(t);
  state.available = state.available.map((candidate) => candidate.id >= 5 && candidate.id <= 8 ? { ...candidate, genre: '' } : candidate);
  await state.service.fill();
  assert.equal((await state.service.take(['9', '10', '11', '12']))?.meta.id, 5);
  assert.deepEqual(await reserveIds(state.service), [5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(state.resolved.length, 12);
});

test('同为冲突时先淘汰未落盘项，不牺牲其他未知歌', async (t) => {
  const state = styleFiller(t, {
    count: 9,
    state: { cached: new Set([1, 3, 4, 5, 6, 7, 8]) },
    ensure: async (candidate, _, state) => { if (candidate.id !== 2) state.cached.add(candidate.id); },
  });
  state.available = state.available.map((candidate) => candidate.id >= 3 && candidate.id <= 8 ? { ...candidate, genre: '' } : candidate);
  await state.service.fill();
  state.cached.add(2);
  assert.deepEqual(await reserveIds(state.service), [1, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(state.resolved, [2, 9]);
});

test('hunt没有命中也只尝试一次，后续补库不再额外解析四首', async (t) => {
  const state = styleFiller(t, { resolve: async (candidate) => ({ ...candidate, genre: '摇滚' }) });
  await state.service.fill();
  assert.equal(state.resolved.length, 12);
  await state.service.fill();
  state.available = state.available.slice(1);
  await state.service.fill();
  await state.service.fill();
  assert.deepEqual(state.resolved, [...Array.from({ length: 12 }, (_, i) => i + 1), 13]);
  assert.deepEqual(state.downloads, [1, 2, 3, 4, 5, 6, 7, 8, 13]);
});

test('混合限流结果也跳过hunt，且本次机会已消耗', async (t) => {
  const state = styleFiller(t, { resolve: async (candidate) => candidate.id === 1
    ? { ...candidate, playable: false, rateLimited: true }
    : { ...candidate, genre: '摇滚' } });
  await state.service.fill();
  assert.deepEqual(state.resolved, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  state.available = state.available.filter((candidate) => candidate.id !== 1 && candidate.id !== 2);
  await state.service.fill();
  assert.deepEqual(state.resolved, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('整批限流时不hunt，后续恢复仍只正常补八首', async (t) => {
  let blocked = true;
  const state = styleFiller(t, { resolve: async (candidate) => blocked
    ? { ...candidate, playable: false, rateLimited: true }
    : { ...candidate, genre: '摇滚' } });
  await state.service.fill();
  assert.equal(state.resolved.length, 8);
  blocked = false;
  await state.service.fill();
  assert.deepEqual(state.resolved, Array.from({ length: 16 }, (_, i) => i + 1));
});

test('网易云冷却时跳过hunt，解除冷却不会补做该次寻找', async (t) => {
  const state = styleFiller(t, { state: { limited: true }, resolve: async (candidate) => ({ ...candidate, genre: '摇滚' }) });
  await state.service.fill();
  assert.equal(state.resolved.length, 8);
  state.limited = false;
  state.available = state.available.slice(1);
  await state.service.fill();
  assert.deepEqual(state.resolved, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('首轮没有曲风约束也消耗hunt机会，后来激活只正常补库', async (t) => {
  const state = styleFiller(t, { state: { constraints: [] } });
  await state.service.fill();
  state.constraints = styleConstraints('吉他');
  state.available = state.available.slice(1);
  await state.service.fill();
  assert.deepEqual(state.resolved, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('空候选fill没有正常派发，不消耗首次hunt机会', async (t) => {
  const state = styleFiller(t);
  const available = state.available;
  state.available = [];
  await state.service.fill();
  state.available = available;
  await state.service.fill();
  assert.equal(state.resolved.length, 12);
});

test('正常补库途中曲风改变时跳过hunt，后来也不补做', async (t) => {
  const gate = defer();
  const state = styleFiller(t, { resolve: async (candidate) => {
    await gate.promise;
    return candidate;
  } });
  const work = state.service.fill();
  state.constraints = styleConstraints('吉他');
  gate.resolve();
  await work;
  assert.equal(state.resolved.length, 8);
  state.available = state.available.slice(1);
  await state.service.fill();
  assert.equal(state.resolved.length, 9);
});

test('take和多个fill并发共用同一轮且只寻找四首', async (t) => {
  const gate = defer();
  const state = styleFiller(t, { resolve: async (candidate) => {
    if (candidate.id <= 8) await gate.promise;
    return candidate;
  } });
  const first = state.service.fill();
  const take = state.service.take();
  assert.equal(state.service.fill(), first);
  gate.resolve();
  await first;
  assert.equal((await take)?.meta.id, 9);
  assert.deepEqual(state.resolved, Array.from({ length: 12 }, (_, i) => i + 1));
});

test('invalidate重新开放一次hunt，而普通重复fill不会开放', async (t) => {
  const state = styleFiller(t);
  await state.service.fill();
  assert.equal(state.resolved.length, 12);
  state.service.invalidate();
  state.cached.clear();
  await state.service.fill();
  await state.service.fill();
  assert.deepEqual(state.resolved, [...Array.from({ length: 12 }, (_, i) => i + 1), ...Array.from({ length: 12 }, (_, i) => i + 1)]);
});

test('hunt途中invalidate取消请求，迟到结果不回写且新轮可以再hunt', async (t) => {
  const started = defer();
  const gate = defer();
  const signals = [];
  let old = true;
  const state = styleFiller(t, { resolve: async (candidate, { signal }) => {
    if (old && candidate.id > 8) {
      signals.push(signal);
      if (signals.length === 4) started.resolve();
      await gate.promise;
    }
    return candidate;
  } });
  const work = state.service.fill();
  await Promise.race([started.promise, work]);
  assert.equal(signals.length, 4);
  state.service.invalidate();
  assert.equal(signals.every((signal) => signal.aborted), true);
  await work;
  old = false;
  state.cached.clear();
  await state.service.fill();
  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await state.service.take())?.meta.id, 9);
  assert.equal(state.downloads.filter((id) => id > 8).length, 4);
  assert.deepEqual(state.service.pins(), [9]);
});

test('hunt解析中清除或改变曲风，旧命中不取歌词也不下载', async (t) => {
  for (const next of ['', '吉他']) {
    await t.test(next || '清除', async (t) => {
      const started = defer();
      const gate = defer();
      let hunts = 0;
      const state = styleFiller(t, { resolve: async (candidate) => {
        if (candidate.id > 8) {
          hunts += 1;
          if (hunts === 4) started.resolve();
          await gate.promise;
        }
        return candidate;
      } });
      const work = state.service.fill();
      await Promise.race([started.promise, work]);
      assert.equal(hunts, 4);
      state.constraints = styleConstraints(next);
      gate.resolve();
      await work;
      assert.deepEqual(state.lyrics, [1, 2, 3, 4, 5, 6, 7, 8]);
      assert.deepEqual(state.downloads, state.lyrics);
      assert.equal((await state.service.take())?.meta.id, 1);
    });
  }
});

test('hunt歌词等待中清除曲风也不下载旧命中', async (t) => {
  const started = defer();
  const gate = defer();
  let hunts = 0;
  const state = styleFiller(t, { lyric: async (id) => {
    if (id > 8) {
      hunts += 1;
      if (hunts === 4) started.resolve();
      await gate.promise;
    }
    return '[00:01]歌词';
  } });
  const work = state.service.fill();
  await Promise.race([started.promise, work]);
  assert.equal(hunts, 4);
  state.constraints = [];
  gate.resolve();
  await work;
  assert.deepEqual(state.downloads, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('hunt淘汰不会改动已prepared歌曲的pin，caller仍排除解析后的id', async (t) => {
  const started = defer();
  const gate = defer();
  let hunts = 0;
  const state = styleFiller(t, { resolve: async (candidate) => {
    if (candidate.id > 8) {
      hunts += 1;
      if (hunts === 4) started.resolve();
      await gate.promise;
    }
    return candidate.id === 9 ? { ...candidate, id: 99 } : candidate;
  } });
  const work = state.service.fill();
  await Promise.race([started.promise, work]);
  assert.equal(hunts, 4);
  assert.equal((await state.service.take())?.meta.id, 1);
  assert.deepEqual(state.service.pins(), [1]);
  gate.resolve();
  await work;
  assert.deepEqual(state.service.pins(), [1]);
  assert.equal((await state.service.take(['99']))?.meta.id, 10);
  assert.deepEqual(state.service.pins(), [10]);
  assert.equal(await state.service.take(['5', '6', '7', '8', '99', '10', '11', '12']), null);
  assert.equal(state.resolved.length, 12);
});

test('正常补库用尽原六秒预算时不hunt，跳过的机会也已消耗', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const lyricsStarted = defer();
  let slow = true;
  let lyrics = 0;
  const state = styleFiller(t, {
    resolve: async (candidate) => {
      if (slow) await new Promise((resolve) => setTimeout(resolve, 5999));
      return { ...candidate, genre: '摇滚' };
    },
    lyric: async () => {
      lyrics += 1;
      if (lyrics === 8) lyricsStarted.resolve();
      if (slow) await new Promise((resolve) => setTimeout(resolve, 1));
      return '[00:01]歌词';
    },
  });
  const work = state.service.fill();
  t.mock.timers.tick(5999);
  await Promise.race([lyricsStarted.promise, work]);
  assert.equal(lyrics, 8);
  t.mock.timers.tick(1);
  await work;
  assert.equal(Date.now(), 16000);
  assert.deepEqual(state.resolved, [1, 2, 3, 4, 5, 6, 7, 8]);
  slow = false;
  state.available = state.available.slice(1);
  await state.service.fill();
  assert.deepEqual(state.resolved, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('hunt解析与歌词共用原六秒截止点，不重新获得六秒或三秒', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const resolveStarted = defer();
  const lyricsStarted = defer();
  const signals = [];
  let hunts = 0;
  const state = styleFiller(t, {
    resolve: async (candidate) => {
      if (candidate.id > 8) {
        hunts += 1;
        if (hunts === 4) resolveStarted.resolve();
      }
      await new Promise((resolve) => setTimeout(resolve, candidate.id <= 8 ? 5000 : 500));
      return candidate;
    },
    lyric: async (id, { signal }) => {
      if (id <= 8) return '[00:01]歌词';
      signals.push(signal);
      if (signals.length === 4) lyricsStarted.resolve();
      return new Promise(() => {});
    },
  });
  const work = state.service.fill();
  t.mock.timers.tick(5000);
  await Promise.race([resolveStarted.promise, work]);
  assert.equal(hunts, 4);
  t.mock.timers.tick(500);
  await Promise.race([lyricsStarted.promise, work]);
  assert.equal(signals.length, 4);
  t.mock.timers.tick(499);
  assert.equal(signals.some((signal) => signal.aborted), false);
  t.mock.timers.tick(1);
  await work;
  assert.equal(Date.now(), 16000);
  assert.equal(signals.every((signal) => signal.aborted), true);
  assert.deepEqual(state.resolved, Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal((await state.service.take())?.meta.lyric, '');
});
