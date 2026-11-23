// 5090 台式机上的 Fish S2-Pro 官方服务：POST {baseUrl}/v1/tts，音色用已注册的 reference_id。
// 网络：WSL 节点在外只能走 DERP 中继（几 KB/s、时通时断），默认经 Windows 节点开隧道到 WSL 的 tailnet 地址，
// 切档也经它跳（ssh -J）。来龙去脉见 g10 docs/PC-RTX5090.md「2026-10-31」节。
// 语音档按需加载：空闲 10 分钟卸载，冷启动约 2 分钟（编译缓存被清后约 3 分钟）；被别的任务登记占用时明确报错，不抢卡、不回退到 Fish 云端。
// 开 --compile 后合成比实时快（30–62 token/s，实时约需 21.5），但流式对短句没有提前量，所以按句切开逐句要 MP3：第一句好了就开口。
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { config } from '../config.js';
import { getSettings } from '../settings.js';
import { abortReason, delay, throwIfAborted, withAbort } from './abort.js';

export const ext = 'mp3';
// 通道状态（starting / busy / ready / offline / error），界面用它显示「语音启动中」「5090 在忙」。
export const laneEvents = new EventEmitter();
let lastLaneStatus = { state: 'ready' };
let laneCooldown = null;
const OCCUPIED_COOLDOWN = 10 * 60 * 1000;
const TRANSPORT_BACKOFF = 45000;

function laneError(message, code) {
  return Object.assign(new Error(message), { code });
}

function activeCooldown() {
  if (laneCooldown && Date.now() >= laneCooldown.until) laneCooldown = null;
  return laneCooldown;
}

function rememberFailure(error) {
  const ms = error.code === 'PC5090_OCCUPIED' ? OCCUPIED_COOLDOWN
    : error.code === 'PC5090_TRANSPORT' ? TRANSPORT_BACKOFF : 0;
  if (ms) laneCooldown = { error, until: Date.now() + ms };
}

function checkCooldown(bypassCooldown) {
  const cooldown = activeCooldown();
  if (cooldown && !bypassCooldown) throw cooldown.error;
}

export function getLaneStatus() { return { ...lastLaneStatus }; }
// 被占 / 连不上的冷却期内返回那次的错误：调用方可以当场跳过口播，不用等异步失败。
export function cooldownError() { return activeCooldown()?.error || null; }

function setLaneStatus(state, message) {
  if (lastLaneStatus.state === state && lastLaneStatus.message === message) return;
  lastLaneStatus = { state, ...(message ? { message } : {}) };
  laneEvents.emit('status', getLaneStatus());
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function currentPc5090Config() {
  const pc = getSettings().tts.pc5090;
  const env = config.tts.pc5090;
  return {
    baseUrl: String(pc.baseUrl).replace(/\/+$/, ''),
    voice: pc.voice,
    sshHost: env.sshHost,
    jumpHost: env.jumpHost,
    tunnelHost: env.tunnelHost,
    tunnelTarget: env.tunnelTarget,
    gpuctl: env.gpuctl,
    noPreempt: env.noPreempt !== false,
    whole: env.split !== true,
    style: String(env.style || '').trim(),
  };
}

export function probePort(baseUrl, { timeout = 5000, connect = net.connect, signal } = {}) {
  throwIfAborted(signal);
  const url = new URL(baseUrl);
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port });
    const finish = (open) => {
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      resolve(open);
    };
    const abort = () => { socket.destroy(); reject(abortReason(signal)); };
    signal?.addEventListener('abort', abort, { once: true });
    socket.setTimeout(timeout, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

// up：正常应答；busy：连上了但不回（服务单线程，给别人合成时健康检查也不回）；down：没起来或连不上。
// 经隧道时本机端口总能连上（是 ssh 在听），档没起来表现为连接被立刻断开。
export async function laneState(baseUrl, { fetchFn = fetch, probe = probePort, timeout = 5000, signal } = {}) {
  throwIfAborted(signal);
  if (!(await withAbort(probe(baseUrl, { signal, timeout }), signal))) return 'down';
  const timeoutSignal = AbortSignal.timeout(timeout);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    const res = await withAbort(fetchFn(`${baseUrl}/v1/health`, { signal: requestSignal }), requestSignal);
    return res.ok ? 'up' : 'down';
  } catch (error) {
    throwIfAborted(signal);
    return error?.name === 'TimeoutError' ? 'busy' : 'down';
  }
}

