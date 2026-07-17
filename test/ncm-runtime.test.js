import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('桌面 App 内置网易云服务只开放 Claudio 需要的五个只读接口', () => {
  const { buildModuleDefs } = require('../packaging/ncm-modules.cjs');
  const defs = buildModuleDefs('/runtime/NeteaseCloudMusicApi', (file) => file);
  assert.deepEqual(defs.map((item) => item.route), [
    '/search',
    '/song/url/v1',
    '/lyric',
    '/simi/song',
    '/playlist/track/all',
  ]);
  assert.equal(defs.every((item) => item.module.startsWith('/runtime/NeteaseCloudMusicApi/module/')), true);
});
