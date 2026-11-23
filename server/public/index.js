// Claudio 公用版入口（CLAUDIO_MODE=public）。和个人版 server/index.js 完全分开跑：
// 独立端口、独立数据目录、没有老板的口味 / 记忆 / 网易云 cookie / 5090 钥匙。
//
// 必填环境变量：PUBLIC_HUB_BASE、PUBLIC_HUB_KEY（claudio-invite scope）、PUBLIC_VAULT_KEY、CLAUDIO_DATA_DIR
// 好友互荐：PUBLIC_FRIENDS（0 = 关）PUBLIC_OWNER_NAME（老板在好友圈里的默认名字，默认「站长」）FRIENDS_INTERNAL（老板个人版用的内部口，如 127.0.0.1:8092；不设不开）
// 可选：PORT(8091) HOST(127.0.0.1) NCM_BASE NCM_SHARED_URL（老板实例的搜索名额服务，盒子上是 http://127.0.0.1:8099）PUBLIC_LLM_BASE PUBLIC_LLM_MODEL PUBLIC_ENGINE_METRICS
//      PUBLIC_BORROW_OWNER（0 = 未绑定时不用运营者配置的默认音源）PUBLIC_MAX_LISTENERS PUBLIC_FREE_CHART（没绑定的人放哪个榜单里的免费歌，默认热歌榜）PUBLIC_COOKIE_SECURE PUBLIC_APPLY_ORIGINS PUBLIC_TURNSTILE_SECRET(_FILE) PUBLIC_TURNSTILE_SITEKEY PUBLIC_TTS（0 = 不念口播）
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicApp, syncWithHub } from './app.js';
import { createBrain } from './brain.js';
import { createHubClient } from './hub-client.js';
import { createMemberStore, parseVaultKey } from './members.js';
import { createFriendStore, loadWords } from './friends.js';
import { startOwnerServer } from './friends-routes.js';
import { createNcmClient } from './ncm-public.js';
import { createOwnerChannel } from '../ncm-shared.js';

const env = process.env;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function fail(message) {
  console.error(`[public] ${message}`);
  process.exit(1);
}

if (env.CLAUDIO_MODE !== 'public') fail('公用版只在 CLAUDIO_MODE=public 时启动');
// 隔离自检：公用实例里不该看到任何老板的私人配置
for (const name of ['NCM_COOKIE', 'FISH_API_KEY', 'LOCAL_LLM_API_KEY', 'DEEPSEEK_API_KEY']) {
  if (env[name]) fail(`环境里有 ${name}，公用版不该带老板的私人配置，拒绝启动`);
}
for (const name of ['PUBLIC_HUB_BASE', 'PUBLIC_HUB_KEY', 'PUBLIC_VAULT_KEY', 'CLAUDIO_DATA_DIR']) {
  if (!env[name]) fail(`缺少 ${name}`);
}

// Turnstile secret 也可以放单独的文件（老板自己填，不进 secret.env、不打印）
function readSecretFile(file) {
  if (!file) return '';
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

const log = (event, id = '', extra = '') => {
  // 只记事件和成员 id，不记对话、歌单、cookie、令牌
  console.log(`${new Date().toISOString()} ${event} ${id} ${extra}`.trim());
};

const hub = createHubClient({ base: env.PUBLIC_HUB_BASE, key: env.PUBLIC_HUB_KEY });
const dataDir = path.resolve(env.CLAUDIO_DATA_DIR);
const vaultKey = parseVaultKey(env.PUBLIC_VAULT_KEY);
const members = createMemberStore({ root: path.join(dataDir, 'members'), vaultKey });
// 好友互荐：一份加密文件；附言 / 昵称的敏感词表 friend-words.txt 放数据目录（一行一个，不进仓库）。PUBLIC_FRIENDS=0 关掉
const ownerName = env.PUBLIC_OWNER_NAME || '站长';
const friends = env.PUBLIC_FRIENDS === '0' ? null : createFriendStore({ file: path.join(dataDir, 'friends.enc'), vaultKey, ownerName });
const wordsFile = path.join(dataDir, 'friend-words.txt');
let words = { at: 0, list: [] };
const friendWords = () => {
  if (Date.now() - words.at > 60_000) words = { at: Date.now(), list: loadWords(wordsFile) };
  return words.list;
};
// 未绑定网易云时用运营者配置的默认音源（经主实例取链接，主实例的 cookie 不进这个进程）；PUBLIC_BORROW_OWNER=0 关掉
const owner = env.NCM_SHARED_URL && env.PUBLIC_BORROW_OWNER !== '0' ? createOwnerChannel(env.NCM_SHARED_URL) : null;
const ncm = createNcmClient({ base: env.NCM_BASE || 'http://127.0.0.1:3011', sharedUrl: env.NCM_SHARED_URL || '', owner });
const brain = createBrain({
  baseUrl: env.PUBLIC_LLM_BASE || 'http://127.0.0.1:8001/v1',
  model: env.PUBLIC_LLM_MODEL || 'DeepSeek-V4.1-Flash-1017',
  apiKey: env.PUBLIC_LLM_KEY || 'local',
  metricsUrl: env.PUBLIC_ENGINE_METRICS ?? 'http://127.0.0.1:8889/metrics',
  personaFile: path.join(root, 'prompts', 'public-dj.md'),
});

// 两个值要配齐才校验人机：只有 secret 没有 site key 时页面出不了验证框，申请会全被拒
const turnstileSiteKey = env.PUBLIC_TURNSTILE_SITEKEY || '';
const turnstileSecret = turnstileSiteKey ? (env.PUBLIC_TURNSTILE_SECRET || readSecretFile(env.PUBLIC_TURNSTILE_SECRET_FILE)) : '';
if (!turnstileSecret || !turnstileSiteKey) log('turnstile-off', '', turnstileSiteKey ? 'no-secret' : 'no-sitekey');

const { app, recommendFriend } = createPublicApp({
  hub,
  ncm,
  brain,
  members,
  webRoot: path.join(root, 'web'),
  cookieSecure: env.PUBLIC_COOKIE_SECURE !== '0',
  applyOrigins: String(env.PUBLIC_APPLY_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  turnstileSecret,
  turnstileSiteKey: turnstileSecret ? turnstileSiteKey : '',
  maxListeners: Number(env.PUBLIC_MAX_LISTENERS) || 8,
  freeChartId: env.PUBLIC_FREE_CHART || '3778678',
  // 口播找老板实例的 8099 名额服务要（PUBLIC_TTS=0 关掉）
  ttsUrl: env.PUBLIC_TTS === '0' ? '' : (env.NCM_SHARED_URL || ''),
  friends,
  friendWords,
  ownerName,
  log,
});

const port = Number(env.PORT || 8091);
const host = env.HOST || '127.0.0.1';
http.createServer(app).listen(port, host, () => log('listening', `${host}:${port}`));
// 老板个人版进好友圈的内部口：只听本机（盒子上 127.0.0.1:8092），不挂在对外的 8091 上
if (friends && env.FRIENDS_INTERNAL) startOwnerServer(env.FRIENDS_INTERNAL, { friends, recommend: recommendFriend, words: friendWords }, log);

async function sync() {
  try {
    await syncWithHub({ hub, members, friends, log });
  } catch (error) {
    log('sync-failed', '', error.reason || error.name);
  }
}
setTimeout(sync, 5000);
setInterval(sync, Number(env.PUBLIC_SYNC_MS) || 60_000).unref();