// ssh 会往 stderr 打 ** 开头的提醒（post-quantum 之类），取原因时跳过。
function lastLine(text) {
  return String(text || '').split('\n').map((line) => line.trim())
    .filter((line) => line && !line.startsWith('**')).pop() || '';
}

export function tunnelArgs(cfg) {
  const { port } = new URL(cfg.baseUrl);
  return [
    '-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=8',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    '-L', `127.0.0.1:${port}:${cfg.tunnelTarget}`, cfg.tunnelHost,
  ];
}

let tunnelChild = null;
let tunnelOpening = null;
process.once('exit', () => tunnelChild?.kill());

function closeTunnel(child) {
  if (tunnelChild === child) tunnelChild = null;
  child.kill();
}

// 共享任务自己持有 signal；最后一位有效调用者离开时才取消上游。
async function waitForShared(task, signal, abandon) {
  task.waiters += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    signal?.removeEventListener('abort', release);
    task.waiters -= 1;
    if (!task.waiters && !task.settled) {
      abandon();
      task.controller.abort(abortReason(signal));
    }
  };
  if (signal?.aborted) release();
  else signal?.addEventListener('abort', release, { once: true });
  try {
    await withAbort(task.promise, signal);
    throwIfAborted(signal);
  } finally { release(); }
}

async function openTunnel(cfg, { spawnFn, probe, interval, signal }) {
  throwIfAborted(signal);
  const child = spawnFn('ssh', tunnelArgs(cfg), { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  let failed = null;
  child.stderr?.on('data', (data) => { stderr = `${stderr}${data}`.slice(-2000); });
  child.once('error', (error) => { failed = error; });
  child.once('exit', () => { if (tunnelChild === child) tunnelChild = null; });
  tunnelChild = child;
  try {
    for (let index = 0; index < 40 && !failed && child.exitCode === null; index += 1) {
      if (await withAbort(probe(cfg.baseUrl, { timeout: 500, signal }), signal)) return;
      await delay(interval, signal);
    }
  } catch (error) {
    closeTunnel(child);
    throw error;
  }
  closeTunnel(child);
  const reason = failed?.message || lastLine(stderr);
  throw laneError(`连不上 5090：经 ${cfg.tunnelHost} 的隧道没开起来${reason ? `（${reason}）` : ''}`, 'PC5090_TRANSPORT');
}

// 地址指向本机端口时才开隧道；端口已经在听（自己开的或老板手动开的）就直接用。
export async function ensureTunnel(cfg, { spawnFn = spawn, probe = probePort, interval = 250, signal } = {}) {
  throwIfAborted(signal);
  if (!cfg.tunnelHost || !LOOPBACK.has(new URL(cfg.baseUrl).hostname)) return;
  if (await withAbort(probe(cfg.baseUrl, { timeout: 500, signal }), signal)) return;
  throwIfAborted(signal);
  if (!tunnelOpening || tunnelOpening.controller.signal.aborted) {
    const task = { controller: new AbortController(), waiters: 0, settled: false, promise: null };
    tunnelOpening = task;
    task.promise = Promise.resolve()
      .then(() => openTunnel(cfg, { spawnFn, probe, interval, signal: task.controller.signal }))
      .finally(() => {
        task.settled = true;
        if (tunnelOpening === task) tunnelOpening = null;
      });
    task.promise.catch(() => {});
  }
  const task = tunnelOpening;
  await waitForShared(task, signal, () => { if (tunnelOpening === task) tunnelOpening = null; });
}

// 开 --compile 后冷启动 103–109 秒，编译缓存被清后约 190 秒。
export function runGpuctlEnsure(cfg, { spawnFn = spawn, timeout = 240000, signal } = {}) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const gpuctl = ['gpuctl', 'ensure', 'tts', ...(cfg.noPreempt === false ? [] : ['--no-preempt']), '--wait', '10'];
    let command = 'wsl.exe';
    let args = ['-e', ...gpuctl];
    if (cfg.gpuctl !== 'wsl') {
      if (!cfg.sshHost) { reject(laneError('没配 PC5090_SSH_HOST，拉不起 5090 语音档', 'PC5090_TRANSPORT')); return; }
      command = 'ssh';
      args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8'];
      if (cfg.jumpHost) args.push('-J', cfg.jumpHost);
      args.push(cfg.sshHost, ...gpuctl);
    }
    let child;
    try { child = spawnFn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { reject(laneError(`连不上 5090：${error.message}`, 'PC5090_TRANSPORT')); return; }
    let output = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const abort = () => { finish(abortReason(signal)); child.kill(); };
    const timer = setTimeout(() => { finish(laneError('5090 语音启动超时', 'PC5090_OTHER')); child.kill(); }, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (error) => {
      finish(laneError(`连不上 5090：${error.message}`, 'PC5090_TRANSPORT'));
    });
    child.on('close', (code) => {
      if (code === 0) return finish();
      const reason = lastLine(output) || `退出码 ${code}`;
      if (/\[arbiter\]|占用/.test(output)) return finish(laneError(`5090 正被别的任务占着，语音暂时用不了：${reason}`, 'PC5090_OCCUPIED'));
      const transport = code === 255 || /ssh:|ConnectTimeout|unknown port|connection (?:refused|timed out|closed)|could not resolve hostname/i.test(output);
      finish(laneError(`5090 语音没起来：${reason}`, transport ? 'PC5090_TRANSPORT' : 'PC5090_OTHER'));
    });
  });
}

