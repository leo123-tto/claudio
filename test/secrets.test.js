import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSecretStore } from '../server/secrets.js';

test('API 密钥只落在权限 0600 的本地文件，并且公开状态只有是否配置', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-secrets-'));
  const file = path.join(dir, 'secrets.json');
  const store = createSecretStore({
    file,
    fallbacks: { deepseekApiKey: 'env-deepseek', fishApiKey: '' },
  });

  assert.equal(store.get('deepseekApiKey'), 'env-deepseek');
  assert.deepEqual(store.status(), { deepseekApiKey: true, fishApiKey: false });

  store.update({ deepseekApiKey: 'local-deepseek', fishApiKey: 'local-fish' });
  assert.equal(store.get('deepseekApiKey'), 'local-deepseek');
  assert.equal(store.get('fishApiKey'), 'local-fish');
  assert.deepEqual(store.status(), { deepseekApiKey: true, fishApiKey: true });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(store.status()), /local-|env-/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('空白输入表示保留原密钥，null 才会清除本地密钥并回退环境配置', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-secrets-'));
  const store = createSecretStore({
    file: path.join(dir, 'secrets.json'),
    fallbacks: { deepseekApiKey: 'env-deepseek', fishApiKey: '' },
  });

  store.update({ deepseekApiKey: 'local-deepseek' });
  store.update({ deepseekApiKey: '   ' });
  assert.equal(store.get('deepseekApiKey'), 'local-deepseek');
  store.update({ deepseekApiKey: null });
  assert.equal(store.get('deepseekApiKey'), 'env-deepseek');
  assert.throws(() => store.update({ unknownKey: 'nope' }));

  fs.rmSync(dir, { recursive: true, force: true });
});
