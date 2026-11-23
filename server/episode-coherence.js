// 只在点名未播放的歌或顺序不符时重写，避免换歌后仍念旧歌名。
const clean = (text) => String(text || '').toLocaleLowerCase().replace(/\s+/g, '');
const referring = /它|这首|那首|这支|那支|这段旋律|这把嗓子/;

// 念出来的名字：多位歌手只念第一位，歌名去掉末尾的版本括号（Live、English Version 之类），免得念成「斜杠」「括号」。
export function spokenArtist(artist) {
  return String(artist || '').split(/\s*\/\s*/)[0].trim();
}
export function spokenTitle(title) {
  const raw = String(title || '').trim();
  return raw.replace(/\s*[（(][^（）()]*[）)]\s*$/, '').trim() || raw;
}

function mentionAt(text, song) {
  const title = clean(song.title);
  const artist = clean(song.artist);
  const titleAt = title ? text.indexOf(title.length >= 4 ? title : `《${title}》`) : -1;
  const artistAt = artist.length >= 2 ? text.indexOf(artist) : -1;
  if (titleAt < 0) return artistAt;
  if (artistAt < 0) return titleAt;
  return Math.min(titleAt, artistAt);
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const keyOf = (song) => `${clean(song.title)}|${clean(song.artist)}`;

// 把一句里对旧歌的点名换成新歌：歌手的《歌名》、《歌名》、四字以上裸歌名、歌手名。同时替换，互换顺序也不会串。
function swapNames(sentence, pairs) {
  const marks = [];
  let out = sentence;
  const put = (pattern, text) => {
    out = out.replace(pattern, () => { marks.push(text); return `\u0000${marks.length - 1}\u0000`; });
  };
  for (const { from, to } of pairs) {
    const title = String(from.title || '').trim();
    const artist = String(from.artist || '').trim();
    const name = spokenTitle(to.title);
    const who = spokenArtist(to.artist);
    if (title && artist) put(new RegExp(`${escapeRe(artist)}\\s*的\\s*《\\s*${escapeRe(title)}\\s*》`, 'gi'), `${who ? `${who}的` : ''}《${name}》`);
    if (title) put(new RegExp(`《\\s*${escapeRe(title)}\\s*》`, 'gi'), `《${name}》`);
    if (title && clean(title).length >= 4) put(new RegExp(escapeRe(title), 'gi'), `《${name}》`);
    if (artist && clean(artist).length >= 2 && who) put(new RegExp(escapeRe(artist), 'gi'), who);
  }
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => marks[Number(i)]);
}

export function correctSay(say, plannedSongs = [], songs = []) {
  const text = String(say || '').trim();
  const normalized = clean(text);
  const all = [...plannedSongs, ...songs];
  const mentions = [];
  const seen = new Set();
  for (const song of all) {
    const key = keyOf(song);
    if (seen.has(key)) continue;
    seen.add(key);
    const at = mentionAt(normalized, song);
    if (at >= 0) mentions.push({ key, at, song });
  }
  mentions.sort((a, b) => a.at - b.at);
  const expected = songs.map(keyOf);
  let next = 0;
  if (mentions.every((item) => {
    const index = expected.indexOf(item.key, next);
    if (index < 0) return false;
    next = index + 1;
    return true;
  })) return text;
  // 对不上时尽量保留大脑原话：按点名先后把第 k 首换成实际第 k 首，只换名字；多出来、没歌可换的那几句才删。
  const mapping = new Map(mentions.map((item, i) => [item.key, songs[i] || null]));
  const sentences = text.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [];
  const kept = [];
  let lastMapped = false;
  let announced = false;
  for (const sentence of sentences) {
    const named = mentions.filter((item) => mentionAt(clean(sentence), item.song) >= 0);
    if (!named.length) {
      if (referring.test(sentence) && !lastMapped) continue; // 指代的是被删掉的歌，或开头就指代旧歌
      kept.push(sentence.trim());
      continue;
    }
    if (named.some((item) => !mapping.get(item.key))) { lastMapped = false; continue; }
    kept.push(swapNames(sentence, named.map((item) => ({ from: item.song, to: mapping.get(item.key) }))).trim());
    lastMapped = true;
    announced = true;
  }
  if (!announced && songs.length) {
    const lead = kept.filter((sentence) => !referring.test(sentence));
    const announcement = songs.map((song, i) => `${i ? '再听' : '先听'}${spokenArtist(song.artist) ? `${spokenArtist(song.artist)}的` : ''}《${spokenTitle(song.title)}》`).join('，');
    return `${lead.join('')}${announcement}。`;
  }
  return kept.join('');
}
