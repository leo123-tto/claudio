// 好友互荐（事项 26）的接口：公用版成员走 /api/friends/*（要已绑定的设备），老板个人版走只听本机的内部口 /owner/*。
// 存储和规则在 friends.js；这里只管接口、附言检查、「把这首推荐给 XX」这句话。
import express from 'express';
import http from 'node:http';
import { FriendError, OWNER_ID, cleanName, cleanNote, judgePrompt, noteProblem, LIMITS } from './friends.js';

const NOTE_MESSAGES = {
  'too-long': `附言最多 ${LIMITS.noteMax} 个字`,
  link: '附言里不能带链接',
  number: '附言里不能带号码',
  contact: '附言里不能留联系方式',
  word: '附言里有不合适的词，换个说法',
};

export function sendFriendError(res, error) {
  if (error instanceof FriendError) return res.status(error.status).json({ error: error.code, message: error.message });
  return res.status(500).json({ error: 'server_error', message: '出了点问题，稍后再试' });
}

// 推荐的统一入口（成员和老板共用）：附言先过本地规则（不过就整条不发，让人改），再交给 judge 异步判能不能念。
// trusted（老板自己发的）不叫大脑，本地规则过了就算通过。
export function createRecommender({ friends, words = () => [], brain = null, log = () => {}, judgeWaitMs = LIMITS.noteWaitMs - 30_000 }) {
  function judge(recId, note) {
    Promise.resolve()
      .then(() => (typeof brain?.judge === 'function' ? brain.judge(judgePrompt(note), { waitMs: judgeWaitMs }) : null))
      .catch(() => null)
      .then((ok) => {
        if (ok !== true) log('friend-note-rejected', recId, ok === false ? 'judged' : 'unjudged');
        friends.setNoteVerdict(recId, ok === true);
      });
  }
  return function recommend(from, to, song, rawNote = '', { trusted = false } = {}) {
    const note = cleanNote(rawNote);
    const problem = noteProblem(note, words());
    if (problem) throw new FriendError(`note-${problem}`, NOTE_MESSAGES[problem]);
    const rec = friends.recommend(from, to, song, note);
    if (note) {
      if (trusted) friends.setNoteVerdict(rec.id, true);
      else judge(rec.id, note);
    }
    return { ...rec, noteState: note ? (trusted ? 'ok' : 'pending') : 'none' };
  };
}

// 昵称会被念出来：和附言同一套本地规则，也不许冒充站长
export function checkNick(nick, { words = () => [], ownerName = '' } = {}) {
  const clean = cleanName(nick);
  if (!clean) return '';
  const problem = noteProblem(clean, words());
  if (problem) throw new FriendError(`nick-${problem}`, problem === 'too-long' ? '昵称太长了' : '这个昵称不能用');
  if (ownerName && clean === cleanName(ownerName)) throw new FriendError('nick-owner', '这个昵称不能用');
  return clean;
}

// 「把这首推荐给小王」「推荐给小王，说下雨天听这个」：返回 { name, note, explicit } 或 null。
// explicit = 说了「这首 / 它」；没说的（「推荐给我几首周杰伦」）要名字对得上好友才算，由调用方判断
const REC_TEXT = /^(?:请|帮我|麻烦)?(?:把|将)?(这首歌?|这歌|它|现在这首歌?|正在放的(?:这首)?歌?)?(?:推荐|推|分享|发)给\s*([^，,：:。！!\s]{1,12})(?:[，,：:\s]+(?:(?:跟|告诉|对)(?:ta|他|她)\s*)?(?:说|附言|留言|附一句|带句话)[：:，,\s]*(.+?))?[。！!～~]*$/i;
export function parseRecText(text) {
  const m = REC_TEXT.exec(String(text || '').trim());
  if (!m || /^(?:我|你|大家|咱)/.test(m[2])) return null;
  return { name: m[2].trim(), note: (m[3] || '').trim(), explicit: Boolean(m[1]) };
}

// 按名字找好友：全等优先，其次包含；找不到 / 不止一个都返回给调用方去问
export function matchFriend(list, name) {
  const want = cleanName(name).toLowerCase();
  if (!want) return { hits: [] };
  const exact = list.filter((f) => f.name.toLowerCase() === want);
  if (exact.length) return { hits: exact };
  return { hits: list.filter((f) => f.name.toLowerCase().includes(want) || want.includes(f.name.toLowerCase())) };
}

