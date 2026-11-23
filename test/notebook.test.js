// 「Vera 的笔记本」：四栏结构、敏感标记、别再提、真删除（连备份一起清）、可提往事的挑选与校验。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  backgroundText,
  buildNote,
  classifyKind,
  createNotebookStore,
  guessSongs,
  isSensitiveText,
  mentionableText,
  parseLegacyMemory,
  sameSong,
  stripMemoryStory,
  stableId,
  mergeInferredNotes,
  touchedByUser,
  patchNote,
  pickMentionable,
  validateMemoryRef,
} from '../server/notebook.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-notebook-'));

test('旧记忆按行解析，四栏粗分，歌名能猜出来', () => {
  const entries = parseLegacyMemory([
    '# Claudio 的记忆',
    '> 注释不算',
    '- [2026-06-06] ta 有深夜听歌、听着听着才睡着的习惯。',
    '- 他妈妈住在老家，周末常回去。',
    '- ta 觉得《Lemon》听太多遍了',
    '- [不是日期] 老板喜欢《老街》',
  ].join('\n'));
  assert.deepEqual(entries.map((item) => item.text), [
    'ta 有深夜听歌、听着听着才睡着的习惯。',
    '他妈妈住在老家，周末常回去。',
    'ta 觉得《Lemon》听太多遍了',
    '老板喜欢《老街》',
  ]);
  assert.equal(entries[0].at.slice(0, 10), '2026-06-06');
  assert.equal(classifyKind(entries[0].text), 'habit');
  assert.equal(classifyKind(entries[1].text, guessSongs(entries[1].text)), 'person');
  assert.deepEqual(guessSongs(entries[2].text), [{ title: 'Lemon', artist: '' }]);
  assert.equal(classifyKind(entries[2].text, guessSongs(entries[2].text)), 'song');
});

test('敏感词自动标 quiet，含老板要的那几个词；改写时也会重新判定', () => {
  for (const word of ['分手', '去世', '生病', '打官司', '焦虑', '失眠', '流产', '分居', '欠款', '被骗']) {
    assert.equal(isSensitiveText(`他说最近${word}`), true, word);
  }
  assert.equal(isSensitiveText('他喜欢下雨天听钢琴'), false);
  const note = buildNote({ kind: 'event', text: '他最近焦虑得睡不着' });
  assert.equal(note.sensitive, 'quiet');
  const plain = buildNote({ kind: 'event', text: '他周末常去爬山' });
  assert.equal(plain.sensitive, 'normal');
  const rewritten = patchNote(plain, { text: '他上周被骗了' });
  assert.equal(rewritten.sensitive, 'quiet');
  // 明说「可以主动提」才放开
  assert.equal(patchNote(note, { sensitive: 'normal' }).sensitive, 'normal');
});

