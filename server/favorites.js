import fs from 'node:fs';
import path from 'node:path';
import { parseFavoriteSongs } from './recommendation.js';

const HEADER = `# 我喜欢的歌曲

> 这里的歌曲用来记住你的口味。自动推荐不会机械重播这些原曲，也会搭配新风格、当下流行和老歌。
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
  const sourcesFile = `${file}.sources.json`;
  const knownSources = new Set(['import', 'button', 'chat', 'unknown']);
  function read() {
    try {
      const songs = parseFavoriteSongs(fs.readFileSync(file, 'utf8'));
      let sources = {};
      try { sources = JSON.parse(fs.readFileSync(sourcesFile, 'utf8')); } catch { /* 旧曲库来源未知 */ }
      return songs.map((song) => {
        const saved = sources?.[songKey(song)];
        const list = Array.isArray(saved) ? saved.filter((source) => knownSources.has(source)) : [];
        return { ...song, sources: list.length ? [...new Set(list)] : ['unknown'] };
      });
    }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  function write(songs) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const sourceTemp = `${sourcesFile}.tmp`;
    fs.writeFileSync(sourceTemp, JSON.stringify(Object.fromEntries(songs.map((song) => [songKey(song), song.sources]))));
    fs.renameSync(sourceTemp, sourcesFile);
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, renderFavoritesMarkdown(songs));
    fs.renameSync(temp, file);
  }
  function remember(incoming, source) {
    if (!knownSources.has(source) || source === 'unknown') throw new TypeError('收藏来源无效');
    const songs = read();
    const merged = mergeFavoriteSongs(songs, incoming);
    const byKey = new Map(songs.map((song) => [songKey(song), song]));
    const incomingKeys = new Set(incoming.map(songKey));
    const withSources = merged.songs.map((song) => {
      const sources = [...(byKey.get(songKey(song))?.sources || [])];
      if (incomingKeys.has(songKey(song)) && !sources.includes(source)) sources.push(source);
      return { ...song, sources };
    });
    write(withSources);
    return { added: merged.added, duplicates: merged.duplicates, total: withSources.length };
  }
  return {
    read,
    list: read,
    summary() { return { total: read().length }; },
    isFavorite(song) {
      return Boolean(read().find((entry) => songKey(entry) === songKey(song))?.sources.includes('button'));
    },
    rememberSong({ title, artist } = {}, { source = 'button' } = {}) {
      return remember([{ title, artist }], source);
    },
    forgetSong(song) {
      const songs = read();
      const index = songs.findIndex((entry) => songKey(entry) === songKey(song));
      if (index < 0 || !songs[index].sources.includes('button')) return { removed: 0, deleted: 0, total: songs.length };
      songs[index].sources = songs[index].sources.filter((source) => source !== 'button');
      const deleted = songs[index].sources.length ? 0 : 1;
      if (deleted) songs.splice(index, 1);
      write(songs);
      return { removed: 1, deleted, total: songs.length };
    },
    async importPlaylist(input) {
      const playlistId = parsePlaylistId(input);
      const tracks = await fetchPlaylistTracks(playlistId);
      if (!Array.isArray(tracks) || !tracks.length) {
        throw new Error('没有读取到歌曲；请确认歌单存在、可公开访问，或已配置网易云登录 Cookie');
      }
      const received = tracks.length;
      const merged = remember(tracks, 'import');
      return {
        playlistId,
        received,
        added: merged.added,
        duplicates: merged.duplicates,
        total: merged.total,
      };
    },
  };
}

