import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLAUDE_MODELS,
  DEEPSEEK_MODELS,
  AUDIO_QUALITIES,
  DEFAULT_SETTINGS,
  FISH_MODELS,
  PROVIDERS,
  TTS_PROVIDERS,
  mergeSettings,
  migrateLegacySettings,
  toPublicSettings,
} from '../server/settings.js';

test('默认用家里盒子，只保留本地 / Claude / DeepSeek 三家', () => {
  assert.deepEqual(PROVIDERS, ['local', 'claude', 'deepseek']);
  assert.equal(DEFAULT_SETTINGS.llm.provider, 'local');
  assert.deepEqual(Object.keys(DEFAULT_SETTINGS.llm.models), ['local', 'claude', 'deepseek']);
  assert.deepEqual(DEFAULT_SETTINGS.recommendation.mix, {
    familiar: 10,
    adjacent: 65,
    explore: 25,
  });
  assert.deepEqual(CLAUDE_MODELS, ['sonnet', 'opus']);
  assert.deepEqual(DEEPSEEK_MODELS, ['deepseek-flash', 'deepseek-v4-pro']);
  assert.deepEqual(FISH_MODELS, ['s1', 's2-pro']);
  assert.equal(DEFAULT_SETTINGS.llm.models.deepseek, 'deepseek-flash');
  assert.equal(DEFAULT_SETTINGS.llm.models.local, 'DeepSeek-V4.1-Flash-1017');
  // 本机 .env 配了 LOCAL_LLM_BASE_URL 就以它为默认，没配是 127.0.0.1
  assert.equal(DEFAULT_SETTINGS.llm.local.baseUrl, (process.env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:8001/v1').replace(/\/+$/, ''));
  assert.equal(DEFAULT_SETTINGS.llm.reasoningEffort, undefined);
  assert.deepEqual(TTS_PROVIDERS, ['pc5090', 'fish']);
  assert.equal(DEFAULT_SETTINGS.tts.provider, 'pc5090');
  assert.deepEqual(DEFAULT_SETTINGS.tts.pc5090, {
    baseUrl: 'http://127.0.0.1:18081',
    voice: 'claudio',
  });
  assert.equal(DEFAULT_SETTINGS.tts.local, undefined);
  assert.ok(AUDIO_QUALITIES.includes(DEFAULT_SETTINGS.playback.quality));
});

test('设置补丁只允许已知模型、供应商和推荐模式', () => {
  const next = mergeSettings(DEFAULT_SETTINGS, {
    llm: {
      provider: 'claude',
      models: {
        claude: 'opus',
        deepseek: 'deepseek-v4-pro',
      },
    },
    tts: { fish: { model: 's2-pro', referenceId: 'voice-123' } },
    recommendation: { mode: 'balanced' },
  });

  assert.equal(next.llm.provider, 'claude');
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
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { llm: { models: { claude: 'haiku' } } }));
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { llm: { models: { deepseek: 'deepseek-v4-flash' } } }).llm.models.deepseek, 'deepseek-flash');
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { llm: { models: { deepseek: 'deepseek-chat' } } }).llm.models.deepseek, 'deepseek-flash');
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { llm: { models: { deepseek: 'deepseek-nope' } } }));
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { llm: { provider: 'deepseek' } }).llm.provider, 'deepseek');
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { llm: { provider: 'local' } }).llm.provider, 'local');
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { tts: { provider: 'fish' } }).tts.provider, 'fish');
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { tts: { provider: 'say' } }));
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { tts: { fish: { model: 'speech-1.5' } } }));
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { recommendation: { mode: 'chaos' } }));
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { playback: { quality: 'lossless' } }).playback.quality, 'lossless');
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { playback: { quality: 'hires' } }).playback.quality, 'hires');
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { playback: { quality: 'jymaster' } }));
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { playback: { quality: 'sky' } }));
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { secret: 'do-not-accept' }));
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { llm: { models: { local: 'bad name' } } }));
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { llm: { models: { local: '' } } }));
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { llm: { local: { baseUrl: 'ftp://box.local' } } }));
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { tts: { pc5090: { voice: 'x'.repeat(101) } } }));
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { tts: { pc5090: { baseUrl: 'ftp://pc.local' } } }));
});

