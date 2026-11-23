// 公用版的短口播：一句、不超过 25 字，排在老板之后。
//
// 合成交给老板实例 8099 名额服务的 POST /tts（server/ncm-shared.js）：老板那边语音用 5090、通道就绪、自己没在
// 合成 / 排队时才念，否则回 409，这一句就不念了——不重试、不排队，歌照放。公用版自己同一时间也只要 1 句。
// 念好的 mp3 按 id 记 10 分钟，网页来取（/api/voice/:id）；只有同一个人能取。
import crypto from 'node:crypto';

export const VOICE_MAX = 25;
const TTL = 10 * 60_000;

const len = (text) => [...String(text || '')].length;

// 太长就取第一句；第一句也超就不念
export function voiceText(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (len(clean) <= VOICE_MAX) return clean;
  const first = clean.match(/^[^。！？!?]+[。！？!?]/)?.[0] || '';
  return first && len(first) <= VOICE_MAX ? first : '';
}

// 自动接着放时的报幕（不叫大脑）
export function introLine(song, rand = Math.random) {
  const t = String(song?.title || '').replace(/\s*[(（].*?[)）]\s*/g, '').trim();
  const a = String(song?.artist || '').split(' / ')[0];
  if (!t) return '';
  const lines = [`下一首，${a}的《${t}》。`, `接下来是${a}，《${t}》。`, `来听${a}的《${t}》。`];
  const pick = lines[Math.floor(rand() * lines.length)];
  return voiceText(pick) || voiceText(`接下来，《${t}》。`);
}

export function createVoice({ ttsUrl = '', fetchFn = fetch, timeout = 12_000, now = () => Date.now(), log = () => {} } = {}) {
  const lines = new Map(); // id -> { memberId, promise, until }
  let busy = false;

  function sweep() {
    const t = now();
    for (const [id, v] of lines) if (v.until <= t) lines.delete(id);
  }

  async function synth(text) {
    try {
      const res = await fetchFn(new URL('/tts', ttsUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status !== 200) return null;
      const audio = Buffer.from(await res.arrayBuffer());
      return audio.length ? audio : null;
    } catch {
      return null;
    } finally {
      busy = false;
    }
  }

  // 返回口播 id；不念（没配、太长、正在念别人的）返回 ''
  function request(memberId, text) {
    const say = voiceText(text);
    if (!ttsUrl || !say || busy) return '';
    busy = true;
    sweep();
    const id = crypto.randomBytes(9).toString('base64url');
    const promise = synth(say);
    promise.then((audio) => { if (!audio) log('voice-skip', memberId); });
    lines.set(id, { memberId, promise, until: now() + TTL });
    return id;
  }

  async function get(memberId, id) {
    const line = lines.get(String(id));
    if (!line || line.memberId !== memberId || line.until <= now()) return null;
    return line.promise;
  }

  return { request, get, lines };
}
