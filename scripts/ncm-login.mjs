// 网易云扫码登录：弹二维码 → 用网易云 App 扫 → 提取关键 cookie 写入 .env 的 NCM_COOKIE。
// 前置：先起网易云实例（npm run ncm）。用法：node scripts/ncm-login.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.NCM_BASE ?? 'http://localhost:3000';
const ENV_PATH = path.resolve(import.meta.dirname, '..', '.env');
const ts = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p) {
  const r = await fetch(new URL(p, BASE));
  if (!r.ok) throw new Error(`${p} -> ${r.status}（网易云实例没起？先 npm run ncm）`);
  return r.json();
}

// 1. 取 key
const keyRes = await api(`/login/qr/key?timestamp=${ts()}`);
const unikey = keyRes?.data?.unikey;
if (!unikey) {
  console.log('❌ 拿不到 qr key：', JSON.stringify(keyRes).slice(0, 200));
  process.exit(1);
}

// 2. 生成二维码图片并弹出
const createRes = await api(`/login/qr/create?key=${unikey}&qrimg=true&timestamp=${ts()}`);
const qrimg = createRes?.data?.qrimg;
if (!qrimg) {
  console.log('❌ 拿不到二维码：', JSON.stringify(createRes).slice(0, 200));
  process.exit(1);
}
const b64 = qrimg.includes(',') ? qrimg.split(',')[1] : qrimg;
const png = path.join(os.tmpdir(), 'claudio-ncm-qr.png');
fs.writeFileSync(png, Buffer.from(b64, 'base64'));
console.log('📲 二维码已弹出，请用【网易云音乐 App】扫码登录：', png);
spawn('open', [png], { detached: true, stdio: 'ignore' }).unref();

// 3. 轮询扫码状态：800 过期 / 801 待扫 / 802 待确认 / 803 成功
let cookie = '';
for (let i = 0; i < 150; i++) {
  await sleep(2000);
  const d = await api(`/login/qr/check?key=${unikey}&timestamp=${ts()}`);
  if (d.code === 803) {
    cookie = d.cookie || '';
    console.log('\n✅ 扫码成功，已登录');
    break;
  }
  if (d.code === 800) {
    console.log('\n❌ 二维码过期，请重跑脚本');
    process.exit(1);
  }
  process.stdout.write(`\r等待中… 状态 ${d.code}（801=待扫 / 802=待确认） ${i * 2}s`);
}
if (!cookie) {
  console.log('\n⌛ 超时未完成扫码');
  process.exit(1);
}

// 4. 只提取 MUSIC_U / __csrf 写入 .env（不存其它无关属性）
const mu = cookie.match(/MUSIC_U=([^;,\s]+)/);
const csrf = cookie.match(/__csrf=([^;,\s]+)/);
if (!mu) {
  console.log('❌ cookie 里没找到 MUSIC_U，原始片段：', cookie.slice(0, 120));
  process.exit(1);
}
const clean = [`MUSIC_U=${mu[1]}`, csrf && `__csrf=${csrf[1]}`].filter(Boolean).join('; ');

let env = fs.readFileSync(ENV_PATH, 'utf8');
const line = `NCM_COOKIE=${clean}`;
env = /^NCM_COOKIE=.*$/m.test(env)
  ? env.replace(/^NCM_COOKIE=.*$/m, line)
  : `${env}\n${line}\n`;
fs.writeFileSync(ENV_PATH, env);
console.log('✅ 登录态已写入 .env 的 NCM_COOKIE（仅 MUSIC_U/__csrf）');

// 5. 验证当前登录账号
try {
  const acc = await api(`/login/status?timestamp=${ts()}`);
  const nick = acc?.data?.profile?.nickname ?? acc?.profile?.nickname ?? '(已登录)';
  console.log('👤 当前登录：', nick);
} catch {
  /* 验证失败不影响主流程 */
}
