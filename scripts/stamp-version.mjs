#!/usr/bin/env node
// 部署前在仓库里跑：把当前 git 提交短号和时间写进 server/version.json，部署同步 server/ 时一起拷到盒子
// （盒子上没有 .git，容器里也没有 git）。页面设置 / 账号面板角落的版本就从这里来（server/version.js）。不进仓库。
// 用法：node scripts/stamp-version.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
const file = path.join(root, 'server', 'version.json');
fs.writeFileSync(file, `${JSON.stringify({ commit, builtAt: new Date().toISOString() })}\n`);
console.log(`${file}: ${commit}`);