async function waitReady(cfg, { fetchFn, spawnFn, probe, attempts = 30, interval = 2000, signal }) {
  for (let index = 0; index < attempts; index += 1) {
    throwIfAborted(signal);
    await ensureTunnel(cfg, { spawnFn, probe, signal });
    if (await laneState(cfg.baseUrl, { fetchFn, probe, signal }) !== 'down') return;
    await delay(interval, signal);
  }
  throw new Error('5090 语音启动后一直没有就绪');
}

// 自己正在合成时服务不回健康检查，这时不查，免得把自己当成「别人在用」。
let inflight = 0;
let starting = null;
let ensuring = 0;
let probing = null;

// 后台重连隧道但不切档；档没起来也允许下次口播按需启动。
export async function probeLane({
  fetchFn = fetch, spawnFn = spawn, probe = probePort, cfg, timeout = 2000, signal,
} = {}) {
  throwIfAborted(signal);
  if (probing || ensuring > 0 || starting || inflight > 0) return 'busy';
  const activeCfg = cfg ?? currentPc5090Config();
  const baseUrl = activeCfg.baseUrl;
  const previousStatus = lastLaneStatus;
  const task = { controller: new AbortController(), settled: false };
  probing = task;
  const probeSignal = signal ? AbortSignal.any([signal, task.controller.signal]) : task.controller.signal;
  let openedTunnel = null;
  const unchanged = () => probing === task && !ensuring && !starting && !inflight
    && lastLaneStatus === previousStatus && activeCfg.baseUrl === baseUrl
    && (cfg || currentPc5090Config().baseUrl === baseUrl);
  try {
    try {
      await ensureTunnel(activeCfg, {
        probe, signal: probeSignal,
        spawnFn: (...args) => { openedTunnel = spawnFn(...args); return openedTunnel; },
      });
    } catch (error) {
      throwIfAborted(probeSignal);
      task.settled = true;
      if (unchanged() && lastLaneStatus.state !== 'offline') setLaneStatus('offline', '5090 暂时离线，稍后重试');
      return 'down';
    }
    const state = await laneState(baseUrl, { fetchFn, probe, timeout, signal: probeSignal });
    throwIfAborted(probeSignal);
    if (ensuring || starting || inflight > 0) return 'busy';
    if (activeCfg.baseUrl !== baseUrl || (!cfg && currentPc5090Config().baseUrl !== baseUrl)) return 'down';
    // ready 广播会同步触发口播重试，此时探测已完成，不再被它抢占。
    task.settled = true;
    if (unchanged()) {
      if (state === 'up') { laneCooldown = null; setLaneStatus('ready'); }
      else if (state === 'down' && !activeCooldown()) setLaneStatus('ready');
    }
    return state;
  } catch (error) {
    throwIfAborted(signal);
    if (task.controller.signal.aborted) return 'busy';
    throw error;
  } finally {
    // 取消只收走探测新开的隧道；已存在或已交给前台的共享隧道保留。
    if (signal?.aborted && openedTunnel && tunnelChild === openedTunnel
      && !ensuring && !starting && !inflight && !tunnelOpening?.waiters) closeTunnel(openedTunnel);
    if (probing === task) probing = null;
  }
}

