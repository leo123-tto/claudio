import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { createEpisodeBuffer } from '../server/episode-buffer.js';
const deferred = () => { let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; };
const ep = (id) => ({ id, say: '歇一会儿', queue:[{type:'song',url:'https://music.126.net/a',meta:{id,title:id,artist:'歌手'}}] });
async function settle() { for(let i=0;i<5;i++) await tick(); }

test('adopt拒绝已经盖上旧epoch的远程节目，不得重新盖章复活', (t) => {
  const service = createEpisodeBuffer({ enabled: () => false });
  t.after(() => service.dispose());
  const old = { ...ep('old-remote'), epoch: service.snapshot().epoch };
  service.invalidate();
  assert.throws(() => service.adopt(old, 'remote-claim'), /更新|失效/);
  assert.equal(old.epoch, 0);
  assert.deepEqual(service.exclusions(), []);
});

test('buffer填两期，claim不提交，重复claim不重取，started幂等且补齐', async (t) => {
  let count=0; const history=[],events=[];
  const service=createEpisodeBuffer({build:async()=>ep(String(++count)),commit:e=>history.push(e.id),emit:e=>events.push(e)});
  t.after(()=>service.dispose()); service.ensure(); await settle();
  assert.equal(service.snapshot().buffered,2); assert.deepEqual(history,[]);
  const claimed=await service.claim('claim-1'); await settle();
  assert.equal((await service.claim('claim-1')).id,claimed.id);
  assert.deepEqual(history,[]); assert.equal(events.some(e=>e.kind==='episode'),false);
  service.start(claimed.id,'claim-1'); service.start(claimed.id,'claim-1');
  assert.deepEqual(history,[claimed.id]); await settle(); assert.equal(service.snapshot().buffered,2);
});
test('空buffer立即返回null且仅一条生成车道，chat抢占并恢复补充', async (t) => {
  const work=[]; let inFlight=0,max=0;
  const service=createEpisodeBuffer({build:({signal})=>{
    inFlight++; max=Math.max(max,inFlight); const task=deferred(); work.push(task);
    signal.addEventListener('abort',()=>task.reject(signal.reason),{once:true});
    return task.promise.finally(()=>inFlight--);
  }}); t.after(()=>service.dispose());
  assert.equal(await service.claim('empty'),null); await settle(); assert.equal(work.length,1);
  const chat=service.runForeground(async()=>{inFlight++;max=Math.max(max,inFlight);inFlight--;return 'chat';});
  assert.equal(await chat,'chat'); await settle(); assert.equal(work.length,2); assert.equal(max,1);
  work[1].resolve(ep('new')); await settle(); assert.equal(service.snapshot().buffered,1);
});
test('新chat取消旧chat，旧finally不解除新任务状态', async(t)=>{
  const service=createEpisodeBuffer({enabled:()=>false,build:()=>ep('unused')});t.after(()=>service.dispose());
  const old=service.runForeground(signal=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})));
  const rejected=assert.rejects(old,/替换/);await settle();
  const newer=deferred();const current=service.runForeground(()=>newer.promise);await rejected;await settle();
  assert.equal(service.snapshot().generating,true);newer.resolve('new');assert.equal(await current,'new');
});
test('release和15分钟过期直接丢弃，epoch使旧claim失效并拒绝旧任务回写',async(t)=>{
  let clock=1000,count=0;const service=createEpisodeBuffer({now:()=>clock,build:async()=>ep(String(++count))});t.after(()=>service.dispose());
  service.ensure();await settle();const one=await service.claim('one');assert.equal(service.release('one'),true);assert.throws(()=>service.start(one.id,'one'),/失效/);
  const two=await service.claim('two');clock+=15*60*1000;assert.throws(()=>service.start(two.id,'two'),/失效/);
  await settle();const three=await service.claim('three');const next=service.invalidate();assert.equal(next,1);assert.throws(()=>service.start(three.id,'three'),/失效/);
  await assert.rejects(service.claim('three'),/更新/);
});
test('后台旧任务即使忽略abort并成功返回，也不能污染新epoch',async(t)=>{
  const first=deferred();let count=0;const service=createEpisodeBuffer({build:()=>++count===1?first.promise:Promise.resolve(ep(`new-${count}`))});t.after(()=>service.dispose());
  service.ensure();await settle();service.invalidate();first.resolve(ep('old'));await settle();assert.equal(service.snapshot().next.id,'new-2');assert.equal(service.snapshot().buffered,2);
});
test('pending语音独立完成、失败重试、开始无声后不再插入',async(t)=>{
  let count=0; const voices=new Map(),events=[];
  const service=createEpisodeBuffer({capacity:1,build:async()=>ep(String(++count)),emit:e=>events.push(e),synthesize:(text,{signal})=>{
    const task=deferred();voices.set(count,task);return task.promise;
  }});t.after(()=>service.dispose());service.ensure();await settle();
  const one=await service.claim('one');assert.equal(one.voice.status,'pending');assert.equal(one.queue[0].type,'song');
  voices.get(1).resolve({url:'/tts/one.mp3'});await settle();assert.equal(one.voice.status,'ready');assert.equal(one.queue[0].type,'tts');assert.equal(events.some(e=>e.kind==='voiceReady'&&e.episodeId===one.id),true);
  const two=await service.claim('two');service.start(two.id,'two');voices.get(2).resolve({url:'/tts/two.mp3'});await settle();assert.equal(two.voice.status,'skipped');assert.equal(two.queue[0].type,'song');
});
test('语音失败pending可重试成功，40分钟旧口播保留歌并跳过',async(t)=>{
  let clock=1,attempt=0;const events=[];
  const service=createEpisodeBuffer({capacity:1,now:()=>clock,build:async()=>ep('one'),emit:e=>events.push(e),synthesize:async()=>{if(++attempt===1)throw Error('暂时失败');return {url:'/tts/ok.mp3'};}});t.after(()=>service.dispose());
  service.ensure();await settle();assert.equal(service.getVoice('one').status,'pending');service.retryVoices();await settle();assert.equal(service.getVoice('one').status,'ready');
  clock+=41*60*1000;const one=await service.claim('one');assert.equal(one.voice.status,'skipped');assert.equal(one.say,'歇一会儿');assert.equal(one.queue[0].type,'song');
});
test('离线或反复失败跳过口播；重试退避30/60/120秒且成功复位',async(t)=>{
  let count=0;const delays=[],callbacks=[];
  const service=createEpisodeBuffer({hasClients:()=>true,build:async()=>{if(++count<4)throw Error('失败');return ep('ready');},capacity:1,setTimer:(cb,delay)=>{callbacks.push(cb);delays.push(delay);return 1;},clearTimer:()=>{}});t.after(()=>service.dispose());
  service.ensure();await settle();callbacks.shift()();await settle();callbacks.shift()();await settle();callbacks.shift()();await settle();assert.deepEqual(delays,[30000,60000,120000]);assert.equal(service.snapshot().buffered,1);
  const offline=createEpisodeBuffer({capacity:1,build:async()=>ep('offline'),offline:()=>true,synthesize:()=>assert.fail('离线不合成')});t.after(()=>offline.dispose());offline.ensure();await settle();assert.equal(offline.getVoice('offline').status,'skipped');
});
test('已经开始的claim不能跨epoch或过期再次下发，start重试仍幂等',async(t)=>{
  let clock=1,count=0;const service=createEpisodeBuffer({now:()=>clock,build:async()=>ep(String(++count))});t.after(()=>service.dispose());service.ensure();await settle();
  const one=await service.claim('one');service.start(one.id,'one');service.invalidate();await assert.rejects(service.claim('one'),/失效/);assert.equal(service.start(one.id,'one').id,one.id);
  await settle();const two=await service.claim('two');service.start(two.id,'two');clock+=16*60*1000;await assert.rejects(service.claim('two'),/失效/);
});
test('第二期低优先级可被chat抢占，生成时避开buffer、claim和current',async(t)=>{
  let count=0;const captured=[];const second=deferred();let secondSignal;
  const service=createEpisodeBuffer({build:({signal,excludeSongs})=>{
    captured.push(excludeSongs.map(song=>song.id));count++;
    if(count===2){secondSignal=signal;signal.addEventListener('abort',()=>second.reject(signal.reason),{once:true});return second.promise;}
    return Promise.resolve(ep(String(count)));
  }});t.after(()=>service.dispose());service.ensure();await settle();
  assert.deepEqual(captured[1],['1']);assert.equal(service.snapshot().buffered,1);
  assert.equal(await service.runForeground(async()=> 'chat'),'chat');assert.equal(secondSignal.aborted,true);await settle();
  const first=await service.claim('first');await settle();const next=await service.claim('next');service.start(first.id,'first');await settle();
  const held=service.exclusions().map(song=>song.id);assert.ok(held.includes(first.id));assert.ok(held.includes(next.id));assert.ok(service.snapshot().buffered>0);
  assert.ok(captured.at(-1).includes(first.id));
});

