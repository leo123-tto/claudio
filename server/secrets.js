import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SECRET_NAMES = ['deepseekApiKey', 'fishApiKey'];

function cleanSecret(value, label) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`${label} 必须是字符串`);
  const clean = value.trim();
  if (!clean) return undefined;
  if (clean.length > 10000) throw new TypeError(`${label} 长度异常`);
  return clean;
}

export function createSecretStore({ file, fallbacks = {} }) {
  let local = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      local = Object.fromEntries(SECRET_NAMES
        .filter((name) => typeof parsed[name] === 'string' && parsed[name].trim())
        .map((name) => [name, parsed[name].trim()]));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[secrets] 本地密钥文件无效，忽略：', error.message);
  }

  function get(name) {
    if (!SECRET_NAMES.includes(name)) throw new TypeError(`不支持的密钥 ${name}`);
    return local[name] || String(fallbacks[name] || '').trim();
  }

  function status() {
    return {
      deepseekApiKey: Boolean(get('deepseekApiKey')),
      fishApiKey: Boolean(get('fishApiKey')),
    };
  }

  function update(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TypeError('密钥设置必须是对象');
    }
    for (const name of Object.keys(patch)) {
      if (!SECRET_NAMES.includes(name)) throw new TypeError(`不支持的密钥 ${name}`);
      const clean = cleanSecret(patch[name], name);
      if (clean === null) delete local[name];
      else if (clean !== undefined) local[name] = clean;
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(local, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
    return status();
  }

  return { get, status, update };
}

const store = createSecretStore({
  file: path.join(config.paths.cache, 'secrets.json'),
  fallbacks: {
    deepseekApiKey: config.llm.deepseek.apiKey,
    fishApiKey: config.tts.fish.apiKey,
  },
});

export function getSecret(name) {
  return store.get(name);
}

export function updateSecrets(patch) {
  return store.update(patch);
}

export function credentialStatus() {
  const status = store.status();
  return {
    deepseek: status.deepseekApiKey,
    fish: status.fishApiKey,
  };
}
