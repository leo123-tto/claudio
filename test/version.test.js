import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveVersion } from '../server/version.js';

function tmpRoot(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-ver-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name), body);
  return root;
}

test('版本：环境变量优先，其次 git 短号', () => {
  const root = tmpRoot({ 'package.json': '{"version":"0.1.0"}' });
  assert.equal(resolveVersion({ root, env: { CLAUDIO_VERSION: 'abc1234' }, git: () => 'fff0000' }), 'abc1234');
  assert.equal(resolveVersion({ root, env: {}, git: () => 'fff0000' }), 'fff0000');
});

test('版本：没有 git 时读部署写的 version.json（放在 server/ 下，随 server/ 一起同步）', () => {
  const root = tmpRoot({ 'package.json': '{"version":"0.1.0"}' });
  fs.mkdirSync(path.join(root, 'server'));
  fs.writeFileSync(path.join(root, 'server', 'version.json'), '{"commit":"3b4fa01","builtAt":"2026-11-23T08:00:00Z"}');
  assert.equal(resolveVersion({ root, env: {}, git: () => '' }), '3b4fa01');
});

test('版本：都没有时用 package.json 版本加构建时间，不编提交号', () => {
  const root = tmpRoot({ 'package.json': '{"version":"0.1.0"}' });
  fs.mkdirSync(path.join(root, 'server'));
  fs.writeFileSync(path.join(root, 'server', 'version.json'), '{"commit":"不是提交号","builtAt":"2026-11-23T08:05:00Z"}');
  const v = resolveVersion({ root, env: {}, git: () => '' });
  assert.match(v, /^0\.1\.0\+\d{8}\.\d{4}$/);
  const bare = tmpRoot({ 'package.json': '{"version":"0.2.0"}' });
  assert.match(resolveVersion({ root: bare, env: {}, git: () => '' }), /^0\.2\.0\+\d{8}\.\d{4}$/);
});

// 公开快照（git archive，没有 .git）里跑测试时跳过
const inRepo = fs.existsSync(new URL('../.git', import.meta.url));
test('版本：仓库里真跑 git 能拿到短号', { skip: !inRepo && '没有 .git' }, () => {
  assert.match(resolveVersion({ env: {} }), /^[0-9a-f]{7,}$/);
});
