import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { EventEmitter } from 'node:events';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'claudio-contract-'));
process.env.CLAUDIO_RESOURCE_ROOT=directory;
process.env.CLAUDIO_DATA_DIR=directory;
process.env.CLAUDIO_NO_LISTEN='1';
process.env.CLAUDIO_SKIP_PREFETCH='1';
const realFetch=globalThis.fetch;
globalThis.fetch=()=>{throw Error('离线测试禁止真实网络');};
const retryCallbacks=[];
const realSetInterval=globalThis.setInterval;
let runtime;
try {
  globalThis.setInterval=(callback, ms, ...args)=>{
    if(ms===60000)retryCallbacks.push(callback);
    return realSetInterval(callback, ms, ...args);
  };
  runtime=await import('../server/index.js');
} finally { globalThis.setInterval=realSetInterval; }
const {services,episodeBuffer,server,closeRuntime}=runtime;
const state=await import('../server/state.js');
const messages=[];
let ws;
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
async function settle(){for(let i=0;i<5;i++)await tick();}
let id=0;
const plan=(overrides={})=>({say:'坐一会儿。先听甲乐队的《候选甲》。',intent:'recommend',play:[{title:'候选甲',artist:'甲乐队',discoveryType:'adjacent',score:90},{title:'候选乙',artist:'乙乐队',discoveryType:'explore',lane:'fresh',score:80}],...overrides});
services.cache={has:()=>false,pin:()=>{},ensure:async()=>{throw Error('不下载');},info:()=>null,resolve:()=>null};
services.ncm={...services.ncm,lyric:async()=>'',songUrl:async id=>({url:`https://m.126.net/fresh-${id}`}),resolve:async song=>({...song,id:String(++id),url:`https://m.126.net/${id}`,playable:true})};
services.synthesize=async()=>({url:'/tts/complete.mp3'});
services.plan=async()=>plan();
services.stream=async(_prompt,{onText})=>{const text=JSON.stringify(plan());onText?.(text);return text;};
services.prepareLiveTts=()=>({url:'/api/tts/stream/fake.mp3',ready:Promise.resolve()});
async function request(url,body,method=body===undefined?'GET':'POST') {
  const parsed=new URL(url,'http://fake.local');
  const route=runtime.app._router.stack.find(layer=>layer.route?.path===parsed.pathname&&layer.route.methods[method.toLowerCase()]);
  assert.ok(route,`已注册路由 ${method} ${parsed.pathname}`);
  const req={body,query:Object.fromEntries(parsed.searchParams),params:{},ip:'127.0.0.1'};
  const res=new EventEmitter();
  let result;
  res.status=(status)=>{res.statusCode=status;return res;};
  res.json=(value)=>{res.writableEnded=true;result={status:res.statusCode||200,body:structuredClone(value)};return res;};
  await route.route.stack[0].handle(req,res);
  return result;
}

test.before(async()=>{
  ws=new EventEmitter();ws.send=raw=>messages.push(JSON.parse(raw));
  runtime.wss.emit('connection',ws);
  await settle();
});
test.after(()=>{
  closeRuntime();runtime.wss.close();globalThis.fetch=realFetch;fs.rmSync(directory,{recursive:true,force:true});
});

