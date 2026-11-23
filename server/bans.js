// 禁播清单：明确不喜欢的歌以后不再自动选。可以单条撤销。
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export function songIdentity(song) {
  const title = String(song?.title || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  const artist = String(song?.artist || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  return `${title}|${artist}`;
}

function cleanSong(song, at) {
  const title = String(song?.title || '').replace(/\s+/g, ' ').trim();
  const artist = String(song?.artist || '').replace(/\s+/g, ' ').trim();
  if (!title || !artist) return null;
  return { title, artist, at: at || new Date().toISOString() };
}

export function addBan(songs = [], song, at) {
  const next = cleanSong(song, at);
  if (!next) return [...songs];
  const key = songIdentity(next);
  if (songs.some((item) => songIdentity(item) === key)) return [...songs];
  return [...songs, next];
}

export function removeBan(songs = [], song) {
  const key = songIdentity(song);
  if (key === '|') return [...songs];
  return songs.filter((item) => songIdentity(item) !== key);
}

export function createBanStore(file) {
  function read() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const songs = Array.isArray(data?.songs) ? data.songs.filter((song) => cleanSong(song)) : [];
      return { seeded: Boolean(data?.seeded), songs };
    } catch {
      return { seeded: false, songs: [] };
    }
  }
  function write(data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  }
  return {
    file,
    list() {
      return read().songs;
    },
    add(song) {
      const data = read();
      const songs = addBan(data.songs, song);
      write({ seeded: true, songs });
      return songs;
    },
    remove(song) {
      const data = read();
      const songs = removeBan(data.songs, song);
      write({ seeded: true, songs });
      return songs;
    },
    ensureSeeded(songs = []) {
      const data = read();
      if (data.seeded) return data.songs;
      const seeded = songs.reduce((list, song) => addBan(list, song), []);
      write({ seeded: true, songs: seeded });
      return seeded;
    },
  };
}

export const banStore = createBanStore(path.join(config.paths.cache, 'bans.json'));
