import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 独立的虚构资料目录，导入 context 不读取个人档案或启动外部服务。
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-context-test-'));
process.env.CLAUDIO_RESOURCE_ROOT = fixtureRoot;
process.env.CLAUDIO_DATA_DIR = fixtureRoot;
fs.mkdirSync(path.join(fixtureRoot, 'user'), { recursive: true });
fs.mkdirSync(path.join(fixtureRoot, 'cache'), { recursive: true });
fs.writeFileSync(path.join(fixtureRoot, 'cache', 'discovery-pool.json'), JSON.stringify({
  songs: [{ title: '池中虚构曲', artist: '虚构乐团', lane: 'fresh' }],
}));
const { buildPromptBundle } = await import('../server/context.js');
const { createNotebookStore } = await import('../server/notebook.js');
test.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

function section(prompt, heading) {
  return prompt.split(`## ${heading}\n`)[1]?.split('\n\n## ')[0] || '';
}

test('正向曲风请求给五首同风格候选，桥接、发现位与起手指纹不再争抢方向', () => {
  const { prompt } = buildPromptBundle({ userInput: '来点爵士' });
  const task = section(prompt, '本次最高优先级任务');
  assert.match(task, /5 个候选/);
  assert.match(task, /全部满足/);
  assert.doesNotMatch(task, /仍要留一首口味桥接|两首歌里要有一首|起手指纹：/);
  assert.equal(section(prompt, '候选池'), '');
  const pool = section(buildPromptBundle({ mood: '爵士' }).prompt, '候选池');
  assert.match(pool, /仅作参考/);
  assert.doesNotMatch(pool, /选一首口味桥接，再选一首本期发现位/);
});

test('自动心情请求也以明确风格为先，纯排除项仍沿用普通推荐', () => {
  const styled = section(buildPromptBundle({ mood: '安静' }).prompt, '本次最高优先级任务');
  assert.match(styled, /5 个候选/);
  assert.doesNotMatch(styled, /起手指纹：|两首歌里要有一首/);
  const excluded = section(buildPromptBundle({ userInput: '不要爵士，随便推荐' }).prompt, '本次最高优先级任务');
  assert.match(excluded, /3 个候选/);
  assert.doesNotMatch(excluded, /5 个候选/);
});

test('输出契约保持稳定，候选数量、仅前两首可播与聊天控制空歌单都有明确约束', () => {
  const ordinary = buildPromptBundle({ userInput: '随便推荐' }).prompt;
  const styled = buildPromptBundle({ userInput: '放钢琴曲', briefSay: true }).prompt;
  const contract = section(ordinary, '输出契约（严格只输出 JSON）');
  assert.equal(section(styled, '输出契约（严格只输出 JSON）'), contract);
  assert.match(contract, /默认给 3 个候选/);
  assert.match(contract, /正向.*5 个候选/);
  assert.match(contract, /只播放前两首/);
  assert.match(contract, /say.*只.*前两首/);
  assert.match(contract, /chat 和 control 必须给 \[\]/);
});

test('所有模式展示全部避重歌名歌手，与推荐过滤清单一致', () => {
  const excludeSongs = Array.from({ length: 25 }, (_, index) => ({
    title: `虚构已播${index + 1}`, artist: `虚构歌手${index + 1}`, year: 2000, genre: '虚构曲风',
  }));
  for (const userInput of ['', '听点古典', '随便推荐']) {
    const { prompt, recommendation } = buildPromptBundle({ userInput, excludeSongs });
    const recent = section(prompt, '最近听过（硬避重；含今天播过的，程序还会再滤一遍）');
    assert.equal(recent, excludeSongs.map(({ title, artist }) => `- ${title} — ${artist}`).join('\n'));
    assert.deepEqual(recommendation.recentSongs, excludeSongs);
    // 听众原话仍放最后，避重清单留在它前面。
    if (userInput) assert.ok(prompt.indexOf('## 最近听过') < prompt.indexOf('## 听众刚说'));
  }
});

