// macOS 输出菜单：本机扬声器走 CoreAudio；AirPlay 音箱点控制中心里同名的那一项。
// 切的是这台 Mac 的默认播放设备，歌曲不用重开。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { buildOutputMenu, parseDnsSdBrowse, planOutputChange } from './audio-route.js';
import { stopExclusive } from './exclusive-play.js';
import { applyRoomAliases } from './rooms.js';
import { roomStore } from './room-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, 'native', 'audio-output.c');
const scriptPath = path.join(here, 'native', 'select-output.applescript');

let menuCache = { at: 0, menu: null };
let exclusiveId = '';

function run(command, args, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('timeout'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function helperPath() {
  return path.join(config.paths.cache, 'audio-output');
}

async function ensureHelper() {
  const binary = helperPath();
  const sourceTime = fs.statSync(source).mtimeMs;
  let binaryTime = 0;
  try { binaryTime = fs.statSync(binary).mtimeMs; } catch { /* 还没编译 */ }
  if (binaryTime >= sourceTime) return binary;
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  const compiled = await run('clang', [
    '-O2', '-framework', 'CoreAudio', '-framework', 'CoreFoundation', '-framework', 'CoreGraphics',
    source, '-o', binary,
  ], 20000);
  if (compiled.code !== 0) throw new Error('audio helper compile failed');
  fs.chmodSync(binary, 0o755);
  return binary;
}

async function helperJson(args) {
  const binary = await ensureHelper();
  const result = await run(binary, args, 5000);
  const line = result.stdout.trim().split(/\n/).filter(Boolean).at(-1) || '';
  try {
    return JSON.parse(line);
  } catch {
    throw new Error('audio helper');
  }
}

function browse(type) {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/dns-sd', ['-B', type, 'local.']);
    let text = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 1600);
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', () => { clearTimeout(timer); resolve(text); });
  });
}

async function computerName() {
  try {
    const result = await run('/usr/sbin/scutil', ['--get', 'ComputerName'], 2000);
    return result.stdout.trim();
  } catch {
    return '';
  }
}

export async function listOutputs({ fresh = false } = {}) {
  if (!fresh && menuCache.menu && Date.now() - menuCache.at < 8000) return menuCache.menu;
  const [listed, airplay, raop, name] = await Promise.all([
    helperJson(['list']),
    browse('_airplay._tcp'),
    browse('_raop._tcp'),
    computerName(),
  ]);
  const menu = applyRoomAliases(buildOutputMenu({
    devices: listed.devices || [],
    airplayNames: parseDnsSdBrowse(`${airplay}\n${raop}`),
    computerName: name,
    exclusiveId,
  }), roomStore.read());
  menuCache = { at: Date.now(), menu };
  return menu;
}

function friendlySwitchError(text) {
  if (/不允许辅助|not authorized|1002|-25211|assistive/i.test(text)) {
    return '需要在系统设置 → 隐私与安全性 → 辅助功能里允许 Claudio';
  }
  if (/没有打开/.test(text)) return '没能打开控制中心，请再点一次';
  if (/没有 AirPlay/.test(text)) return '控制中心里没找到 AirPlay';
  const missing = text.match(/列表里没有「(.+?)」/);
  if (missing) return `控制中心里现在没有「${missing[1]}」，确认音箱开着再试`;
  return '没能切换到这台音箱';
}

function jxa(source) {
  return run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source], 5000);
}

async function clickMenuBar(x, y) {
  const px = Math.round(Number(x));
  const py = Math.round(Number(y));
  if (!Number.isFinite(px) || !Number.isFinite(py)) return;
  await jxa(`ObjC.import('CoreGraphics');
const src = $.CGEventSourceCreate(1);
const pos = $.CGPointMake(${px}, ${py});
const down = $.CGEventCreateMouseEvent(src, 1, pos, 0);
const up = $.CGEventCreateMouseEvent(src, 2, pos, 0);
$.CGEventPost(0, down);
delay(0.05);
$.CGEventPost(0, up);`);
}

async function restoreCursor(point) {
  const px = Number(point?.x);
  const py = Number(point?.y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return;
  await jxa(`ObjC.import('CoreGraphics');
const src = $.CGEventSourceCreate(1);
const pos = $.CGPointMake(${px}, ${py});
const move = $.CGEventCreateMouseEvent(src, 5, pos, 0);
$.CGEventPost(0, move);`).catch(() => {});
}

export async function selectSystemDevice(name, {
  helperJson: getHelper = helperJson,
  clickMenuBar: click = clickMenuBar,
  restoreCursor: restore = restoreCursor,
  run: runCommand = run,
} = {}) {
  const [icon, cursor] = await Promise.all([getHelper(['icon']), getHelper(['cursor'])]);
  const x = Math.round(Number(icon.x) || 0);
  if (!x) return { ok: false, error: '没找到菜单栏上的控制中心' };
  let result;
  try {
    await click(x, icon.y || 16);
    result = await runCommand('/usr/bin/osascript', [scriptPath, name], 14000);
  } finally {
    await restore(cursor);
  }
  if (result?.code === 0) return { ok: true };
  return { ok: false, error: friendlySwitchError(`${result?.stderr || ''}\n${result?.stdout || ''}`) };
}

export async function openBluetoothSettings({ run: runCommand = run } = {}) {
  try {
    const result = await runCommand('/usr/bin/open', ['x-apple.systempreferences:com.apple.BluetoothSettings'], 5000);
    return result.code === 0 ? { ok: true } : { ok: false, error: '没能打开蓝牙设置' };
  } catch { return { ok: false, error: '没能打开蓝牙设置' }; }
}

export async function selectOutput(id) {
  const menu = await listOutputs({ fresh: true });
  const plan = planOutputChange(menu, id);
  if (!plan.ok) return plan;
  if (plan.action === 'none') {
    return {
      ok: true,
      ...menu,
      unchanged: true,
      exclusive: plan.item.route === 'exclusive',
      uid: plan.item.uid || '',
      outputId: plan.item.id,
      name: plan.item.name,
    };
  }
  if (plan.action === 'coreaudio') {
    exclusiveId = '';
    await stopExclusive();
    const set = await helperJson(['set-uid', plan.item.uid]);
    if (!set.ok) return { ok: false, error: '没能切换到这台设备' };
  } else if (plan.action === 'exclusive') {
    exclusiveId = plan.item.id;
  } else {
    exclusiveId = '';
    await stopExclusive();
    const switched = await selectSystemDevice(plan.item.deviceName || plan.item.name);
    if (!switched.ok) return switched;
  }
  menuCache = { at: 0, menu: null };
  const next = await listOutputs({ fresh: true });
  console.log(`[output] ${plan.item.deviceName || plan.item.name}`);
  return {
    ok: true,
    ...next,
    exclusive: plan.action === 'exclusive',
    uid: plan.item.uid || '',
    outputId: plan.item.id,
    name: plan.item.name,
  };
}
