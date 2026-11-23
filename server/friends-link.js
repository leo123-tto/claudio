// 老板个人版进好友圈（事项 26）：好友数据在公用版容器里（server/public/friends.js），个人版经盒子本机的内部口去要，
// 不经 hub、不出本机。FRIENDS_URL（盒子上 http://127.0.0.1:8092）不设就整个关掉。
//
// 能跨人传的只有推荐的歌和附言：这里只把「老板要推荐的这首（歌名 / 歌手 / id / 封面）」送过去，
// 只拿回「朋友推荐给老板的歌 + 附言」。老板的口味、记忆、听歌记录一律不送。
// 朋友推荐的歌在个人版里标 discoveryType=friend：放了 / 听完 / 跳过都不进口味推断（profile.js），只有老板自己红心才算。
import { randomUUID } from 'node:crypto';
import { recIntro } from './public/voice.js';
import { oneSentence } from './drive.js';
import { ttsText } from './tone.js';

const ROUTES = new Set(['code', 'add', 'remove', 'block', 'unblock', 'profile', 'recommend', 'next', 'played', 'like', 'like-song', 'unplayable']);

export class FriendsLinkError extends Error {
  constructor(status, body) {
    super(body?.message || '好友服务暂时连不上');
    this.status = status;
    this.body = body || { error: 'unreachable', message: this.message };
  }
}

export function createFriendsLink(baseUrl, { fetchFn = fetch, timeout = 2500 } = {}) {
  if (!baseUrl) return null;
  async function call(pathname, body) {
    let res;
    try {
      res = await fetchFn(new URL(pathname, baseUrl), {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw new FriendsLinkError(503);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new FriendsLinkError(res.status, data);
    return data;
  }
  return {
    overview: () => call('/owner/overview'),
    // 网页的 /api/friends/<name> 原样转过去（只认上面列的几个）
    post(name, body = {}) {
      if (!ROUTES.has(name)) throw new FriendsLinkError(404, { error: 'not_found', message: '没有这个操作' });
      return call(`/owner/${name}`, body);
    },
  };
}

// 朋友推荐的歌做成一期：只这一首，模板报幕带上是谁推荐的和附言（不叫大脑）。没有、拿不到、放不了都返回 null，照常备节目。
// songUrl(id) 按 id 取直链（备用音源 id 也认）；取不到再 resolve(歌名 / 歌手) 搜一次。网易云忙（抛错）不算放不了，过半小时再给。
export async function buildFriendEpisode({ link, songUrl, resolve, epoch, tone = null, drive = false, cacheHas = () => false, banned = () => false, log = () => {} }) {
  if (!link) return null;
  let rec;
  try { rec = (await link.post('next')).rec; } catch { return null; }
  if (!rec?.song?.id) return null;
  const song = rec.song;
  // 老板说过以后不放的歌，朋友推荐了也不放（推荐人那边看到「对方放不了」）
  if (banned(song)) {
    link.post('unplayable', { rec: rec.id }).catch(() => {});
    return null;
  }
  let audio = null;
  try {
    audio = await songUrl(song.id);
    if (!audio?.url) {
      const found = await resolve({ title: song.title, artist: song.artist });
      if (found?.playable && found.url) audio = found;
    }
  } catch (error) {
    log('friend-rec-busy', error.code || error.name);
    return null;
  }
  if (!audio?.url) {
    link.post('unplayable', { rec: rec.id }).catch(() => {});
    return null;
  }
  const from = rec.from?.name || '朋友';
  const intro = recIntro({ from, song, note: rec.note || '' });
  const speak = drive ? oneSentence(intro.speak) : intro.speak;
  const id = audio.id || song.id;
  return {
    id: randomUUID(), epoch, sayWrittenAt: Date.now(),
    say: drive ? oneSentence(intro.say) : intro.say,
    sayTts: speak && tone ? ttsText(speak, tone) : speak,
    intent: 'recommend', reason: 'friend',
    voice: { status: speak ? 'pending' : 'skipped' },
    friendRec: { id: rec.id, from },
    queue: [{
      type: 'song', url: cacheHas(id) ? `/media/${id}` : audio.url,
      meta: {
        id, title: song.title, artist: song.artist, lyric: '', remoteUrl: audio.url,
        discoveryType: 'friend', friendRec: rec.id, friendFrom: from,
        ...(song.cover || audio.cover ? { cover: song.cover || audio.cover } : {}),
        ...(audio.quality ? { quality: audio.quality } : {}),
      },
    }],
  };
}
