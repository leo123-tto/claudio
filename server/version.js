// 页面角落显示的版本，给人看「自己的改动上线了没有」。启动时算一次：
// 1. 环境变量 CLAUDIO_VERSION（部署时直接指定）；
// 2. 代码目录是 git 仓库：git 提交短号；
// 3. server/version.json（部署前在仓库里跑 `node scripts/stamp-version.mjs`：{ commit, builtAt }；放在 server/ 下，
//    部署照常同步 server/ 就带过去了。盒子上的代码是拷过去的，没有 .git，容器里也没装 git）；
// 4. 都没有：package.json 的版本 + 构建时间（取 package.json / server / web 入口文件里最新的修改时间）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HASH = /^[0-9a-f]{7,40}$/i;

function stamp(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.${p(d.getHours())}${p(d.getMinutes())}`;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function gitShort(root) {
  if (!fs.existsSync(path.join(root, '.git'))) return '';
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    const hash = String(out).trim();
    return HASH.test(hash) ? hash : '';
  } catch { return ''; }
}

function newestMtime(root) {
  let newest = 0;
  for (const rel of ['package.json', 'server/index.js', 'server/public/app.js', 'web/boot.js', 'web/index.html']) {
    try { newest = Math.max(newest, fs.statSync(path.join(root, rel)).mtimeMs); } catch { /* 少了就跳过 */ }
  }
  return newest;
}

export function resolveVersion({ root = ROOT, env = process.env, git = gitShort } = {}) {
  const fromEnv = String(env.CLAUDIO_VERSION || '').trim();
  if (fromEnv) return fromEnv.slice(0, 40);
  const hash = git(root);
  if (hash) return hash;
  const stamped = readJson(path.join(root, 'server', 'version.json'));
  const commit = String(stamped?.commit || '').trim();
  if (HASH.test(commit)) return commit.slice(0, 7);
  const pkg = readJson(path.join(root, 'package.json'));
  const built = stamp(stamped?.builtAt || newestMtime(root));
  return [pkg?.version || '0.0.0', built].filter(Boolean).join('+');
}

let cached = null;
export function appVersion() {
  if (cached === null) cached = resolveVersion();
  return cached;
}
