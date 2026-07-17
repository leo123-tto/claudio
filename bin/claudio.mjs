#!/usr/bin/env node
// claudio —— 启动器：起服务（网易云 API + 大脑）→ 打开前端播放器窗口。
// 播放 / 聊天 / 可视化都在【前端】（浏览器或窗口里放歌）——关掉窗口声音就停，不在后台出声、不留孤儿进程。
// 后端只当「大脑 + API」（claude 写口播 / 网易云解析 / TTS / 记忆），不自己 afplay/ffplay。
//   claudio        起服务 + 开前端窗口
//   claudio stop   关服务 + 杀掉任何残留播放进程（可靠的总开关）
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NCM = 3000, APP = 8080;
const BASE = `http://localhost:${APP}`;
const LOGDIR = path.join(ROOT, 'cache', 'logs');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; // 无边框窗（在窗口里放歌，关窗即停）

const C = {
  d: (s) => `\x1b[2m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (s) => console.log(`  ${C.g('✓')} ${s}`);
const dot = (s) => console.log(`  ${C.d('·')} ${C.d(s)}`);
const TTY = process.stdout.isTTY;

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
function startSpin(label) {
  if (!TTY) { console.log(`  ${C.d('·')} ${C.d(label)}`); return { update() {}, stop(line) { if (line) console.log(line); } }; }
  let i = 0, extra = '';
  const draw = () => process.stdout.write(`\r  ${C.c(SPIN[i % SPIN.length])} ${label}${extra}\x1b[K`);
  draw();
  const t = setInterval(() => { i++; draw(); }, 80);
  return { update(e) { extra = e || ''; }, stop(line) { clearInterval(t); process.stdout.write('\r\x1b[K'); if (line) console.log(line); } };
}

async function up(url) { try { await fetch(url, { signal: AbortSignal.timeout(2000) }); return true; } catch { return false; } }
async function waitUp(url, ms) { const t = Date.now(); while (Date.now() - t < ms) { if (await up(url)) return true; await sleep(500); } return false; }

function lanIP() {
  const list = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
  return (list.find((i) => i.address.startsWith('192.168.')) || list[0])?.address || null;
}

const owned = [];
function startDetached(cmd, args, logname) {
  fs.mkdirSync(LOGDIR, { recursive: true });
  const fd = fs.openSync(path.join(LOGDIR, logname), 'a');
  const p = spawn(cmd, args, { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd] });
  owned.push(p);
  return p;
}

// 打开前端播放器窗口：优先 Tauri 原生窗（关窗即停音乐、可缩迷你窗）→ 回退 Chrome --app 无边框窗 → 系统浏览器
const APP_BUNDLES = [
  path.join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'Claudio.app'),
  path.join(ROOT, 'src-tauri', 'target', 'debug', 'bundle', 'macos', 'Claudio.app'),
];
function openFront() {
  try {
    const appPath = APP_BUNDLES.find((p) => fs.existsSync(p));
    if (appPath) {
      try { spawnSync('pkill', ['-f', 'Claudio.app']); } catch {} // 杀旧实例，确保启动刚构建的最新 .app（含最新 Rust/capability）
      spawn('open', ['-n', appPath]).unref(); // -n 强制新实例
      return 'tauri';
    }
  } catch {}
  try {
    if (fs.existsSync(CHROME)) { spawn(CHROME, [`--app=${BASE}`, '--window-size=440,760'], { detached: true, stdio: 'ignore' }).unref(); return 'win'; }
  } catch {}
  try { spawn('open', [BASE]).unref(); return 'browser'; } catch { return null; }
}

async function main() {
  console.log(`\n  ${C.b('🎙  CLAUDIO')}  ${C.d('个人 AI 电台 · 启动器')}\n`);
  await sleep(400);
  ok(`Node ${process.version}${fs.existsSync(path.join(ROOT, '.env')) ? '' : C.y('  (缺 .env)')}`);
  await sleep(500);

  // 网易云 API
  if (await up(`http://localhost:${NCM}`)) ok(`网易云 API 已就位  :${NCM}`);
  else {
    const sp = startSpin('唤醒网易云 API');
    startDetached('npx', ['--yes', 'NeteaseCloudMusicApi'], 'ncm.log');
    const okk = await waitUp(`http://localhost:${NCM}`, 60000);
    sp.stop(okk ? `  ${C.g('✓')} 网易云 API 就绪    :${NCM}` : `  ${C.y('✗')} 网易云 API 启动超时`);
    if (!okk) return fail('网易云 API 启动超时');
  }
  await sleep(500);

  // 大脑（只当 API：claude / 解析 / TTS / 记忆；不在后台出声）
  if (await up(`${BASE}/api/status`)) ok(`Claudio 大脑已就位 :${APP}`);
  else {
    const sp = startSpin('唤醒 Claudio 大脑');
    startDetached('node', ['server/index.js'], 'dev.log');
    const okk = await waitUp(`${BASE}/api/status`, 60000);
    sp.stop(okk ? `  ${C.g('✓')} Claudio 大脑就绪   :${APP}` : `  ${C.y('✗')} 大脑启动超时`);
    if (!okk) return fail('大脑启动超时');
  }
  await sleep(550);

  // 天气
  try {
    const w = (await (await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(9000) })).json())?.weather || null;
    if (w?.summary) ok(`今天天气  ${w.cityName ? w.cityName + ' · ' : ''}${w.desc} ${w.tempC}°C ${C.d(`（体感 ${w.feels}° · 湿度 ${w.humidity}%）`)}`);
    else dot('天气拉取中（稍后注入选歌）');
  } catch {}
  await sleep(550);

  // 口味曲库
  try {
    const n = (fs.readFileSync(path.join(ROOT, 'user', 'favorites.md'), 'utf8').match(/^-\s.+—.+$/gm) || []).length;
    if (n) ok(`懂你口味  ${C.d(`${n} 首喜欢的歌已经读进脑子`)}`);
  } catch {}
  await sleep(550);

  // Fish 余额
  try {
    const fc = await (await fetch(`${BASE}/api/fish-credit`, { signal: AbortSignal.timeout(8000) })).json();
    if (fc?.ok) ok(`Fish 余额  ${C.c('$' + Number(fc.credit).toFixed(2))}  ${C.d('（充值余额 · 用多少扣多少 · 网页右上角可点开充值）')}`);
  } catch {}
  await sleep(550);

  // 打开前端窗口（在这里面放歌 / 聊天 / 看可视化；关窗即停）
  const how = openFront();
  for (const p of owned) p.unref();
  const ip = lanIP();
  ok(how === 'tauri' ? '已打开 Claudio 桌面窗（关窗即停音乐 · 顶栏 ▽ 缩成迷你窗）'
    : how === 'win' ? '已打开播放器窗口（Chrome 无边框；想要原生窗跑 npm run tauri:build）'
    : how === 'browser' ? '已在浏览器打开播放器'
    : `请手动打开 ${BASE}`);
  console.log(`\n  ${C.d('网页：')}${C.c(BASE)}${ip ? C.d('   手机同 WiFi ') + C.c(`http://${ip}:${APP}`) : ''}`);
  console.log(`  ${C.d('要全部关掉（服务 + 声音）：')}${C.c('claudio stop')}\n`);
  process.exit(0); // 服务已 detached 常驻；启动器退出即可，声音在前端窗口里
}