// 返回 up 或 busy。没起来就经 gpuctl 拉起（同一时间只拉一次）。
export async function ensureLane(options = {}) {
  throwIfAborted(options.signal);
  // 冷却中的普通口播不抢占恢复探测，也不碰 ssh 或广播 starting。
  checkCooldown(options.bypassCooldown);
  ensuring += 1;
  if (probing && !probing.settled) probing.controller.abort();
  try { return await prepareLane(options); }
  finally { ensuring -= 1; }
}

async function prepareLane({
  fetchFn = fetch,
  spawnFn = spawn,
  probe = probePort,
  cfg = currentPc5090Config(),
  interval,
  signal,
  bypassCooldown = false,
} = {}) {
  throwIfAborted(signal);
  checkCooldown(bypassCooldown);
  if (inflight > 0) return 'up';
  try { await ensureTunnel(cfg, { spawnFn, probe, signal }); }
  catch (error) {
    throwIfAborted(signal);
    rememberFailure(error);
    if (error.code === 'PC5090_TRANSPORT') setLaneStatus('offline', error.message);
    throw error;
  }
  const state = await laneState(cfg.baseUrl, { fetchFn, probe, signal });
  throwIfAborted(signal);
  if (state === 'up') { laneCooldown = null; setLaneStatus('ready'); return state; }
  if (state === 'busy') {
    setLaneStatus('busy');
    return state;
  }
  // 健康检查期间另一位调用者可能刚收到拒绝。
  checkCooldown(bypassCooldown);
  if (!starting || starting.controller.signal.aborted) {
    const task = {
      controller: new AbortController(), waiters: 0, settled: false, promise: null,
      previousStatus: getLaneStatus(),
    };
    const sharedSignal = task.controller.signal;
    starting = task;
    setLaneStatus('starting');
    task.promise = Promise.resolve()
      .then(() => runGpuctlEnsure(cfg, { spawnFn, signal: sharedSignal }))
      .then(() => waitReady(cfg, { fetchFn, spawnFn, probe, interval, signal: sharedSignal }))
      .then(
        () => { if (starting === task) { laneCooldown = null; setLaneStatus('ready'); } },
        (error) => {
          if (starting === task && !sharedSignal.aborted) {
            rememberFailure(error);
            setLaneStatus('error', error.message);
          }
          throw error;
        },
      )
      .finally(() => {
        task.settled = true;
        if (starting === task) starting = null;
      });
    task.promise.catch(() => {});
  }
  const task = starting;
  await waitForShared(task, signal, () => {
    if (starting !== task) return;
    starting = null;
    if (lastLaneStatus.state === 'starting') setLaneStatus(task.previousStatus.state, task.previousStatus.message);
  });
  return 'up';
}

// 预热：开节目或用户开口时先把通道叫起来，和大模型写稿同时进行。
export function warm() {
  if (getSettings().tts.provider !== 'pc5090') return;
  ensureLane().catch((error) => console.warn('[5090 语音]', error.message));
}