// ---- 公用版成员的接口 ----
export function mountFriendRoutes(app, { auth, friends, recommend, members, failLimiter, clientIp, words, ownerName }) {
  const r = express.Router();
  r.use(auth, (req, res, next) => {
    try { friends.seen(req.member.id, req.member.name); } catch { /* 名字记不上不影响 */ }
    next();
  });
  const wrap = (fn) => (req, res) => {
    try { res.json(fn(req) ?? { ok: true }); } catch (error) { sendFriendError(res, error); }
  };
  const target = (req) => String(req.body?.id || '');

  r.get('/', wrap((req) => friends.overview(req.member.id, req.member.name)));
  r.post('/code', wrap((req) => friends.createCode(req.member.id)));
  r.post('/add', (req, res) => {
    const ip = clientIp(req);
    if (failLimiter.blocked(ip)) return res.status(429).json({ error: 'rate_limit', message: '试错太多次了，10 分钟后再来' });
    try {
      res.json({ friend: friends.redeem(req.member.id, String(req.body?.code || '').replace(/\s+/g, '')) });
    } catch (error) {
      if (error.code === 'bad-code') failLimiter.fail(ip);
      sendFriendError(res, error);
    }
  });
  r.post('/remove', wrap((req) => { friends.remove(req.member.id, target(req)); }));
  r.post('/block', wrap((req) => { friends.block(req.member.id, target(req)); }));
  r.post('/unblock', wrap((req) => { friends.unblock(req.member.id, target(req)); }));
  r.post('/profile', wrap((req) => {
    const body = req.body || {};
    const nick = body.nick === undefined ? undefined : checkNick(body.nick, { words, ownerName });
    return friends.setProfile(req.member.id, { nick, accept: body.accept === undefined ? undefined : body.accept === true });
  }));
  // 只能推荐自己「最近听过」里的歌：歌的信息从自己的记录里取，不信网页传来的
  r.post('/recommend', wrap((req) => {
    const id = String(req.body?.songId ?? '');
    const song = (members.memory(req.member.id).history || []).find((s) => String(s.id) === id);
    if (!song) throw new FriendError('bad-song', '先放一下这首，再推荐');
    return { rec: recommend(req.member.id, String(req.body?.to || ''), song, req.body?.note || '') };
  }));
  r.post('/like', wrap((req) => ({ rec: friends.like(req.member.id, String(req.body?.rec || '')) })));
  // 问了没听：网页在等待窗口关掉后调，把这条从「待播」挪到「暂存」。
  // 不是彻底不要——用户之后问「刚才谁推荐了什么」还找得回来（dropped 列表）。
  r.post('/drop', wrap((req) => ({ rec: friends.drop(req.member.id, String(req.body?.rec || '')) })));
  r.post('/recover', wrap((req) => ({ rec: friends.recover(req.member.id, String(req.body?.rec || '')) })));
  r.get('/dropped', wrap((req) => ({ dropped: friends.droppedList(req.member.id) })));
  app.use('/api/friends', r);
}

// ---- 老板个人版的内部口：只听本机，不挂在对外的 8091 上 ----
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function createOwnerApp({ friends, recommend, words }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => (LOOPBACK.has(req.socket.remoteAddress) ? next() : res.status(403).json({ error: 'forbidden' })));
  app.use(express.json({ limit: '16kb' }));
  const wrap = (fn) => (req, res) => {
    try { res.json(fn(req) ?? { ok: true }); } catch (error) { sendFriendError(res, error); }
  };
  const target = (req) => String(req.body?.id || '');
  const rec = (req) => String(req.body?.rec || '');
  app.get('/owner/overview', wrap(() => friends.overview(OWNER_ID)));
  // 老板看整体数字（不看内容）：好友对数、今天推荐几首、总数、今天已播
  app.get('/owner/stats', wrap(() => friends.stats()));
  app.post('/owner/code', wrap(() => friends.createCode(OWNER_ID)));
  app.post('/owner/add', wrap((req) => ({ friend: friends.redeem(OWNER_ID, String(req.body?.code || '').replace(/\s+/g, '')) })));
  app.post('/owner/remove', wrap((req) => { friends.remove(OWNER_ID, target(req)); }));
  app.post('/owner/block', wrap((req) => { friends.block(OWNER_ID, target(req)); }));
  app.post('/owner/unblock', wrap((req) => { friends.unblock(OWNER_ID, target(req)); }));
  app.post('/owner/profile', wrap((req) => {
    const body = req.body || {};
    const nick = body.nick === undefined ? undefined : checkNick(body.nick, { words });
    return friends.setProfile(OWNER_ID, { nick, accept: body.accept === undefined ? undefined : body.accept === true });
  }));
  // 老板的歌信息由个人版给（它自己的正在放）；附言照样过本地规则，不叫大脑
  app.post('/owner/recommend', wrap((req) => ({ rec: recommend(OWNER_ID, String(req.body?.to || ''), req.body?.song, req.body?.note || '', { trusted: true }) })));
  app.post('/owner/next', wrap(() => ({ rec: friends.next(OWNER_ID) })));
  app.post('/owner/played', wrap((req) => ({ rec: friends.played(OWNER_ID, rec(req)) })));
  app.post('/owner/like', wrap((req) => ({ rec: friends.like(OWNER_ID, rec(req)) })));
  app.post('/owner/like-song', wrap((req) => ({ rec: friends.likeSong(OWNER_ID, String(req.body?.songId ?? '')) })));
  app.post('/owner/unplayable', wrap((req) => { friends.unplayable(OWNER_ID, rec(req)); }));
  app.post('/owner/drop', wrap((req) => ({ rec: friends.drop(OWNER_ID, rec(req)) })));
  app.post('/owner/recover', wrap((req) => ({ rec: friends.recover(OWNER_ID, rec(req)) })));
  app.get('/owner/dropped', wrap(() => ({ dropped: friends.droppedList(OWNER_ID) })));
  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  return app;
}

export function startOwnerServer(address, deps, log = () => {}) {
  const [host, port] = String(address).includes(':') ? String(address).split(':') : ['127.0.0.1', address];
  if (!LOOPBACK.has(host) && host !== 'localhost') throw new Error('好友内部口只能听本机');
  const server = http.createServer(createOwnerApp(deps));
  server.on('error', (error) => log('friends-internal-error', '', error.code || error.name));
  server.listen(Number(port), host, () => log('friends-internal', `${host}:${port}`));
  return server;
}
