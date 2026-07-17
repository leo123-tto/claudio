import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceApp = path.join(root, 'src-tauri/target/release/bundle/macos/Claudio.app');
const targetApp = '/Applications/Claudio.app';
const data = path.join(os.homedir(), 'Library/Application Support/com.claudio.fm');

if (!fs.existsSync(sourceApp)) throw new Error('没有找到 release App，请先运行 npm run tauri:build');

function copyFileIfMissing(source, target) {
  if (!fs.existsSync(source) || fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function copyTreeMissing(source, target) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyTreeMissing(from, to);
    else copyFileIfMissing(from, to);
  }
}

// 首次安装只迁移缺失文件，不覆盖已经由 App 维护的数据。
copyTreeMissing(path.join(root, 'user'), path.join(data, 'user'));
for (const name of ['.env', '.env.local']) copyFileIfMissing(path.join(root, name), path.join(data, name));
for (const name of ['settings.json', 'secrets.json', 'state.json', 'listening-events.jsonl', 'discovery-pool.json']) {
  copyFileIfMissing(path.join(root, 'cache', name), path.join(data, 'cache', name));
}
copyTreeMissing(path.join(root, 'cache', 'tts'), path.join(data, 'cache', 'tts'));

// 终止旧终端启动器和旧 App，避免端口占用；命令不读取或打印任何私密配置。
spawnSync(process.execPath, [path.join(root, 'bin', 'claudio.mjs'), 'stop'], { stdio: 'inherit' });

const installing = '/Applications/.Claudio.installing.app';
fs.rmSync(installing, { recursive: true, force: true });
const copied = spawnSync('/usr/bin/ditto', [sourceApp, installing], { stdio: 'inherit' });
if (copied.status !== 0) throw new Error('复制 Claudio.app 失败');

if (fs.existsSync(targetApp)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(os.homedir(), '.Trash', `Claudio-backup-${stamp}.app`);
  fs.renameSync(targetApp, backup);
}
fs.renameSync(installing, targetApp);
spawnSync('/usr/bin/open', [targetApp], { stdio: 'ignore' });
console.log(`Claudio 已安装并启动：${targetApp}`);
