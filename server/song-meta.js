// 从网易云歌曲详情里取出年份、曲风和封面。没有就留空，不编。
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { songIdentity } from './bans.js';

function cleanTag(value) {
  const text = String(value?.name || value?.tag || value || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 20) return '';
  return text;
}

function collectTags(source, into) {
  const lists = [
    source?.tags,
    source?.genreTags,
    source?.data?.tags,
    source?.data?.wiki?.tags,
    source?.wiki?.tags,
  ];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const tag = cleanTag(item);
      if (tag && !into.includes(tag)) into.push(tag);
    }
  }
}

function pushTag(into, value) {
  const tag = cleanTag(value);
  if (tag && !into.includes(tag)) into.push(tag);
}

// 现在的网易云百科不给 tags 数组，曲风和语种写在百科区块里。
function collectWikiGenres(wiki, into) {
  const blocks = wiki?.data?.blocks || wiki?.blocks || [];
  for (const block of blocks) {
    for (const creative of block?.creatives || []) {
      const heading = creative?.uiElement?.mainTitle?.title;
      if (heading !== '曲风' && heading !== '语种') continue;
      const resources = Array.isArray(creative.resources) ? creative.resources : [];
      if (resources.length) {
        for (const resource of resources) pushTag(into, resource?.uiElement?.mainTitle?.title);
        continue;
      }
      const links = creative?.uiElement?.textLinks;
      if (!Array.isArray(links)) continue;
      for (const link of links) pushTag(into, link?.text);
    }
  }
}

function yearFromPublish(value) {
  const publish = Number(value);
  if (!Number.isFinite(publish) || publish <= 0) return null;
  if (publish >= 1900 && publish <= 2100) return publish;
  const year = new Date(publish).getFullYear();
  return year >= 1900 && year <= 2100 ? year : null;
}

// 封面走 https、要 600 见方，界面拿来做背景和迷你条缩略图。
function coverFrom(song) {
  const raw = String(song?.al?.picUrl || song?.album?.picUrl || '').trim();
  if (!/^https?:\/\//.test(raw)) return '';
  return `${raw.replace(/^http:/, 'https:').split('?')[0]}?param=600y600`;
}

export function parseSongFacts(detail, wiki = null) {
  const song = detail?.songs?.[0] || null;
  const album = song?.album || song?.al;
  const albumLabels = [album?.name, album?.type, album?.subType].filter(Boolean).join(' ');
  const compilation = /精选|合[集辑]|选集|\b(?:greatest\s+hits|best\s+of|collection|compilation)\b/i.test(albumLabels);
  const year = compilation ? null : yearFromPublish(song?.publishTime);
  const tags = [];
  collectTags(song, tags);
  collectTags(song?.album || song?.al, tags);
  collectTags(wiki, tags);
  collectWikiGenres(wiki, tags);
  return { year, genre: tags.slice(0, 3).join(' / '), cover: coverFrom(song) };
}

export function createFactStore(file) {
  function read() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  }
  return {
    remember(song) {
      const key = song?.id ? `id:${song.id}` : songIdentity(song);
      if (!key || key === '|' || key === 'id:') return;
      const year = Number(song.year);
      const genre = String(song.genre || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!year && !genre) return;
      const all = read();
      all[key] = {
        title: song.title || '',
        artist: song.artist || '',
        ...(year >= 1900 && year <= 2100 ? { year } : {}),
        ...(genre ? { genre } : {}),
      };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(all));
    },
    lookup(song) {
      const all = read();
      return all[song?.id ? `id:${song.id}` : ''] || all[songIdentity(song)] || {};
    },
  };
}

export const factStore = createFactStore(path.join(config.paths.cache, 'song-facts.json'));
