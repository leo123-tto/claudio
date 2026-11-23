import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  bufferNeeded,
  ensureLane,
  ensureTunnel,
  getLaneStatus,
  laneEvents,
  laneState,
  mp3Audio,
  probeLane,
  probePort,
  runGpuctlEnsure,
  splitSentences,
  stream,
  synthesize,
  testConnection,
  tunnelArgs,
  withXing,
  synthesizeIfIdle,
} from '../server/tts/pc5090.js';

const cfg = {
  baseUrl: 'http://127.0.0.1:9',
  voice: 'claudio',
  sshHost: 'gpu-wsl',
  jumpHost: 'gpu-win',
  tunnelHost: '',
  tunnelTarget: '',
};
const tunnelCfg = { ...cfg, baseUrl: 'http://127.0.0.1:18081', tunnelHost: 'gpu-win', tunnelTarget: '192.0.2.40:8080' };
const open = async () => true;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// MPEG-1 Layer III、128k、44.1k、单声道，一帧 417 字节、1152 个采样。
const HEADER = [0xff, 0xfb, 0x90, 0xc4];

function frames(count) {
  return Buffer.concat(Array.from({ length: count }, () => {
    const frame = Buffer.alloc(417, 0x11);
    Buffer.from(HEADER).copy(frame);
    return frame;
  }));
}

// Fish 出的 MP3：开头一帧 Xing，记的是这一段自己的帧数。
function fishMp3(count) {
  const xing = Buffer.alloc(417);
  Buffer.from(HEADER).copy(xing);
  xing.write('Xing', 21, 'latin1');
  xing.writeUInt32BE(0x0f, 25);
  xing.writeUInt32BE(count, 29);
  return Buffer.concat([xing, frames(count)]);
}

function bodyOf(buffer) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}

// 健康检查按 health 回；合成按 tts 回，并记下每次请求。
function fakeFish({ health = async () => ({ ok: true }), tts, log = [] }) {
  const fetchFn = async (url, options = {}) => {
    if (url.endsWith('/v1/health')) return health();
    const body = JSON.parse(options.body);
    log.push(body);
    return tts(body);
  };
  return { fetchFn, log };
}

function fakeSsh(calls, { code = 0, output = '' } = {}) {
  return (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      if (output) child.stderr.write(output);
      child.emit('close', code);
    });
    return child;
  };
}

function pendingSsh(children) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = 0;
    child.kill = () => { child.killed += 1; };
    children.push(child);
    return child;
  };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

async function failLane(message = 'fake startup failure') {
  await assert.rejects(() => ensureLane({
    cfg, probe: open, fetchFn: async () => ({ ok: false }),
    spawnFn: fakeSsh([], { code: 1, output: message }),
  }), new RegExp(message));
  assert.equal(getLaneStatus().state, 'error');
}

function fakeTunnel() {
  const calls = [];
  const children = [];
  let listening = false;
  const spawnFn = (command, args) => {
    calls.push({ command, args });
    assert.deepEqual(args, tunnelArgs(tunnelCfg));
    const child = pendingSsh(children)();
    listening = true;
    child.kill = () => {
      child.killed += 1;
      listening = false;
      child.exitCode = 0;
      child.emit('exit', 0);
    };
    return child;
  };
  return { calls, children, spawnFn, probe: async () => listening, close: () => children.at(-1)?.kill() };
}

test('MP3：去掉 ID3 和 Xing 帧，数出帧数；拼好的整段补回 Xing', () => {
  const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 10]), Buffer.alloc(10)]);
  const parsed = mp3Audio(Buffer.concat([id3, fishMp3(3)]));
  assert.equal(parsed.frames, 3);
  assert.ok(Math.abs(parsed.seconds - (3 * 1152) / 44100) < 1e-9);
  assert.deepEqual(parsed.audio, frames(3));

  const joined = Buffer.concat([mp3Audio(fishMp3(2)).audio, mp3Audio(fishMp3(3)).audio]);
  const fixed = withXing(joined);
  assert.equal(fixed.subarray(21, 25).toString('latin1'), 'Xing');
  assert.equal(fixed.readUInt32BE(29), 5);
  assert.equal(fixed.readUInt32BE(33), fixed.length);
  assert.deepEqual(mp3Audio(fixed).audio, joined);
  assert.deepEqual(withXing(Buffer.from('not mp3')), Buffer.from('not mp3'));
});

test('按句切：短句并到下一句，长的第一句在逗号处先切一刀', () => {
  assert.deepEqual(
    splitSentences('晚上好，这里是 Claudio。今晚有点凉！给你放一首老歌吧。'),
    ['晚上好，这里是 Claudio。', '今晚有点凉！给你放一首老歌吧。'],
  );
  assert.deepEqual(
    splitSentences('今晚城里有点凉，窗外还在下小雨，给你放一首适合发呆的歌。后面再聊。'),
    ['今晚城里有点凉，', '窗外还在下小雨，给你放一首适合发呆的歌。后面再聊。'],
  );
  assert.deepEqual(splitSentences('一段没有标点的话'), ['一段没有标点的话']);
  assert.deepEqual(splitSentences('好。'), ['好。']);
});

test('开口前要攒的秒数：比实时快只等第一句，比实时慢要攒到最后一句不断', () => {
  assert.ok(Math.abs(bufferNeeded([5, 5], 0.5) - 2.5) < 1e-9);
  assert.equal(bufferNeeded([5, 5], 2), 15);
  assert.equal(bufferNeeded([], 2), 0);
});

test('合成比实时快：逐句要 MP3，第一句好了就开口', async () => {
  const events = [];
  const { fetchFn, log } = fakeFish({
    tts: async (body) => {
      events.push(`tts:${body.text}`);
      return { ok: true, status: 200, body: bodyOf(fishMp3(40)) };
    },
  });
  const chunks = [];
  for await (const chunk of stream('晚上好，这里是 Claudio。今晚有点凉，给你放一首老歌吧。', { cfg, fetchFn, probe: open })) {
    events.push('yield');
    chunks.push(chunk);
  }
  assert.deepEqual(events, ['tts:晚上好，这里是 Claudio。', 'yield', 'tts:今晚有点凉，给你放一首老歌吧。', 'yield']);
  // normalize、use_memory_cache 是 S2 的参数，Drama 3 网关不认，不再传
  assert.deepEqual(log[0], {
    text: '晚上好，这里是 Claudio。',
    reference_id: 'claudio',
    format: 'mp3',
  });
  assert.deepEqual(Buffer.concat(chunks), frames(80));
});

