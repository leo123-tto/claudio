import fs from 'node:fs';
import path from 'node:path';
import { styleConstraints } from './style-request.js';
import { config } from './config.js';
import { recentPlays, recentMessages } from './state.js';
import { summaryLine } from './weather.js';
import { readMemory } from './memory.js';
import { getSettings } from './settings.js';
import {
  buildRecommendationBrief,
  laneBrief,
  parseFavoriteSongs,
  sampleDiscoveryPool,
} from './recommendation.js';
import {
  currentProfile,
  dislikedSongs as readDislikedSongs,
  recentFingerprints,
  recentLanes,
  recentListenedSongs,
  readEvents,
  songsPlayedSince,
} from './events.js';
import { getDiscoveryPool } from './discovery.js';
import { isFillerEvent, signalWeight } from './profile.js';
import { banStore } from './bans.js';
import { factStore } from './song-meta.js';
import { currentScene, sceneText } from './scene.js';
import { DRIVE_PROMPT } from './drive.js';

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

function seededRng(key) {
  let seed = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    seed = Math.imul(seed ^ key.charCodeAt(index), 16777619);
  }
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function sample(items, count, rng) {
  const pool = mergeSongs(items);
  const picked = [];
  while (pool.length && picked.length < count) {
    picked.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  return picked;
}

function formatSongs(songs = []) {
  return songs.map((song) => {
    const facts = [song.year, song.genre].filter(Boolean).join(' ');
    return facts ? `- ${song.title} — ${song.artist}（${facts}）` : `- ${song.title} — ${song.artist}`;
  }).join('\n') || '（暂无）';
}

function withFacts(songs = []) {
  return songs.map((song) => ({ ...song, ...factStore.lookup(song) }));
}

function songKey(song) {
  return `${String(song?.title || '').toLocaleLowerCase()}|${String(song?.artist || '').toLocaleLowerCase()}`;
}

function mergeSongs(primary = [], extra = []) {
  const seen = new Set();
  const result = [];
  for (const song of [...primary, ...extra]) {
    const key = songKey(song);
    if (key === '|' || seen.has(key)) continue;
    seen.add(key);
    result.push(song);
  }
  return result;
}

const LANE_LABEL = {
  bridge: '口味桥接',
  popular: '当下流行',
  fresh: '新风格',
  classic: '老内容',
};

function formatPool(songs = []) {
  return songs.map((song) => {
    const label = LANE_LABEL[song.lane] || LANE_LABEL.bridge;
    return `- [${label}] ${song.title} — ${song.artist}`;
  }).join('\n') || '（暂无）';
}

// 同一场景以前的反应：喜欢 / 听完的、很快跳过 / 不喜欢的，各取最近 5 首。只看最近 90 天，垫场歌不算。
export function sceneMemory(events, scene) {
  const since = Date.now() - 90 * 24 * 3600_000;
  const liked = new Map();
  const skipped = new Map();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.scene !== scene.key || !event.song?.title || isFillerEvent(event)) continue;
    if (new Date(event.at).getTime() < since) break;
    const name = `${event.song.title} - ${event.song.artist || ''}`.trim();
    const weight = signalWeight(event);
    if (weight >= 20 && !skipped.has(name)) liked.set(name, true);
    else if (weight < 0 && !liked.has(name)) skipped.set(name, true);
  }
  const top = (map) => [...map.keys()].slice(0, 5).join('；');
  if (!liked.size && !skipped.size) return '';
  return [`## 这个场景（${scene.label}）以前`,
    liked.size ? `喜欢或听完：${top(liked)}` : '',
    skipped.size ? `很快跳过或不喜欢：${top(skipped)}` : '',
  ].filter(Boolean).join('\n');
}

