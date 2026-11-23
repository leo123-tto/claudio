import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEpisodeSongs, refreshEpisodeUrls } from '../server/episode-audio.js';
const forever = () => new Promise(()=>{});
test('整期20秒预算可保留成功歌曲，挂起单歌会收到abort',async()=>{
  let aborted=false;
  const result=await resolveEpisodeSongs([{title:'ok'},{title:'bad'},{title:'hung'}],{timeout:10,resolve:async(song,{signal})=>{
    if(song.title==='ok')return {playable:true,url:'ok'};
    if(song.title==='bad')throw Error('版权');
    signal.addEventListener('abort',()=>{aborted=true;});return forever();
  }});
  assert.equal(result.length,1);assert.equal(result[0].candidate.title,'ok');assert.equal(aborted,true);
});
test('外部取消立即拒绝并真正取消所有歌',async()=>{
  const controller=new AbortController();let inner;
  const work=resolveEpisodeSongs([{}],{signal:controller.signal,resolve:(_,options)=>{inner=options.signal;return forever();}});
  const reason=Error('换了心情');controller.abort(reason);await assert.rejects(work,e=>e===reason);assert.equal(inner.aborted,true);
});
test('G11 可选诊断报告解析失败、不可播和超时，不传错误或直链', async () => {
  const candidates = ['ok', 'error', 'unplayable', 'missing-url', 'null', 'hung'].map((title) => ({ title }));
  const drops = [];
  const result = await resolveEpisodeSongs(candidates, { timeout: 10,
    onDrop: (...args) => drops.push(args),
    resolve: async ({ title }) => {
      if (title === 'error') throw new Error('https://private.example/secret');
      if (title === 'hung') return forever();
      if (title === 'null') return null;
      if (title === 'missing-url') return { playable: true };
      return { playable: title !== 'unplayable', url: 'https://private.example/audio' };
    },
  });
  assert.deepEqual(result.map(({ candidate }) => candidate.title), ['ok', 'unplayable', 'missing-url', 'null']);
  assert.deepEqual(drops.map(([candidate, reason]) => [candidate.title, reason]), [
    ['error', 'resolve-error'], ['unplayable', 'unplayable'], ['missing-url', 'unplayable'], ['null', 'unplayable'], ['hung', 'timeout'],
  ]);
  assert.ok(drops.every((args) => args.length === 2));
  assert.equal(JSON.stringify(drops).includes('private.example'), false);
});
test('G11 诊断不改变返回顺序，诊断自身抛错不影响成功结果', async () => {
  let finishFirst;
  const first = new Promise((done) => { finishFirst = done; });
  const result = await resolveEpisodeSongs([{ title: 'first' }, { title: 'second' }, { title: 'bad' }], {
    onDrop: () => { throw new Error('诊断故障'); },
    resolve: async ({ title }) => {
      if (title === 'first') return first;
      if (title === 'bad') throw new Error('单首失败');
      finishFirst({ playable: true, url: 'one' });
      return { playable: true, url: 'two' };
    },
  });
  assert.deepEqual(result.map(({ candidate, index }) => [candidate.title, index]), [['first', 0], ['second', 1]]);
});
test('G15 限流与普通不可播使用不同淘汰原因', async () => {
  const drops = [];
  const result = await resolveEpisodeSongs([{ title: '限流' }, { title: '无版权' }], {
    onDrop: (candidate, reason) => drops.push([candidate.title, reason]),
    resolve: async ({ title }) => ({ playable: false, url: null,
      ...(title === '限流' ? { rateLimited: true, error: 'ncm /search -> 405' } : {}) }),
  });
  assert.equal(result.length, 2);
  assert.deepEqual(drops, [['限流', 'rate-limited'], ['无版权', 'unplayable']]);
});
test('G11 外部取消不记为淘汰，超时后的迟到结果也不重复诊断', async () => {
  const drops = [];
  const controller = new AbortController();
  const work = resolveEpisodeSongs([{}], { signal: controller.signal, onDrop: (...args) => drops.push(args), resolve: (_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  controller.abort(new Error('取消'));
  await assert.rejects(work, /取消/);
  assert.deepEqual(drops, []);
  let lateResolve;
  const pending = new Promise((done) => { lateResolve = done; });
  await resolveEpisodeSongs([{ title: 'late' }], { timeout: 10, onDrop: (...args) => drops.push(args), resolve: () => pending });
  lateResolve({ playable: false });
  await Promise.resolve();
  assert.deepEqual(drops.map(([candidate, reason]) => [candidate.title, reason]), [['late', 'timeout']]);
});
test('claim刷新并行，缓存直用，挂起请求3秒取消且保留旧URL',async()=>{
  const ep={queue:[{type:'song',url:'old1',meta:{id:'1'}},{type:'song',url:'old2',meta:{id:'2'}},{type:'song',url:'old3',meta:{id:'3'}}]};
  const calls=[];let hungSignal;
  await refreshEpisodeUrls(ep,{cache:{has:id=>id==='1'},timeout:10,songUrl:(id,_,{signal})=>{
    calls.push(id);if(id==='2')return Promise.resolve({url:'fresh2'});hungSignal=signal;return forever();
  }});
  assert.deepEqual(calls,['2','3']);assert.deepEqual(ep.queue.map(i=>i.url),['/media/1','fresh2','old3']);assert.equal(ep.queue[1].meta.remoteUrl,'fresh2');assert.equal(hungSignal.aborted,true);
});
