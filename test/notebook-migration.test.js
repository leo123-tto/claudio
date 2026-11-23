// 迁移脚本：dry-run 不写盘、备份权限 0600、重跑会把删掉的条目找回来所以要拒绝、清空记忆连备份一起删。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNotebookStore } from '../server/notebook.js';
import { createMemberStore, parseVaultKey } from '../server/public/members.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'migrate-notebook.mjs');
const mode = (file) => fs.statSync(file).mode & 0o777;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-migrate-'));
  fs.mkdirSync(path.join(dir, 'user'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'user', 'memory.md'), [
    '# Claudio 的记忆', '', '> 说明',
    '- [2026-06-06] ta 有深夜听歌、听着听着才睡着的习惯。',
    '- [2026-06-07] ta 觉得《Lemon》已经听太多遍。',
    '- 他分手那次听了一整夜。',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'cache', 'taste-digest.md'), '# 持续整理的品味\n已经确认的偏好：他妹妹在老家读高中\n');
  const members = path.join(dir, 'members');
  fs.mkdirSync(path.join(members, 'mem_0000000a'), { recursive: true });
  const memory = {
    prefs: ['爱听粤语老歌', '不喜欢重金属'], recent: [], history: [], hearts: [], turns: [], taste: null,
    account: null, adult: false, talk: 'normal', quality: 'lossless',
  };
  fs.writeFileSync(path.join(members, 'mem_0000000a', 'memory.json'), JSON.stringify(memory), { mode: 0o600 });
  return { dir, members, file: path.join(dir, 'user', 'notebook.json') };
}

function run(dir, members, ...flags) {
  return execFileSync(process.execPath, [script, '--dir', dir, '--members', members, ...flags], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('dry-run 什么都不写', () => {
  const { dir, members, file } = fixture();
  try {
    const out = run(dir, members);
    assert.match(out, /dry-run/);
    assert.match(out, /ta 觉得《Lemon》已经听太多遍/);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(path.join(dir, 'notebook-migration-backup')), false);
    assert.equal(fs.existsSync(path.join(dir, 'notebook-migration.lock')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('--apply：写笔记本、旧文件进单独备份目录且 0600、成员 prefs 搬走、派生摘要删掉', () => {
  const { dir, members, file } = fixture();
  try {
    run(dir, members, '--apply');
    const book = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(book.migratedAt);
    assert.equal(book.notes.length, 3);
    assert.equal(book.notes.find((n) => n.text.includes('分手')).sensitive, 'quiet');
    assert.equal(mode(file), 0o600);

    const backupDir = path.join(dir, 'notebook-migration-backup');
    const stamp = fs.readdirSync(backupDir)[0];
    const backupMemory = path.join(backupDir, stamp, 'memory.md');
    const backupMember = path.join(backupDir, stamp, 'members', 'mem_0000000a', 'memory.json');
    assert.equal(fs.existsSync(backupMemory), true);
    assert.equal(fs.existsSync(backupMember), true);
    assert.equal(mode(backupMemory), 0o600);
    assert.equal(mode(backupMember), 0o600);
    // 原来那份 memory.md 不动
    assert.match(fs.readFileSync(path.join(dir, 'user', 'memory.md'), 'utf8'), /听着听着才睡着/);

    const memberFile = path.join(members, 'mem_0000000a', 'memory.json');
    const mem = JSON.parse(fs.readFileSync(memberFile, 'utf8'));
    assert.deepEqual(mem.prefs, []);
    assert.equal(mem.notes.length, 2);
    assert.equal(mem.adult, false);
    assert.equal(mem.talk, 'normal');
    assert.equal(mem.quality, 'lossless');
    assert.equal(mode(memberFile), 0o600);
    // 旧摘要里的记忆原文不能留着
    assert.equal(fs.existsSync(path.join(dir, 'cache', 'taste-digest.md')), false);
    // 锁用完就删
    assert.equal(fs.existsSync(path.join(dir, 'notebook-migration.lock')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('已迁过一次就拒绝重跑：删掉的条目不会复活', () => {
  const { dir, members, file } = fixture();
  try {
    run(dir, members, '--apply');
    const store = createNotebookStore(file);
    const target = store.list().find((note) => note.text.includes('Lemon'));
    assert.equal(store.remove(target.id), true);
    assert.equal(store.list().length, 2);

    let failed = false;
    try { run(dir, members, '--apply'); } catch (error) {
      failed = true;
      assert.match(String(error.stdout || '') + String(error.stderr || ''), /已经迁过一次/);
    }
    assert.equal(failed, true, '重跑必须被拒绝');
    // 拒绝之后笔记本没有被改回去
    assert.equal(createNotebookStore(file).list().length, 2);
    assert.equal(createNotebookStore(file).list().some((note) => note.text.includes('Lemon')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('清空记忆连迁移备份一起删（备份里不能留着删掉的东西）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-members-'));
  const members = createMemberStore({ root: dir, vaultKey: parseVaultKey('22'.repeat(32)) });
  const id = 'mem_0000000a';
  members.saveMemory(id, { notes: [{ id: 'n_00000001', kind: 'event', text: '一条记忆' }], prefs: [] });
  const folder = path.join(dir, id);
  fs.writeFileSync(path.join(folder, 'memory.json.20261123T000000.bak'), '{"prefs":["旧记忆"]}', { mode: 0o600 });
  assert.equal(fs.existsSync(path.join(folder, 'memory.json.20261123T000000.bak')), true);
  members.clearMemory(id);
  assert.equal(fs.existsSync(path.join(folder, 'memory.json')), false);
  assert.equal(fs.existsSync(path.join(folder, 'memory.json.20261123T000000.bak')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
