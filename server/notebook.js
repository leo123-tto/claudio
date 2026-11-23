// 「Vera 的笔记本」：结构化长期记忆（人 / 习惯 / 歌 / 事 四栏）。
//
// 存法：
//   - 个人版：数据目录下 user/notebook.json，一个文件：
//       { version, migratedAt, notes: [条目…] }
//   - 公用版：并在 members 的 memory.json 的 notes 字段（见 server/public/members.js），
//     仍用同一个 createNotebookStore，只是换文件。
//
// 每条：{ id, kind, text, quote, songs:[{title,artist}], at, source, sensitive, status }
//   kind      person | habit | song | event
//   quote     原话片段（口播引用时点开看的就是它）
//   sensitive normal | quiet（quiet = 分手、丧事、生病、职场冲突这类，永不主动提）
//   status    active | muted（muted = 用户按了「别再提」）
//
// 删除必须是真的删除：从主文件里去掉，同时把 .bak（只留上一版、给回滚用）里那条也清掉。
// 备份不存删除记录，免得「删了还在备份里躺着」。
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { config } from './config.js';

export const NOTE_KINDS = ['person', 'habit', 'song', 'event'];
export const KIND_LABEL = { person: '人', habit: '习惯', song: '歌', event: '事' };
export const TEXT_MAX = 120;
export const QUOTE_MAX = 240;
export const NOTES_MAX = 400;

// 这些词一出现就标 quiet：只有用户自己先提起时才接，绝不主动提。
// 老板本职是诉讼律师，「打官司 / 冲突」也标上，避免她主动聊案子。
export const SENSITIVE_WORDS = [
  '分手', '离婚', '去世', '离世', '丧事', '丧礼', '生病', '住院', '癌', '抑郁',
  '裁员', '失业', '吵架', '冲突', '打官司', '焦虑', '失眠', '流产', '分居', '欠款', '被骗',
];

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function isSensitiveText(text) {
  const body = String(text ?? '');
  return SENSITIVE_WORDS.some((word) => body.includes(word));
}

