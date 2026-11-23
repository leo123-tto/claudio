#!/usr/bin/env node
// 把旧记忆迁成「Vera 的笔记本」结构。
//
//   node scripts/migrate-notebook.mjs                     # 只看，不写（dry-run）
//   node scripts/migrate-notebook.mjs --apply             # 真写 user/notebook.json
//   node scripts/migrate-notebook.mjs --dir /data --apply # 指定数据目录（盒子上的容器数据）
//   node scripts/migrate-notebook.mjs --members /data/members --apply   # 公用版每人 prefs → notes
//   node scripts/migrate-notebook.mjs --apply --force     # 已经迁过一次仍要重跑（小心：会把删掉的条目找回来）
//
// 规矩：
//   - 默认 dry-run，只打印将要生成什么；要写盘必须显式 --apply。
//   - 数据目录不给 --dir 时读 CLAUDIO_DATA_DIR（容器里就是它）。
//   - 已经迁过（notebook.json 里有 migratedAt）就拒绝再跑：再跑会把用户删掉的条目从旧文件里搬回来。
//   - 跑之前先停服务器（脚本自己也会加一把锁；锁在 <data>/notebook-migration.lock，进程退出就删）。
//   - memory.md 不删不改；迁移前把旧文件复制到 <data>/notebook-migration-backup/<时间戳>/，权限 0600。
//     这个目录只在「上线验证期」内用来回滚，验证通过后由老板安排删除。
//   - 迁移后 memory.md 不再进提示词（只当回滚备份），所以备份留着已删的原句也不会漏进 prompt；
//     真正的「删了就没了」由笔记本负责（删除时也会清掉 memory.md 里的原句）。
//   - 公用版把 prefs 搬进 notes 后清空 prefs（否则删掉的那条还会从 prefs 漏回提示词）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildNote,
  classifyKind,
  createNotebookStore,
  guessSongs,
  isSensitiveText,
  parseLegacyMemory,
} from '../server/notebook.js';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag, fallback = '') => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(value('--dir', process.env.CLAUDIO_DATA_DIR || root));
const userDir = path.join(dataDir, 'user');
const memoryFile = path.join(userDir, 'memory.md');
const notebookFile = path.join(userDir, 'notebook.json');
// 派生缓存：旧版本会把「已确认的偏好」写进去，里面可能有已删记忆的原文，迁移时直接丢掉，下次生成是干净的。
const tasteDigestFile = path.join(dataDir, 'cache', 'taste-digest.md');
const membersDir = value('--members', '');
const apply = has('--apply');
const force = has('--force');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
const backupDir = path.join(dataDir, 'notebook-migration-backup', stamp);
const lockFile = path.join(dataDir, 'notebook-migration.lock');

const label = { person: '人', habit: '习惯', song: '歌', event: '事' };
const say = (line = '') => console.log(line);

// 写私有数据一律 0600：备份里是全部旧记忆，不能比原来更松。
function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function toNotes(entries, source) {
  const notes = [];
  for (const entry of entries) {
    const songs = guessSongs(entry.text);
    const note = buildNote({
      kind: classifyKind(entry.text, songs),
      text: entry.text,
      quote: entry.text,
      songs,
      source,
      at: entry.at,
      sensitive: isSensitiveText(entry.text) ? 'quiet' : 'normal',
    });
    if (note) notes.push(note);
  }
  return notes;
}

// ── 先看状态，再决定能不能跑 ──
say(`数据目录：${dataDir}`);
const store = createNotebookStore(notebookFile);
const before = store.read();
if (before.migratedAt) {
  say(`已经迁过一次（migratedAt=${before.migratedAt}），不重复迁移：再跑会把你在笔记本里删掉的条目从 memory.md 搬回来。`);
  if (!apply) process.exit(0);
  if (!force) {
    say('如果确实要重跑，加 --force（建议先备份 notebook.json）。什么都没写。');
    process.exit(1);
  }
  say('--force：按你的要求重跑（已删的条目可能复活，重跑后请检查笔记本）。');
}
say(`个人记忆：${memoryFile}`);
const memoryText = readText(memoryFile);
const legacyEntries = parseLegacyMemory(memoryText);
say(`读到 ${legacyEntries.length} 条旧记忆${memoryText ? '' : '（文件不存在或为空）'}`);

