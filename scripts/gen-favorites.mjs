// 从喜欢歌单 md 生成 user/favorites.md（歌名 — 歌手），兼容网易云/QQ 两种表格列序。
// 用法：node scripts/gen-favorites.mjs [源md路径]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.argv[2];
if (!src) {
  console.error('用法：node scripts/gen-favorites.mjs <歌单 Markdown 路径>');
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lines = fs.readFileSync(src, 'utf8').split('\n');

let titleCol = -1, artistCol = -1;
const out = [], seen = new Set();
for (const line of lines) {
  if (!line.trim().startsWith('|')) { titleCol = -1; continue; } // 离开表格区
  const cells = line.split('|').map((s) => s.trim());
  if (cells.includes('歌曲标题')) { // 表头：确定列位置
    titleCol = cells.indexOf('歌曲标题');
    artistCol = cells.indexOf('歌手');
    continue;
  }
  if (line.includes('---') || titleCol < 0) continue;
  if (!/^\d+$/.test(cells[1] || '')) continue; // 只取数据行（第1列是序号）
  const title = cells[titleCol], artist = cells[artistCol];
  if (!title) continue;
  const key = `${title}|${artist}`;
  if (seen.has(key)) continue;
  seen.add(key);
  out.push(`- ${title} — ${artist}`);
}

const header = `# 我的喜欢曲库\n\n> 共 ${out.length} 首，从网易云 / QQ 音乐喜欢歌单整理。仅用于让 Claudio 体会我的口味风格，不是点歌清单。\n\n`;
fs.writeFileSync(path.join(root, 'user', 'favorites.md'), header + out.join('\n') + '\n');
console.log(`生成 ${out.length} 首 → user/favorites.md`);