export function normalizeSongs(list = []) {
  const seen = new Set();
  const songs = [];
  for (const item of Array.isArray(list) ? list : []) {
    const title = clean(item?.title ?? item, 80);
    const artist = clean(item?.artist, 80);
    if (!title) continue;
    const key = `${title.toLocaleLowerCase()}|${artist.toLocaleLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    songs.push({ title, artist });
    if (songs.length >= 6) break;
  }
  return songs;
}

// 粗分四栏：提到人的称呼 / 关系词进「人」，作息习惯进「习惯」，有歌进「歌」，其余是「事」。
const PERSON_RE = /(爸爸|妈妈|爸|妈|老婆|老公|女朋友|男朋友|未婚妻|孩子|女儿|儿子|同事|老板|领导|朋友|室友|父母|妹妹|姐姐|哥哥|弟弟)/;
const HABIT_RE = /(每天|每晚|常常|经常|总是|习惯|通勤|加班|早上|凌晨|深夜|周末|午休|睡前|起床|路上)/;

export function classifyKind(text, songs = []) {
  const body = String(text ?? '');
  if (normalizeSongs(songs).length) return 'song';
  if (PERSON_RE.test(body)) return 'person';
  if (HABIT_RE.test(body)) return 'habit';
  return 'event';
}

const NOTE_ID_RE = /^n_[0-9a-f]{8}$/;
// 手改过 / 老格式的条目没有合法 id：按「栏 + 正文 + 时间」算一个稳定的 id。
// 不能用随机值——那样每次读都会换一个，删除永远 404。
export function stableId(kind, text, at = '') {
  const digest = createHash('sha1').update(`${kind}\u0000${text}\u0000${at}`).digest('hex').slice(0, 8);
  return `n_${digest}`;
}

function normalizeNote(raw = {}) {
  const kind = NOTE_KINDS.includes(raw.kind) ? raw.kind : 'event';
  const text = clean(raw.text, TEXT_MAX);
  if (text.length < 2) return null;
  const songs = normalizeSongs(raw.songs);
  const at = Number.isFinite(Date.parse(raw.at)) ? new Date(raw.at).toISOString() : new Date().toISOString();
  const note = {
    id: NOTE_ID_RE.test(String(raw.id || '')) ? raw.id : stableId(kind, text, at),
    kind,
    text,
    quote: clean(raw.quote, QUOTE_MAX),
    songs,
    at,
    source: ['manual', 'legacy', 'inferred', 'chat'].includes(raw.source) ? raw.source : 'manual',
    sensitive: raw.sensitive === 'quiet' || (raw.sensitive !== 'normal' && isSensitiveText(`${text} ${raw.quote || ''}`))
      ? 'quiet' : 'normal',
    status: raw.status === 'muted' ? 'muted' : 'active',
  };
  return note;
}

// 老的 user/memory.md：`- [2026-06-06] 事实`，没有日期也可以。只读出条目，不改文件。
export function parseLegacyMemory(markdown) {
  const entries = [];
  for (const line of String(markdown ?? '').split('\n')) {
    const match = line.match(/^\s*-\s+(?:\[([^\]]*)\]\s*)?(.+)$/);
    if (!match) continue;
    const text = clean(match[2], TEXT_MAX);
    if (text.length < 2) continue;
    const at = Date.parse(match[1] || '');
    entries.push({ text, ...(Number.isFinite(at) ? { at: new Date(at).toISOString() } : {}) });
  }
  return entries;
}

// 从条目里猜出提到的歌（歌名带书名号的、或「歌手 - 歌名」），用于把往事和歌绑在一起。
export function guessSongs(text) {
  const body = String(text ?? '');
  const songs = [];
  for (const match of body.matchAll(/《([^》]{1,40})》/g)) songs.push({ title: match[1] });
  // 「歌手 - 歌名」：两侧都不能以数字开头，也不能全是标点，免得把「7-8点」「2026-11-23」当成歌。
  for (const match of body.matchAll(/([^\d\s，。；、:：,.;!?！？()（）【】《》]{2,20})\s*[-—－]\s*([^\d\s，。；、:：,.;!?！？()（）【】《》]{1,20})/g)) {
    if (match[1] && match[2]) songs.push({ artist: match[1], title: match[2] });
  }
  return normalizeSongs(songs);
}

// 单独造一条（不落盘）：公用版把条目存在成员 memory.json 的 notes 里，就用这个。
export function buildNote(input = {}, { now = new Date() } = {}) {
  return normalizeNote({ ...input, source: input.source || 'manual', at: input.at || now.toISOString() });
}

// 改一条：只允许动这几样，id / at 不变。
export function patchNote(note, patch = {}) {
  const next = {};
  if (typeof patch.text === 'string') next.text = patch.text;
  if (typeof patch.quote === 'string') next.quote = patch.quote;
  if (NOTE_KINDS.includes(patch.kind)) next.kind = patch.kind;
  if (patch.sensitive === 'quiet' || patch.sensitive === 'normal') next.sensitive = patch.sensitive;
  if (patch.status === 'active' || patch.status === 'muted') next.status = patch.status;
  if (Array.isArray(patch.songs)) next.songs = patch.songs;
  // 没明说敏感级时：改完的文字里冒出敏感词就自动转 quiet；原来标了 quiet 不会自己松掉。
  if (next.sensitive === undefined) {
    const body = `${next.text ?? note.text} ${next.quote ?? note.quote ?? ''}`;
    next.sensitive = isSensitiveText(body) || note.sensitive === 'quiet' ? 'quiet' : 'normal';
  }
  return normalizeNote({ ...note, ...next, id: note.id, at: note.at });
}

export function createNotebookStore(file, { now = () => new Date() } = {}) {
  const backupFile = `${file}.bak`;
  const readJson = (target) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch { return null; }
  };
  const shape = (data) => ({
    version: 1,
    ...(data?.migratedAt ? { migratedAt: data.migratedAt } : {}),
    notes: (Array.isArray(data?.notes) ? data.notes : []).map(normalizeNote).filter(Boolean).slice(-NOTES_MAX),
  });
  const writeAtomic = (target, text) => {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
  };
  const serialize = (data) => JSON.stringify({
    version: 1,
    ...(data?.migratedAt ? { migratedAt: data.migratedAt } : {}),
    notes: data?.notes || [],
  }, null, 2);
  // 手改过 / 老格式的条目没有合法 id：读的时候补成固定 id 并写回一次，否则删除永远找不到它。
  const read = () => {
    const shaped = shape(readJson(file));
    const raw = readJson(file);
    if (raw && Array.isArray(raw.notes) && raw.notes.some((note) => !NOTE_ID_RE.test(String(note?.id || '')))) {
      writeAtomic(file, serialize(shaped));
    }
    return shaped;
  };
  // 写之前先把当前内容留成 .bak（只留上一版）。第一次写没有旧内容就不造备份。
  const write = (data) => {
    const next = shape(data);
    const current = readJson(file);
    if (current) writeAtomic(backupFile, JSON.stringify(current));
    writeAtomic(file, serialize(next));
    return next;
  };

  function list() {
    return read().notes;
  }

  function find(id) {
    return list().find((note) => note.id === id) || null;
  }

  function create(input = {}) {
    const data = read();
    const note = buildNote(input, { now: now() });
    if (!note) return null;
    // 同一句话不重复记。
    const twin = data.notes.find((item) => item.text.toLocaleLowerCase() === note.text.toLocaleLowerCase()
      && item.kind === note.kind);
    if (twin) return twin;
    data.notes = [...data.notes, note].slice(-NOTES_MAX);
    write(data);
    return note;
  }

  function update(id, patch = {}) {
    const data = read();
    const index = data.notes.findIndex((note) => note.id === id);
    if (index < 0) return null;
    const merged = patchNote(data.notes[index], patch);
    if (!merged) return null;
    data.notes[index] = merged;
    write(data);
    return merged;
  }

  // 真删：主文件、备份里同时清掉。
  function remove(id) {
    const data = read();
    const next = data.notes.filter((note) => note.id !== id);
    if (next.length === data.notes.length) return false;
    data.notes = next;
    const current = readJson(file);
    if (current) writeAtomic(backupFile, JSON.stringify(current));
    writeAtomic(file, serialize(shape(data)));
    const backup = readJson(backupFile);
    if (backup && Array.isArray(backup.notes)) {
      const scrubbed = backup.notes.filter((note) => note?.id !== id);
      writeAtomic(backupFile, serialize({ ...backup, notes: scrubbed }));
    }
    return true;
  }

  function clear() {
    write({ notes: [] });
  }

  return { file, backupFile, read, list, find, create, update, remove, clear, write };
}

// 默认的个人版笔记本（数据目录 user/notebook.json）。每次现拼路径，方便测试换目录。
export function personalNotebook() {
  return createNotebookStore(path.join(config.paths.user, 'notebook.json'));
}

// 个人版是否已经切成「笔记本为唯一记忆源」。迁移过后 memory.md 只当回滚备份、不再注入。
// 强制回到旧来源：CLAUDIO_NOTEBOOK_SOURCE=legacy。
export function notebookIsSource(store = personalNotebook()) {
  if (String(process.env.CLAUDIO_NOTEBOOK_SOURCE || '').toLowerCase() === 'legacy') return false;
  return Boolean(store.read().migratedAt);
}

// 挑「可提往事」：只挑 active、非 quiet、且挂着歌的条目（这样「和接下来放的歌有关」才验得了）。
// 最近听过的歌有交集排前面，同分看新旧。挑不到就返回空数组 —— 那一期她就不提旧事。
export function pickMentionable(notes = [], { recentSongs = [], limit = 5, now = new Date() } = {}) {
  const recent = new Set((Array.isArray(recentSongs) ? recentSongs : [])
    .map((song) => `${String(song?.title || '').toLocaleLowerCase()}|${String(song?.artist || '').toLocaleLowerCase()}`));
  const nowMs = now.getTime();
  return (Array.isArray(notes) ? notes : [])
    .filter((note) => note && note.status === 'active' && note.sensitive !== 'quiet' && note.songs?.length)
    .map((note) => {
      const overlap = note.songs.filter((song) => recent.has(`${song.title.toLocaleLowerCase()}|${song.artist.toLocaleLowerCase()}`)).length;
      const ageDays = Math.max(0, (nowMs - Date.parse(note.at)) / 86400_000) || 0;
      const score = overlap * 3 + (note.kind === 'song' ? 1 : 0) + Math.max(0, 2 - ageDays / 30);
      return { note, score };
    })
    .sort((a, b) => b.score - a.score || Date.parse(b.note.at) - Date.parse(a.note.at))
    .slice(0, Math.max(0, limit))
    .map(({ note }) => note);
}

// 同一首歌：两边都有歌手就歌名歌手都比；有一边歌手是空的（只记了歌名）就只比歌名。
export function sameSong(a, b) {
  const title = (song) => String(song?.title || '').trim().toLocaleLowerCase();
  const artist = (song) => String(song?.artist || '').trim().toLocaleLowerCase();
  if (!title(a) || title(a) !== title(b)) return false;
  if (!artist(a) || !artist(b)) return true;
  return artist(a) === artist(b);
}

// 口播引用了哪条：必须是这次给过她的候选、还活着、没标「别再提」，并且那条挂的歌真的在播。
export function validateMemoryRef({ refId, candidates = [], playedSongs = [] } = {}) {
  const id = String(refId || '').trim();
  if (!id) return null;
  const note = (Array.isArray(candidates) ? candidates : []).find((item) => item?.id === id);
  if (!note || note.status !== 'active' || note.sensitive === 'quiet') return null;
  const played = Array.isArray(playedSongs) ? playedSongs : [];
  if (!note.songs.some((song) => played.some((other) => sameSong(song, other)))) return null;
  return { id: note.id, kind: note.kind, text: note.text, quote: note.quote, songs: note.songs, at: note.at };
}

// 把模型新学到的候选并进笔记本：同一句不重复，敏感词自动标 quiet。返回新的 notes 数组。
// 个人版、公用版都走这里 —— 记忆只有一个入口，也只有一个删除的地方。
export function mergeInferredNotes(notes = [], candidates = [], { now = new Date() } = {}) {
  const list = Array.isArray(notes) ? [...notes] : [];
  for (const item of Array.isArray(candidates) ? candidates : []) {
    const value = typeof item === 'string' ? item : item?.value;
    const songs = guessSongs(value);
    const note = buildNote({
      kind: classifyKind(value, songs), text: value, quote: item?.evidence || value, songs, source: 'inferred',
    }, { now });
    if (!note) continue;
    if (list.some((other) => String(other?.text || '').toLocaleLowerCase() === note.text.toLocaleLowerCase())) continue;
    list.push(note);
  }
  return list.slice(-NOTES_MAX);
}

// 这轮说话有没有碰到这条敏感记忆：碰到敏感词，或者句子里有这条正文的连续 3 个字。
export function touchedByUser(text, userInput) {
  const said = String(userInput || '');
  if (!said.trim()) return false;
  const body = String(text || '');
  if (SENSITIVE_WORDS.some((word) => body.includes(word) && said.includes(word))) return true;
  const chars = [...body.replace(/\s+/g, '')];
  for (let index = 0; index + 3 <= chars.length; index += 1) {
    if (said.includes(chars.slice(index, index + 3).join(''))) return true;
  }
  return false;
}

// 稳定背景：她平时就该知道的事。
// quiet（分手、丧事、生病、职场冲突…）默认**不进提示词**，只有听众这轮自己先说到相关的词才带上，
// 而且带上时标明「等他先说起才接」。
export function backgroundText(notes = [], { limit = 12, userInput = '' } = {}) {
  const list = (Array.isArray(notes) ? notes : [])
    .filter((note) => note && note.status === 'active')
    .filter((note) => note.sensitive !== 'quiet' || touchedByUser(note.text, userInput))
    .slice(-limit);
  return list.map((note) => `- [${KIND_LABEL[note.kind] || '事'}] ${note.text}${note.sensitive === 'quiet' ? '〔别主动提，等他先说起才接〕' : ''}`).join('\n');
}

// 口播里说了哪条旧事但歌对不上：把提到这条的那几句从 say 里摘掉（保留其余原话）。
// 判断依据是这条挂的歌名 / 歌手，以及正文里连续 4 个字。摘不掉就原样返回，交给调用方决定。
export function stripMemoryStory(say, note) {
  const text = String(say || '').trim();
  if (!text || !note) return { say: text, stripped: false };
  const marks = [...(note.songs || []).flatMap((song) => [song.title, song.artist])]
    .filter((word) => word && String(word).trim().length >= 2)
    .map((word) => String(word).trim().toLocaleLowerCase());
  const chars = [...String(note.text || '').replace(/\s+/g, '')];
  for (let index = 0; index + 4 <= chars.length; index += 1) marks.push(chars.slice(index, index + 4).join('').toLocaleLowerCase());
  const sentences = text.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [text];
  const kept = sentences.filter((sentence) => {
    const body = sentence.toLocaleLowerCase();
    return !marks.some((mark) => mark && body.includes(mark));
  });
  if (!kept.length) return { say: '', stripped: true };
  if (kept.length === sentences.length) return { say: text, stripped: false };
  return { say: kept.join('').trim(), stripped: true };
}

// 注入提示词的一段：只给候选的 id / 栏 / 日期 / 内容 / 关联歌，不给敏感标记（它们根本进不来）。
export function mentionableText(candidates = []) {
  return (Array.isArray(candidates) ? candidates : [])
    .map((note) => `- [${note.id}][${KIND_LABEL[note.kind] || '事'}] ${note.at.slice(0, 10)} ${note.text}（关联歌：${note.songs
      .map((song) => `${song.title}${song.artist ? ` / ${song.artist}` : ''}`).join('、')}）`)
    .join('\n');
}