test('睡眠定时 idle：停掉在做的后台节目、不再补，下次领取自动恢复', async (t) => {
  const work = [];
  const service = createEpisodeBuffer({ build: ({ signal }) => {
    const task = deferred(); work.push(task);
    signal.addEventListener('abort', () => task.reject(signal.reason), { once: true });
    return task.promise;
  } });
  t.after(() => service.dispose());
  service.ensure(); await settle();
  assert.equal(work.length, 1);
  service.idle(); await settle();
  await assert.rejects(work[0].promise, /睡眠定时/);
  assert.equal(work.length, 1);
  assert.equal(service.snapshot().buffered, 0);
  assert.equal(await service.claim('morning'), null); await settle();
  assert.equal(work.length, 2);
});

test('没人在听就不备节目，有人连上后 ensure 才开始', async (t) => {
  let listeners = 0; let builds = 0;
  const service = createEpisodeBuffer({ listening: () => listeners > 0, build: async () => ep(String(++builds)) });
  t.after(() => service.dispose());
  service.ensure(); await settle();
  assert.equal(builds, 0);
  listeners = 1; service.ensure(); await settle();
  assert.equal(service.snapshot().buffered, 2);
});

test('驾驶模式开关的旧做法 invalidate 会清空备好的节目（进驾驶后按下一首就得等重新生成）', async (t) => {
  let count = 0;
  const service = createEpisodeBuffer({ build: async () => ep(String(++count)) });
  t.after(() => service.dispose()); service.ensure(); await settle();
  assert.equal(service.snapshot().buffered, 2);
  service.invalidate();
  assert.equal(service.snapshot().buffered, 0);
  assert.equal(await service.claim('right-after'), null);
});

