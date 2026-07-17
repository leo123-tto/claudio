import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export const CODEX_MODELS = ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'];
export const CLAUDE_MODELS = ['sonnet', 'opus'];
export const DEEPSEEK_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'];
export const FISH_MODELS = ['s1', 's2-pro'];
export const REASONING_EFFORTS = ['low', 'medium'];
export const RECOMMENDATION_MIXES = Object.freeze({
  familiar: Object.freeze({ familiar: 60, adjacent: 30, explore: 10 }),
  balanced: Object.freeze({ familiar: 30, adjacent: 50, explore: 20 }),
  discovery: Object.freeze({ familiar: 10, adjacent: 65, explore: 25 }),
});

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  llm: Object.freeze({
    provider: 'codex',
    models: Object.freeze({
      codex: 'gpt-5.6-luna',
      claude: CLAUDE_MODELS.includes(config.claude.model) ? config.claude.model : 'sonnet',
      deepseek: DEEPSEEK_MODELS.includes(config.llm.deepseek.model)
        ? config.llm.deepseek.model
        : 'deepseek-v4-flash',
    }),
    reasoningEffort: 'low',
  }),
  tts: Object.freeze({
    provider: 'fish',
    fish: Object.freeze({
      model: FISH_MODELS.includes(config.tts.fish.model) ? config.tts.fish.model : 's1',
      referenceId: config.tts.fish.voiceZh || config.tts.fish.referenceId || config.tts.fish.voiceEn || '',
    }),
  }),
  recommendation: Object.freeze({
    mode: 'discovery',
    mix: RECOMMENDATION_MIXES.discovery,
  }),
});

const SETTINGS_FILE = path.join(config.paths.cache, 'settings.json');
const PROVIDERS = ['codex', 'claude', 'deepseek'];

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

export function mergeSettings(current = DEFAULT_SETTINGS, patch = {}) {
  assertKeys(patch, ['version', 'llm', 'tts', 'recommendation'], '设置');
  const next = clone(current);

  if (patch.version !== undefined && patch.version !== 1) {
    throw new TypeError('不支持的设置版本');
  }

  if (patch.llm !== undefined) {
    assertKeys(patch.llm, ['provider', 'models', 'reasoningEffort'], '模型设置');
    if (patch.llm.provider !== undefined) {
      if (!PROVIDERS.includes(patch.llm.provider)) throw new TypeError('不支持的模型供应商');
      next.llm.provider = patch.llm.provider;
    }
    if (patch.llm.reasoningEffort !== undefined) {
      if (!REASONING_EFFORTS.includes(patch.llm.reasoningEffort)) throw new TypeError('不支持的推理强度');
      next.llm.reasoningEffort = patch.llm.reasoningEffort;
    }
    if (patch.llm.models !== undefined) {
      assertKeys(patch.llm.models, PROVIDERS, '模型选择');
      if (patch.llm.models.codex !== undefined && !CODEX_MODELS.includes(patch.llm.models.codex)) {
        throw new TypeError('不支持的 ChatGPT 模型');
      }
      if (patch.llm.models.claude !== undefined && !CLAUDE_MODELS.includes(patch.llm.models.claude)) {
        throw new TypeError('不支持的 Claude 模型');
      }
      if (patch.llm.models.deepseek !== undefined && !DEEPSEEK_MODELS.includes(patch.llm.models.deepseek)) {
        throw new TypeError('不支持的 DeepSeek 模型');
      }
      for (const provider of PROVIDERS) {
        if (patch.llm.models[provider] !== undefined) next.llm.models[provider] = patch.llm.models[provider];
      }
    }
  }

  if (patch.tts !== undefined) {
    assertKeys(patch.tts, ['provider', 'fish'], '语音设置');
    if (patch.tts.provider !== undefined && patch.tts.provider !== 'fish') {
      throw new TypeError('语音固定使用 Fish，不会切换到 macOS 本地语音');
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
  return next;
}

export function toPublicSettings(settings, availability = {}, credentials = {}) {
  return {
    version: settings.version,
    llm: clone(settings.llm),
    tts: clone(settings.tts),
    recommendation: clone(settings.recommendation),
    options: {
      providers: PROVIDERS,
      codexModels: CODEX_MODELS,
      claudeModels: CLAUDE_MODELS,
      deepseekModels: DEEPSEEK_MODELS,
      fishModels: FISH_MODELS,
      reasoningEfforts: REASONING_EFFORTS,
      recommendationModes: Object.keys(RECOMMENDATION_MIXES),
    },
    availability: {
      codex: Boolean(availability.codex),
      claude: Boolean(availability.claude),
      deepseek: Boolean(availability.deepseek),
    },
    credentials: {
      deepseek: Boolean(credentials.deepseek),
      fish: Boolean(credentials.fish),
    },
  };
}

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    // 2026-07-24 起 DeepSeek 停用旧别名；已有本地设置无损迁到 V4 Flash。
    if (['deepseek-chat', 'deepseek-reasoner'].includes(parsed?.llm?.models?.deepseek)) {
      parsed.llm.models.deepseek = 'deepseek-v4-flash';
    }
    return mergeSettings(DEFAULT_SETTINGS, parsed);
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
