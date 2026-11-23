// 公用版自动接着放（已绑定网易云的人）：红心 4 : 推荐 4 : 新歌 2，按 10 首一副牌洗。
//
// - 红心：TA 网易云「我喜欢的音乐」抽样（绑定时取的，带 id）。
// - 推荐：TA 的每日推荐（按人缓存到第二天 6 点），用完了拿私人 FM（一次 3 首），都没有就拿 TA 红心歌的相似歌。不搜歌。
// - 新歌：大脑按此刻场景挑几首 TA 红心之外的歌，后台一首首搜成能放的（占搜索名额，拿不到就下次再说），
//   攒在 TA 的临时记忆里；轮到新歌时池子是空的就拿推荐 / 红心顶上，不让人等。
// 都是已知 id，接着放时只问直链。
export const DECK = ['like', 'rec', 'like', 'rec', 'new', 'like', 'rec', 'like', 'rec', 'new'];
const FALLBACK = { like: ['rec', 'new'], rec: ['like', 'new'], new: ['rec', 'like'] };
const FRESH_RETRY_MS = 15 * 60_000;
const FRESH_LOW = 2;
const FRESH_PROMPT = '（自动续播，不用回话）按此刻的时间和 ta 的口味，挑 4 首 ta 红心里没有、但大概率会喜欢的歌，intent 用 recommend。';

export function shuffle(list, rand = Math.random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// 从这个人的牌里抽 n 张，抽完重洗一副
export function drawKinds(deck, n, rand = Math.random) {
  let left = Array.isArray(deck) ? [...deck] : [];
  const kinds = [];
  while (kinds.length < n) {
    if (!left.length) left = shuffle(DECK, rand);
    kinds.push(left.shift());
  }
  return { kinds, deck: left };
}

// 下一个北京时间 6 点（每日推荐换新的时候）
export function nextRefresh(t) {
  const bj = new Date(t + 8 * 3600_000);
  const six = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate(), 6) - 8 * 3600_000;
  return six > t ? six : six + 24 * 3600_000;
}

export const songKey = (s) => `${s?.title || ''}|${s?.artist || ''}`.toLowerCase();

export function createMixer({ ncm, brain, members, qualityFor, log = () => {}, now = () => Date.now(), rand = Math.random }) {
  const refilling = new Set();

  async function recPool(memory, cookie, memberId) {
    if (!memory.rec || memory.rec.until <= now()) {
      const songs = await ncm.dailyRecommend(cookie, { memberId }).catch(() => []);
      memory.rec = { songs: songs.slice(0, 40), until: songs.length ? nextRefresh(now()) : now() + 30 * 60_000 };
    }
    return memory.rec.songs;
  }

  // 新歌在后台攒：叫一次大脑拿 4 首，再逐首搜成能放的。名额不够就停，等下次。
  async function refillFresh(memberId, cookie) {
    if (refilling.has(memberId)) return;
    refilling.add(memberId);
    try {
      const memory = members.memory(memberId);
      const level = qualityFor(memory, cookie);
      const reply = await brain.ask({ text: FRESH_PROMPT, auto: false, memory, bound: true, hour: new Date(now() + 8 * 3600_000).getUTCHours() });
      const liked = new Set((memory.taste?.likes || []).map(songKey));
      const found = [];
      for (const cand of reply.play || []) {
        let song;
        try {
          song = await ncm.resolve(cand, { cookie, memberId, level, allowTrial: false });
        } catch { break; }
        if (song.playable && !liked.has(songKey(song))) {
          found.push({ id: song.id, title: song.title, artist: song.artist, duration: song.duration || 0, cover: song.cover || '' });
        }
      }
      const latest = members.memory(memberId);
      const pool = [...(latest.fresh?.songs || []), ...found].slice(-12);
      members.saveMemory(memberId, { ...latest, fresh: { songs: pool, at: now() } });
      log('fresh-refill', memberId, String(found.length));
    } catch (error) {
      log('fresh-failed', memberId, error.code || error.name);
    } finally {
      refilling.delete(memberId);
    }
  }

  // 返回能放的歌（最多 count 首）；memory 会被改（牌、推荐缓存、新歌池），调用方负责存
  async function pick(m, memory, cookie, { count = 2, level, playById }) {
    const recent = new Set((memory.recent || []).slice(-60).map(songKey));
    const used = new Set();
    const ok = (s) => s?.id && !recent.has(songKey(s)) && !used.has(songKey(s));
    const pools = {
      like: () => (memory.taste?.likes || []).filter(ok),
      rec: async () => {
        let list = (await recPool(memory, cookie, m.id)).filter(ok);
        if (!list.length) {
          const fm = await ncm.personalFm(cookie, { memberId: m.id }).catch(() => []);
          list = fm.filter(ok);
        }
        // 2026-11-23 实测：只存了 MUSIC_U / __csrf 的扫码登录态，每日推荐和私人 FM 都回空（code 200）。
        // 那就拿 TA 红心里随机两首的相似歌顶上（按 id，不搜），按人记 6 小时
        if (!list.length) {
          if (!memory.simi || memory.simi.until <= now() || !memory.simi.songs.some(ok)) {
            const seeds = shuffle(memory.taste?.likes || [], rand).slice(0, 2);
            const found = [];
            for (const seed of seeds) found.push(...await ncm.simiSongs(seed.id, { memberId: m.id }).catch(() => []));
            memory.simi = { songs: found.slice(0, 20), until: now() + 6 * 3600_000 };
          }
          list = memory.simi.songs.filter(ok);
        }
        return list;
      },
      new: () => (memory.fresh?.songs || []).filter(ok),
    };
    const drawn = drawKinds(memory.deck, count, rand);
    memory.deck = drawn.deck;
    const songs = [];
    for (const kind of drawn.kinds) {
      let got = null;
      for (const k of [kind, ...FALLBACK[kind]]) {
        for (const cand of shuffle(await pools[k](), rand).slice(0, 3)) {
          used.add(songKey(cand));
          let song;
          try {
            song = await playById(cand, { cookie, memberId: m.id, level });
          } catch (error) {
            // 限速 / 限流：已经有的先放，一首都没有才往上报
            if (songs.length) return finish(songs);
            throw error;
          }
          if (song.playable) { got = { ...song, cover: song.cover || cand.cover || '', from: k }; break; }
        }
        if (got) break;
      }
      if (got) {
        songs.push(got);
        if (got.from === 'new') memory.fresh = { ...memory.fresh, songs: (memory.fresh?.songs || []).filter((s) => s.id !== got.id) };
      }
    }
    return finish(songs);

    function finish(out) {
      const fresh = memory.fresh?.songs || [];
      if (fresh.length < FRESH_LOW && (!memory.freshTried || now() - memory.freshTried > FRESH_RETRY_MS)) {
        memory.freshTried = now();
        // 调用方先把这次的记忆存下（同步），再在后台攒新歌
        setTimeout(() => refillFresh(m.id, cookie), 0);
      }
      return out;
    }
  }

  return { pick, refillFresh, refilling };
}
