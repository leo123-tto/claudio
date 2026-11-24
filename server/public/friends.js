// 好友互荐（事项 26）：电台的几位朋友（含老板本人，id 是 owner）之间互加好友、互相推荐歌。
//
// - 好友靠好友码互加：一方生成 6 位码（15 分钟、用一次），另一方输入，两人互为好友；随时可删、可屏蔽。
// - 能跨人传的只有「推荐的歌 + 附言」：别的记忆、听歌记录一律不过这里。
// - 推荐记录只给当事两人看：发的人看「发出」（已送达 / 已播 / 好听，不给看被跳过），收的人看「收到」。
//   被屏蔽的人照样看到「已送达」，收的人那边永远看不到、也不会播。
// - 附言 ≤30 字：发出时先过本地规则（链接、手机号、微信 / QQ 号、词表），再让大脑判一句能不能念；
//   没通过或判不了的只推荐歌，附言不给对方看、不念。
// - 整份数据一个文件，用和网易云 cookie 同一把钥匙加密（AES-256-GCM），盒子上顺手打开看不到内容。
// - 老板后台只要数字（stats），不看内容。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { encrypt, decrypt } from './members.js';
import { stripTags } from '../tts/tags.js';

export const OWNER_ID = 'owner';
export const FRIEND_ID = /^(mem_[0-9a-f]{8}|owner)$/;
export const LIMITS = Object.freeze({
  perDay: 5, // 每人每天最多推荐几首
  pairPerDay: 3, // 对同一个人每天最多几首
  sameSongDays: 90, // 同一首对同一个人多少天内只推一次
  inboxPending: 20, // 收件箱里最多攒几条没播的
  expireDays: 14, // 多少天没播就过期
  noteMax: 30,
  nickMax: 12,
  friendsMax: 50,
  codeMinutes: 15,
  listMax: 100, // 「收到 / 发出」各给多少条
  offerAgainMs: 30 * 60_000, // 交给网页后半小时没开播（页面关了）就当没送到，下次再给
  lostMax: 5, // 问过没听的最多记几条，给「找回」用
  lostDays: 7, // 超过这些天的没听记录不再念
  gapMs: 10 * 60_000, // 同一个人两次插播至少隔多久
  noteWaitMs: 3 * 60_000, // 附言还在检查时，最多等多久再送（送时附言没判完就不带）
});
const DAY = 24 * 3600_000;
const KEEP = 3000;

