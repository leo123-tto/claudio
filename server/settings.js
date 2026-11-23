import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// 大脑只留三家：家里盒子（本地）、Claude 订阅、DeepSeek 官方。
// ChatGPT / Grok / Ornith / Agent2API 于 2026-10-31 下线；旧设置读进来时自动改到本地。
export const PROVIDERS = ['local', 'claude', 'deepseek'];
const LEGACY_PROVIDERS = ['codex', 'grok', 'ornith', 'agent2api'];
export const CLAUDE_MODELS = ['sonnet', 'opus'];
export const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];
// 官方当前名是 deepseek-flash（V4.1 Flash）。旧名仍会被接口暂时转到同一模型，本地设置直接迁过去。
const DEEPSEEK_ALIASES = Object.freeze({
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
});
export const FISH_MODELS = ['s1', 's2-pro'];
export const RECOMMENDATION_MIXES = Object.freeze({
  familiar: Object.freeze({ familiar: 60, adjacent: 30, explore: 10 }),
  balanced: Object.freeze({ familiar: 30, adjacent: 50, explore: 20 }),
  discovery: Object.freeze({ familiar: 10, adjacent: 65, explore: 25 }),
});

// 本地大模型的默认入口；真实地址写 .env 的 LOCAL_LLM_BASE_URL，或在设置页填。
const DEFAULT_LOCAL_LLM_BASE = 'http://127.0.0.1:8001/v1';
export const DEFAULT_LOCAL_LLM_MODEL = 'DeepSeek-V4.1-Flash-1017';
// 盒子上这些旧名现在都是 DeepSeek 的别名，设置里直接换成正名。
const LEGACY_LOCAL_MODELS = ['qwen3.8-flash-next-unc', 'GLM-5.3-Flash-EXL3', 'flash-next'];
const LOCAL_MODEL_RE = /^[A-Za-z0-9._:/-]+$/;
export const TTS_PROVIDERS = ['pc5090', 'fish'];
export const AUDIO_QUALITIES = ['standard', 'higher', 'exhigh', 'lossless', 'hires'];

function envAudioQuality() {
  const level = String(config.ncm.level || '').trim();
  return AUDIO_QUALITIES.includes(level) ? level : 'exhigh';
}

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  llm: Object.freeze({
    provider: 'local',
    models: Object.freeze({
      local: config.llm.local.model || DEFAULT_LOCAL_LLM_MODEL,
      claude: CLAUDE_MODELS.includes(config.claude.model) ? config.claude.model : 'sonnet',
      deepseek: DEEPSEEK_MODELS.includes(config.llm.deepseek.model)
        ? config.llm.deepseek.model
        : 'deepseek-flash',
    }),
    local: Object.freeze({
      baseUrl: String(config.llm.local.baseUrl || DEFAULT_LOCAL_LLM_BASE).replace(/\/+$/, ''),
    }),
  }),
  tts: Object.freeze({
    provider: 'pc5090',
    fish: Object.freeze({
      model: FISH_MODELS.includes(config.tts.fish.model) ? config.tts.fish.model : 's1',
      referenceId: config.tts.fish.voiceZh || config.tts.fish.referenceId || config.tts.fish.voiceEn || '',
    }),
    pc5090: Object.freeze({
      baseUrl: String(config.tts.pc5090.baseUrl).replace(/\/+$/, ''),
      voice: config.tts.pc5090.voice || 'claudio',
    }),
  }),
  recommendation: Object.freeze({
    mode: 'discovery',
    mix: RECOMMENDATION_MIXES.discovery,
  }),
  playback: Object.freeze({
    quality: envAudioQuality(),
  }),
});

const SETTINGS_FILE = path.join(config.paths.cache, 'settings.json');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} 必须是对象`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${label} 不支持字段 ${key}`);
  }
}

function assertHttpUrl(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} 必须是字符串`);
  const clean = value.trim();
  if (!clean) throw new TypeError(`${label} 不能为空`);
  if (clean.length > 200) throw new TypeError(`${label} 长度异常`);
  let parsed;
  try {
    parsed = new URL(clean);
  } catch {
    throw new TypeError(`${label} 必须是合法 URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`${label} 必须是 http 或 https 地址`);
  }
  return clean.replace(/\/+$/, '');
}