test('reviseSays：备好的节目留着，只把口播改短、重新合成；领取过的也改，正在放的不动', async (t) => {
  let count = 0; const events = []; const spoken = [];
  const voices = [];
  const service = createEpisodeBuffer({
    build: async () => ({ ...ep(String(++count)), say: '第一句比较长的开场白。第二句接着聊点别的。' }),
    synthesize: (text, { signal }) => { spoken.push(text); const d = deferred(); voices.push({ text, d, signal }); signal.addEventListener('abort', () => d.reject(signal.reason), { once: true }); return d.promise; },
    emit: (e) => events.push(e),
  });
  t.after(() => service.dispose());
  service.ensure(); await settle();
  assert.equal(service.snapshot().buffered, 2);
  // 第一段语音合成好了，第二段还在合成
  voices[0].d.resolve({ url: '/tts/long-1.mp3' }); await settle();
  const claimed = await service.claim('c1'); await settle();
  assert.equal(claimed.queue[0].type, 'tts');

  const n = service.reviseSays((say) => say.split('。')[0] + '。');
  assert.equal(n, 3); // 领取的 1 段 + 补齐的 2 段
  assert.equal(service.snapshot().buffered, 2); // 没作废
  assert.equal(claimed.say, '第一句比较长的开场白。');
  assert.equal(claimed.queue.some((q) => q.type === 'tts'), false);
  assert.equal(claimed.voice.status, 'pending');
  assert.equal(voices[1].signal.aborted, true); // 旧的长口播合成停掉
  const revised = events.filter((e) => e.kind === 'sayRevised');
  assert.equal(revised.length, 3);
  assert.ok(revised.every((e) => e.say === '第一句比较长的开场白。' && e.voice === 'pending'));
  assert.deepEqual(spoken.slice(-3), Array(3).fill('第一句比较长的开场白。'));
  // 短口播合成好：照常 voiceReady
  voices.at(-3).d.resolve({ url: '/tts/short.mp3' }); await settle();
  assert.ok(events.some((e) => e.kind === 'voiceReady' && e.text === '第一句比较长的开场白。'));
  // 已经短了：再改不动
  assert.equal(service.reviseSays((say) => say.split('。')[0] + '。'), 0);
  // 开播时语音还没好就跳过口播直接放歌
  service.start(claimed.id, 'c1');
  assert.equal(claimed.say, '第一句比较长的开场白。');
});

test('reviseSays：语音本来就跳过的（5090 不在）保持跳过，不去合成', async (t) => {
  let count = 0; const spoken = [];
  const service = createEpisodeBuffer({
    build: async () => ({ ...ep(String(++count)), say: '很长的一段话。还有第二句。' }),
    synthesize: async (text) => { spoken.push(text); throw new Error('5090 离线'); },
  });
  t.after(() => service.dispose());
  service.ensure(); await settle();
  const before = spoken.length;
  service.reviseSays((say) => say.split('。')[0] + '。');
  await settle();
  assert.equal(spoken.length, before);
  assert.ok(service.held().every((e) => e.voice.status === 'skipped' && e.say === '很长的一段话。'));
});
test('口播频率：领取时问一次 speaks；不开口就停掉语音、交出去掉口播的副本，原件的 say 不动',async(t)=>{
  let count=0,asked=0;const voices=[],events=[];
  const service=createEpisodeBuffer({capacity:1,build:async()=>ep(String(++count)),emit:e=>events.push(e),speaks:()=>{asked++;return false;},synthesize:()=>new Promise((resolve)=>voices.push(resolve))});
  t.after(()=>service.dispose());service.ensure();await settle();
  const muted=await service.claim('one');
  assert.equal(muted.say,'');assert.equal(muted.voice.status,'skipped');assert.equal(muted.queue.every(item=>item.type==='song'),true);
  assert.equal((await service.claim('one')).say,'');assert.equal(asked,1); // 只问一次
  assert.equal(service.held().find(e=>e.id===muted.id).say,'歇一会儿');
  voices[0]({url:'/tts/late.mp3'});await settle();
  assert.equal(events.some(e=>e.kind==='voiceReady'&&e.episodeId===muted.id),false);
  assert.equal(service.getVoice(muted.id).status,'skipped');
  const spoken=createEpisodeBuffer({capacity:1,build:async()=>ep('s'),speaks:()=>true});t.after(()=>spoken.dispose());spoken.ensure();await settle();
  assert.equal((await spoken.claim('s')).say,'歇一会儿');
});
