import { activeTasteEvents } from './profile.js';

const NOTE = '这些是听过、亲口说过好听或点过爱心之后整理出来的锚点。推荐时要留出新风格、当下流行和老歌，不要只绕着这些原曲打转。';

function names(items, format, limit) {
  return items.slice(0, limit).map(format).filter(Boolean);
}

export function renderTasteDigest({ profile = {}, events = [] } = {}) {
  const artists = (profile.artists || []).filter((item) => item.score > 0);
  const avoided = (profile.artists || []).filter((item) => item.score < 0);
  const songs = (profile.songs || []).filter((item) => item.score > 0);
  const likes = [];
  const seen = new Set();
  const active = activeTasteEvents(events);
  for (let index = active.length - 1; index >= 0 && likes.length < 6; index -= 1) {
    const event = active[index];
    if (!['favorite', 'explicit_like'].includes(event?.type) || !event.song?.title) continue;
    const key = `${event.song.title}|${event.song.artist || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    likes.push(event.song);
  }
  const lines = ['# 持续整理的品味', '', NOTE, ''];
  const artistLine = names(artists, (item) => item.artist, 5);
  const songLine = names(songs, (item) => `《${item.title}》${item.artist || ''}`, 6);
  const likeLine = names(likes, (item) => `《${item.title}》— ${item.artist || '未知'}`, 6);
  const avoidLine = names(avoided, (item) => item.artist, 4);
  const stable = (profile.memories?.stable || []).slice(-3).map((item) => item.value).filter(Boolean);
  if (artistLine.length) lines.push(`常被正向记住的歌手：${artistLine.join('、')}`);
  if (songLine.length) lines.push(`明确喜欢过的歌：${songLine.join('、')}`);
  if (likeLine.length) lines.push(`最近亲口说好听或点过爱心：${likeLine.join('、')}`);
  if (avoidLine.length) lines.push(`先少放的歌手：${avoidLine.join('、')}`);
  if (stable.length) lines.push(`已经确认的偏好：${stable.join('；')}`);
  if (!artistLine.length && !songLine.length && !likeLine.length) {
    lines.push('还没有亲口记下的喜欢。听到好听的，说「好听」或点爱心就会记在这里。');
  }
  return `${lines.join('\n').trim()}\n`;
}