function explicitSongRequest(input = '') {
  const text = String(input).trim();
  if (!text || styleConstraints(text).length) return false;
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

export function buildPromptBundle({ userInput = '', mood = '', sleep = null, nowPlaying = null, briefSay = false, drive = false, excludeSongs = [], recentSays = [], now = new Date(), scene = currentScene(now) } = {}) {
  const settings = getSettings();
  const favoriteSongs = readFavorites();
  const actualRecent = recentListenedSongs(50);
  const legacyRecent = recentPlays(20).map(({ title, artist }) => ({ title, artist }));
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const playedToday = songsPlayedSince(readEvents(), dayStart.getTime());
  const recentSongs = withFacts(mergeSongs(mergeSongs(actualRecent.length ? actualRecent : legacyRecent, playedToday), excludeSongs));
  const banned = banStore.ensureSeeded(readDislikedSongs());
  const profile = currentProfile();
  const messages = recentMessages(20);
  const brief = buildRecommendationBrief({
    mode: settings.recommendation.mode,
    messages,
    recentFingerprints: recentFingerprints(),
    recentLanes: recentLanes(),
  });
  const lane = laneBrief(brief.discoveryLane);
  const recentArtists = [...new Set(recentSongs.map((song) => song.artist).filter(Boolean))].slice(0, 5);
  const isExplicitSongRequest = explicitSongRequest(userInput);
  const hasPositiveStyle = styleConstraints([userInput, mood].filter(Boolean).join(' ')).some(Array.isArray);

  const weather = summaryLine();
  const sceneHistory = sceneMemory(readEvents(), scene);
  const environment = [
    `现在时间：${now.toLocaleString('zh-CN', { hour12: false })}`,
    weather ? `天气：${weather}` : '',
    mood ? `当前心情：${mood}` : '',
  ].filter(Boolean).join('\n');

  const taste = readSafe(path.join(config.paths.user, 'taste.md'));
  const tasteDigest = readSafe(path.join(config.paths.cache, 'taste-digest.md'));
  const oldMemory = readMemory(24);
  const routines = readUserDoc('routines.md');
  const moodRules = readUserDoc('mood-rules.md');
  const playlists = readPlaylists();
  // 两份样本各用独立种子，同一小时复用前缀，改曲库仍立即生效。
  const hourKey = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours()].join('-');
  const favoriteSample = sample(favoriteSongs, 12, seededRng(`favorites|${hourKey}`));
  // 先排除程序会拦下的歌，避免候选池反复引导空节目。
  const excludedPoolKeys = new Set([...recentSongs, ...banned].map(songKey));
  const eligiblePool = mergeSongs(getDiscoveryPool(200)).filter((song) => !excludedPoolKeys.has(songKey(song)));
  const pool = withFacts(sampleDiscoveryPool(eligiblePool, lane.lane, {
    rng: seededRng(`pool|${hourKey}|${lane.lane}`),
  }));

  const outputContract = `JSON 字段顺序必须是 say、intent、action、actionValue、play、reason、memoryCandidates：
{"say":"中文口播","intent":"chat","action":"none","actionValue":0,"play":[],"reason":"意图与选择依据","memoryCandidates":[]}
- say：必须第一个生成。聊天和推荐默认用中文口语 2–3 句、70 到 110 字，多讲一句此刻的感觉或为什么接这首；本次任务若要求简短口播则按任务长度。不要清单式念歌名，也不要长篇。控制确认就一句，20 字内。不使用固定开场套话。
- intent：只能是 chat / recommend / control。先判断听众是在陪伴聊天、想换音乐，还是要求操作播放器。
- action：control 时只能是 pause / resume / next / previous / stop / favorite / dislike / volume_up / volume_down / volume_set；其他意图必须是 none。
- actionValue：仅 volume_set 时填 0–100，其余填 0。
- play：只有 recommend 才能给歌曲，默认给 3 个候选；听众明确提出正向曲风、乐器或情绪要求时给 5 个候选，所有候选都须满足要求，宁可少给。仅排除某类音乐不启用 5 个候选。chat 和 control 必须给 []，绝不能因为对话里提到“歌”就自动推荐。按 play 顺序只播放前两首，其余仅是不可播时的备选；say 只可按顺序提到前两首，不能提备选。
- play 每一项固定写成 {"title":"歌名","artist":"歌手","discoveryType":"adjacent","lane":"fresh","bridgeFrom":"从哪条偏好接过来","score":80}。title、artist 必填，写网易云上的原名，不加书名号，不写 Live / 伴奏 / 翻唱版。网易云没有版权的歌手（如周杰伦）不要选，放不出来。
- discoveryType 只能是 familiar / adjacent / explore；score 是 0–100 的综合适配分。发现位的歌可加 lane：popular / fresh / classic。
- memoryCandidates：只记录听众这次亲自表达的新证据，格式 {"key":"类别","value":"事实","evidence":"原话依据"}；没有就 []。`;

  const styleRules = `本次有明确的正向曲风、乐器或情绪要求：${[userInput, mood].filter(Boolean).join(' ')}。
若 intent=recommend，给 5 个候选，全部满足本次要求；前两首计划播放，后三首只作不可播时的备选，say 只提到前两首。宁可少给，不用不符的歌补位。
桥接、发现位轮换和起手指纹都让位于本次要求，不为凑轨位改变曲风、乐器或情绪；候选池仅作参考，可选池外更合适的歌。
最近听过和今天已经播过的不重复；禁播清单里的歌不要再选，除非听众明确点名。没有点名时不照搬收藏原曲。`;

  // 工作、深夜、睡前这类要安静的场景，自动节目的桥接和发现位也得服从场景，口播长度也按场景来。
  const sceneFirst = ['work', 'late', 'sleep'].includes(scene.key)
    ? `\n此刻是${scene.label}：桥接和发现位都必须符合「此刻场景」的要求，不符就不选（发现位可以换成符合场景的新歌或老歌）；口播长度也按此刻场景来，覆盖输出契约里的字数。`
    : '';
  const automaticRules = (hasPositiveStyle ? `这次是自动推荐，intent=recommend，action=none。\n${styleRules}` : `这次是自动推荐。两首歌里要有一首口味桥接，再有一首本期发现位「${lane.name}」。
发现位按当下流行、新风格、老内容轮换。本期是 ${lane.name}：${lane.hint}
起手指纹：语言=${brief.openingFingerprint.language}，能量=${brief.openingFingerprint.energy}，方向=${brief.openingFingerprint.familiarity}。
硬要求：
1. 收藏原曲只用来理解口味。听众没有点名时，不要直接选收藏原曲。
2. 3 个候选里必须有一首口味桥接：discoveryType=adjacent，bridgeFrom 写清它从哪条已知偏好接过来，而且不是收藏原曲。
3. 再必须有一首本期发现位，lane=${lane.lane}，discoveryType=explore。popular 用热歌榜里他没听过的；fresh 用明显不同的语种或曲风；classic 用 2016 年前的老歌或经典原唱，不要新歌。
4. 最近听过和今天已经播过的不重复；最近 5 位歌手尽量不重复。禁播清单里的歌不要再选，除非听众这次明确点名。
5. 口播不要念「冷门」「算法」「比例」「发现位」，像朋友自然带出即可。最近听过如果写了年份或曲风，可以自然提一句；没有就不要编。`) + sceneFirst;

  const chatRules = `听众刚说了话。你既是能放歌的私人 DJ，也是可以日常交流的陪伴者。按以下优先级判断：
1. 普通聊天、倾诉、问问题、评价当前歌：intent=chat，action=none，play=[]。认真回应内容，让当前歌继续，绝不强行转成推荐。他说好听、喜欢、记下，只是在记这首，不要因此换歌。
2. 明确要求推荐、换一批、想听某种音乐或点具体歌曲：intent=recommend，action=none，${hasPositiveStyle ? '给 5 个候选，全部满足明确要求；桥接、发现位轮换和起手指纹都让位于本次要求。' : '给 3 个候选。听众说了要哪种（语言、年代、歌手、场景，比如粤语老歌、跑步、某位歌手）时，3 首都必须符合，候选池里不符的歌不用，桥接和发现位让位；只说换一首、没说要哪种时，才留一首口味桥接，并掺进新风格、当下流行或老内容。没有点名时不要照搬收藏原曲。'}明确点了某首具体歌时才允许命中收藏原曲。
3. 要操作软件播放器：intent=control，play=[]，action 对应暂停、继续、下一首、上一首、停止、收藏、不喜欢或音量。可用功能只有 pause/resume/next/previous/stop/favorite/dislike/volume_up/volume_down/volume_set，不要编造其他按钮。
不确定时优先 chat，不要擅自换歌。回应要像熟悉的朋友，直接自然，不复述规则。`;

  const recentDjLines = [...messages
    .filter((item) => item?.role === 'claudio')
    .map((item) => item.content), ...recentSays]
    .filter((text, index, list) => text && list.lastIndexOf(text) === index).slice(-3)
    .map((text) => `- ${String(text).trim().split(/[，。！？!?；;、]/)[0]}`);

  // 不变的放前面、每次都变的放后面：本地盒子、DeepSeek、Claude 都按前缀复用缓存，首字更快。
  // 盒子按 2048 token 一块缓存（2026-11-22 实测：同前缀第二次 prefill 1.9 → 0.85 秒），点歌和自动节目共用前面这块，
  // 所以点歌不删中间段落；最近听过也全带（少带会让大脑挑到被滤掉的歌、选歌落空）。点歌只在尾部加一句要短。
  const chat = Boolean(userInput);
  const prompt = [
    '你是 Claudio，听众的私人电台 DJ。像懂 ta 的老朋友，中文、温柔，把话说完整一点，不油腻、不套话。',
    '## 输出契约（严格只输出 JSON）\n' + outputContract,
    '## 听众口味档案\n' + (taste || '（尚未填写）'),
    playlists ? '## 听众手工歌单（理解场景，不要把它当默认点歌单）\n' + playlists : '',
    routines ? '## 作息\n' + routines : '',
    moodRules ? '## 情绪规则\n' + moodRules : '',
    tasteDigest ? '## 持续整理的品味（他亲口说过好听或点过爱心后自动整理；手写口味档案仍以 taste.md 为准）\n' + tasteDigest : '',
    oldMemory ? '## 人工可编辑的长期记忆（保留旧系统，只作稳定背景）\n' + oldMemory : '',
    banned.length ? '## 禁播（自动推荐不要再选，听众可以要求恢复）\n' + formatSongs(banned) : '',
    favoriteSample.length ? '## 收藏曲口味样本（只作锚点，自动推荐严禁照搬原曲）\n' + formatSongs(favoriteSample) : '',
    '## 结构化行为画像（分数越高越偏爱，负数表示避开）\n' + profileText(profile),
    '## 最近听过（硬避重；含今天播过的，程序还会再滤一遍）\n' + formatSongs(recentSongs.map(({ title, artist }) => ({ title, artist }))),
    // 点歌不给候选池：实测大脑会照抄池里的歌（点陈奕迅给张信哲、点粤语老歌给池里的国语歌）；程序兜底仍会用池子。
    pool.length && !userInput ? '## 候选池\n' + (hasPositiveStyle
      ? '仅作参考，轨位和起手方向让位于本次明确要求；不符要求的歌不用。\n'
      : `按轨标注。本期发现位是${lane.name}。选一首口味桥接，再选一首本期发现位；也可以提出池外更好的歌，但 lane 要标对。\n`) + formatPool(pool) : '',
    recentDjLines.length ? '## 最近三次口播的首个分句（不得复用这些开头或意象）\n' + recentDjLines.join('\n') : '',
    brief.recentUserMessages.length ? '## 最近听众自己说过的话\n' + brief.recentUserMessages.map((line) => `- ${line}`).join('\n') : '',
    '## 本次最高优先级任务\n' + (userInput ? chatRules : automaticRules),
    userInput && hasPositiveStyle ? styleRules : '',
    chat ? '本次是听众当面说话，要快：say 用 1–2 句、40 到 70 字；reason 15 字内；memoryCandidates 只在听众这次明确说了喜好时写，否则 []。' : '',
    briefSay ? '本次简短口播：推荐或聊天只说一句，30到45个字，不要第二句；控制确认仍在20字内。' : '',
    drive ? DRIVE_PROMPT : '',
    sleep?.remainingMin != null ? `## 睡前模式\n约 ${sleep.remainingMin} 分钟后睡，歌曲能量逐步下降；剩 5 分钟内温柔收尾。` : '',
    '## 此刻场景（选歌和口播长度按这个来）\n' + sceneText(scene),
    sceneHistory,
    '## 环境\n' + environment,
    nowPlaying?.type === 'song'
      ? `## 正在播放\n《${nowPlaying.title}》— ${nowPlaying.artist}${[nowPlaying.year, nowPlaying.genre].filter(Boolean).length ? `（${[nowPlaying.year, nowPlaying.genre].filter(Boolean).join(' ')}）` : ''}。听众说“这首”就是指它；评价它时通常 play=[]。`
      : '',
    userInput ? '## 听众刚说\n' + userInput : '',
  ].filter(Boolean).join('\n\n');

  return {
    prompt,
    recommendation: {
      favoriteSongs,
      recentSongs,
      dislikedSongs: [],
      bannedSongs: banned,
      recentArtists,
      explicitRequest: isExplicitSongRequest,
      styleRequest: [userInput, mood].filter(Boolean).join(' '),
      fingerprint: brief.openingFingerprint.id,
      mode: brief.mode,
      discoveryLane: lane.lane,
      poolSongs: pool,
    },
  };
}

export function buildPrompt(options = {}) {
  return buildPromptBundle(options).prompt;
}
