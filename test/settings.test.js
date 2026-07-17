import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLAUDE_MODELS,
  DEEPSEEK_MODELS,
  DEFAULT_SETTINGS,
  FISH_MODELS,
  mergeSettings,
  toPublicSettings,
} from '../server/settings.js';

test('默认使用 Luna + low，并保留三个可切换供应商', () => {
  assert.equal(DEFAULT_SETTINGS.llm.provider, 'codex');
  assert.equal(DEFAULT_SETTINGS.llm.models.codex, 'gpt-5.6-luna');
  assert.equal(DEFAULT_SETTINGS.llm.reasoningEffort, 'low');
  assert.deepEqual(DEFAULT_SETTINGS.recommendation.mix, {
    familiar: 10,
    adjacent: 65,
    explore: 25,
  });
  assert.deepEqual(CLAUDE_MODELS, ['sonnet', 'opus']);
  assert.deepEqual(DEEPSEEK_MODELS, ['deepseek-v4-flash', 'deepseek-v4-pro']);
  assert.deepEqual(FISH_MODELS, ['s1', 's2-pro']);
  assert.equal(DEFAULT_SETTINGS.llm.models.deepseek, 'deepseek-v4-flash');
  assert.equal(DEFAULT_SETTINGS.tts.provider, 'fish');
});

test('设置补丁只允许已知模型、供应商和推荐模式', () => {
  const next = mergeSettings(DEFAULT_SETTINGS, {
    llm: {
      provider: 'claude',
      models: {
        codex: 'gpt-5.6-terra',
        claude: 'opus',
        deepseek: 'deepseek-v4-pro',
      },
    },
    tts: { fish: { model: 's2-pro', referenceId: 'voice-123' } },
    recommendation: { mode: 'balanced' },
  });

  assert.equal(next.llm.provider, 'claude');
  assert.equal(next.llm.models.codex, 'gpt-5.6-terra');
  assert.equal(next.llm.models.claude, 'opus');
  assert.equal(next.llm.models.deepseek, 'deepseek-v4-pro');
  assert.equal(next.tts.fish.model, 's2-pro');
  assert.equal(next.tts.fish.referenceId, 'voice-123');
  assert.equal(next.recommendation.mode, 'balanced');
  assert.deepEqual(next.recommendation.mix, {
    familiar: 30,
    adjacent: 50,
    explore: 20,
  });

  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { llm: { provider: 'unknown' } }));
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { llm: { models: { codex: 'gpt-nope' } } }));
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { llm: { models: { claude: 'haiku' } } }));
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { llm: { models: { deepseek: 'deepseek-chat' } } }));
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { tts: { provider: 'say' } }));
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { tts: { fish: { model: 'speech-1.5' } } }));
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { recommendation: { mode: 'chaos' } }));
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { secret: 'do-not-accept' }));
});

test('公开设置不包含任何密钥或环境变量值', () => {
  const publicValue = toPublicSettings(DEFAULT_SETTINGS, {
    codex: true,
    claude: false,
    deepseek: true,
  }, { deepseek: true, fish: true });

  assert.equal(publicValue.llm.provider, 'codex');
  assert.deepEqual(publicValue.tts, DEFAULT_SETTINGS.tts);
  assert.deepEqual(publicValue.availability, {
    codex: true,
    claude: false,
    deepseek: true,
  });
  assert.deepEqual(publicValue.credentials, {
    deepseek: true,
    fish: true,
  });
  assert.doesNotMatch(JSON.stringify(publicValue), /api.?key|token|secret/i);
});

test('已落盘的完整设置能够在重启时重新归一化读取', () => {
  const persisted = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  const reloaded = mergeSettings(DEFAULT_SETTINGS, persisted);
  assert.deepEqual(reloaded.recommendation.mix, { familiar: 10, adjacent: 65, explore: 25 });
  assert.equal(reloaded.llm.models.codex, 'gpt-5.6-luna');
});
