import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPersona, personaMode, personaNow, DEFAULT_CLOSING } from '../server/persona.js';

test('人格核心是 Vera，不含任何听众的个人信息；个人版追加文件接在后面、带结束语', () => {
  const core = loadPersona({ file: null });
  assert.match(core.body, /^你是 Vera，Claudio 电台的 DJ/);
  // 核心就是仓库里的 prompts/vera.md 原文，不掺任何数据目录里的东西
  assert.equal(core.body, fs.readFileSync(new URL('../prompts/vera.md', import.meta.url), 'utf8').trim());
  assert.equal(core.closing, DEFAULT_CLOSING);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-'));
  const file = path.join(dir, 'persona.md');
  fs.writeFileSync(file, '---\nclosing: 晚安，明天见。\n---\n## 你知道的他\n他住在海边。\n');
  const mine = loadPersona({ file });
  assert.ok(mine.body.startsWith(core.body));
  assert.match(mine.body, /他住在海边/);
  assert.equal(mine.closing, '晚安，明天见。');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('此刻用哪一面：晚上深夜守夜人，周末白天或「随便放」策展人，其余老朋友；最后一段带结束语', () => {
  const monday = new Date(2026, 10, 23, 15);
  const saturday = new Date(2026, 10, 28, 15);
  assert.equal(personaMode({ toneKey: 'night', now: saturday }), 'night');
  assert.equal(personaMode({ toneKey: 'day', now: saturday }), 'curator');
  assert.equal(personaMode({ toneKey: 'work', now: monday, text: '随便放点' }), 'curator');
  assert.equal(personaMode({ toneKey: 'work', now: monday }), 'friend');
  assert.match(personaNow('night', { closing: '晚安。' }), /结束语收尾，一字不改：「晚安。」/);
  assert.doesNotMatch(personaNow('friend'), /结束语/);
});