test('合成比实时慢：攒到后面不会断才开口', async () => {
  const events = [];
  const { fetchFn } = fakeFish({
    tts: async () => {
      events.push('tts');
      await sleep(60);
      return { ok: true, status: 200, body: bodyOf(fishMp3(1)) };
    },
  });
  for await (const _chunk of stream('第一句话说得长一点。第二句话说得长一点。第三句话说得长一点。', { cfg, fetchFn, probe: open })) {
    events.push('yield');
  }
  assert.deepEqual(events, ['tts', 'tts', 'tts', 'yield', 'yield', 'yield']);
});

test('现念的口播插在后台预生成前面', async () => {
  const order = [];
  const { fetchFn } = fakeFish({
    tts: async (body) => {
      order.push(body.text);
      if (body.text.startsWith('预生成')) await sleep(30);
      return { ok: true, status: 200, body: bodyOf(fishMp3(40)) };
    },
  });
  const background = synthesize('预生成第一句话。预生成第二句话。', { cfg, fetchFn, probe: open });
  await sleep(5);
  for await (const _chunk of stream('现念的第一句话。现念的第二句话。', { cfg, fetchFn, probe: open })) { /* 念 */ }
  const file = await background;
  assert.deepEqual(order, ['预生成第一句话。', '现念的第一句话。', '现念的第二句话。', '预生成第二句话。']);
  assert.equal(file.readUInt32BE(29), 80);
});

test('5090 在给别人合成：整段一次要，并广播在忙和就绪', async () => {
  const states = [];
  const listener = (status) => states.push(status.state);
  laneEvents.on('status', listener);
  const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  const { fetchFn, log } = fakeFish({
    health: async () => { throw timeout; },
    tts: async () => ({ ok: true, status: 200, body: bodyOf(fishMp3(2)) }),
  });
  const chunks = [];
  for await (const chunk of stream('第一句话说得长一点。第二句话说得长一点。', { cfg, fetchFn, probe: open })) chunks.push(chunk);
  laneEvents.off('status', listener);
  assert.deepEqual(log.map((body) => body.text), ['第一句话说得长一点。第二句话说得长一点。']);
  assert.deepEqual(Buffer.concat(chunks), frames(2));
  assert.deepEqual(states, ['busy', 'ready']);
});

test('通道状态：正常应答为 up，连上不回为 busy，连不上或被断开为 down', async () => {
  const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  assert.equal(await laneState(cfg.baseUrl, { probe: async () => false }), 'down');
  assert.equal(await laneState(cfg.baseUrl, { probe: open, fetchFn: async () => ({ ok: true }) }), 'up');
  assert.equal(await laneState(cfg.baseUrl, { probe: open, fetchFn: async () => { throw timeout; } }), 'busy');
  assert.equal(await laneState(cfg.baseUrl, { probe: open, fetchFn: async () => { throw new TypeError('fetch failed'); } }), 'down');
});

test('语音档在就不碰 ssh；没起来只经跳板叫一次 gpuctl，并广播启动中和就绪', async () => {
  const sshCalls = [];
  await ensureLane({ cfg, probe: open, fetchFn: async () => ({ ok: true }), spawnFn: fakeSsh(sshCalls) });
  assert.equal(sshCalls.length, 0);

  let up = false;
  const fetchFn = async () => {
    if (!up) throw new TypeError('fetch failed');
    return { ok: true };
  };
  const states = [];
  const listener = (status) => states.push(status.state);
  laneEvents.on('status', listener);
  const spawnFn = (...args) => {
    up = true;
    return fakeSsh(sshCalls)(...args);
  };
  await Promise.all([
    ensureLane({ cfg, probe: open, fetchFn, spawnFn, interval: 1 }),
    ensureLane({ cfg, probe: open, fetchFn, spawnFn, interval: 1 }),
  ]);
  laneEvents.off('status', listener);
  assert.equal(sshCalls.length, 1);
  assert.deepEqual(sshCalls[0].args, [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-J', 'gpu-win',
    'gpu-wsl', 'gpuctl', 'ensure', 'tts', '--no-preempt', '--wait', '10',
  ]);
  assert.deepEqual(states, ['starting', 'ready']);
});

test('隧道：本机端口没在听才开，并发只开一个；地址不是本机就不开', async () => {
  const calls = [];
  let listening = false;
  const spawnFn = (command, args) => {
    calls.push({ command, args });
    listening = true;
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = () => {};
    return child;
  };
  const probe = async () => listening;
  await Promise.all([
    ensureTunnel(tunnelCfg, { spawnFn, probe, interval: 1 }),
    ensureTunnel(tunnelCfg, { spawnFn, probe, interval: 1 }),
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'ssh');
  assert.deepEqual(calls[0].args, tunnelArgs(tunnelCfg));
  assert.deepEqual(calls[0].args.slice(-3), ['-L', '127.0.0.1:18081:192.0.2.40:8080', 'gpu-win']);

  await ensureTunnel({ ...tunnelCfg, baseUrl: 'http://192.0.2.40:8080' }, { spawnFn, probe: async () => false });
  await ensureTunnel({ ...tunnelCfg, tunnelHost: '' }, { spawnFn, probe: async () => false });
  assert.equal(calls.length, 1);
});

test('隧道开不起来时报 ssh 的原因，跳过 ** 开头的提醒', async () => {
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = () => {};
    setImmediate(() => {
      child.stderr.write('** WARNING: connection is not using a post-quantum key exchange algorithm.\n'
        + 'ssh: connect to host 192.0.2.41 port 22: Operation timed out\n');
      setTimeout(() => {
        child.exitCode = 255;
        child.emit('exit', 255);
      }, 5);
    });
    return child;
  };
  await assert.rejects(
    () => ensureTunnel(tunnelCfg, { spawnFn, probe: async () => false, interval: 1 }),
    (error) => /隧道没开起来（ssh: connect to host 192\.0\.2\.41 port 22: Operation timed out）/.test(error.message)
      && !error.message.includes('post-quantum'),
  );
});

test('端口探测：能连上为真，被拒为假', async () => {
  const connect = (event) => () => {
    const socket = new EventEmitter();
    socket.setTimeout = () => {};
    socket.destroy = () => {};
    setImmediate(() => socket.emit(event));
    return socket;
  };
  assert.equal(await probePort('http://127.0.0.1:9', { connect: connect('connect') }), true);
  assert.equal(await probePort('http://127.0.0.1:9', { connect: connect('error') }), false);
});

