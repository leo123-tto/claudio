import fs from 'node:fs';
import path from 'node:path';
import { parseFavoriteSongs } from './recommendation.js';

const HEADER = `# 我喜欢的歌曲

> 这里的歌曲只用来分析你的口味和寻找相邻的小众音乐；发现模式不会机械重播这些原曲。
`;

function clean(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function songKey(song) {
  return `${clean(song?.title).toLocaleLowerCase()}|${clean(song?.artist).toLocaleLowerCase()}`;
}

export function parsePlaylistId(input) {
  const value = clean(input);
  if (/^\d{1,30}$/.test(value)) return value;
  let url;
  try { url = new URL(value); } catch { throw new TypeError('请填写网易云歌单链接或歌单 ID'); }
  if (url.protocol !== 'https:' || url.hostname !== 'music.163.com') {
    throw new TypeError('只支持 music.163.com 的网易云歌单链接');
  }
  const direct = url.searchParams.get('id');
  const hashQuery = url.hash.includes('?') ? new URLSearchParams(url.hash.slice(url.hash.indexOf('?') + 1)).get('id') : '';
  const id = direct || hashQuery;
  if (!/^\d{1,30}$/.test(id || '')) throw new TypeError('链接中没有有效的网易云歌单 ID');
  return id;
}

export function mergeFavoriteSongs(existing = [], incoming = []) {
  const songs = existing
    .map((song) => ({ title: clean(song.title), artist: clean(song.artist) }))
    .filter((song) => song.title && song.artist);
  const keys = new Set(songs.map(songKey));
  let added = 0;
  let duplicates = 0;
  for (const item of incoming) {
    const song = { title: clean(item?.title), artist: clean(item?.artist) };
    const key = songKey(song);
    if (!song.title || !song.artist || key === '|') continue;
    if (keys.has(key)) { duplicates += 1; continue; }
    keys.add(key);
    songs.push(song);
    added += 1;
  }
  return { songs, added, duplicates };
}

export function renderFavoritesMarkdown(songs = []) {
  const cleanSongs = mergeFavoriteSongs([], songs).songs;
  const list = cleanSongs.map((song) => `- ${song.title} — ${song.artist}`).join('\n');
  return `${HEADER}\n> 共 ${cleanSongs.length} 首。可在 Claudio 设置中继续导入网易云歌单，重复歌曲会自动跳过。\n\n${list}${list ? '\n' : ''}`;
}

export function createFavoritesStore({ file, fetchPlaylistTracks }) {
  if (typeof fetchPlaylistTracks !== 'function') throw new TypeError('缺少歌单读取器');
  function read() {
    try { return parseFavoriteSongs(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  return {
    summary() { return { total: read().length }; },
    async importPlaylist(input) {
      const playlistId = parsePlaylistId(input);
      const tracks = await fetchPlaylistTracks(playlistId);
      if (!Array.isArray(tracks) || !tracks.length) {
        throw new Error('没有读取到歌曲；请确认歌单存在、可公开访问，或已配置网易云登录 Cookie');
      }
      const received = tracks.length;
      const merged = mergeFavoriteSongs(read(), tracks);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, renderFavoritesMarkdown(merged.songs));
      fs.renameSync(temp, file);
      return {
        playlistId,
        received,
        added: merged.added,
        duplicates: merged.duplicates,
        total: merged.songs.length,
      };
    },
  };
}