// 一次只送一句。现念的口播排在后台预生成前面；它每念完一句马上要下一句，所以放锁后留一小会儿，免得预生成插进来。
const waiting = { high: [], low: [] };
let held = false;

function grant() {
  if (held) return;
  const next = waiting.high.shift() || waiting.low.shift();
  if (!next) return;
  held = true;
  next.grant();
}

function acquire(priority, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const entry = { grant: () => { signal?.removeEventListener('abort', abort); resolve(); } };
    const abort = () => {
      const index = waiting[priority].indexOf(entry);
      if (index >= 0) waiting[priority].splice(index, 1);
      signal.removeEventListener('abort', abort);
      reject(abortReason(signal));
    };
    signal?.addEventListener('abort', abort, { once: true });
    waiting[priority].push(entry);
    grant();
  });
}

function release(priority) {
  held = false;
  if (priority === 'high' && !waiting.high.length) setTimeout(grant, 100);
  else grant();
}

// 按句切。太短的句子并到下一句，免得一字一顿；第一句太长就在逗号处先切一刀，早点开口。
export function splitSentences(text, { min = 8, firstMax = 24 } = {}) {
  const parts = String(text || '').match(/[^。！？!?；;…\n]+(?:[。！？!?；;…\n]+[”」』）)]*)?/g) || [];
  const out = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (out.length && out[out.length - 1].length < min) out[out.length - 1] += part;
    else out.push(part);
  }
  if (out.length > 1 && out[out.length - 1].length < min) out[out.length - 2] += out.pop();
  const head = out[0] || '';
  if (head.length > firstMax) {
    const cut = head.slice(min - 1).search(/[，,：:]/);
    const at = min + cut;
    if (cut >= 0 && head.length - at >= min) out.splice(0, 1, head.slice(0, at), head.slice(at).trim());
  }
  return out;
}

// 点歌先单独合成、马上念的第一句：一句完整的话、约 3 秒（14 字起），盖住后半段整段合成的时间。
// 2026-11-23 实测首句只有约 1.4 秒（逗号处断开的半句），后半段还没合成完，口播中间停了约 4 秒。
// 第一句不够 14 字就接下一句；整句超过 40 字才在 14 字后的逗号处断。后半段太短（不到 8 字）就不拆，整段一次要。
export function splitHead(text, { minChars = 14, maxChars = 40, minRest = 8 } = {}) {
  const sentences = splitSentences(text, { firstMax: Infinity });
  let head = '';
  let i = 0;
  while (i < sentences.length && head.length < minChars) {
    // 已经有半句以上、再接一整句会超长：就用现在这句，不为凑字数拖慢开口。
    if (head.length >= minRest && head.length + sentences[i].length > maxChars) break;
    head += sentences[i++];
  }
  let rest = sentences.slice(i).join('');
  if (head.length > maxChars) {
    const cut = head.slice(minChars - 1).search(/[，,：:]/);
    if (cut >= 0) { const at = minChars + cut; rest = head.slice(at).trim() + rest; head = head.slice(0, at); }
  }
  return rest.length >= minRest ? [head, rest] : [head + rest];
}

const MP3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_RATES = [44100, 48000, 32000];

// 只认 MPEG-1 Layer III（Fish 出的就是这种，VBR）；别的返回 null。
function frameAt(buffer, offset) {
  if (offset + 4 > buffer.length || buffer[offset] !== 0xff || (buffer[offset + 1] & 0xfe) !== 0xfa) return null;
  const bitrate = MP3_BITRATES[buffer[offset + 2] >> 4] * 1000;
  const rate = MP3_RATES[(buffer[offset + 2] >> 2) & 0x03];
  if (!bitrate || !rate) return null;
  const crc = (buffer[offset + 1] & 0x01) === 0 ? 2 : 0;
  return {
    rate,
    length: Math.floor((144 * bitrate) / rate) + ((buffer[offset + 2] >> 1) & 0x01),
    tagAt: offset + 4 + crc + ((buffer[offset + 3] >> 6) === 0x03 ? 17 : 32),
  };
}