test('5090 被别的任务占着时明确报错，不排队', async () => {
  await assert.rejects(
    () => runGpuctlEnsure(cfg, { spawnFn: fakeSsh([], { code: 1, output: '[arbiter] 5090 被「video-studio」占用：配音批量\n' }) }),
    /正被别的任务占着.*video-studio/,
  );
  await assert.rejects(
    () => runGpuctlEnsure(cfg, { spawnFn: fakeSsh([], { code: 255, output: 'ssh: connect to host gpu-wsl port 22: Operation timed out\n' }) }),
    /5090 语音没起来/,
  );
});

test('装在 5090 本机时经 wsl.exe 调 gpuctl，不走 ssh', async () => {
  const calls = [];
  await runGpuctlEnsure({ ...cfg, gpuctl: 'wsl' }, { spawnFn: fakeSsh(calls) });
  assert.deepEqual(calls, [{ command: 'wsl.exe', args: ['-e', 'gpuctl', 'ensure', 'tts', '--no-preempt', '--wait', '10'] }]);
});

test('旧盒子的受限钥匙不认 --no-preempt：关掉后只带 --wait', async () => {
  const calls = [];
  await runGpuctlEnsure({ ...cfg, noPreempt: false }, { spawnFn: fakeSsh(calls) });
  assert.equal(calls[0].command, 'ssh');
  assert.deepEqual(calls[0].args.slice(-5), ['gpuctl', 'ensure', 'tts', '--wait', '10']);
});

test('启动失败后健康检查恢复，通道广播 ready 清掉 error', async () => {
  const states = [];
  const listener = (status) => states.push(status.state);
  laneEvents.on('status', listener);
  try {
    await assert.rejects(() => ensureLane({
      cfg, probe: open,
      fetchFn: async () => ({ ok: false }),
      spawnFn: fakeSsh([], { code: 1, output: 'offline' }),
    }), /offline/);
    assert.equal(getLaneStatus().state, 'error');
    await ensureLane({ cfg, probe: open, fetchFn: async () => ({ ok: true }) });
    assert.equal(getLaneStatus().state, 'ready');
    assert.deepEqual(states, ['starting', 'error', 'ready']);
  } finally { laneEvents.off('status', listener); }
});

test('取消 gpuctl 冷启动会杀掉 ssh 并及时拒绝', async () => {
  const controller = new AbortController();
  let killed = false;
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { killed = true; };
    return child;
  };
  const pending = runGpuctlEnsure(cfg, { spawnFn, signal: controller.signal });
  controller.abort(new Error('cancel startup'));
  await assert.rejects(pending, /cancel startup/);
  assert.equal(killed, true);
});

test('两段口播共用冷启动，首个调用取消不会取消另一段', async () => {
  const firstController = new AbortController();
  const secondController = new AbortController();
  const children = [];
  let up = false;
  const fetchFn = async (url) => url.endsWith('/v1/health')
    ? { ok: up }
    : { ok: true, body: bodyOf(fishMp3(2)) };
  const options = { cfg, fetchFn, probe: open, spawnFn: pendingSsh(children) };
  const first = synthesize('第一段口播。', { ...options, signal: firstController.signal });
  first.catch(() => {});
  await nextTurn();
  const second = synthesize('第二段口播。', { ...options, signal: secondController.signal });
  second.catch(() => {});
  try {
    await nextTurn();
    assert.equal(children.length, 1);
    firstController.abort(new Error('cancel first voice'));
    await assert.rejects(first, /cancel first voice/);
    assert.equal(children[0].killed, 0);
    assert.equal(getLaneStatus().state, 'starting');
    up = true;
    children[0].emit('close', 0);
    assert.deepEqual(mp3Audio(await second).audio, frames(2));
    assert.equal(getLaneStatus().state, 'ready');
  } finally {
    firstController.abort();
    secondController.abort();
    await Promise.allSettled([first, second]);
  }
});

test('冷启动等候者全取消才杀 ssh，取消不广播通道故障', async () => {
  const firstController = new AbortController();
  const secondController = new AbortController();
  const children = [];
  const states = [];
  const listener = ({ state }) => states.push(state);
  laneEvents.on('status', listener);
  const options = { cfg, fetchFn: async () => ({ ok: false }), probe: open, spawnFn: pendingSsh(children) };
  const first = ensureLane({ ...options, signal: firstController.signal });
  first.catch(() => {});
  await nextTurn();
  const second = ensureLane({ ...options, signal: secondController.signal });
  second.catch(() => {});
  try {
    await nextTurn();
    secondController.abort(new Error('cancel joining voice'));
    await assert.rejects(second, /cancel joining voice/);
    assert.equal(children[0].killed, 0);
    firstController.abort(new Error('cancel last voice'));
    await assert.rejects(first, /cancel last voice/);
    await nextTurn();
    assert.equal(children[0].killed, 1);
    assert.equal(states.includes('error'), false);
    assert.equal(getLaneStatus().state, 'ready');
  } finally {
    firstController.abort();
    secondController.abort();
    laneEvents.off('status', listener);
    await Promise.allSettled([first, second]);
  }
});

test('两段口播共用隧道，首个调用取消不杀仍有人等待的 ssh', async () => {
  const firstController = new AbortController();
  const secondController = new AbortController();
  const children = [];
  let finishProbe;
  const opened = new Promise((resolve) => { finishProbe = resolve; });
  let probes = 0;
  const options = {
    spawnFn: pendingSsh(children), interval: 1,
    probe: async () => (++probes === 2 ? opened : false),
  };
  const first = ensureTunnel(tunnelCfg, { ...options, signal: firstController.signal });
  first.catch(() => {});
  await nextTurn();
  const second = ensureTunnel(tunnelCfg, { ...options, signal: secondController.signal });
  second.catch(() => {});
  try {
    await nextTurn();
    assert.equal(children.length, 1);
    firstController.abort(new Error('cancel first tunnel waiter'));
    await assert.rejects(first, /cancel first tunnel waiter/);
    assert.equal(children[0].killed, 0);
    finishProbe(true);
    await second;
  } finally {
    firstController.abort();
    secondController.abort();
    finishProbe(true);
    await Promise.allSettled([first, second]);
  }
});