export class FriendError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// 页面上显示的名字：去掉换行和标记符号（进提示词、进口播都安全），截短
export function cleanName(name, max = LIMITS.nickMax) {
  // 先去括号再说：名字里不会有演出标记，「【小王】」也别被当成标记整个删掉
  return [...String(name || '').replace(/[#<>`{}[\]【】「」"\\]+/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('');
}

// 附言：纯文字、一行；带演出标记、尖括号方括号的一律去掉（不让附言改 Vera 的念法）
export function cleanNote(text) {
  return stripTags(String(text || '')).replace(/[<>[\]{}`#【】\\]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const PHONE = /1[3-9]\d{9}/;
const LONG_DIGITS = /\d{6,}/;
const LINK = /(https?:\/\/|www\.|\.(com|cn|net|org|top|app|me|io|cc|xyz)\b)/i;
const CONTACT = /(微信|威信|薇信|weixin|wechat|vx|wx|qq|扣扣|加我|私聊|联系方式|电话|手机号)/i;

// 本地规则：返回不能发的原因（'' = 没问题）。words 是数据目录里的词表（一行一个，不进仓库）
export function noteProblem(note, words = []) {
  const text = String(note || '');
  if (!text) return '';
  if ([...text].length > LIMITS.noteMax) return 'too-long';
  if (LINK.test(text)) return 'link';
  if (PHONE.test(text) || LONG_DIGITS.test(text.replace(/[\s-]/g, ''))) return 'number';
  if (CONTACT.test(text)) return 'contact';
  const lower = text.toLowerCase();
  if (words.some((w) => w && lower.includes(w))) return 'word';
  return '';
}

export function loadWords(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map((w) => w.trim().toLowerCase()).filter((w) => w && !w.startsWith('#'));
  } catch {
    return [];
  }
}

// 大脑判附言用的提示词：只要 {"ok":true|false}
export function judgePrompt(note) {
  return [
    '你是电台的内容审核。下面是一位听众写给朋友的附言，电台 DJ 会把它念给那位朋友听。',
    '判断能不能念：不能有辱骂、歧视、色情、暴力、广告推销、联系方式、政治内容、别人的隐私；正常的问候、玩笑、心情、对歌的评价都可以。',
    '只输出 JSON：{"ok":true} 或 {"ok":false}，不要别的字。',
    `附言：「${note}」`,
  ].join('\n');
}

const SONG_ID = /^(\d{1,15}|[a-z]{2,4}\d{1,20})$/;
function cleanSong(song) {
  const id = String(song?.id ?? '');
  const title = String(song?.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!SONG_ID.test(id) || !title) return null;
  const cover = String(song?.cover || '');
  return {
    id: /^\d+$/.test(id) ? Number(id) : id,
    title,
    artist: String(song?.artist || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    cover: /^https:\/\/p\d+\.music\.126\.net\/[\w\-./=]+$/.test(cover) && cover.length < 300 ? cover : '',
    duration: Math.max(0, Math.min(3600, Math.round(Number(song?.duration) || 0))),
  };
}

const emptyData = () => ({ profiles: {}, links: [], codes: {}, recs: [], delivered: {} });

export function createFriendStore({
  file,
  vaultKey,
  now = () => Date.now(),
  randomCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'),
  ownerName = '站长',
  limits = LIMITS,
} = {}) {
  let data = null;

  function load() {
    if (data) return data;
    try {
      data = { ...emptyData(), ...JSON.parse(decrypt(vaultKey, fs.readFileSync(file, 'utf8'))) };
    } catch (error) {
      if (error.code !== 'ENOENT' && fs.existsSync(file)) {
        // 解不开（钥匙换了 / 文件坏了）：留着原文件，不覆盖
        fs.renameSync(file, `${file}.bad-${now()}`);
      }
      data = emptyData();
    }
    return data;
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, encrypt(vaultKey, JSON.stringify(data)), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  const check = (id) => {
    if (!FRIEND_ID.test(String(id))) throw new FriendError('bad-id', '找不到这位朋友');
    return String(id);
  };

  function profile(id) {
    const d = load();
    d.profiles[id] ||= { nick: '', hubName: '', accept: true, blocked: [] };
    return d.profiles[id];
  }

  // 每次这个人来调接口都顺手记一下 hub 里的名字（好友看到的默认名字）
  function seen(id, hubName = '') {
    check(id);
    const p = profile(id);
    const name = cleanName(hubName);
    if (name && name !== p.hubName) { p.hubName = name; save(); }
  }

  function nameOf(id) {
    const p = load().profiles[id];
    return cleanName(p?.nick) || cleanName(p?.hubName) || (id === OWNER_ID ? cleanName(ownerName) : '朋友');
  }

  const linked = (a, b) => load().links.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  const friendIds = (id) => load().links.flatMap(([x, y]) => (x === id ? [y] : y === id ? [x] : []));

  function sweep() {
    const d = load();
    const t = now();
    let changed = false;
    for (const [code, c] of Object.entries(d.codes)) if (c.until <= t) { delete d.codes[code]; changed = true; }
    for (const rec of d.recs) {
      if (rec.status === 'pending' && t - rec.at > limits.expireDays * DAY) { rec.status = 'expired'; changed = true; }
      // 问过没听的只留一段时间给「找回」用，久了就清掉，别让记录一直涨
      if (rec.status === 'dropped' && t - (rec.droppedAt || rec.at) > limits.lostDays * DAY) { rec.status = 'expired'; changed = true; }
    }
    if (d.recs.length > KEEP) { d.recs = d.recs.slice(-KEEP); changed = true; }
    if (changed) save();
  }

  // ---- 资料 ----
  function setProfile(id, { nick, accept } = {}) {
    check(id);
    const p = profile(id);
    if (nick !== undefined) p.nick = cleanName(nick);
    if (accept !== undefined) p.accept = Boolean(accept);
    save();
    return me(id);
  }

  function me(id) {
    const p = profile(id);
    return { id, name: nameOf(id), nick: p.nick || '', accept: p.accept !== false, blocked: p.blocked.map((b) => ({ id: b, name: nameOf(b) })) };
  }

  // ---- 好友码 ----
  function createCode(id) {
    check(id);
    sweep();
    const d = load();
    for (const [code, c] of Object.entries(d.codes)) if (c.id === id) delete d.codes[code];
    let code;
    do { code = randomCode(); } while (d.codes[code]);
    const until = now() + limits.codeMinutes * 60_000;
    d.codes[code] = { id, until };
    save();
    return { code, expires: until };
  }

  function redeem(id, code) {
    check(id);
    sweep();
    const d = load();
    const entry = d.codes[String(code || '').trim()];
    if (!entry) throw new FriendError('bad-code', '好友码不对或过期了', 403);
    if (entry.id === id) throw new FriendError('self', '这是你自己的好友码');
    delete d.codes[String(code).trim()];
    const other = entry.id;
    if (!linked(id, other)) {
      if (friendIds(id).length >= limits.friendsMax || friendIds(other).length >= limits.friendsMax) {
        save();
        throw new FriendError('too-many', '好友太多了，先删几个');
      }
      d.links.push([id, other, now()]);
      // 互加就当和好：两边的屏蔽都解开
      profile(id).blocked = profile(id).blocked.filter((b) => b !== other);
      profile(other).blocked = profile(other).blocked.filter((b) => b !== id);
    }
    save();
    return { id: other, name: nameOf(other) };
  }

  function friends(id) {
    return friendIds(check(id)).map((f) => ({ id: f, name: nameOf(f), accept: profile(f).accept !== false }));
  }

  function remove(id, other) {
    check(id);
    const d = load();
    d.links = d.links.filter(([x, y]) => !((x === id && y === other) || (x === other && y === id)));
    save();
  }

  // 屏蔽：解除好友，对方之后（包括已经发来没播的）都不会到我这儿
  function block(id, other) {
    check(id); check(other);
    remove(id, other);
    const p = profile(id);
    if (!p.blocked.includes(other)) p.blocked.push(other);
    // 已经发来还没播的也作废（以后解除屏蔽也不会冒出来），发的人那边照旧「已送达」
    for (const r of load().recs) if (r.from === other && r.to === id && r.status === 'pending') r.blocked = true;
    save();
  }

  function unblock(id, other) {
    const p = profile(check(id));
    p.blocked = p.blocked.filter((b) => b !== other);
    save();
  }

  const isBlocked = (to, from) => (load().profiles[to]?.blocked || []).includes(from);

  // ---- 推荐 ----
  // note 已经 cleanNote 过、过了本地规则；noteState：none / pending（等大脑判）/ ok / rejected
  function recommend(from, to, song, note = '') {
    check(from); check(to);
    sweep();
    const d = load();
    if (from === to) throw new FriendError('self', '不能推荐给自己');
    if (!linked(from, to) && !isBlocked(to, from)) throw new FriendError('not-friend', '你们还不是好友');
    const clean = cleanSong(song);
    if (!clean) throw new FriendError('bad-song', '这首歌信息不全，换一首试试');
    if (profile(to).accept === false) throw new FriendError('not-accepting', `${nameOf(to)}暂时不接收推荐`);
    const t = now();
    const mine = d.recs.filter((r) => r.from === from && t - r.at < DAY);
    if (mine.length >= limits.perDay) throw new FriendError('day-limit', `今天已经推荐了 ${limits.perDay} 首，明天再来`, 429);
    if (mine.filter((r) => r.to === to).length >= limits.pairPerDay) throw new FriendError('pair-limit', `今天给${nameOf(to)}推荐得够多了，明天再来`, 429);
    if (d.recs.some((r) => r.from === from && r.to === to && String(r.song.id) === String(clean.id) && t - r.at < limits.sameSongDays * DAY)) {
      throw new FriendError('duplicate', `这首已经推荐给${nameOf(to)}了`);
    }
    const blocked = isBlocked(to, from);
    if (!blocked && d.recs.filter((r) => r.to === to && r.status === 'pending' && !r.blocked).length >= limits.inboxPending) {
      throw new FriendError('inbox-full', `${nameOf(to)}还有好多首没听，过两天再推荐`);
    }
    const rec = {
      id: `rec_${crypto.randomBytes(6).toString('hex')}`, from, to, song: clean,
      note: note || '', noteState: note ? 'pending' : 'none', at: t, status: 'pending',
      offeredAt: 0, playedAt: 0, liked: false, ...(blocked ? { blocked: true } : {}),
    };
    d.recs.push(rec);
    save();
    return sentView(rec);
  }

  function setNoteVerdict(recId, ok) {
    const rec = load().recs.find((r) => r.id === recId);
    if (!rec || rec.noteState !== 'pending') return;
    rec.noteState = ok ? 'ok' : 'rejected';
    save();
  }

  // 给 to 挑一首该插播的（最早的）；挑中就记下交出去的时间。没有、或离上次插播太近返回 null。
  function next(to, { force = false } = {}) {
    check(to);
    sweep();
    const d = load();
    const t = now();
    if (!force && t - (d.delivered[to] || 0) < limits.gapMs) return null;
    const rec = d.recs.find((r) => r.to === to && r.status === 'pending' && !r.blocked && !isBlocked(to, r.from)
      && t - (r.offeredAt || 0) >= limits.offerAgainMs
      && !(r.noteState === 'pending' && t - r.at < limits.noteWaitMs));
    if (!rec) return null;
    rec.offeredAt = t;
    d.delivered[to] = t;
    save();
    return deliveryView(rec);
  }

  function findFor(to, recId) {
    const rec = load().recs.find((r) => r.id === String(recId || '') && r.to === to && !r.blocked);
    if (!rec) throw new FriendError('no-rec', '找不到这条推荐', 404);
    return rec;
  }

  function played(to, recId) {
    const rec = findFor(check(to), recId);
    if (rec.status === 'pending' || rec.status === 'expired') { rec.status = 'played'; rec.playedAt = now(); save(); }
    return receivedView(rec);
  }

  function like(to, recId) {
    const rec = findFor(check(to), recId);
    if (!rec.liked) { rec.liked = true; if (rec.status !== 'played') { rec.status = 'played'; rec.playedAt ||= now(); } save(); }
    return receivedView(rec);
  }

  // 按歌找（红心时只知道歌）：最近播过的那条
  function likeSong(to, songId) {
    check(to);
    const rec = [...load().recs].reverse().find((r) => r.to === to && !r.blocked && String(r.song.id) === String(songId)
      && (r.status === 'played' || r.offeredAt));
    return rec ? like(to, rec.id) : null;
  }

  // 这首在对方那里放不了：标出来，别再给
  function unplayable(to, recId) {
    const rec = findFor(check(to), recId);
    if (rec.status === 'pending') { rec.status = 'unplayable'; save(); }
  }

  // ---- 问过但没听 ----
  // Vera 问「要不要听」，对方没回、或回了不听，都落到 dropped：不再自动插播，
  // 但记录留着——用户问「刚才谁推荐了什么」时还要能说出来，也能 recover 回 pending。
  function drop(to, recId) {
    const rec = findFor(check(to), recId);
    if (rec.status === 'pending') { rec.status = 'dropped'; rec.droppedAt = now(); save(); }
    return receivedView(rec);
  }

  // 找回来的那首重新排队（用户说了「那首听听看」）
  function recover(to, recId) {
    const rec = findFor(check(to), recId);
    if (rec.status === 'dropped') {
      rec.status = 'pending';
      rec.offeredAt = 0;
      rec.droppedAt = 0;
      save();
    }
    return receivedView(rec);
  }

  // 最近被丢弃的几条：Vera 念「谁推了什么」用，也可以拿来恢复
  // 按丢弃时间排（不是按推荐时间）——用户问的是「刚才」谁推的。
  function droppedList(to, { days = limits.lostDays } = {}) {
    check(to);
    sweep();
    const t = now();
    return load().recs
      .filter((r) => r.to === to && !r.blocked && !isBlocked(to, r.from)
        && r.status === 'dropped' && t - (r.droppedAt || r.at) < days * DAY)
      .sort((x, y) => (y.droppedAt || y.at) - (x.droppedAt || x.at))
      .slice(0, limits.lostMax)
      .map(receivedView);
  }

  // ---- 给两边看的样子 ----
  const noteFor = (rec) => (rec.noteState === 'ok' ? rec.note : '');
  function deliveryView(rec) {
    return { id: rec.id, from: { id: rec.from, name: nameOf(rec.from) }, song: rec.song, note: noteFor(rec), at: rec.at };
  }
  function receivedView(rec) {
    const status = rec.status === 'played' ? 'played'
      : rec.status === 'expired' ? 'expired'
        : rec.status === 'unplayable' ? 'unplayable'
          : rec.status === 'dropped' ? 'dropped'
            : 'new';
    return { ...deliveryView(rec), status, liked: rec.liked };
  }
  // 发的人看到的：被跳过不给看；被屏蔽的照样「已送达」
  function sentView(rec) {
    const status = rec.blocked ? 'sent' : rec.status === 'pending' ? 'sent' : rec.status;
    return {
      id: rec.id, to: { id: rec.to, name: nameOf(rec.to) }, song: rec.song, note: rec.note, at: rec.at,
      noteState: rec.noteState, status, liked: rec.blocked ? false : rec.liked,
    };
  }

  function inbox(id) {
    check(id);
    sweep();
    return load().recs.filter((r) => r.to === id && !r.blocked && !isBlocked(id, r.from)).slice(-limits.listMax).reverse().map(receivedView);
  }

  function sent(id) {
    check(id);
    sweep();
    return load().recs.filter((r) => r.from === id).slice(-limits.listMax).reverse().map(sentView);
  }

  function dayLeft(id) {
    const t = now();
    return Math.max(0, limits.perDay - load().recs.filter((r) => r.from === id && t - r.at < DAY).length);
  }

  function overview(id, hubName = '') {
    seen(id, hubName);
    return { me: me(id), friends: friends(id), inbox: inbox(id), sent: sent(id), dayLeft: dayLeft(id), noteMax: limits.noteMax };
  }

  // 成员被删 / 停用：好友关系、好友码、和 ta 有关的推荐全删
  function purge(id) {
    const d = load();
    if (!d.profiles[id] && !d.links.some((l) => l.includes(id)) && !d.recs.some((r) => r.from === id || r.to === id)) return false;
    delete d.profiles[id];
    delete d.delivered[id];
    d.links = d.links.filter(([x, y]) => x !== id && y !== id);
    for (const [code, c] of Object.entries(d.codes)) if (c.id === id) delete d.codes[code];
    d.recs = d.recs.filter((r) => r.from !== id && r.to !== id);
    for (const p of Object.values(d.profiles)) p.blocked = (p.blocked || []).filter((b) => b !== id);
    save();
    return true;
  }

  // 圈子里出现过的所有成员 id（不含老板）：和 hub 对账用，停用 / 删除的整块清掉
  function ids() {
    const d = load();
    const all = new Set([...Object.keys(d.profiles), ...d.links.flatMap(([x, y]) => [x, y]),
      ...d.recs.flatMap((r) => [r.from, r.to]), ...Object.values(d.codes).map((c) => c.id)]);
    all.delete(OWNER_ID);
    return [...all];
  }

  // 老板后台只看数字
  function stats() {
    const d = load();
    const t = now();
    const today = d.recs.filter((r) => t - r.at < DAY);
    return {
      friendPairs: d.links.length,
      recsToday: today.length,
      recsTotal: d.recs.length,
      playedToday: today.filter((r) => r.status === 'played').length,
    };
  }

  return {
    seen, nameOf, me, setProfile, createCode, redeem, friends, remove, block, unblock,
    recommend, setNoteVerdict, next, played, like, likeSong, unplayable,
    drop, recover, droppedList,
    inbox, sent, dayLeft, overview, purge, ids, stats, isFriend: (a, b) => linked(a, b),
  };
}