function skipId3(buffer) {
  if (buffer.length < 10 || buffer.subarray(0, 3).toString('latin1') !== 'ID3') return 0;
  return 10 + (((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f));
}

// 去掉 ID3 和开头的 Xing / Info 帧，数出音频帧和时长。几句拼成一条流时，第一句的 Xing 会让播放器把它的时长当成全长。
export function mp3Audio(buffer) {
  let start = skipId3(buffer);
  const head = frameAt(buffer, start);
  if (head) {
    const tag = buffer.subarray(head.tagAt, head.tagAt + 4).toString('latin1');
    if (tag === 'Xing' || tag === 'Info') start += head.length;
  }
  const rate = frameAt(buffer, start)?.rate || 44100;
  let frames = 0;
  for (let at = start, frame; (frame = frameAt(buffer, at)); at += frame.length) frames += 1;
  return { audio: buffer.subarray(start), frames, seconds: (frames * 1152) / rate };
}

// 拼好的整段补一个 Xing 帧（总帧数、总字节），播放器才能算对时长；字幕按时长走。
export function withXing(buffer) {
  const { audio, frames } = mp3Audio(buffer);
  const first = frameAt(audio, 0);
  if (!first || !frames) return buffer;
  const length = Math.floor((144 * 128000) / first.rate);
  const frame = Buffer.alloc(length);
  audio.copy(frame, 0, 0, 4);
  frame[1] |= 0x01; // 不带 CRC
  frame[2] = (9 << 4) | (frame[2] & 0x0c); // 128k、不补位，采样率照旧
  const tagAt = 4 + ((frame[3] >> 6) === 0x03 ? 17 : 32);
  frame.write('Xing', tagAt, 'latin1');
  frame.writeUInt32BE(0x03, tagAt + 4);
  frame.writeUInt32BE(frames, tagAt + 8);
  frame.writeUInt32BE(length + audio.length, tagAt + 12);
  return Buffer.concat([frame, audio]);
}

async function readAll(body, signal) {
  const reader = body.getReader();
  const chunks = [];
  const abort = () => { Promise.resolve(reader.cancel(abortReason(signal))).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      const { value, done } = await withAbort(reader.read(), signal);
      throwIfAborted(signal);
      if (done) break;
      if (value?.length) chunks.push(Buffer.from(value));
    }
  } finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
  return Buffer.concat(chunks);
}

async function requestSentence(text, { cfg, fetchFn, signal, priority }) {
  await acquire(priority, signal);
  inflight += 1;
  const startedAt = Date.now();
  try {
    throwIfAborted(signal);
    const res = await withAbort(fetchFn(`${cfg.baseUrl}/v1/tts`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: cfg.style ? `${cfg.style} ${text}` : text, // 语气提示只影响念法，不会被念出来
        reference_id: cfg.voice,
        format: 'mp3',
        use_memory_cache: 'on',
        normalize: true,
      }),
    }), signal);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`5090 语音 ${res.status}: ${String(detail).slice(0, 300)}`);
    }
    if (!res.body) throw new Error('5090 语音返回空音频流');
    const result = { ...mp3Audio(await readAll(res.body, signal)), ms: Date.now() - startedAt };
    throwIfAborted(signal);
    laneCooldown = null;
    setLaneStatus('ready');
    return result;
  } finally {
    inflight -= 1;
    release(priority);
  }
}

// 开口前要攒够几秒：后面每一句都得在已攒的念完之前合成好。rate = 合成耗时 / 音频时长。
export function bufferNeeded(rest, rate) {
  let need = 0;
  let before = 0;
  for (const seconds of rest) {
    need = Math.max(need, rate * (before + seconds) - before);
    before += seconds;
  }
  return need;
}

