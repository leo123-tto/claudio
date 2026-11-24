// 公用版的短口播：念出来的纯文字不超过 100 字（不算演出标记和语气提示），整句取，排在老板之后。
//
// 合成交给老板实例 8099 名额服务的 POST /tts（server/ncm-shared.js）：老板那边语音用 5090、通道就绪、自己没在
// 合成 / 排队时才念，否则回 409，这一句就不念了——不重试、不排队，歌照放。公用版自己同一时间也只要 1 句。
// 念好的 mp3 按 id 记 10 分钟，网页来取（/api/voice/:id）；只有同一个人能取。
// 发给 TTS 的是 ttsText()：时段语气的导演提示 + 清洗过的演出标记；页面和记录用的是去掉标记的干净文字。
//
// 两种口播：
//   request       点歌回话、每批第一首的模板报幕：马上合成，用户要的口播压过后台报幕。
//   requestIntro  后台报幕：id 先给出去，稿子由大脑在空闲时现写（不扣朋友的次数），写不出来就用模板句，
//                 念之前等前一句念完；用户那边的口播一来就让路。写好的字随语音一起交给网页（见 get）。
import crypto from 'node:crypto';
import { sanitizeTags, stripTags, plainText } from '../tts/tags.js';
import { ttsText } from '../tone.js';

export const VOICE_MAX = 100;
const TTL = 10 * 60_000;
const MAX_INTRO_PENDING = 6; // 同时在写的后台报幕超过这个数，多出来的直接用模板句

const len = (text) => [...String(text || '')].length;
const plainLen = (text) => len(plainText(text));

// 按句切，句末标点留在句尾；最后一截没标点也算一句
export function sentences(text) {
  return String(text || '').match(/[^。！？!?]*[。！？!?]+|[^。！？!?]+$/g) || [];
}

// 整句取：放得下就整段；放不下就留前面放得下的整句；第一句都放不下返回 ''（只出字、不念）。
export function wholeSentences(text, max, measure = len) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean || measure(clean) <= max) return clean;
  let out = '';
  for (const sentence of sentences(clean)) {
    if (measure(out + sentence) > max) break;
    out += sentence;
  }
  return out.trim();
}

// 给 5090 念的整串：纯文字 ≤ VOICE_MAX（整句取，切完标记再清洗一遍保证成对）；不给 tone 就只返回清洗后的稿子
export function voiceText(text, tone = null) {
  const opts = tone ? { maxTags: tone.maxTags, maxPairs: tone.maxPairs, points: tone.points, pairs: tone.pairs } : {};
  const body = sanitizeTags(String(text || '').replace(/\s+/g, ' ').trim(), opts);
  if (!body) return '';
  const cut = sanitizeTags(wholeSentences(body, VOICE_MAX, plainLen), opts);
  return tone ? ttsText(cut, tone) : cut;
}

// 自动接着放时的报幕（不叫大脑；大脑写的报幕不可用时的退路）
export function introLine(song, rand = Math.random) {
  const t = String(song?.title || '').replace(/\s*[(（].*?[)）]\s*/g, '').trim();
  const a = String(song?.artist || '').split(' / ')[0];
  if (!t) return '';
  const lines = [`下一首，${a}的《${t}》。`, `接下来是${a}，《${t}》。`, `来听${a}的《${t}》。`];
  const pick = lines[Math.floor(rand() * lines.length)];
  return voiceText(pick) || voiceText(`接下来，《${t}》。`);
}

// 好友推荐的报幕（两版共用）：第一句永远是「XX给你推荐了《Y》」（驾驶模式只念一句也带着是谁推荐的），
// 附言是别人写的字，原样接在后面念、不进大脑；整段放不进语音上限就不念附言（页面照样显示）。
// from、note 已经过 friends.js 的 cleanName / cleanNote（没有演出标记、没有括号）。
export function recNoteLine(from, note) {
  const n = String(note || '').trim();
  return n ? `${from}留了句话：${n}${/[。！？!?…~～]$/.test(n) ? '' : '。'}` : '';
}
export function recIntro({ from, song, note = '' }, rand = Math.random) {
  const t = String(song?.title || '').replace(/\s*[(（].*?[)）]\s*/g, '').trim() || String(song?.title || '').trim();
  const a = String(song?.artist || '').split(' / ')[0];
  // 念出来的不用「ta」（语音会念成字母）
  const lead = [`${from}给你推荐了《${t}》，我这就放上。`, `${from}给你推荐了《${t}》，我不剧透，你自己听。`, `${from}给你推荐了《${t}》，这首算${from}点的。`];
  const head = lead[Math.floor(rand() * lead.length)];
  const say = `${from}给你推荐了${a ? `${a}的` : ''}《${t}》${note ? `：「${note}」` : '。'}`;
  return { say, speak: withNote(head, from, note) || voiceText(`${from}给你推荐了《${t}》。`) };
}

