import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { recentPlays, recentMessages } from './state.js';
import { summaryLine } from './weather.js';
import { readMemory } from './memory.js';
import { getSettings } from './settings.js';
import {
  buildRecommendationBrief,
  parseFavoriteSongs,
} from './recommendation.js';
import {
  currentProfile,
  dislikedSongs as readDislikedSongs,
  recentFingerprints,
  recentListenedSongs,
} from './events.js';
import { getDiscoveryPool } from './discovery.js';

function readSafe(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

function readUserDoc(name) {
  return readSafe(path.join(config.paths.user, name))
    .split('\n')
    .filter((line) => !line.trim().startsWith('>'))
    .join('\n')
    .trim();
}

function readPlaylists() {
  try {
    const data = JSON.parse(readSafe(path.join(config.paths.user, 'playlists.json')) || '{}');
    return (Array.isArray(data.playlists) ? data.playlists : [])
      .filter((playlist) => playlist?.name && !playlist.name.includes('示例') && playlist.songs?.length)
      .map((playlist) => `【${playlist.name}${playlist.mood ? ` · ${playlist.mood}` : ''}】\n${playlist.songs
        .map((song) => `  - ${song.title} — ${song.artist || ''}`).join('\n')}`)
      .join('\n');
  } catch { return ''; }
}

function readFavorites() {
  return parseFavoriteSongs(readSafe(path.join(config.paths.user, 'favorites.md')));
}

function sample(items, count) {
  const pool = items.slice();
  const picked = [];
  while (pool.length && picked.length < count) {
    picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return picked;
}

function formatSongs(songs = []) {
  return songs.map((song) => `- ${song.title} — ${song.artist}`).join('\n') || '（暂无）';
}

function daypartHint(hour) {
  if (hour >= 5 && hour < 9) return '清晨：轻柔、有唤醒感，但不要固定成华语老歌。';
  if (hour >= 9 && hour < 12) return '上午工作：低干扰、有流动感，可少歌词或纯音乐。';
  if (hour >= 12 && hour < 14) return '午间：松弛、换口味，适合给一点新鲜感。';
  if (hour >= 14 && hour < 18) return '下午：专注但不沉闷。';
  if (hour >= 18 && hour < 23) return '傍晚到夜里：放松、有故事感，允许跨风格探索。';
  return '深夜：安静、温柔、克制，口播也轻一点。';
}

function explicitSongRequest(input = '') {
  const text = String(input).trim();
  if (!text) return false;
  if (/《[^》]+》|“[^”]+”|「[^」]+」/.test(text)) return true;
  if (/(推荐|新的|新歌|冷门|小众|类似|随便|换一批)/.test(text)) return false;
  return /(播放|放一下|放首|来一首|想听).{1,30}/.test(text);
}

function profileText(profile) {
  const likedArtists = profile.artists.filter((item) => item.score > 0).slice(0, 10)
    .map((item) => `${item.artist}(${item.score})`).join('、');
  const avoidedArtists = profile.artists.filter((item) => item.score < 0).slice(-8)
    .map((item) => `${item.artist}(${item.score})`).join('、');
  const stable = profile.memories.stable.slice(-12).map((item) => `- ${item.key}：${item.value}`).join('\n');
  return [
    likedArtists ? `正向歌手信号：${likedArtists}` : '',
    avoidedArtists ? `负向歌手信号：${avoidedArtists}` : '',
    stable ? `已被至少两条证据确认的偏好：\n${stable}` : '',
  ].filter(Boolean).join('\n') || '（行为画像刚开始积累，先参考口味档案）';
}

export function buildPromptBundle({ userInput = '', mood = '', sleep = null, nowPlaying = null } = {}) {
  const settings = getSettings();
  const favoriteSongs = readFavorites();
  const actualRecent = recentListenedSongs(50);
  const legacyRecent = recentPlays(20).map(({ title, artist }) => ({ title, artist }));
  const recentSongs = actualRecent.length ? actualRecent : legacyRecent;
  const disliked = readDislikedSongs();
  const profile = currentProfile();
  const messages = recentMessages(20);
  const brief = buildRecommendationBrief({
    mode: settings.recommendation.mode,
    messages,
    recentFingerprints: recentFingerprints(),
  });
  const recentArtists = [...new Set(recentSongs.map((song) => song.artist).filter(Boolean))].slice(0, 5);
  const isExplicitSongRequest = explicitSongRequest(userInput);

  const now = new Date();
  const weather = summaryLine();
  const environment = [
    `现在时间：${now.toLocaleString('zh-CN', { hour12: false })}`,
    weather ? `天气：${weather}` : '',
    daypartHint(now.getHours()),
    mood ? `当前心情：${mood}` : '',
  ].filter(Boolean).join('\n');

  const taste = readSafe(path.join(config.paths.user, 'taste.md'));
  const oldMemory = readMemory(24);
  const routines = readUserDoc('routines.md');
  const moodRules = readUserDoc('mood-rules.md');
  const playlists = readPlaylists();
  const favoriteSample = sample(favoriteSongs, 12);
  const pool = sample(getDiscoveryPool(60), 12);

  const outputContract = `JSON 字段顺序必须是 say、intent、action、actionValue、play、reason、memoryCandidates：
{"say":"中文口播","intent":"chat","action":"none","actionValue":0,"play":[],"reason":"意图与选择依据","memoryCandidates":[]}
- say：必须第一个生成；中文口语 1–2 句、60 字内，不使用固定开场套话。
- intent：只能是 chat / recommend / control。先判断听众是在陪伴聊天、想换音乐，还是要求操作播放器。
- action：control 时只能是 pause / resume / next / previous / stop / favorite / dislike / volume_up / volume_down / volume_set；其他意图必须是 none。
- actionValue：仅 volume_set 时填 0–100，其余填 0。
- play：只有 recommend 才能给 3 个候选；chat 和 control 必须给 []，绝不能因为对话里提到“歌”就自动推荐。
- discoveryType 只能是 familiar / adjacent / explore；score 是 0–100 的综合适配分。
- memoryCandidates：只记录听众这次亲自表达的新证据，格式 {"key":"类别","value":"事实","evidence":"原话依据"}；没有就 []。`;

  const automaticRules = `这次是自动推荐。发现模式比例：熟悉锚点 ${brief.mix.familiar}% / 同风格小众发现 ${brief.mix.adjacent}% / 边界探索 ${brief.mix.explore}%。
起手指纹：语言=${brief.openingFingerprint.language}，能量=${brief.openingFingerprint.energy}，方向=${brief.openingFingerprint.familiarity}。
硬要求：
1. 收藏曲只用于理解口味，自动推荐不得直接选收藏原曲；热门歌曲也不是优先答案。
2. 优先选“听感能解释得通、但听众很可能没听过”的小众曲、专辑深曲或相邻风格音乐人。
3. 最近 50 首不重复；最近 5 位歌手尽量不重复。
4. 不为冷门而冷门：bridgeFrom 必须说清它从哪条已知偏好自然桥接。
5. 口播不要强调“冷门”“算法”“比例”，像朋友自然带出即可。`;

  const chatRules = `听众刚说了话。你既是能放歌的私人 DJ，也是可以日常交流的陪伴者。按以下优先级判断：
1. 普通聊天、倾诉、问问题、评价当前歌：intent=chat，action=none，play=[]。认真回应内容，让当前歌继续，绝不强行转成推荐。
2. 明确要求推荐、换一批、想听某种音乐或点具体歌曲：intent=recommend，action=none，给 3 个候选；仍优先新发现，不回到热门榜单或收藏原曲。明确点了某首具体歌时才允许命中收藏原曲。
3. 要操作软件播放器：intent=control，play=[]，action 对应暂停、继续、下一首、上一首、停止、收藏、不喜欢或音量。可用功能只有 pause/resume/next/previous/stop/favorite/dislike/volume_up/volume_down/volume_set，不要编造其他按钮。
不确定时优先 chat，不要擅自换歌。回应要像熟悉的朋友，直接自然，不复述规则。`;

  const prompt = [
    '你是 Claudio，听众的私人电台 DJ。像懂 ta 的老朋友，中文、温柔、简短，不油腻、不套话。',
    '## 本次最高优先级任务\n' + (userInput ? chatRules : automaticRules),
    '## 输出契约（严格只输出 JSON）\n' + outputContract,
    '## 听众口味档案\n' + (taste || '（尚未填写）'),
    '## 结构化行为画像（分数越高越偏爱，负数表示避开）\n' + profileText(profile),
    oldMemory ? '## 人工可编辑的长期记忆（保留旧系统，只作稳定背景）\n' + oldMemory : '',
    favoriteSample.length ? '## 收藏曲口味样本（只作锚点，自动推荐严禁照搬原曲）\n' + formatSongs(favoriteSample) : '',
    pool.length ? '## 网易云相似关系挖出的候选池（优先从中辨别真正贴合的小众作品，也可提出池外更好候选）\n' + formatSongs(pool) : '',
    playlists ? '## 听众手工歌单（理解场景，不要把它当默认点歌单）\n' + playlists : '',
    routines ? '## 作息\n' + routines : '',
    moodRules ? '## 情绪规则\n' + moodRules : '',
    sleep?.remainingMin != null ? `## 睡前模式\n约 ${sleep.remainingMin} 分钟后睡，歌曲能量逐步下降；剩 5 分钟内温柔收尾。` : '',
    '## 环境\n' + environment,
    nowPlaying?.type === 'song'
      ? `## 正在播放\n《${nowPlaying.title}》— ${nowPlaying.artist}。听众说“这首”就是指它；评价它时通常 play=[]。`
      : '',
    '## 最近听过（硬避重；程序还会对完整 50 首二次过滤）\n' + formatSongs(recentSongs.slice(0, 20)),
    brief.recentUserMessages.length ? '## 最近听众自己说过的话（不注入 DJ 套话）\n' + brief.recentUserMessages.map((line) => `- ${line}`).join('\n') : '',
    userInput ? '## 听众刚说\n' + userInput : '',
  ].filter(Boolean).join('\n\n');

  return {
    prompt,
    recommendation: {
      favoriteSongs,
      recentSongs,
      dislikedSongs: disliked,
      recentArtists,
      explicitRequest: isExplicitSongRequest,
      fingerprint: brief.openingFingerprint.id,
      mode: brief.mode,
      poolSongs: pool,
    },
  };
}

export function buildPrompt(options = {}) {
  return buildPromptBundle(options).prompt;
}
