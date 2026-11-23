// 长期记忆：DJ 在互动中觉得"值得长期记住的关于 ta 的事"，逐条沉淀到 user/memory.md（人可读、可手动增删改）。
// context.js 每次开节目都把它注入 prompt → Claudio 越聊越懂 ta，用于聊天 / 推荐 / 做歌单。
// 设计：只 append、不整文件重写——保住老板手动写的内容；按正文去重，避免同一件事反复记。
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const FILE = path.join(config.paths.user, 'memory.md');
const HEADER = `# Claudio 的记忆

> Claudio 在和你互动时，把觉得值得长期记住的事一条条记在这里（你也可以手动增删改）。
> 每次开节目都会读它，用来更懂你：聊天、推荐、做歌单都会参考。
`;

// 读出所有记忆条目（markdown 列表行）
function readLines() {
  try {
    return fs.readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim().startsWith('- '));
  } catch { return []; }
}
// 取条目正文（去掉 "- [日期] " 前缀），用于去重比较
const bodyOf = (line) => line.replace(/^-\s*(?:\[[^\]]*\]\s*)?/, '').trim().toLowerCase();

// 记一条记忆（DJ 判定值得记时调用）。完全相同的事不重复记；首次写自动建文件头。
export function appendMemory(text) {
  const fact = String(text || '').replace(/\s+/g, ' ').trim();
  if (fact.length < 4) return false; // 太短的不当记忆
  if (readLines().some((l) => bodyOf(l) === fact.toLowerCase())) return false; // 去重
  const date = new Date().toISOString().slice(0, 10);
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, HEADER + '\n');
    fs.appendFileSync(FILE, `- [${date}] ${fact}\n`);
    console.log(`[记忆] +1：${fact.slice(0, 50)}`);
    return true;
  } catch (e) { console.warn('[记忆] 写入失败：', e.message); return false; }
}

// 和 memory.md 同源的副本：同一个目录下的 memory.md.*（老板手动的 .bak），以及迁移备份目录里的拷贝。
// 迁移后 memory.md 只当回滚备份，但备份里留着已删的原句，等于「删了还在」，所以删一条时这些一起清。
function legacyCopies() {
  const files = new Set([FILE]);
  const collect = (dir) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) if (/^memory\.md($|\.)/.test(name)) files.add(path.join(dir, name));
  };
  collect(config.paths.user);
  const backupRoot = path.join(config.paths.dataRoot, 'notebook-migration-backup');
  let stamps = [];
  try { stamps = fs.readdirSync(backupRoot); } catch { stamps = []; }
  for (const stamp of stamps) {
    collect(path.join(backupRoot, stamp, 'user'));
    collect(path.join(backupRoot, stamp));
  }
  return [...files];
}

// 笔记本里删掉一条时，把 memory.md（和它的备份副本）里对应的那行也删掉。
export function removeMemoryLine(text) {
  const fact = bodyOf(`- ${String(text || '')}`);
  if (!fact) return 0;
  let removed = 0;
  for (const file of legacyCopies()) {
    let lines;
    try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { continue; }
    const kept = lines.filter((line) => bodyOf(line) !== fact);
    const count = lines.length - kept.length;
    if (!count) continue;
    try {
      fs.writeFileSync(file, kept.join('\n'), { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      removed += count;
    } catch (e) { console.warn('[记忆] 删除失败：', e.message); }
  }
  return removed;
}

// 给 context 注入：最近 n 条记忆文本（注入有上限，防 prompt 过长）；没有返回 ''
export function readMemory(n = 60) {
  return readLines().slice(-n).join('\n');
}
