import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, 'runtime');
const app = path.join(runtime, 'app');

if (process.platform !== 'darwin') throw new Error('当前桌面包只支持 macOS');
if (!fs.existsSync(path.join(root, 'node_modules', 'NeteaseCloudMusicApi', 'server.js'))) {
  throw new Error('缺少 NeteaseCloudMusicApi，请先运行 npm install');
}

fs.rmSync(runtime, { recursive: true, force: true });
fs.mkdirSync(app, { recursive: true });
for (const directory of ['server', 'web', 'prompts']) {
  fs.cpSync(path.join(root, directory), path.join(app, directory), { recursive: true });
}
fs.cpSync(path.join(root, 'node_modules'), path.join(app, 'node_modules'), { recursive: true });
fs.copyFileSync(path.join(root, 'package.json'), path.join(app, 'package.json'));
fs.copyFileSync(process.execPath, path.join(runtime, 'node'));
fs.chmodSync(path.join(runtime, 'node'), 0o755);
fs.mkdirSync(path.join(runtime, 'ncm'), { recursive: true });
fs.copyFileSync(path.join(root, 'packaging', 'start-ncm.cjs'), path.join(runtime, 'ncm', 'start.cjs'));
fs.copyFileSync(path.join(root, 'packaging', 'ncm-modules.cjs'), path.join(runtime, 'ncm', 'ncm-modules.cjs'));
fs.cpSync(path.join(root, 'packaging', 'default-user'), path.join(runtime, 'default-user'), { recursive: true });

const forbidden = ['.env', '.env.local', 'user', 'cache'];
for (const name of forbidden) {
  if (fs.existsSync(path.join(app, name))) throw new Error(`运行时不应包含私人目录：${name}`);
}
console.log(`Claudio runtime prepared (${process.arch}, Node ${process.version})`);