test('公开设置不包含任何密钥或环境变量值', () => {
  const publicValue = toPublicSettings(DEFAULT_SETTINGS, {
    local: true,
    claude: false,
    deepseek: true,
    codex: true,
  }, { deepseek: true, fish: true });

  assert.equal(publicValue.llm.provider, 'local');
  assert.deepEqual(publicValue.playback, DEFAULT_SETTINGS.playback);
  assert.deepEqual(publicValue.options.providers, ['local', 'claude', 'deepseek']);
  assert.deepEqual(publicValue.options.audioQualities, ['standard', 'higher', 'exhigh', 'lossless', 'hires']);
  assert.deepEqual(publicValue.tts, DEFAULT_SETTINGS.tts);
  assert.deepEqual(publicValue.availability, { local: true, claude: false, deepseek: true });
  assert.deepEqual(publicValue.credentials, {
    deepseek: true,
    fish: true,
    local: false,
  });
  assert.equal(publicValue.auth, undefined);
  assert.doesNotMatch(JSON.stringify(publicValue), /api.?key|accessToken|refreshToken|secret/i);
});

test('已落盘的完整设置能够在重启时重新归一化读取', () => {
  const persisted = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  const reloaded = mergeSettings(DEFAULT_SETTINGS, persisted);
  assert.deepEqual(reloaded.recommendation.mix, { familiar: 10, adjacent: 65, explore: 25 });
  assert.equal(reloaded.llm.models.local, 'DeepSeek-V4.1-Flash-1017');
  assert.equal(reloaded.tts.pc5090.voice, 'claudio');
});

test('旧 settings.json 里已下线的大脑迁到本地，其余字段保留', () => {
  const legacy = {
    version: 1,
    llm: {
      provider: 'ornith',
      models: {
        codex: 'gpt-5.6-luna',
        claude: 'opus',
        deepseek: 'deepseek-v4-flash',
        grok: 'grok-4.6',
        local: 'qwen3.8-flash-next-unc',
        ornith: 'ornith-1.5',
        agent2api: 'Qwen3.8-Flash',
      },
      local: { baseUrl: 'http://192.0.2.10:8001/v1' },
      ornith: { baseUrl: 'http://192.0.2.20:9000/v1' },
      agent2api: { baseUrl: 'http://192.0.2.20:9000/v1' },
      reasoningEffort: 'low',
    },
    tts: {
      provider: 'fish',
      fish: { model: 's1', referenceId: 'voice-old' },
    },
    recommendation: { mode: 'discovery' },
  };
  const reloaded = mergeSettings(DEFAULT_SETTINGS, legacy);
  assert.equal(reloaded.llm.provider, 'local');
  assert.deepEqual(reloaded.llm.models, {
    local: 'DeepSeek-V4.1-Flash-1017',
    claude: 'opus',
    deepseek: 'deepseek-flash',
  });
  assert.equal(reloaded.llm.ornith, undefined);
  assert.equal(reloaded.llm.reasoningEffort, undefined);
  assert.equal(reloaded.tts.fish.referenceId, 'voice-old');
  assert.equal(reloaded.playback.quality, DEFAULT_SETTINGS.playback.quality);
  for (const provider of ['codex', 'grok', 'agent2api']) {
    assert.equal(migrateLegacySettings({ llm: { provider } }).llm.provider, 'local');
  }
});

test('旧盒子语音（local）迁到 5090，旧字段丢掉', () => {
  const reloaded = mergeSettings(DEFAULT_SETTINGS, {
    tts: {
      provider: 'local',
      fish: { model: 's1', referenceId: 'voice-old' },
      local: { baseUrl: 'http://192.0.2.20:30040/v1', voice: 'claudio', instruct: '', stream: true },
    },
  });
  assert.equal(reloaded.tts.provider, 'pc5090');
  assert.equal(reloaded.tts.local, undefined);
  assert.equal(reloaded.tts.fish.referenceId, 'voice-old');
  assert.equal(reloaded.tts.pc5090.baseUrl, 'http://127.0.0.1:18081');
});

test('本地模型和 5090 语音地址去尾斜杠，已取消的流式开关读进来时丢掉', () => {
  const next = mergeSettings(DEFAULT_SETTINGS, {
    llm: {
      provider: 'local',
      models: { local: 'DeepSeek-V4.1-Flash-1017' },
      local: { baseUrl: 'http://192.0.2.10:8001/v1/' },
    },
    tts: {
      provider: 'pc5090',
      pc5090: { baseUrl: 'http://pc.example:8080///', voice: 'claudio', stream: false },
    },
  });
  assert.equal(next.llm.local.baseUrl, 'http://192.0.2.10:8001/v1');
  assert.equal(next.tts.provider, 'pc5090');
  assert.equal(next.tts.pc5090.baseUrl, 'http://pc.example:8080');
  assert.equal(next.tts.pc5090.stream, undefined);
});
