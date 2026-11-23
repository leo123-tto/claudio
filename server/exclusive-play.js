// 把一首歌或一段口播单独送到已经接上的 CoreAudio 设备，不改系统默认输出。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { allowedAudioUrl, audioCache } from './audio-cache.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, 'native', 'play-device.swift');
const helperSource = path.join(here, 'native', 'audio-output.c');

let child = null;
let token = 0;
let status = { token: 0, running: false, event: 'idle', seconds: 0, duration: 0, error: '' };

function run(command, args, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('timeout'));
    }, timeoutMs);
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', (error) => { clearTimeout(timer); reject(error); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

function helperBinary() {
  return path.join(config.paths.cache, 'audio-output');
}

async function ensureHelper() {
  const binary = helperBinary();
  const sourceTime = fs.statSync(helperSource).mtimeMs;
  let binaryTime = 0;
  try { binaryTime = fs.statSync(binary).mtimeMs; } catch { /* 还没编译 */ }
  if (binaryTime >= sourceTime) return binary;
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  const compiled = await run('clang', [
    '-O2', '-framework', 'CoreAudio', '-framework', 'CoreFoundation', '-framework', 'CoreGraphics',
    helperSource, '-o', binary,
  ], 20000);
  if (compiled.code !== 0) throw new Error('audio helper compile failed');
  return binary;
}

function playerBinary() {
  return path.join(config.paths.cache, 'play-device');
}

async function ensurePlayer() {
  const binary = playerBinary();
  const sourceTime = fs.statSync(source).mtimeMs;
  let binaryTime = 0;
  try { binaryTime = fs.statSync(binary).mtimeMs; } catch { /* 还没编译 */ }
  if (binaryTime >= sourceTime) return binary;
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  const compiled = await run('swiftc', ['-O', source, '-o', binary], 60000);
  if (compiled.code !== 0) throw new Error('单独播放编译失败');
  return binary;
}

function allowedAudio(url) {
  return allowedAudioUrl(url);
}

async function fetchAudio(url, { signal } = {}) {
  let current = url;
  for (let hop = 0; hop <= 2; hop += 1) {
    signal?.throwIfAborted();
    const response = await fetch(current, { redirect: 'manual', signal });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      const next = new URL(response.headers.get('location'), current).href;
      if (!allowedAudio(next)) throw new Error('redirect to disallowed host');
      current = next;
      continue;
    }
    return response;
  }
  throw new Error('too many redirects');
}

export async function materializeAudio(url, { cache = audioCache, signal } = {}) {
  signal?.throwIfAborted();
  const clean = String(url || '').split('?')[0];
  if (clean.startsWith('/media/')) {
    const file = cache.resolve(clean);
    if (!file) throw new Error('音频缓存还没准备好');
    return file;
  }
  if (clean.startsWith('/tts/')) {
    const name = path.basename(clean);
    if (!/^[a-f0-9]+\.(mp3|wav|aiff|m4a)$/i.test(name)) throw new Error('语音文件无效');
    const file = path.join(config.paths.cacheTts, name);
    if (!fs.existsSync(file)) throw new Error('语音文件还没准备好');
    return file;
  }
  const remote = String(url || '');
  if (!allowedAudio(remote)) throw new Error('不允许的音频地址');
  const hash = createHash('sha1').update(clean).digest('hex').slice(0, 20);
  const dir = path.join(config.paths.cache, 'exclusive');
  fs.mkdirSync(dir, { recursive: true });
  const response = await fetchAudio(remote, { signal });
  signal?.throwIfAborted();
  if (!response.ok) {
    const expired = response.status === 401 || response.status === 403 || response.status === 410;
    throw new Error(expired ? '这首的播放链接失效了' : '这首音频下载失败');
  }
  const type = response.headers.get('content-type') || '';
  const ext = /mp4|m4a|aac/.test(type) ? 'm4a' : 'mp3';
  const file = path.join(dir, `${hash}.${ext}`);
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return file;
  const bytes = Buffer.from(await response.arrayBuffer());
  signal?.throwIfAborted();
  if (bytes.length < 1000 || bytes.length > 80 * 1024 * 1024) throw new Error('这首音频大小异常');
  fs.writeFileSync(file, bytes);
  return file;
}

async function audioIdFor(uid) {
  const binary = await ensureHelper();
  const listed = await run(binary, ['list'], 5000);
  const line = listed.stdout.trim().split(/\n/).filter(Boolean).at(-1) || '';
  const data = JSON.parse(line);
  const device = (data.devices || []).find((item) => item.uid === uid && item.audioId);
  if (!device) throw new Error('这只音箱还没单独接上');
  return Number(device.audioId);
}

function consume(proc, playToken) {
  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\n/);
    buffer = lines.pop() || '';
    if (playToken !== token) return;
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.event === 'ready') {
          status = { ...status, running: true, event: 'playing', duration: Number(event.seconds) || 0, error: '' };
        } else if (event.event === 'pos') {
          status = {
            ...status,
            running: true,
            event: status.event === 'paused' ? 'paused' : 'playing',
            seconds: Number(event.seconds) || 0,
          };
        } else if (event.event === 'ended') {
          status = { ...status, running: false, event: 'ended' };
        } else if (event.event === 'error') {
          status = { ...status, running: false, event: 'error', error: String(event.message || '没能单独播放') };
        }
      } catch { /* 忽略半行 */ }
    }
  });
}

export function exclusiveStatus() {
  return { ...status };
}

export async function stopExclusive() {
  const proc = child;
  child = null;
  token += 1;
  status = { token, running: false, event: 'idle', seconds: 0, duration: 0, error: '' };
  if (!proc) return;
  try { proc.stdin.write('stop\n'); } catch { /* 已经退出 */ }
  proc.kill('SIGTERM');
}

export async function controlExclusive(command, value) {
  if (!child) return exclusiveStatus();
  if (command === 'pause' || command === 'resume' || command === 'stop') {
    child.stdin.write(`${command}\n`);
    if (command === 'pause') status = { ...status, event: 'paused' };
    if (command === 'resume') status = { ...status, event: 'playing' };
    if (command === 'stop') await stopExclusive();
  } else if (command === 'volume') {
    const volume = Math.max(0, Math.min(1, Number(value) || 0));
    child.stdin.write(`volume ${volume}\n`);
  }
  return exclusiveStatus();
}

export async function playExclusive({ uid, url, volume = 1, signal } = {}) {
  signal?.throwIfAborted();
  await stopExclusive();
  signal?.throwIfAborted();
  const playToken = token;
  const audioId = await audioIdFor(uid);
  signal?.throwIfAborted();
  const file = await materializeAudio(url, { signal });
  signal?.throwIfAborted();
  if (playToken !== token) return exclusiveStatus();
  const binary = await ensurePlayer();
  signal?.throwIfAborted();
  const level = Math.max(0, Math.min(1, Number(volume) || 0));
  const proc = spawn(binary, [String(audioId), file, String(level)], { stdio: ['pipe', 'pipe', 'pipe'] });
  child = proc;
  status = { token: playToken, running: true, event: 'starting', seconds: 0, duration: 0, error: '' };
  consume(proc, playToken);
  proc.on('close', () => {
    if (child === proc) child = null;
    if (playToken === token && status.event !== 'ended' && status.event !== 'error') {
      status = { ...status, running: false, event: 'ended' };
    }
  });
  return exclusiveStatus();
}