test('笔记本接管记忆源：只提可提往事、别再提的不出现、敏感词标明别主动提', () => {
  const fs2 = fs;
  const userDir = path.join(fixtureRoot, 'user');
  const notebookFile = path.join(userDir, 'notebook.json');
  const memoryFile = path.join(userDir, 'memory.md');
  fs2.writeFileSync(memoryFile, '# 记忆\n- [2026-06-01] 旧文件里的那句话\n');
  const notes = [
    { id: 'n_00000001', kind: 'song', text: '他循环过这条街', songs: [{ title: '老街', artist: '李荣浩' }], at: '2026-06-01T00:00:00.000Z', source: 'legacy', sensitive: 'normal', status: 'active' },
    { id: 'n_00000002', kind: 'event', text: '他分手那天听了一夜', songs: [{ title: '老街', artist: '李荣浩' }], at: '2026-06-02T00:00:00.000Z', source: 'legacy', sensitive: 'quiet', status: 'active' },
    { id: 'n_00000003', kind: 'song', text: '这条他不想再提', songs: [{ title: '晴天', artist: '周杰伦' }], at: '2026-06-03T00:00:00.000Z', source: 'manual', sensitive: 'normal', status: 'muted' },
    { id: 'n_00000004', kind: 'habit', text: '他每天十一点后才听', songs: [], at: '2026-06-04T00:00:00.000Z', source: 'legacy', sensitive: 'normal', status: 'active' },
  ];
  try {
    fs2.writeFileSync(notebookFile, JSON.stringify({ version: 1, migratedAt: '2026-11-23T00:00:00.000Z', notes }));
    const { prompt, recommendation } = buildPromptBundle({ now: new Date('2026-11-23T22:00:00+08:00') });
    const mention = section(prompt, '可提往事（这次她能不能提起旧事，只看这里）');
    assert.match(mention, /n_00000001/);
    assert.doesNotMatch(mention, /n_00000002|n_00000003|n_00000004/);
    const background = section(prompt, '她记得的事（稳定背景，用来更懂人；不要拿来当口播开场梗）');
    assert.match(background, /每天十一点/);
    // quiet 默认不进提示词：他这轮没先说起，就别让模型知道
    assert.doesNotMatch(background, /分手那天听了一夜/);
    assert.doesNotMatch(background, /不想再提/);
    // 迁移后 memory.md 不再注入（删掉的条目不能从旧文件漏回来）
    assert.equal(section(prompt, '人工可编辑的长期记忆（保留旧系统，只作稳定背景）'), '');
    assert.match(section(prompt, '你们的关系（决定怎么说话，不要说出来）'), /第一次听|熟客|老友|只对你/);
    assert.match(section(prompt, '输出契约（严格只输出 JSON）'), /memoryRef/);
    assert.equal(recommendation.mentionable.length, 1);

    // 他自己先说到「分手」，这条 quiet 才允许进背景，并且标明别主动提
    const touched = buildPromptBundle({ userInput: '今天有点难受，想起分手那天', now: new Date('2026-11-23T22:00:00+08:00') }).prompt;
    assert.match(section(touched, '她记得的事（稳定背景，用来更懂人；不要拿来当口播开场梗）'), /分手那天听了一夜〔别主动提/);

    // 回滚：显式切回旧来源，memory.md 照旧注入
    process.env.CLAUDIO_NOTEBOOK_SOURCE = 'legacy';
    const rolled = buildPromptBundle({ now: new Date('2026-11-23T22:00:00+08:00') }).prompt;
    assert.match(section(rolled, '人工可编辑的长期记忆（保留旧系统，只作稳定背景）'), /旧文件里的那句话/);
    assert.equal(section(rolled, '她记得的事（稳定背景，用来更懂人；不要拿来当口播开场梗）'), '');
  } finally {
    delete process.env.CLAUDIO_NOTEBOOK_SOURCE;
    fs2.rmSync(notebookFile, { force: true });
    fs2.rmSync(`${notebookFile}.bak`, { force: true });
    fs2.rmSync(memoryFile, { force: true });
    fs2.rmSync(path.join(fixtureRoot, 'cache', 'familiarity.json'), { force: true });
  }
});