test('HTTP claim不生成等待/不发episode/不写历史，start唯一提交',async()=>{
  const empty=await request('/api/next?claimId=empty');assert.equal(empty.status,202);
  const history=state.recentMessages(200).length;
  const ep={id:'ready-one',epoch:episodeBuffer.snapshot().epoch,say:'现在休息一下',voice:{status:'skipped'},queue:[{type:'song',url:'https://m.126.net/1',meta:{id:'1',title:'已准备',artist:'丙'}}]};
  episodeBuffer.adopt(ep,'ready-claim');messages.length=0;
  const one=await request('/api/next?claimId=ready-claim');const two=await request('/api/next?claimId=ready-claim');
  assert.equal(one.body.episode.id,two.body.episode.id);assert.equal(one.body.claimId,'ready-claim');assert.equal(state.recentMessages(200).length,history);assert.equal(messages.some(m=>m.kind==='episode'),false);
  assert.equal((await request('/api/episode/started',{id:ep.id,claimId:'ready-claim'})).body.ok,true);
  await request('/api/episode/started',{id:ep.id,claimId:'ready-claim'});assert.equal(state.recentMessages(200).length,history+1);
  assert.equal((await request('/api/now')).body.episode.id,ep.id);
});
test('chat所有HTTP分支回requestId/origin，mood独立生成',async()=>{
  const control=await request('/api/chat',{input:'暂停',requestId:'control-id'});assert.equal(control.body.requestId,'control-id');assert.equal(control.body.origin,'chat');
  const empty=await request('/api/chat',{requestId:'empty-id'});assert.equal(empty.status,202);assert.equal(empty.body.origin,'chat');assert.equal(empty.body.requestId,'empty-id');
  let prompt='';services.stream=async(text,{onText})=>{prompt=text;const raw=JSON.stringify(plan({intent:'chat',say:'轻轻松松。',play:[]}));onText(raw);return raw;};
  const mood=await request('/api/chat',{mood:'轻松',requestId:'mood-id'});assert.equal(mood.body.ok,true);assert.equal(mood.body.requestId,'mood-id');assert.match(prompt,/轻松/);
  await settle();assert.ok(messages.some(m=>m.kind==='episode'&&m.requestId==='mood-id'&&m.origin==='chat'));
  services.stream=async()=>{throw new DOMException('This operation was aborted','TimeoutError');};
  const failed=await request('/api/chat',{input:'讲句话',requestId:'error-id'});assert.equal(failed.status,500);assert.equal(failed.body.requestId,'error-id');assert.match(failed.body.error,/大脑超过 150 秒/);assert.equal(failed.body.origin,'chat');
});
test('推荐先解析校正再合成，语音未完成HTTP先返回，晚失败sayFailed带身份',async()=>{
  const voice=deferred();let voiceOptions,spoken;
  services.prepareLiveTts=(say,options)=>{spoken=say;voiceOptions=options;return{url:'/api/tts/stream/test.mp3',ready:voice.promise};};
  services.stream=async(_,{onText})=>{const raw=JSON.stringify(plan());onText(raw);assert.equal(spoken,undefined);return raw;};
  services.ncm.resolve=async song=>({...song,id:String(++id),url:`https://m.126.net/${id}`,playable:song.title!=='候选甲'});
  const reply=await request('/api/chat',{input:'换一批音乐',requestId:'voice-id'});assert.equal(reply.body.ok,true);assert.equal(reply.body.episode.voice.status,'pending');assert.equal(reply.body.episode.queue[0].type,'song');assert.doesNotMatch(spoken,/候选甲/);assert.match(spoken,/候选乙/);
  voice.resolve();await settle();assert.ok(messages.some(m=>m.kind==='sayReady'&&m.requestId==='voice-id'&&m.origin==='chat'));
  voiceOptions.onError(Error('中途断流'));await settle();assert.ok(messages.some(m=>m.kind==='sayFailed'&&m.requestId==='voice-id'&&m.origin==='chat'));
});
test('新chat真取消旧chat；设置改变后迟到语音不能广播',async()=>{
  const slow=deferred();let signal;
  services.stream=async(_text,options)=>{signal=options.signal;options.signal.addEventListener('abort',()=>slow.reject(options.signal.reason),{once:true});return slow.promise;};
  const old=request('/api/chat',{input:'旧请求',requestId:'old-id'});while(!signal)await tick();
  const next=await request('/api/chat',{input:'暂停',requestId:'new-id'});assert.equal(next.body.ok,true);assert.equal(signal.aborted,true);assert.equal((await old).body.requestId,'old-id');
  const voice=deferred();let voiceSignal;
  services.stream=async(_,{onText})=>{const raw=JSON.stringify(plan({say:'陪你坐一会儿。',intent:'chat',play:[]}));onText(raw);return raw;};
  services.prepareLiveTts=(_,{signal})=>{voiceSignal=signal;return{url:'/tts/late.mp3',ready:voice.promise};};
  await request('/api/chat',{input:'说句话',requestId:'late-id'});
  const before=episodeBuffer.snapshot().epoch;await request('/api/settings',{},'PATCH');assert.ok(episodeBuffer.snapshot().epoch>before);assert.equal(voiceSignal.aborted,true);
  voice.resolve();await settle();assert.equal(messages.some(m=>m.kind==='sayReady'&&m.requestId==='late-id'),false);
});
test('取消收藏仅按钮来源，蓝牙设置route转交adapter',async()=>{
  await request('/api/fav',{title:'测试收藏',artist:'甲'});
  const off=await request('/api/fav',{title:'测试收藏',artist:'甲',remove:true});assert.equal(off.body.ok,true);assert.equal(off.body.removed,1);
  let called=0;services.openBluetoothSettings=async()=>{called++;return{ok:true};};assert.equal((await request('/api/outputs/bluetooth-settings',{})).body.ok,true);assert.equal(called,1);
});
test('room-control与空chat错误分支也保留chat身份，语音早失败HTTP跳过',async()=>{
  services.listOutputs=async()=>({items:[{id:'room-test',name:'客厅',deviceName:'客厅'}]});
  services.selectOutput=async()=>({ok:true});
  const room=await request('/api/chat',{input:'放到客厅',requestId:'room-id'});
  assert.equal(room.body.requestId,'room-id');assert.equal(room.body.origin,'chat');assert.equal(room.body.control.action,'output');
  services.prepareLiveTts=()=>{throw Error('离线');};
  services.stream=async(_,{onText})=>{const raw=JSON.stringify(plan({intent:'chat',say:'在这里。',play:[]}));onText(raw);return raw;};
  const early=await request('/api/chat',{input:'在吗',requestId:'early-fail'});
  assert.equal(early.body.episode.voice.status,'skipped');assert.equal(early.body.episode.queue.length,0);assert.ok(messages.some(m=>m.kind==='sayFailed'&&m.requestId==='early-fail'));
});
test('scheduled携带claimId且不提前改current或写历史，headless返回上游URL',async()=>{
  services.plan=async()=>plan();
  services.ncm.resolve=async song=>({...song,id:String(++id),url:`https://m.126.net/${id}`,playable:true});
  const history=state.recentMessages(200).length;
  const before=(await request('/api/now')).body.episode?.id;
  process.env.CLAUDIO_SKIP_PREFETCH='0';
  await runtime.onScheduled('morning-show');await settle();
  const scheduled=messages.filter(m=>m.kind==='scheduled').at(-1);
  assert.ok(scheduled?.claimId);assert.ok(scheduled.episode?.id);assert.equal(state.recentMessages(200).length,history);assert.equal((await request('/api/now')).body.episode?.id,before);
  const started=await request('/api/episode/started',{id:scheduled.episode.id,claimId:scheduled.claimId});assert.equal(started.body.ok,true);
  process.env.CLAUDIO_SKIP_PREFETCH='1';
  services.plan=async()=>plan({play:[{title:'另一首',artist:'新歌手',discoveryType:'adjacent'}]});
  const board=await request('/api/remote/play',{where:'开发板',query:'随便'});
  assert.equal(board.body.ok,true);assert.match(board.body.url,/^https:\/\//);assert.equal(board.body.episode,undefined);
});
test('非ready状态后口播成功会广播ready',async()=>{
  const {laneEvents}=await import('../server/tts/pc5090.js');laneEvents.emit('status',{state:'busy'});
  services.prepareLiveTts=()=>({url:'/tts/recovered.mp3',ready:Promise.resolve()});
  services.stream=async(_,{onText})=>{const raw=JSON.stringify(plan({intent:'chat',play:[],say:'语音恢复了。'}));onText(raw);return raw;};
  const before=messages.filter(m=>m.kind==='ttsLane'&&m.state==='ready').length;
  await request('/api/chat',{input:'说话',requestId:'recovered'});await settle();
  assert.equal(messages.filter(m=>m.kind==='ttsLane'&&m.state==='ready').length,before+1);
});

test('普通chat保留当前音乐节目的排重与缓存pin，聊天历史照常写入',async()=>{
  const music={id:'playing-music',epoch:episodeBuffer.snapshot().epoch,say:'放三首。',voice:{status:'skipped'},
    queue:['A','B','C'].map(id=>({type:'song',url:`https://m.126.net/${id}`,meta:{id,title:`音乐${id}`,artist:'乐队'}}))};
  episodeBuffer.adopt(music,'playing-music-claim');episodeBuffer.start(music.id,'playing-music-claim');
  const oldCache=services.cache;
  let pins=[];
  services.cache={...oldCache,pin:ids=>{pins=ids;}};
  episodeBuffer.setCurrent(music);
  services.stream=async(_,{onText})=>{const raw=JSON.stringify(plan({intent:'chat',say:'我在，陪你听。',play:[]}));onText(raw);return raw;};
  const history=state.recentMessages(200).length;
  try {
    const reply=await request('/api/chat',{input:'在吗',requestId:'keep-music'});
    assert.equal(reply.body.ok,true);
    assert.equal(state.recentMessages(200).length,history+2);
    assert.equal((await request('/api/now')).body.episode.id,music.id);
    assert.deepEqual(episodeBuffer.exclusions().map(song=>song.id),['A','B','C']);
    assert.ok(['A','B','C'].every(id=>pins.includes(id)));
  } finally { services.cache=oldCache; }
});

test('远程DJ等待歌词时失效会取消请求，不得把旧歌交给开发板',async()=>{
  const lyrics=deferred();let calls=0;
  const oldLyric=services.ncm.lyric;
  services.plan=async()=>plan({play:[{title:'远程旧歌',artist:'远程乐队'}]});
  services.ncm.lyric=()=>{calls++;return lyrics.promise;};
  try {
    const pending=request('/api/remote/play',{where:'开发板',query:'随便'});
    while(calls<2)await tick();
    episodeBuffer.invalidate();
    lyrics.resolve('旧歌词');
    const reply=await pending;
    assert.equal(reply.body.ok,false);
  } finally { lyrics.resolve('');services.ncm.lyric=oldLyric; }
});

test('远程DJ等待设备菜单时失效，不得选设备、播放或写历史',async()=>{
  const menu=deferred();let listed=false,selected=0,played=0;
  const saved={listOutputs:services.listOutputs,selectOutput:services.selectOutput,playExclusive:services.playExclusive};
  services.plan=async()=>plan({play:[{title:'等设备的旧歌',artist:'远程乐队'}]});
  services.listOutputs=async()=>{listed=true;return menu.promise;};
  services.selectOutput=async()=>{selected++;return {ok:true,uid:'fake-bed'};};
  services.playExclusive=async()=>{played++;};
  const before=state.recentMessages(200).length;
  try {
    const pending=request('/api/remote/play',{where:'卧室',query:'随便'});
    while(!listed)await tick();
    episodeBuffer.invalidate();
    menu.resolve({items:[{id:'bed',name:'卧室'}]});
    assert.equal((await pending).body.ok,false);
    assert.equal(selected,0);assert.equal(played,0);
    assert.equal(state.recentMessages(200).length,before);
  } finally { menu.resolve({items:[]});Object.assign(services,saved); }
});

test('新chat或指定点歌替换等待设备的远程DJ，旧任务不能迟到提交',async()=>{
  const saved={listOutputs:services.listOutputs,selectOutput:services.selectOutput,playExclusive:services.playExclusive};
  services.stream=async(_,{onText})=>{const raw=JSON.stringify(plan({intent:'chat',say:'在听。',play:[]}));onText(raw);return raw;};
  try {
    for(const replacement of ['chat','named']) {
      const menu=deferred();let listed=false,played=0;
      services.plan=async()=>plan({play:[{title:`等待中的旧歌${replacement}`,artist:'远程乐队'}]});
      services.listOutputs=async()=>{listed=true;return menu.promise;};
      services.selectOutput=async()=>({ok:true,uid:'fake-bed'});
      services.playExclusive=async()=>{played++;};
      const old=request('/api/remote/play',{where:'卧室',query:'随便'});
      while(!listed)await tick();
      const epoch=episodeBuffer.snapshot().epoch;
      const newer=replacement==='chat'
        ? await request('/api/chat',{input:'在吗',requestId:'replace-remote'})
        : await request('/api/remote/play',{where:'开发板',query:'播放明确的新歌'});
      assert.equal(newer.body.ok,true);assert.equal(episodeBuffer.snapshot().epoch,epoch);
      const history=state.recentMessages(200).length;
      menu.resolve({items:[{id:'bed',name:'卧室'}]});
      assert.equal((await old).body.ok,false);assert.equal(played,0);
      assert.equal(state.recentMessages(200).length,history);
    }
  } finally { Object.assign(services,saved); }
});

test('远程音频下载收到取消后不落盘，已取消播放不触碰音箱',async()=>{
  const {materializeAudio,playExclusive,exclusiveStatus}=await import('../server/exclusive-play.js');
  const {config}=await import('../server/config.js');
  const controller=new AbortController();const bytes=deferred();let reading=false,requestSignal;
  const oldFetch=globalThis.fetch;
  globalThis.fetch=async(_url,{signal})=>{
    requestSignal=signal;
    return {ok:true,headers:new Headers(),arrayBuffer:()=>{reading=true;return bytes.promise;}};
  };
  try {
    const pending=materializeAudio('https://m.126.net/cancelled-remote.mp3',{signal:controller.signal});
    while(!reading)await tick();
    controller.abort(new Error('节目已更新'));
    bytes.resolve(Buffer.alloc(1200));
    await assert.rejects(pending,/节目已更新/);
    assert.equal(requestSignal,controller.signal);
    assert.deepEqual(fs.readdirSync(path.join(config.paths.cache,'exclusive')),[]);
    const before=exclusiveStatus();
    await assert.rejects(playExclusive({uid:'fake-device',signal:controller.signal}),/节目已更新/);
    assert.deepEqual(exclusiveStatus(),before);
  } finally { bytes.resolve(Buffer.alloc(1200));globalThis.fetch=oldFetch; }
});

test('连接客户端时定期探测非ready语音通道',async()=>{
  const {laneEvents}=await import('../server/tts/pc5090.js');
  laneEvents.emit('status',{state:'error'});
  const oldProbe=services.probeTtsLane;
  let calls=0;
  services.probeTtsLane=async()=>{calls++;laneEvents.emit('status',{state:'ready'});return 'up';};
  try {
    ws.emit('close');
    for(const retry of retryCallbacks)await retry();
    assert.equal(calls,0);
    runtime.wss.emit('connection',ws);
    await settle();
    for(const retry of retryCallbacks)await retry();
    assert.equal(calls,1);
    for(const retry of retryCallbacks)await retry();
    assert.equal(calls,1);
  } finally { services.probeTtsLane=oldProbe; }
});

test('重启后重建隧道发现语音档未加载，新准备的节目自动恢复完整口播',async()=>{
  const pc=await import('../server/tts/pc5090.js');
  const cfg={baseUrl:'http://127.0.0.1:9',voice:'fake',sshHost:'fake-worker.invalid',jumpHost:'',tunnelHost:'fake-bridge.invalid',tunnelTarget:'fake-service.invalid:8080'};
  const failedStartup=()=>{
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};
    setImmediate(()=>child.emit('close',1));return child;
  };
  await assert.rejects(pc.ensureLane({cfg,probe:async()=>true,fetchFn:async()=>({ok:false}),spawnFn:failedStartup}));
  assert.equal(pc.getLaneStatus().state,'error');
  const oldProbe=services.probeTtsLane;
  let calls=0,tunnelReady=false,healthCalls=0,tunnelChild;
  const sshCalls=[];
  const spawnFn=(command,args)=>{
    sshCalls.push({command,args});
    assert.equal(command,'ssh');assert.ok(args.includes('-N'));
    assert.equal(args.includes('gpuctl'),false);assert.equal(args.includes('--force'),false);
    const child=new EventEmitter();child.stderr=new EventEmitter();child.exitCode=null;
    child.kill=()=>{if(child.exitCode!==null)return;child.exitCode=0;tunnelReady=false;child.emit('exit',0);child.emit('close',0);};
    tunnelChild=child;tunnelReady=true;return child;
  };
  const oldSynthesize=services.synthesize;
  services.synthesize=async()=>{calls++;return {url:'/tts/recovered-complete.mp3'};};
  services.probeTtsLane=({signal})=>pc.probeLane({cfg,signal,spawnFn,probe:async()=>tunnelReady,fetchFn:async url=>{
    assert.equal(url,`${cfg.baseUrl}/v1/health`);assert.equal(tunnelReady,true);healthCalls++;return {ok:false};
  }});
  services.plan=async()=>plan({say:'歇一会儿。',play:[{title:'恢复后新歌',artist:'恢复乐队'}]});
  try {
    const before=messages.filter(m=>m.kind==='ttsLane'&&m.state==='ready').length;
    for(const retry of retryCallbacks)await retry();
    assert.equal(sshCalls.length,1);assert.equal(healthCalls,1);
    assert.equal(pc.getLaneStatus().state,'ready');
    assert.equal(messages.filter(m=>m.kind==='ttsLane'&&m.state==='ready').length,before+1);
    process.env.CLAUDIO_SKIP_PREFETCH='0';episodeBuffer.ensure();await settle();
    assert.ok(calls>0);
    assert.equal(episodeBuffer.snapshot().next.voice.status,'ready');
    assert.equal(episodeBuffer.snapshot().next.queue[0].url,'/tts/recovered-complete.mp3');
  } finally {
    process.env.CLAUDIO_SKIP_PREFETCH='1';services.probeTtsLane=oldProbe;services.synthesize=oldSynthesize;
    tunnelChild?.kill();
  }
});