const planned = toNotes(legacyEntries, 'legacy');
const existing = new Set((before.notes || []).map((note) => `${note.kind}|${note.text.toLowerCase()}`));
const fresh = planned.filter((note) => !existing.has(`${note.kind}|${note.text.toLowerCase()}`));
say(`笔记本现有 ${before.notes.length} 条，将新增 ${fresh.length} 条：`);
for (const note of planned) {
  say(`  · [${label[note.kind]}] ${note.text.slice(0, 60)}${note.songs.length ? `（关联：${note.songs.map((s) => s.title).join('、')}）` : ''}`
    + `${note.sensitive === 'quiet' ? ' 〔别主动提〕' : ''}`);
}

// ── 公用版 ──
const memberPlans = [];
if (membersDir) {
  say('');
  say(`公用版成员目录：${path.resolve(membersDir)}`);
  let dirs = [];
  try { dirs = fs.readdirSync(membersDir).filter((name) => /^mem_[0-9a-f]{8}$/.test(name)); } catch { dirs = []; }
  for (const id of dirs) {
    const file = path.join(membersDir, id, 'memory.json');
    let mem = null;
    try { mem = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const prefs = Array.isArray(mem.prefs) ? mem.prefs : [];
    const notes = prefs.map((pref) => buildNote({
      kind: classifyKind(pref),
      text: pref,
      quote: pref,
      songs: guessSongs(pref),
      source: 'inferred',
      sensitive: isSensitiveText(pref) ? 'quiet' : 'normal',
    })).filter(Boolean);
    memberPlans.push({ id, file, mem, notes, prefs });
    say(`  ${id}：prefs ${prefs.length} 条 → notes ${notes.length} 条，已有 notes ${(mem.notes || []).length} 条`);
  }
  if (!dirs.length) say('  （没有成员目录）');
}

if (!apply) {
  say('');
  say('这是 dry-run：什么都没写。确认无误后加 --apply。');
  process.exit(0);
}

// ── 写盘（先上锁，防着手跑两个）──
try {
  fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
} catch {
  say(`\n有另一个迁移在跑（锁 ${lockFile}）。先停掉它，或确认后手动删掉这把锁。什么都没写。`);
  process.exit(1);
}
const unlock = () => { try { fs.rmSync(lockFile, { force: true }); } catch { /* 忽略 */ } };
process.on('exit', unlock);
process.on('SIGINT', () => { unlock(); process.exit(130); });

const backups = [];
// 旧文件原来是 0664 / 0644（同组可读）；迁移顺手收紧成 0600，别再比原来更松。
for (const name of (() => { try { return fs.readdirSync(userDir); } catch { return []; } })()) {
  if (/^memory\.md($|\.)/.test(name)) {
    try { fs.chmodSync(path.join(userDir, name), 0o600); } catch { /* 忽略 */ }
  }
}
if (memoryText) {
  const copy = path.join(backupDir, 'memory.md');
  writePrivate(copy, memoryText);
  backups.push(copy);
}
const merged = [...before.notes, ...fresh];
writePrivate(notebookFile, JSON.stringify({
  version: 1, migratedAt: new Date().toISOString(), notes: merged,
}, null, 2));
if (fs.existsSync(tasteDigestFile)) {
  fs.rmSync(tasteDigestFile, { force: true });
  say('已删掉派生的 cache/taste-digest.md（旧版本会把已确认的偏好写进去），下次会自动重新生成。');
}
say('');
say(`已写 ${notebookFile}：${merged.length} 条，迁移标记 ${new Date().toISOString()}`);
say(' memory.md 保留不动，但从此不再进提示词（回滚见 docs/事项28-记忆迁移说明）。');

for (const plan of memberPlans) {
  const backup = path.join(backupDir, 'members', plan.id, 'memory.json');
  writePrivate(backup, JSON.stringify(plan.mem));
  backups.push(backup);
  const seen = new Set((plan.mem.notes || []).map((note) => `${note.kind}|${note.text.toLowerCase()}`));
  const add = plan.notes.filter((note) => !seen.has(`${note.kind}|${note.text.toLowerCase()}`));
  const next = { ...plan.mem, notes: [...(plan.mem.notes || []), ...add], prefs: [] };
  writePrivate(plan.file, JSON.stringify(next));
  say(` ${plan.id}：+${add.length} 条 notes，prefs 已清空`);
}
if (backups.length) {
  say('');
  say(`旧文件备份在 ${backupDir}（权限 0600，只在验证期用来回滚）。验证通过后请老板安排删除整个 notebook-migration-backup 目录。`);
}
say('完成。');