test('隧道等候者全取消才杀 ssh，后续请求会重新开隧道', async () => {
  const firstController = new AbortController();
  const secondController = new AbortController();
  const children = [];
  const spawnFn = pendingSsh(children);
  const probe = async () => false;
  const first = ensureTunnel(tunnelCfg, { spawnFn, probe, interval: 1000, signal: firstController.signal });
  first.catch(() => {});
  await nextTurn();
  const second = ensureTunnel(tunnelCfg, { spawnFn, probe, interval: 1000, signal: secondController.signal });
  second.catch(() => {});
  let replacement;
  try {
    await nextTurn();
    secondController.abort(new Error('cancel joining tunnel waiter'));
    await assert.rejects(second, /cancel joining tunnel waiter/);
    assert.equal(children[0].killed, 0);
    firstController.abort(new Error('cancel last tunnel waiter'));
    await assert.rejects(first, /cancel last tunnel waiter/);
    assert.equal(children[0].killed, 1);
    let probes = 0;
    replacement = ensureTunnel(tunnelCfg, { spawnFn, probe: async () => ++probes > 1, interval: 1 });
    await replacement;
    assert.equal(children.length, 2);
  } finally {
    firstController.abort();
    secondController.abort();
    await Promise.allSettled([first, second, replacement]);
  }
});

test('等待合成锁时取消不会再发送第二个 TTS 请求', async () => {
  const controller = new AbortController();
  let finishFirst;
  let started;
  const firstStarted = new Promise((resolve) => { started = resolve; });
  const requests = [];
  const fetchFn = async (url, options = {}) => {
    if (url.endsWith('/v1/health')) return { ok: true };
    const { text } = JSON.parse(options.body);
    requests.push(text);
    if (text === '占住合成锁。') {
      started();
      await new Promise((resolve) => { finishFirst = resolve; });
    }
    return { ok: true, status: 200, body: bodyOf(fishMp3(40)) };
  };
  const first = synthesize('占住合成锁。', { cfg, fetchFn, probe: open });
  await firstStarted;
  const second = synthesize('排队后取消。', { cfg, fetchFn, probe: open, signal: controller.signal });
  controller.abort(new Error('cancel queued'));
  finishFirst();
  await first;
  await assert.rejects(second, /cancel queued/);
  assert.deepEqual(requests, ['占住合成锁。']);
});

test('5090 音频正文卡住时取消会关 reader 并释放合成锁', async () => {
  let started;
  const bodyStarted = new Promise((resolve) => { started = resolve; });
  let cancelled = false;
  let requestSignal;
  const fetchFn = async (url, options = {}) => {
    if (url.endsWith('/v1/health')) return { ok: true };
    requestSignal = options.signal;
    return {
      ok: true,
      body: new ReadableStream({
        pull() { started(); },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 }),
    };
  };
  const controller = new AbortController();
  const pending = synthesize('正文取消。', { cfg, fetchFn, probe: open, signal: controller.signal });
  await bodyStarted;
  controller.abort(new Error('stop body'));
  await assert.rejects(pending, /stop body/);
  assert.equal(requestSignal.aborted, true);
  assert.equal(cancelled, true);
  const next = fakeFish({ tts: async () => ({ ok: true, body: bodyOf(fishMp3(2)) }) });
  const result = await synthesize('下一句。', { cfg, fetchFn: next.fetchFn, probe: open });
  assert.deepEqual(mp3Audio(result).audio, frames(2));
});

test('新请求检查健康时取消旧冷启动，不复用已取消任务且旧清理不抹掉新任务', async () => {
  const oldController = new AbortController();
  const newController = new AbortController();
  const children = [];
  let healthCalls = 0;
  let up = false;
  let firstStarted;
  const firstSpawned = new Promise((resolve) => { firstStarted = resolve; });
  const fetchFn = async () => {
    healthCalls += 1;
    if (healthCalls === 2) return { get ok() { oldController.abort(new Error('replace old startup')); return false; } };
    return { ok: up };
  };
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    children.push(child);
    firstStarted();
    return child;
  };
  const old = ensureLane({ cfg, fetchFn, spawnFn, probe: open, signal: oldController.signal });
  old.catch(() => {});
  await firstSpawned;
  const replacement = ensureLane({ cfg, fetchFn, spawnFn, probe: open, signal: newController.signal });
  replacement.catch(() => {});
  try {
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(old, /replace old startup/);
    assert.equal(children.length, 2);
    // 旧任务的 finally 已经执行；第三个有效调用仍应共享新任务。
    const joined = ensureLane({ cfg, fetchFn, spawnFn, probe: open, signal: newController.signal });
    joined.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(children.length, 2);
    up = true;
    children[1].emit('close', 0);
    await Promise.all([replacement, joined]);
    assert.equal(getLaneStatus().state, 'ready');
  } finally {
    oldController.abort();
    newController.abort();
    await Promise.allSettled([old, replacement]);
  }
});

test('探测健康恢复会把 error 清成 ready，并给端口同样的短预算', async () => {
  await assert.rejects(() => ensureLane({
    cfg, probe: open, fetchFn: async () => ({ ok: false }),
    spawnFn: fakeSsh([], { code: 1, output: 'probe recovery offline' }),
  }), /offline/);
  const states = [];
  const listener = ({ state }) => states.push(state);
  laneEvents.on('status', listener);
  const probes = [];
  try {
    const state = await probeLane({
      cfg, timeout: 25,
      probe: async (baseUrl, options) => { probes.push({ baseUrl, timeout: options.timeout }); return true; },
      fetchFn: async (url) => { assert.equal(url, `${cfg.baseUrl}/v1/health`); return { ok: true }; },
    });
    assert.equal(state, 'up');
    assert.deepEqual(probes, [{ baseUrl: cfg.baseUrl, timeout: 25 }]);
    assert.deepEqual(states, ['ready']);
    assert.equal(getLaneStatus().state, 'ready');
  } finally { laneEvents.off('status', listener); }
});

