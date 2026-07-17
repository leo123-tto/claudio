// 网易云音乐封装：search → song_url → lyric，并把 {title, artist} 解析成可播直链。
// 通过 NCM_BASE 调用外部的 NeteaseCloudMusicApiEnhanced 实例。
//
// ⚠️ 硬约束：很多歌的 /song/url 需要登录 cookie 才返回真实直链；
//    VIP / 无版权歌即便登录也可能为 null。resolve() 拿不到时返回 playable:false。
import { config } from './config.js';

const { base, cookie } = config.ncm;

async function call(pathname, params = {}) {
  const url = new URL(pathname, base);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  // enhanced 支持 query 传 cookie；同时也带 Cookie header 双保险
  if (cookie) url.searchParams.set('cookie', cookie);
  const res = await fetch(url, { headers: cookie ? { Cookie: cookie } : {} });
  if (!res.ok) throw new Error(`ncm ${pathname} -> ${res.status}`);
  return res.json();
}

export async function search(keywords, limit = 5) {
  const data = await call('/search', { keywords, limit });
  const songs = data?.result?.songs ?? [];
  return songs.map((s) => ({
    id: s.id,
    title: s.name,
    artist: (s.artists ?? s.ar ?? []).map((a) => a.name).join(' / '),
    album: s.album?.name ?? s.al?.name ?? '',
  }));
}

export async function songUrl(id, level = config.ncm.level) {
  // 优先 v1 接口（支持音质 level）；返回 url 可能为 null
  const data = await call('/song/url/v1', { id, level });
  const item = data?.data?.[0];
  return item?.url ?? null;
}

export async function lyric(id) {
  const data = await call('/lyric', { id });
  return data?.lrc?.lyric ?? '';
}

export async function similarSongs(id) {
  const data = await call('/simi/song', { id });
  const songs = data?.songs ?? [];
  return songs.map((song) => ({
    id: song.id,
    title: song.name,
    artist: (song.artists ?? song.ar ?? []).map((artist) => artist.name).join(' / '),
    album: song.album?.name ?? song.al?.name ?? '',
  }));
}

export function normalizePlaylistTracks(data) {
  return (data?.songs ?? [])
    .map((song) => ({
      id: song.id,
      title: String(song.name || '').trim(),
      artist: (song.artists ?? song.ar ?? []).map((artist) => String(artist.name || '').trim()).filter(Boolean).join(' / '),
    }))
    .filter((song) => song.title && song.artist);
}

export async function playlistTracks(id) {
  // 官方歌单常超过 1000 首，接口会一次返回完整 songs；limit 明确放宽，避免默认只取一页。
  const data = await call('/playlist/track/all', { id, limit: 10000, offset: 0 });
  return normalizePlaylistTracks(data);
}

// 把大模型给的 {title, artist} 解析成可播条目。
// 在前几个搜索命中里逐个试 song_url，第一个能拿到直链的就用。
export async function resolve({ title, artist }) {
  const query = [title, artist].filter(Boolean).join(' ');
  let hits = [];
  try {
    hits = await search(query, 8);
  } catch (e) {
    return { title, artist, url: null, playable: false, error: e.message };
  }
  // 优先匹配模型指定的歌手（原唱），其次才任意有直链的版本
  const want = (artist || '').toLowerCase().split('/')[0].trim();
  const ranked = want
    ? [...hits].sort(
        (a, b) =>
          (b.artist.toLowerCase().includes(want) ? 1 : 0) -
          (a.artist.toLowerCase().includes(want) ? 1 : 0),
      )
    : hits;
  // 先用配置音质逐个试；全失败再降到 standard 兜底（低音质有时反而有直链）。
  const levels = [...new Set([config.ncm.level, 'standard'])];
  for (const level of levels) {
    for (const hit of ranked) {
      try {
        const url = await songUrl(hit.id, level);
        if (url) return { ...hit, url, playable: true };
      } catch {
        // 试下一个命中
      }
    }
  }
  return { title, artist, url: null, playable: false };
}