test('笔记本里删掉一条之后，任何提示词来源里都找不到它（memory.md / 事件日志 / 旧品味摘要）', () => {
  const userDir = path.join(fixtureRoot, 'user');
  const cacheDir = path.join(fixtureRoot, 'cache');
  const notebookFile = path.join(userDir, 'notebook.json');
  const memoryFile = path.join(userDir, 'memory.md');
  const eventsFile = path.join(cacheDir, 'listening-events.jsonl');
  const digestFile = path.join(cacheDir, 'taste-digest.md');
  const fact = '他妹妹在老家读高中';
  const before = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8') : '';
  try {
    // 三个「别处」都留着同一句：旧记忆文件、事件日志里推断出的偏好、老版本写的品味摘要
    fs.writeFileSync(memoryFile, `# 记忆\n- [2026-06-01] ${fact}\n`);
    fs.writeFileSync(digestFile, `# 持续整理的品味\n已经确认的偏好：${fact}\n常被正向记住的歌手：虚构歌手\n`);
    const events = [1, 2].map((n) => JSON.stringify({
      id: `e-${n}`, at: '2026-06-01T10:00:00.000Z', type: 'memory_inferred', key: '家人', value: fact, evidenceId: `m-${n}`,
    })).join('\n');
    fs.writeFileSync(eventsFile, `${before}${events}\n`);

    const note = {
      id: 'n_0000000e', kind: 'person', text: fact, quote: fact, songs: [],
      at: '2026-06-01T00:00:00.000Z', source: 'legacy', sensitive: 'normal', status: 'active',
    };
    fs.writeFileSync(notebookFile, JSON.stringify({ version: 1, migratedAt: '2026-11-23T00:00:00.000Z', notes: [note] }));
    const withNote = buildPromptBundle({ now: new Date('2026-11-23T22:00:00+08:00') }).prompt;
    assert.match(withNote, new RegExp(fact));

    // 删掉：笔记本、memory.md 里的那句都清掉（服务端删除时会一起做）
    const store = createNotebookStore(notebookFile);
    assert.equal(store.remove(note.id), true);
    const after = buildPromptBundle({ now: new Date('2026-11-23T22:00:00+08:00') }).prompt;
    assert.doesNotMatch(after, new RegExp(fact), '删掉的记忆不能从任何来源回到提示词');
    // 品味摘要里口味那部分照旧保留
    assert.match(after, /虚构歌手/);
  } finally {
    fs.rmSync(notebookFile, { force: true });
    fs.rmSync(`${notebookFile}.bak`, { force: true });
    fs.rmSync(memoryFile, { force: true });
    fs.rmSync(digestFile, { force: true });
    fs.writeFileSync(eventsFile, before);
  }
});

test('删掉一条记忆时，memory.md 和它的备份副本里的原句一起清（删了就不再留在任何旧文件里）', async () => {
  const { removeMemoryLine } = await import('../server/memory.js');
  const userDir = path.join(fixtureRoot, 'user');
  const backupCopy = path.join(fixtureRoot, 'notebook-migration-backup', '20261123T000000', 'user');
  fs.mkdirSync(backupCopy, { recursive: true });
  const fact = '他妹妹在老家读高中';
  const keep = '他每天十一点后才听';
  const body = `# 记忆\n- [2026-06-01] ${fact}\n- [2026-06-02] ${keep}\n`;
  const files = [path.join(userDir, 'memory.md'), path.join(userDir, 'memory.md.bak-20261123'), path.join(backupCopy, 'memory.md')];
  try {
    for (const file of files) fs.writeFileSync(file, body);
    assert.ok(removeMemoryLine(fact) >= 3);
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(text, new RegExp(fact), file);
      assert.match(text, new RegExp(keep), file);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, file);
    }
  } finally {
    for (const file of files) fs.rmSync(file, { force: true });
    fs.rmSync(path.join(fixtureRoot, 'notebook-migration-backup'), { recursive: true, force: true });
    fs.rmSync(path.join(userDir, 'memory.md'), { force: true });
  }
});