test('无隧道的语音档没起来也清掉 error，busy 保持原状态且不切档', async () => {
  await assert.rejects(() => ensureLane({
    cfg, probe: open, fetchFn: async () => ({ ok: false }),
    spawnFn: fakeSsh([], { code: 1, output: 'keep previous error' }),
  }), /keep previous error/);
  let spawned = 0;
  const spawnFn = () => { spawned += 1; throw new Error('probe must not start gpuctl'); };
  assert.equal(await probeLane({
    cfg, spawnFn, probe: async () => false,
    fetchFn: async () => { throw new Error('closed port must not fetch'); },
  }), 'down');
  assert.equal(getLaneStatus().state, 'ready');
  await assert.rejects(() => ensureLane({
    cfg, probe: open, fetchFn: async () => ({ ok: false }),
    spawnFn: fakeSsh([], { code: 1, output: 'keep busy error' }),
  }), /keep busy error/);
  const before = getLaneStatus();
  assert.equal(await probeLane({
    cfg, spawnFn, probe: open,
    fetchFn: async () => { throw Object.assign(new Error('health timeout'), { name: 'TimeoutError' }); },
  }), 'busy');
  assert.equal(spawned, 0);
  assert.deepEqual(getLaneStatus(), before);
});

test('探测取消后，迟到的健康结果不能误报恢复', async () => {
  const before = getLaneStatus();
  const controller = new AbortController();
  let finishHealth;
  const health = new Promise((resolve) => { finishHealth = resolve; });
  const pending = probeLane({ cfg, probe: open, fetchFn: () => health, signal: controller.signal });
  pending.catch(() => {});
  await nextTurn();
  controller.abort(new Error('cancel read-only probe'));
  await assert.rejects(pending, /cancel read-only probe/);
  finishHealth({ ok: true });
  await nextTurn();
  assert.deepEqual(getLaneStatus(), before);
});

test('正在启动或合成时不探测，迟到探测也不覆盖新启动', async () => {
  let finishHealth;
  const health = new Promise((resolve) => { finishHealth = resolve; });
  const earlyProbe = probeLane({ cfg, probe: open, fetchFn: () => health });
  await nextTurn();
  const controller = new AbortController();
  const children = [];
  const startup = ensureLane({
    cfg, probe: open, fetchFn: async () => ({ ok: false }),
    spawnFn: pendingSsh(children), signal: controller.signal,
  });
  startup.catch(() => {});
  try {
    await nextTurn();
    const noProbe = async () => { throw new Error('starting lane must not probe'); };
    assert.equal(await probeLane({ cfg, probe: noProbe, fetchFn: noProbe }), 'busy');
    finishHealth({ ok: true });
    assert.equal(await earlyProbe, 'busy');
    assert.equal(getLaneStatus().state, 'starting');
  } finally {
    controller.abort(new Error('finish startup probe test'));
    finishHealth({ ok: true });
    await Promise.allSettled([startup, earlyProbe]);
  }

  let finishAudio;
  const audio = new Promise((resolve) => { finishAudio = resolve; });
  const pending = synthesize('合成时不探测。', {
    cfg, probe: open,
    fetchFn: async (url) => (url.endsWith('/v1/health') ? { ok: true } : audio),
  });
  try {
    await nextTurn();
    const noProbe = async () => { throw new Error('synthesizing lane must not probe'); };
    assert.equal(await probeLane({ cfg, probe: noProbe, fetchFn: noProbe }), 'busy');
  } finally {
    finishAudio({ ok: true, body: bodyOf(fishMp3(2)) });
    await pending;
  }
});

test('旧健康探测晚到，不能清掉探测期间新发生的启动错误', async () => {
  await ensureLane({ cfg, probe: open, fetchFn: async () => ({ ok: true }) });
  let finishHealth;
  const health = new Promise((resolve) => { finishHealth = resolve; });
  const pending = probeLane({ cfg, probe: open, fetchFn: () => health });
  await nextTurn();
  await assert.rejects(() => ensureLane({
    cfg, probe: open, fetchFn: async () => ({ ok: false }),
    spawnFn: fakeSsh([], { code: 1, output: 'new startup failure' }),
  }), /new startup failure/);
  const before = getLaneStatus();
  finishHealth({ ok: true });
  await pending;
  assert.deepEqual(getLaneStatus(), before);
});

test('探测期间地址变更，旧地址的健康结果不能恢复新配置', async () => {
  const before = getLaneStatus();
  const mutableCfg = { ...cfg };
  let finishHealth;
  const health = new Promise((resolve) => { finishHealth = resolve; });
  const pending = probeLane({ cfg: mutableCfg, probe: open, fetchFn: () => health });
  await nextTurn();
  mutableCfg.baseUrl = 'http://127.0.0.1:10';
  finishHealth({ ok: true });
  assert.equal(await pending, 'down');
  assert.deepEqual(getLaneStatus(), before);
});

test('重启后探测重建隧道，语音档未启动也 ready；下次口播复用隧道按需切档', async () => {
  await failLane();
  const tunnel = fakeTunnel();
  const states = [];
  const listener = ({ state }) => states.push(state);
  laneEvents.on('status', listener);
  try {
    assert.equal(await probeLane({
      cfg: tunnelCfg, ...tunnel,
      fetchFn: async () => { throw new TypeError('profile is not running'); },
    }), 'down');
    assert.equal(getLaneStatus().state, 'ready');
    assert.deepEqual(states, ['ready']);
    assert.equal(tunnel.calls.length, 1);
    assert.equal(tunnel.calls[0].command, 'ssh');
    const gpuctlCalls = [];
    let up = false;
    await ensureLane({
      cfg: tunnelCfg, probe: tunnel.probe,
      fetchFn: async () => ({ ok: up }),
      spawnFn: (command, args) => {
        assert.ok(args.includes('gpuctl'));
        assert.equal(args.includes('--force'), false);
        up = true;
        return fakeSsh(gpuctlCalls)(command, args);
      },
    });
    assert.equal(gpuctlCalls.length, 1);
    assert.equal(tunnel.calls.length, 1);
    assert.equal(tunnel.children[0].killed, 0);
  } finally {
    laneEvents.off('status', listener);
    tunnel.close();
  }
});

test('节点不可达时探测置 offline，重复失败不重复广播，也不调 gpuctl', async () => {
  await failLane();
  const states = [];
  const children = [];
  const listener = (status) => states.push(status);
  laneEvents.on('status', listener);
  const spawnFn = (command, args) => {
    assert.equal(command, 'ssh');
    assert.deepEqual(args, tunnelArgs(tunnelCfg));
    const child = pendingSsh(children)();
    child.exitCode = 255;
    return child;
  };
  try {
    for (let index = 0; index < 2; index += 1) {
      assert.equal(await probeLane({
        cfg: tunnelCfg, spawnFn, probe: async () => false,
        fetchFn: async () => assert.fail('隧道不通时不能请求健康检查'),
      }), 'down');
      assert.equal(getLaneStatus().state, 'offline');
    }
    assert.equal(states.length, 1);
    assert.match(states[0].message, /5090.*离线/);
    assert.equal(children.length, 2);
    assert.ok(children.every((child) => child.killed === 1));
  } finally { laneEvents.off('status', listener); }
});

