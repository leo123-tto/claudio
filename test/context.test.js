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