function assertLocalModelName(value, label = '本地模型名') {
  if (typeof value !== 'string') throw new TypeError(`${label}必须是字符串`);
  const clean = value.trim();
  if (!clean) throw new TypeError(`${label}不能为空`);
  if (clean.length > 100) throw new TypeError(`${label}长度异常`);
  if (!LOCAL_MODEL_RE.test(clean)) throw new TypeError(`${label}含非法字符`);
  return clean;
}

function assertBoundedString(value, label, { max, allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new TypeError(`${label} 必须是字符串`);
  const clean = value.trim();
  if (!clean && !allowEmpty) throw new TypeError(`${label} 不能为空`);
  if (clean.length > max) throw new TypeError(`${label} 长度异常`);
  return clean;
}

// 旧版设置（含已下线的大脑、思考强度等）读进来时先迁移，旧界面发来的多余字段也一并丢掉，不报错。
export function migrateLegacySettings(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const value = clone(raw);
  const llm = value.llm;
  if (llm && typeof llm === 'object' && !Array.isArray(llm)) {
    if (LEGACY_PROVIDERS.includes(llm.provider)) llm.provider = 'local';
    for (const key of ['reasoningEffort', 'ornith', 'agent2api']) delete llm[key];
    if (llm.models && typeof llm.models === 'object') {
      for (const key of LEGACY_PROVIDERS) delete llm.models[key];
      if (LEGACY_LOCAL_MODELS.includes(llm.models.local)) llm.models.local = DEFAULT_LOCAL_LLM_MODEL;
    }
  }
  // 旧盒子的语音（:30040）已下线，改走 5090。
  const tts = value.tts;
  if (tts && typeof tts === 'object' && !Array.isArray(tts)) {
    if (tts.provider === 'local') tts.provider = 'pc5090';
    delete tts.local;
    // 5090 流式开关已取消（改为逐句合成）。
    if (tts.pc5090 && typeof tts.pc5090 === 'object') delete tts.pc5090.stream;
  }
  return value;
}

export function mergeSettings(current = DEFAULT_SETTINGS, rawPatch = {}) {
  const patch = migrateLegacySettings(rawPatch);
  assertKeys(patch, ['version', 'llm', 'tts', 'recommendation', 'playback'], '设置');
  const next = clone(current);

  if (patch.version !== undefined && patch.version !== 1) {
    throw new TypeError('不支持的设置版本');
  }

  if (patch.llm !== undefined) {
    assertKeys(patch.llm, ['provider', 'models', 'local'], '模型设置');
    if (patch.llm.provider !== undefined) {
      if (!PROVIDERS.includes(patch.llm.provider)) throw new TypeError('不支持的模型供应商');
      next.llm.provider = patch.llm.provider;
    }
    if (patch.llm.local !== undefined) {
      assertKeys(patch.llm.local, ['baseUrl'], '本地模型设置');
      if (patch.llm.local.baseUrl !== undefined) {
        next.llm.local.baseUrl = assertHttpUrl(patch.llm.local.baseUrl, '本地模型服务地址');
      }
    }
    if (patch.llm.models !== undefined) {
      assertKeys(patch.llm.models, PROVIDERS, '模型选择');
      if (patch.llm.models.local !== undefined) {
        next.llm.models.local = assertLocalModelName(patch.llm.models.local);
      }
      if (patch.llm.models.claude !== undefined) {
        if (!CLAUDE_MODELS.includes(patch.llm.models.claude)) throw new TypeError('不支持的 Claude 模型');
        next.llm.models.claude = patch.llm.models.claude;
      }
      if (patch.llm.models.deepseek !== undefined) {
        const model = DEEPSEEK_ALIASES[patch.llm.models.deepseek] || patch.llm.models.deepseek;
        if (!DEEPSEEK_MODELS.includes(model)) throw new TypeError('不支持的 DeepSeek 模型');
        next.llm.models.deepseek = model;
      }
    }
  }

  if (patch.tts !== undefined) {
    assertKeys(patch.tts, ['provider', 'fish', 'pc5090'], '语音设置');
    if (patch.tts.provider !== undefined) {
      if (!TTS_PROVIDERS.includes(patch.tts.provider)) {
        throw new TypeError('语音仅支持 5090 或 Fish，失败不会自动切换');
      }
      next.tts.provider = patch.tts.provider;
    }
    if (patch.tts.fish !== undefined) {
      assertKeys(patch.tts.fish, ['model', 'referenceId'], 'Fish 设置');
      if (patch.tts.fish.model !== undefined) {
        if (!FISH_MODELS.includes(patch.tts.fish.model)) throw new TypeError('不支持的 Fish 模型');
        next.tts.fish.model = patch.tts.fish.model;
      }
      if (patch.tts.fish.referenceId !== undefined) {
        const value = String(patch.tts.fish.referenceId).trim();
        if (value.length > 200) throw new TypeError('Fish 音色 ID 长度异常');
        next.tts.fish.referenceId = value;
      }
    }
    if (patch.tts.pc5090 !== undefined) {
      assertKeys(patch.tts.pc5090, ['baseUrl', 'voice'], '5090 语音设置');
      if (patch.tts.pc5090.baseUrl !== undefined) {
        next.tts.pc5090.baseUrl = assertHttpUrl(patch.tts.pc5090.baseUrl, '5090 语音服务地址');
      }
      if (patch.tts.pc5090.voice !== undefined) {
        next.tts.pc5090.voice = assertBoundedString(patch.tts.pc5090.voice, '5090 音色', { max: 100 });
      }
    }
  }

  if (patch.recommendation !== undefined) {
    assertKeys(patch.recommendation, ['mode', 'mix'], '推荐设置');
    const mode = patch.recommendation.mode;
    if (mode !== undefined) {
      if (!RECOMMENDATION_MIXES[mode]) throw new TypeError('不支持的推荐模式');
      next.recommendation.mode = mode;
      next.recommendation.mix = clone(RECOMMENDATION_MIXES[mode]);
    }
    if (patch.recommendation.mix !== undefined) {
      const expected = RECOMMENDATION_MIXES[next.recommendation.mode];
      if (JSON.stringify(patch.recommendation.mix) !== JSON.stringify(expected)) {
        throw new TypeError('推荐比例只能由推荐模式决定');
      }
      next.recommendation.mix = clone(expected);
    }
  }

  if (patch.playback !== undefined) {
    assertKeys(patch.playback, ['quality'], '播放设置');
    if (patch.playback.quality !== undefined) {
      if (!AUDIO_QUALITIES.includes(patch.playback.quality)) throw new TypeError('不支持的歌曲音质');
      next.playback.quality = patch.playback.quality;
    }
  }
  return next;
}

export function toPublicSettings(settings, availability = {}, credentials = {}) {
  return {
    version: settings.version,
    llm: clone(settings.llm),
    tts: clone(settings.tts),
    recommendation: clone(settings.recommendation),
    playback: clone(settings.playback),
    options: {
      providers: PROVIDERS,
      claudeModels: CLAUDE_MODELS,
      deepseekModels: DEEPSEEK_MODELS,
      ttsProviders: TTS_PROVIDERS,
      fishModels: FISH_MODELS,
      recommendationModes: Object.keys(RECOMMENDATION_MIXES),
      audioQualities: AUDIO_QUALITIES,
    },
    availability: Object.fromEntries(PROVIDERS.map((name) => [name, Boolean(availability[name])])),
    credentials: {
      deepseek: Boolean(credentials.deepseek),
      fish: Boolean(credentials.fish),
      local: Boolean(credentials.local),
    },
  };
}

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return mergeSettings(DEFAULT_SETTINGS, migrateLegacySettings(parsed));
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[settings] 设置文件无效，使用安全默认值：', error.message);
    return clone(DEFAULT_SETTINGS);
  }
}

let runtimeSettings = loadSettings();

export function getSettings() {
  return clone(runtimeSettings);
}

export function updateSettings(patch) {
  const next = mergeSettings(runtimeSettings, patch);
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  const temp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2));
  fs.renameSync(temp, SETTINGS_FILE);
  runtimeSettings = next;
  return getSettings();
}