test('两个并发探测只开一个隧道、做一次健康检查', async () => {
  await failLane();
  const tunnel = fakeTunnel();
  let finishHealth;
  let healthCalls = 0;
  const health = new Promise((resolve) => { finishHealth = resolve; });
  const options = { cfg: tunnelCfg, ...tunnel, fetchFn: () => { healthCalls += 1; return health; } };
  const first = probeLane(options);
  try {
    assert.equal(await probeLane(options), 'busy');
    await nextTurn();
    assert.equal(tunnel.calls.length, 1);
    assert.equal(healthCalls, 1);
    finishHealth({ ok: true });
    assert.equal(await first, 'up');
    assert.equal(getLaneStatus().state, 'ready');
  } finally {
    finishHealth({ ok: true });
    await first;
    tunnel.close();
  }
});

test('ensureLane 尚在检查健康时也阻止探测，取消探测不覆盖它', async () => {
  let finishHealth;
  const health = new Promise((resolve) => { finishHealth = resolve; });
  const foreground = ensureLane({ cfg, probe: open, fetchFn: () => health });
  try {
    await nextTurn();
    const noProbe = async () => assert.fail('前台健康检查期间不能并行探测');
    assert.equal(await probeLane({ cfg, probe: noProbe, fetchFn: noProbe }), 'busy');
  } finally {
    finishHealth({ ok: true });
    await foreground;
  }
});

test('前台启动抢占健康探测，沿用已经建好的同一隧道', async () => {
  await failLane();
  const tunnel = fakeTunnel();
  let finishHealth;
  let healthSignal;
  const health = new Promise((resolve) => { finishHealth = resolve; });
  const background = probeLane({
    cfg: tunnelCfg, ...tunnel,
    fetchFn: (_url, { signal }) => { healthSignal = signal; return health; },
  });
  try {
    await nextTurn();
    assert.equal(healthSignal.aborted, false);
    await ensureLane({ cfg: tunnelCfg, ...tunnel, fetchFn: async () => ({ ok: true }) });
    assert.equal(healthSignal.aborted, true);
    assert.equal(await background, 'busy');
    assert.equal(tunnel.calls.length, 1);
    assert.equal(tunnel.children[0].killed, 0);
    assert.equal(getLaneStatus().state, 'ready');
  } finally {
    finishHealth({ ok: false });
    await background;
    tunnel.close();
  }
});

test('取消正在开隧道的探测会杀 ssh，随后可重新探测', async () => {
  await failLane();
  const before = getLaneStatus();
  const controller = new AbortController();
  const children = [];
  const pending = probeLane({
    cfg: tunnelCfg, spawnFn: pendingSsh(children), probe: async () => false,
    fetchFn: async () => assert.fail('未开隧道不能检查健康'), signal: controller.signal,
  });
  pending.catch(() => {});
  await nextTurn();
  controller.abort(new Error('cancel tunnel probe'));
  await assert.rejects(pending, /cancel tunnel probe/);
  await nextTurn();
  assert.equal(children.length, 1);
  assert.equal(children[0].killed, 1);
  assert.deepEqual(getLaneStatus(), before);
  assert.equal(await probeLane({ cfg, probe: open, fetchFn: async () => ({ ok: true }) }), 'up');
});

test('健康检查中取消探测会收走新开的隧道，保留原有隧道', async () => {
  for (const existing of [false, true]) {
    await failLane();
    const before = getLaneStatus();
    const tunnel = fakeTunnel();
    if (existing) await ensureTunnel(tunnelCfg, tunnel);
    const controller = new AbortController();
    let finishHealth;
    const health = new Promise((resolve) => { finishHealth = resolve; });
    const pending = probeLane({ cfg: tunnelCfg, ...tunnel, fetchFn: () => health, signal: controller.signal });
    pending.catch(() => {});
    try {
      await nextTurn();
      controller.abort(new Error('cancel health with tunnel'));
      await assert.rejects(pending, /cancel health with tunnel/);
      assert.equal(tunnel.children[0].killed, existing ? 0 : 1);
      assert.deepEqual(getLaneStatus(), before);
      finishHealth({ ok: true });
      await nextTurn();
      assert.deepEqual(getLaneStatus(), before);
    } finally {
      finishHealth({ ok: true });
      await Promise.allSettled([pending]);
      if (!tunnel.children[0].killed) tunnel.close();
    }
  }
});