test('增删改：同一句不重复记；删就是真删，备份里也清掉', () => {
  const dir = tmp();
  const file = path.join(dir, 'notebook.json');
  const store = createNotebookStore(file);
  const first = store.create({ kind: 'habit', text: '他每天十一点后才听' });
  assert.ok(first.id.startsWith('n_'));
  assert.equal(store.create({ kind: 'habit', text: '他每天十一点后才听' }).id, first.id);
  store.create({ kind: 'event', text: '他喜欢《老街》' });
  store.create({ kind: 'person', text: '他妈妈在老家' });
  assert.equal(store.list().length, 3);

  // 造一个备份：再写一次，上一版进 .bak
  assert.ok(fs.existsSync(`${file}.bak`));
  const updated = store.update(first.id, { status: 'muted' });
  assert.equal(updated.status, 'muted');
  assert.equal(store.remove(first.id), true);
  assert.equal(store.list().some((note) => note.id === first.id), false);
  const backup = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
  assert.equal(backup.notes.some((note) => note.id === first.id), false, '备份里不能留着删掉的条目');
  assert.equal(store.remove('n_00000000'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('迁移标记：写了 migratedAt 才算笔记本接管记忆源', () => {
  const dir = tmp();
  const store = createNotebookStore(path.join(dir, 'notebook.json'));
  assert.equal(store.read().migratedAt, undefined);
  store.write({ migratedAt: '2026-11-23T00:00:00.000Z', notes: [] });
  assert.equal(store.read().migratedAt, '2026-11-23T00:00:00.000Z');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('可提往事：只挑没标别再提、不敏感、挂着歌的条目，最近听过的排前面', () => {
  const notes = [
    buildNote({ id: 'n_00000001', kind: 'song', text: '他循环过这条街', songs: [{ title: '老街', artist: '李荣浩' }], at: '2026-06-01' }),
    buildNote({ id: 'n_00000002', kind: 'song', text: '他喜欢这张专辑', songs: [{ title: 'Lemon', artist: '米津玄師' }], at: '2026-11-20' }),
    buildNote({ id: 'n_00000003', kind: 'habit', text: '他每天十一点后才听' }),
    buildNote({ id: 'n_00000004', kind: 'event', text: '他分手那天听了一夜', songs: [{ title: '老街', artist: '李荣浩' }] }),
    buildNote({ id: 'n_00000005', kind: 'song', text: '他不想再提这首', songs: [{ title: '老街', artist: '李荣浩' }], status: 'muted' }),
  ];
  const picked = pickMentionable(notes, { recentSongs: [{ title: '老街', artist: '李荣浩' }], now: new Date('2026-11-23T12:00:00Z') });
  assert.deepEqual(picked.map((note) => note.id), ['n_00000001', 'n_00000002']);
  assert.equal(pickMentionable(notes, { recentSongs: [], limit: 1 }).length, 1);
  assert.equal(mentionableText(picked).includes('n_00000001'), true);
  assert.equal(mentionableText(picked).includes('分手'), false);
});

test('引用校验：必须是这次给过的候选，而且那条挂的歌真的在播', () => {
  const note = buildNote({ id: 'n_0000000a', kind: 'song', text: '他循环过这条街', quote: '老街我循环了四遍', songs: [{ title: '老街', artist: '李荣浩' }] });
  const candidates = [note];
  const played = [{ title: '老街', artist: '李荣浩' }, { title: '晴天', artist: '周杰伦' }];
  assert.deepEqual(validateMemoryRef({ refId: note.id, candidates, playedSongs: played }), {
    id: note.id, kind: 'song', text: note.text, quote: note.quote, songs: note.songs, at: note.at,
  });
  // 歌没在播 → 不算引用
  assert.equal(validateMemoryRef({ refId: note.id, candidates, playedSongs: [{ title: '晴天', artist: '周杰伦' }] }), null);
  // 不是这次给过她的候选 → 不算
  assert.equal(validateMemoryRef({ refId: note.id, candidates: [], playedSongs: played }), null);
  // 标了别再提 / 敏感 → 不算
  assert.equal(validateMemoryRef({ refId: note.id, candidates: [patchNote(note, { status: 'muted' })], playedSongs: played }), null);
  assert.equal(validateMemoryRef({ refId: note.id, candidates: [patchNote(note, { sensitive: 'quiet' })], playedSongs: played }), null);
  assert.equal(validateMemoryRef({ refId: '', candidates, playedSongs: played }), null);
});

test('稳定背景：quiet 不主动进提示词，只有他先说起才带；删掉的、别再提的不出现', () => {
  const notes = [
    buildNote({ kind: 'habit', text: '他每天十一点后才听' }),
    buildNote({ kind: 'event', text: '他分手那天听了一夜' }),
    buildNote({ kind: 'song', text: '这条他不想再看', status: 'muted' }),
  ];
  const plain = backgroundText(notes);
  assert.match(plain, /每天十一点/);
  assert.doesNotMatch(plain, /分手那天/);
  assert.doesNotMatch(plain, /不想再看/);
  // 他自己先说到相关的词，才允许带上，并标明别主动提
  assert.match(backgroundText(notes, { userInput: '今天又想起分手那天' }), /分手那天听了一夜〔别主动提，等他先说起才接〕/);
  assert.doesNotMatch(backgroundText(notes), /分手那天/);
  assert.equal(touchedByUser('他分手那天听了一夜', '随便放点'), false);
  assert.equal(touchedByUser('他分手那天听了一夜', '想起分手了'), true);
});

test('手改过 / 没 id 的条目：补成固定 id 并写回，删得掉', () => {
  const dir = tmp();
  const file = path.join(dir, 'notebook.json');
  const handEdited = { version: 1, notes: [{ kind: 'habit', text: '每晚都听一会儿', at: '2026-06-01T00:00:00.000Z' }] };
  fs.writeFileSync(file, JSON.stringify(handEdited));
  const store = createNotebookStore(file);
  const first = store.list()[0];
  assert.match(first.id, /^n_[0-9a-f]{8}$/);
  assert.equal(first.id, stableId('habit', first.text, first.at));
  // 读一次就写回固定 id，再读还是同一个
  assert.equal(store.list()[0].id, first.id);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).notes[0].id, first.id);
  assert.equal(store.remove(first.id), true);
  assert.equal(store.list().length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sameSong：歌手空的条目只比歌名，照样能对上正在放的歌', () => {
  assert.equal(sameSong({ title: '老街' }, { title: '老街', artist: '李荣浩' }), true);
  assert.equal(sameSong({ title: '老街', artist: '' }, { title: '老街', artist: '李荣浩' }), true);
  assert.equal(sameSong({ title: '老街', artist: '李荣浩' }, { title: '老街', artist: '李荣浩' }), true);
  assert.equal(sameSong({ title: '老街', artist: '李荣浩' }, { title: '老街', artist: '别人' }), false);
  assert.equal(sameSong({ title: '老街' }, { title: '晴天' }), false);
  const note = buildNote({ id: 'n_0000000b', kind: 'song', text: '他循环过这条街', quote: '循环了四遍', songs: [{ title: '老街' }] });
  assert.equal(validateMemoryRef({ refId: note.id, candidates: [note], playedSongs: [{ title: '老街', artist: '李荣浩' }] })?.id, note.id);
});

test('歌对不上时，把提这件旧事的那几句从口播里摘掉', () => {
  const note = buildNote({ id: 'n_0000000c', kind: 'song', text: '他循环过这条街，说那是大学那条路', songs: [{ title: '老街', artist: '李荣浩' }] });
  const out = stripMemoryStory('你上次循环《老街》，那就接着听这首。这首新歌很适合今晚。', note);
  assert.equal(out.stripped, true);
  assert.doesNotMatch(out.say, /老街/);
  assert.match(out.say, /这首新歌很适合今晚/);
  // 歌名换成别人、但正文被搬过来也认得
  assert.equal(stripMemoryStory('你说那是大学那条路，我记着。', note).stripped, true);
  // 完全没提就原样返回
  const clean = stripMemoryStory('今晚换点轻的。', note);
  assert.equal(clean.stripped, false);
  assert.equal(clean.say, '今晚换点轻的。');
  // 摘空了就告诉调用方是空的
  assert.equal(stripMemoryStory('《老街》我记得。', note).say, '');
});

test('guessSongs 不把时间段 / 日期当成「歌手 - 歌名」', () => {
  assert.deepEqual(guessSongs('他一般 7-8点 起床'), []);
  assert.deepEqual(guessSongs('2026-11-23 那天'), []);
  assert.deepEqual(guessSongs('他爱听 李荣浩 - 老街'), [{ title: '老街', artist: '李荣浩' }]);
  assert.deepEqual(guessSongs('他爱听《老街》'), [{ title: '老街', artist: '' }]);
});

test('模型新学到的候选并进笔记本：同句不重复，敏感词自动标 quiet', () => {
  const notes = mergeInferredNotes([], [
    { value: '他喜欢粤语老歌', evidence: '我说过喜欢粤语' },
    { value: '他最近被骗了钱', evidence: '被骗了' },
  ]);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].source, 'inferred');
  assert.equal(notes[0].quote, '我说过喜欢粤语');
  assert.equal(notes[1].sensitive, 'quiet');
  assert.equal(mergeInferredNotes(notes, [{ value: '他喜欢粤语老歌' }]).length, 2);
});

test('写盘权限是 0600（笔记本和它的备份）', () => {
  const dir = tmp();
  const file = path.join(dir, 'notebook.json');
  const store = createNotebookStore(file);
  store.create({ kind: 'event', text: '第一条' });
  store.create({ kind: 'event', text: '第二条' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${file}.bak`).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});
