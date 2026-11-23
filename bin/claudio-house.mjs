#!/usr/bin/env node
// Mac mini 常驻：只起网易云和 Claudio 服务，不开窗口，也不预生成电台节目。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;

function start(args) {
  return spawn(node, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CLAUDIO_SKIP_PREFETCH: '1' },
  });
}

async function waitForNcm() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch('http://127.0.0.1:3000', { signal: AbortSignal.timeout(500) });
      if (response) return;
    } catch { /* 还没听 */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.error('[house] 网易云 API 还没起来，Claudio 仍然启动');
}

let app = null;
let exiting = false;

function shutdown() {
  exiting = true;
  for (const proc of [app, ncm]) {
    if (!proc) continue;
    try { proc.kill('SIGTERM'); } catch { /* 已经退出 */ }
  }
}

function watch(proc, name) {
  proc.on('exit', (code, signal) => {
    if (exiting) return;
    exiting = true;
    console.error(`[house] ${name} 退出 code=${code} signal=${signal || ''}`);
    shutdown();
    process.exit(code || 1);
  });
}

const ncm = start(['node_modules/NeteaseCloudMusicApi/app.js']);
process.on('SIGTERM', () => {
  shutdown();
  process.exit(0);
});
process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});
watch(ncm, 'ncm');
await waitForNcm();
app = start(['server/index.js']);
watch(app, 'claudio');