test('G8 拒绝分类、冷却、恢复探测与单次试听绕过', async (t) => {
  let now = 1000000;
  t.mock.method(Date, 'now', () => now);
  const down = async () => ({ ok: false });
  const up = async () => ({ ok: true });
  const reset = () => probeLane({ cfg, probe: open, fetchFn: up });
  t.after(reset);
  const refuse = async (calls = [], output = '[arbiter] GPU 仍被占用，拒绝启动', code = 1) => {
    let refusal;
    await assert.rejects(ensureLane({ cfg, probe: open, fetchFn: down,
      spawnFn: fakeSsh(calls, { code, output }) }), (error) => { refusal = error; return true; });
    return refusal;
  };
  const noIo = () => { throw new Error('冷却期间不能探测或启动'); };

  await t.test('gpuctl 给占用、传输和其他失败稳定 code，取消保持原始原因', async () => {
    for (const [code, output, expected] of [
      [1, '[arbiter] refusal', 'PC5090_OCCUPIED'],
      [1, 'GPU 仍被占用', 'PC5090_OCCUPIED'],
      [255, 'ssh: connection failed', 'PC5090_TRANSPORT'],
      [1, 'ConnectTimeout failed', 'PC5090_TRANSPORT'],
      [1, 'Connection closed by UNKNOWN port 65535', 'PC5090_TRANSPORT'],
      [1, 'model load failed', 'PC5090_OTHER'],
    ]) {
      await assert.rejects(runGpuctlEnsure(cfg, { spawnFn: fakeSsh([], { code, output }) }), { code: expected });
    }
    await assert.rejects(runGpuctlEnsure(cfg, { spawnFn: () => { throw new Error('ENOENT'); } }), { code: 'PC5090_TRANSPORT' });
    const children = [];
    const controller = new AbortController();
    const pending = runGpuctlEnsure(cfg, { spawnFn: pendingSsh(children), signal: controller.signal });
    const reason = new Error('主动取消');
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason && !error.code);
  });

  await t.test('占用后重复口播零 I/O、零 starting，返回同一拒绝', async () => {
    await reset();
    const calls = [];
    const refusal = await refuse(calls);
    assert.equal(refusal.code, 'PC5090_OCCUPIED');
    const states = [];
    const listener = ({ state }) => states.push(state);
    laneEvents.on('status', listener);
    try {
      for (let i = 0; i < 3; i += 1) {
        await assert.rejects(synthesize('这期口播。', { cfg, spawnFn: noIo, probe: noIo, fetchFn: noIo }), (error) => error === refusal);
      }
      assert.equal(calls.length, 1);
      assert.deepEqual(states, []);
    } finally { laneEvents.off('status', listener); }
  });

  await t.test('冷却中的 down / busy 不置 ready，up 清冷却并广播 ready', async () => {
    await reset();
    const refusal = await refuse();
    const states = [];
    const listener = ({ state }) => states.push(state);
    laneEvents.on('status', listener);
    try {
      assert.equal(await probeLane({ cfg, probe: open, fetchFn: down, spawnFn: noIo }), 'down');
      assert.equal(await probeLane({ cfg, probe: open, spawnFn: noIo, fetchFn: async () => {
        throw Object.assign(new Error('busy'), { name: 'TimeoutError' });
      } }), 'busy');
      assert.deepEqual(states, []);
      await assert.rejects(ensureLane({ cfg, probe: noIo }), (error) => error === refusal);
      assert.equal(await reset(), 'up');
      assert.deepEqual(states, ['ready']);
      assert.equal(await ensureLane({ cfg, probe: open, fetchFn: up, spawnFn: noIo }), 'up');
    } finally { laneEvents.off('status', listener); }
  });

  await t.test('冷却中口播不取消正在进行的恢复探测', async () => {
    await reset();
    const refusal = await refuse();
    let resolveHealth, probeSignal;
    const recovery = probeLane({ cfg, probe: open, fetchFn: (_, { signal }) => {
      probeSignal = signal;
      return new Promise((resolve) => { resolveHealth = resolve; });
    } });
    while (!resolveHealth) await nextTurn();
    await assert.rejects(ensureLane({ cfg, probe: noIo, fetchFn: noIo, spawnFn: noIo }), (error) => error === refusal);
    assert.equal(probeSignal.aborted, false);
    resolveHealth({ ok: true });
    assert.equal(await recovery, 'up');
    assert.equal(getLaneStatus().state, 'ready');
  });

  await t.test('十分钟到期后并发口播共享一次启动', async () => {
    await reset();
    const refusal = await refuse();
    now += 10 * 60 * 1000 - 1;
    await assert.rejects(ensureLane({ cfg, probe: noIo }), (error) => error === refusal);
    now += 1;
    let ready = false;
    const children = [];
    const options = { cfg, probe: open, fetchFn: async () => ({ ok: ready }), spawnFn: pendingSsh(children) };
    const callers = [ensureLane(options), ensureLane(options), ensureLane(options)];
    await nextTurn();
    assert.equal(children.length, 1);
    ready = true;
    children[0].emit('close', 0);
    assert.deepEqual(await Promise.all(callers), ['up', 'up', 'up']);
  });

  await t.test('到期后探测 down 恢复按需启动资格', async () => {
    await reset();
    await refuse();
    now += 10 * 60 * 1000;
    assert.equal(await probeLane({ cfg, probe: open, fetchFn: down, spawnFn: noIo }), 'down');
    assert.equal(getLaneStatus().state, 'ready');
    let ready = false;
    const calls = [];
    const ssh = fakeSsh(calls);
    await ensureLane({ cfg, probe: open, fetchFn: async () => ({ ok: ready }),
      spawnFn: (...args) => { const child = ssh(...args); ready = true; return child; } });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes('--no-preempt'));
    assert.equal(calls[0].args.includes('--force'), false);
  });

  await t.test('试听仅这一次绕过，失败后普通口播继续冷却', async () => {
    await reset();
    await refuse();
    const calls = [];
    await assert.rejects(testConnection('试听。', { cfg, probe: open, fetchFn: down,
      spawnFn: fakeSsh(calls, { code: 1, output: '[arbiter] GPU 占用' }) }), { code: 'PC5090_OCCUPIED' });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes('--no-preempt'));
    assert.equal(calls[0].args.includes('--force'), false);
    await assert.rejects(ensureLane({ cfg, probe: noIo, spawnFn: noIo, fetchFn: noIo }), { code: 'PC5090_OCCUPIED' });
  });

  await t.test('试听成功贯穿 stream 和 ensureLane，并恢复普通口播', async () => {
    await reset();
    await refuse();
    const calls = [];
    let ready = false;
    const ssh = fakeSsh(calls);
    const fish = fakeFish({ health: async () => ({ ok: ready }),
      tts: async () => ({ ok: true, body: bodyOf(fishMp3(10)) }) });
    const result = await testConnection('试听正常。', { cfg, probe: open, fetchFn: fish.fetchFn,
      spawnFn: (...args) => { const child = ssh(...args); ready = true; return child; } });
    assert.ok(result.audio.length);
    assert.equal(calls.length, 1);
    assert.equal(fish.log.length, 1);
    assert.equal(await ensureLane({ cfg, probe: open, fetchFn: up, spawnFn: noIo }), 'up');
  });

  await t.test('取消启动不设冷却，迟到的占用结果也不能设置', async () => {
    await reset();
    const children = [];
    const controller = new AbortController();
    const pending = ensureLane({ cfg, probe: open, fetchFn: down, spawnFn: pendingSsh(children), signal: controller.signal });
    while (!children.length) await nextTurn();
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    children[0].stderr.write('[arbiter] 占用');
    children[0].emit('close', 1);
    await nextTurn();
    assert.equal(await ensureLane({ cfg, probe: open, fetchFn: up, spawnFn: noIo }), 'up');
  });

  await t.test('传输失败只退避 45 秒，普通启动错误不进入冷却', async () => {
    await reset();
    const refusal = await refuse([], 'ssh: connect timeout', 255);
    assert.equal(refusal.code, 'PC5090_TRANSPORT');
    now += 44999;
    await assert.rejects(ensureLane({ cfg, probe: noIo }), (error) => error === refusal);
    now += 1;
    await refuse([], 'model load failed');
    assert.equal(await ensureLane({ cfg, probe: open, fetchFn: up, spawnFn: noIo }), 'up');
  });
});