// claudio stop —— 可靠的总开关：关服务端口 + 杀掉任何残留播放进程（防孤儿）
async function stop() {
  const sh = (cmd, args) => new Promise((res) => {
    let s = ''; try { const p = spawn(cmd, args); p.stdout?.on('data', (d) => (s += d)); p.on('close', () => res(s.trim())); p.on('error', () => res('')); } catch { res(''); }
  });
  let n = 0;
  // 1) 关服务端口
  for (const port of [APP, NCM]) {
    const out = await sh('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']);
    for (const pid of out.split('\n').filter(Boolean)) { try { process.kill(+pid, 'SIGKILL'); n++; } catch {} }
  }
  // 2) 杀大脑进程（端口没抓到时兜底）
  await sh('pkill', ['-9', '-f', 'server/index.js']);
  // 3) 杀任何残留的播放进程（孤儿 ffplay/afplay → 历史遗留；前端播放后一般没有，防御性保留）
  let audio = 0;
  for (const proc of ['ffplay', 'afplay']) {
    const out = await sh('pgrep', ['-f', proc]);
    audio += out.split('\n').filter(Boolean).length;
    await sh('pkill', ['-9', '-f', proc]);
  }
  // 4) 关 Claudio 桌面窗（Tauri app；前端播放层，关掉它声音随之停）
  await sh('pkill', ['-f', 'Claudio.app']);
  console.log(`  ${C.g('✓')} 已停止 ${n} 个服务进程${audio ? `，杀掉 ${audio} 个残留播放进程` : ''}，并关闭 Claudio 桌面窗`);
  process.exit(0);
}

function fail(msg) { console.log(`\n  ${C.y('✗')} ${msg}（日志见 cache/logs/）`); process.exit(1); }

if (process.argv[2] === 'stop') stop();
else main().catch((e) => fail(e.message));