// 逐句合成。比实时快就第一句好了开口；比实时慢就攒到后面不会断再开口，宁可晚开口，不在句子中间停。
export async function* stream(text, {
  signal,
  fetchFn = fetch,
  spawnFn = spawn,
  probe = probePort,
  cfg = currentPc5090Config(),
  priority = 'high',
  bypassCooldown = false,
} = {}) {
  const state = await ensureLane({ fetchFn, spawnFn, probe, cfg, signal, bypassCooldown });
  // 5090 在给别人合成时每句都要重新排队，这时整段一次要。
  // 整段念得自然但要等算完才开口：点歌（high）先单独合成第一句马上开口，其余整段接上；后台备节目（low）照旧整段。
  const clean = String(text).trim();
  const halves = splitHead(clean);
  const headFirst = state !== 'busy' && cfg.whole && priority === 'high' && halves.length > 1;
  const pieces = headFirst ? halves : state === 'busy' || cfg.whole ? [clean] : splitSentences(text);
  const pending = [];
  let started = false;
  let spentMs = 0;
  let seconds = 0;
  let chars = 0;
  for (const [index, piece] of pieces.entries()) {
    const part = await requestSentence(piece, { cfg, fetchFn, signal, priority });
    if (started) {
      if (part.audio.length) yield part.audio;
      continue;
    }
    pending.push(part.audio);
    spentMs += part.ms;
    seconds += part.seconds;
    chars += piece.length;
    if (seconds <= 0) continue;
    // 首句开口时剩下一段整段合成，实测（2026-11-23）比首句念完快，直接开口。
    if (headFirst) { started = true; for (const audio of pending.splice(0)) if (audio.length) yield audio; continue; }
    const rest = pieces.slice(index + 1).map((next) => (next.length * seconds) / chars);
    if (bufferNeeded(rest, spentMs / 1000 / seconds) * 1.1 <= seconds) {
      started = true;
      for (const audio of pending.splice(0)) if (audio.length) yield audio;
    }
  }
  for (const audio of pending) if (audio.length) yield audio;
}

export async function synthesize(text, options = {}) {
  const chunks = [];
  for await (const chunk of stream(text, { priority: 'low', ...options })) chunks.push(chunk);
  return withXing(Buffer.concat(chunks));
}

// 公用版的一句短口播，经 8099 名额服务来要（server/ncm-shared.js）。只在老板这边闲着时顺手念：
// 冷却中、正在合成 / 排队 / 拉起 / 探测、隧道没开，一律不念；不开隧道、不调 gpuctl，排队也排在老板后面。
// 返回 mp3；不合适或失败返回 null，公用版就跳过口播。
export async function synthesizeIfIdle(text, { cfg = currentPc5090Config(), fetchFn = fetch, probe = probePort, timeout = 8000 } = {}) {
  const idle = () => !activeCooldown() && lastLaneStatus.state === 'ready'
    && !probing && !ensuring && !starting && !inflight && !held && !waiting.high.length && !waiting.low.length;
  if (!idle()) return null;
  try {
    if (LOOPBACK.has(new URL(cfg.baseUrl).hostname) && !(await probe(cfg.baseUrl, { timeout: 300 }))) return null;
    if (!idle()) return null;
    const part = await requestSentence(text, { cfg, fetchFn, signal: AbortSignal.timeout(timeout), priority: 'low' });
    return part.frames ? withXing(Buffer.from(part.audio)) : null;
  } catch {
    return null;
  }
}

export async function testConnection(text = 'Claudio 语音连接正常。', options = {}) {
  const startedAt = Date.now();
  let firstByteAt = null;
  const controller = new AbortController();
  // 冷启动约 2 分钟（编译缓存被清后约 3 分钟），测试要给够时间。
  const timer = setTimeout(() => controller.abort(new Error('5090 语音测试超时')), 300000);
  const chunks = [];
  try {
    for await (const chunk of stream(text, { ...options, signal: controller.signal, bypassCooldown: true })) {
      if (!firstByteAt) firstByteAt = Date.now();
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(timer);
  }
  if (!chunks.length) throw new Error('5090 语音连接成功但没有返回音频');
  const finishedAt = Date.now();
  const current = currentPc5090Config();
  return {
    audio: withXing(Buffer.concat(chunks)),
    model: current.voice,
    hasVoice: Boolean(current.voice),
    firstAudioMs: (firstByteAt || finishedAt) - startedAt,
    totalMs: finishedAt - startedAt,
  };
}