// 推荐的「先问一句」版：报完幕（和附言）停下来问，网页开麦听回答（web/rec-ask.js）。
// 顺序要紧：附言在先、问句收尾，否则听起来像「听不听？还有句话说……」。
// short：驾驶模式只念一句，也得把问句带上（oneSentence 会切掉问句）。
// 网页没念出来（没语音）就不问，显示时把问句去掉（rec-ask.js 的 withoutAsk）。
export const REC_ASK_TAIL = '要听吗？';
export function recAsk({ from, song, note = '' }, { short = false } = {}) {
  const t = String(song?.title || '').replace(/\s*[(（].*?[)）]\s*/g, '').trim() || String(song?.title || '').trim();
  const a = String(song?.artist || '').split(' / ')[0];
  // 显示的那行带歌手，念出来的那句不带（和 recIntro 一致，口播短一点也更好听）
  const headSay = `${from}给你推荐了${a ? `${a}的` : ''}《${t}》`;
  const headSpeak = `${from}给你推荐了《${t}》`;
  const say = `${headSay}${note && !short ? `：「${note}」` : '。'}${REC_ASK_TAIL}`;
  const brief = voiceText(`${headSpeak}，${REC_ASK_TAIL}`);
  if (short) return { say, speak: brief };
  // 附言接在报幕后面，问句放在最后；接完超长度就退回不带附言的短句
  const body = withNote(`${headSpeak}。`, from, note) || voiceText(`${headSpeak}。`);
  const speak = plainLen(`${body}${REC_ASK_TAIL}`) <= VOICE_MAX ? `${body}${REC_ASK_TAIL}` : brief;
  return { say, speak };
}

// 稿子后面接上附言：放得下就接，放不下只念稿子
export function withNote(text, from, note) {
  const line = recNoteLine(from, note);
  const full = line ? `${String(text || '').trim()}${line}` : String(text || '').trim();
  if (line && plainLen(full) <= VOICE_MAX) return full;
  return plainLen(text) <= VOICE_MAX ? String(text || '').trim() : '';
}

export function createVoice({
  ttsUrl = '',
  fetchFn = fetch,
  timeout = 25_000,
  slotWaitMs = 20_000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
} = {}) {
  const lines = new Map(); // id -> { memberId, promise, until, say }
  let inflight = null; // 正在合成的一句：{ bg, abort }
  let introPending = 0;

  function sweep() {
    const t = now();
    for (const [id, v] of lines) if (v.until <= t) lines.delete(id);
  }

  async function synth(text, bg) {
    const ctrl = new AbortController();
    const job = { bg, abort: () => ctrl.abort() };
    inflight = job;
    try {
      const res = await fetchFn(new URL('/tts', ttsUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.any([AbortSignal.timeout(timeout), ctrl.signal]),
      });
      if (res.status !== 200) return null;
      const audio = Buffer.from(await res.arrayBuffer());
      return audio.length ? audio : null;
    } catch {
      return null;
    } finally {
      if (inflight === job) inflight = null;
    }
  }

  const newId = () => crypto.randomBytes(9).toString('base64url');

  // 返回口播 id；不念（没配、太长、正在念别人的）返回 ''。后台报幕正在合成就把它让掉。
  function request(memberId, text, { tone = null } = {}) {
    const say = voiceText(text, tone);
    if (!ttsUrl || !say) return '';
    if (inflight && !inflight.bg) return '';
    inflight?.abort();
    sweep();
    const id = newId();
    const promise = synth(say, false);
    promise.then((audio) => { if (!audio) log('voice-skip', memberId); });
    lines.set(id, { memberId, promise, until: now() + TTL, say: '' });
    return id;
  }

  // 后台报幕：produce() 返回大脑写的带标记的稿子（空 = 写不出来），fallback 是模板句。没配语音返回 ''。
  function requestIntro(memberId, { produce, fallback = '', tone = null } = {}) {
    if (!ttsUrl) return '';
    sweep();
    const id = newId();
    const entry = { memberId, until: now() + TTL, say: '', promise: null };
    introPending += 1;
    entry.promise = (async () => {
      try {
        let tagged = '';
        if (produce && introPending <= MAX_INTRO_PENDING) {
          try { tagged = (await produce()) || ''; } catch { tagged = ''; }
        }
        let say = voiceText(tagged, tone);
        if (!say) { tagged = fallback; say = voiceText(fallback, tone); }
        entry.say = stripTags(tagged);
        if (!say) return null;
        // 前一句（含用户那边的）念完再念；等不到就只出字
        for (let waited = 0; inflight && waited < slotWaitMs; waited += 500) await sleep(500);
        if (inflight) return null;
        return await synth(say, true);
      } finally {
        introPending -= 1;
      }
    })();
    entry.promise.then((audio) => { if (!audio) log('voice-skip', memberId); });
    lines.set(id, entry);
    return id;
  }

  // 等这句念好：{ audio, say }，audio 为 null 表示不念；say 只有后台报幕才有（网页拿它显示）。不是本人的 / 过期返回 null。
  async function get(memberId, id) {
    const line = lines.get(String(id));
    if (!line || line.memberId !== memberId || line.until <= now()) return null;
    const audio = await line.promise;
    return { audio, say: line.say };
  }

  return { request, requestIntro, get, lines };
}