test('整段合成并带语气提示：后台备节目一次请求，提示放在文字前面', async () => {
  const { fetchFn, log } = fakeFish({
    tts: async () => ({ ok: true, status: 200, body: bodyOf(fishMp3(40)) }),
  });
  const styled = { ...cfg, whole: true, style: '[warm radio host]' };
  for await (const _chunk of stream('晚上好，这里是 Claudio。今晚有点凉，给你放一首老歌吧。', { cfg: styled, fetchFn, probe: open, priority: 'low' })) { /* 念 */ }
  assert.equal(log.length, 1);
  assert.equal(log[0].text, '[warm radio host] 晚上好，这里是 Claudio。今晚有点凉，给你放一首老歌吧。');
});

test('点歌（high）整段模式：首句单独先合成并马上开口，其余整段一次接上', async () => {
  let releaseRest;
  const restGate = new Promise((resolve) => { releaseRest = resolve; });
  let calls = 0;
  const { fetchFn, log } = fakeFish({
    tts: async () => {
      calls += 1;
      if (calls === 2) await restGate;
      return { ok: true, status: 200, body: bodyOf(fishMp3(40)) };
    },
  });
  const styled = { ...cfg, whole: true, style: '[warm radio host]' };
  const it = stream('这个点还要去跑步，那就来点带劲的。鼓点密一点，步子跟着走就不累了。先放《红》。', { cfg: styled, fetchFn, probe: open })[Symbol.asyncIterator]();
  const first = await it.next();
  assert.equal(first.done, false);
  assert.equal(log.length, 1);
  assert.equal(log[0].text, '[warm radio host] 这个点还要去跑步，那就来点带劲的。');
  const second = it.next();
  releaseRest();
  assert.equal((await second).done, false);
  assert.equal((await it.next()).done, true);
  assert.equal(log[1].text, '[warm radio host] 鼓点密一点，步子跟着走就不累了。先放《红》。');
});

test('公用版短口播：闲着才念一句，隧道没开 / 失败就跳过，不拉起', async () => {
  const { fetchFn, log } = fakeFish({ tts: async () => ({ ok: true, status: 200, body: bodyOf(fishMp3(20)) }) });
  const audio = await synthesizeIfIdle('来一首安静的。', { cfg, fetchFn, probe: open });
  assert.ok(audio.length > 0);
  assert.equal(log.at(-1).text, '来一首安静的。');
  assert.equal(await synthesizeIfIdle('隧道没开', { cfg, fetchFn, probe: async () => false }), null);
  const broken = fakeFish({ tts: async () => ({ ok: false, status: 500, body: bodyOf(Buffer.alloc(0)) }) });
  assert.equal(await synthesizeIfIdle('念不出来', { cfg, fetchFn: broken.fetchFn, probe: open }), null);
});

test('点歌先念的第一句是一句完整的话、约 3 秒（14 字起），不在逗号处断成半句', async () => {
  const { splitHead } = await import('../server/tts/pc5090.js');
  assert.deepEqual(splitHead('好嘞，孙燕姿的《遇见》来了。这首歌陪很多人走过一段路，听的时候慢一点。'),
    ['好嘞，孙燕姿的《遇见》来了。', '这首歌陪很多人走过一段路，听的时候慢一点。']);
  assert.deepEqual(splitHead('到了。这首。'), ['到了。这首。']);
  // 凑够 14 字后没剩下多少：不拆，整段一次要。
  assert.deepEqual(splitHead('午休了。放首轻的。给你挑了一首安静的钢琴曲，适合趴一会儿。'),
    ['午休了。放首轻的。给你挑了一首安静的钢琴曲，适合趴一会儿。']);
  const [head, rest] = splitHead('午休时间，来点轻松的。给你放一首郭采洁的《你在 不在》，声音软软的，适合发会儿呆。');
  assert.equal(head, '午休时间，来点轻松的。');
  assert.ok(rest.startsWith('给你放一首'));
});

test('开头的时段语气提示每段都带，句内标记按白名单洗、切开的成对标记补齐', async () => {
  const { fetchFn, log } = fakeFish({ tts: async () => ({ ok: true, status: 200, body: bodyOf(fishMp3(40)) }) });
  const text = '[soft, slow] <whisper>夜深了，这首慢慢听。</whisper>[giggle]明天见，<slow>早点睡</slow>。';
  for await (const _chunk of stream(text, { cfg: { ...cfg, style: '[fallback]' }, fetchFn, probe: open })) { /* 收完 */ }
  assert.deepEqual(log.map((body) => body.text), [
    '[soft, slow] <whisper>夜深了，这首慢慢听</whisper>。',
    '[soft, slow] 明天见，早点睡。',
  ]);
});

test('网关支持流式：整段一次要，带 stream_audio，边收边吐、去掉开头的 Xing', async () => {
  const mp3 = fishMp3(20);
  const { fetchFn, log } = fakeFish({
    health: async () => ({ ok: true, json: async () => ({ status: 'ok', stream_audio: true }) }),
    tts: async () => ({ ok: true, status: 200, body: new ReadableStream({
      start(controller) {
        for (let at = 0; at < mp3.length; at += 1000) controller.enqueue(new Uint8Array(mp3.subarray(at, at + 1000)));
        controller.close();
      },
    }) }),
  });
  const chunks = [];
  for await (const chunk of stream('[warm, soft] 晚上好，这里是 Claudio。今晚有点凉，给你放一首老歌吧。', { cfg: { ...cfg, stream: true }, fetchFn, probe: open })) chunks.push(chunk);
  assert.equal(log.length, 1);
  assert.deepEqual(log[0], {
    text: '[warm, soft] 晚上好，这里是 Claudio。今晚有点凉，给你放一首老歌吧。', reference_id: 'claudio', format: 'mp3', stream_audio: true,
  });
  assert.ok(chunks.length > 1, '开头攒够 2 KB 就先吐');
  assert.deepEqual(Buffer.concat(chunks), frames(20));
  // 关掉流式（PC5090_STREAM=0）退回逐段
  log.length = 0;
  for await (const _chunk of stream('晚上好，这里是 Claudio。今晚有点凉，给你放一首老歌吧。', { cfg: { ...cfg, stream: false }, fetchFn, probe: open })) { /* 收完 */ }
  assert.equal(log.length, 2);
  assert.equal(log[0].stream_audio, undefined);
});
