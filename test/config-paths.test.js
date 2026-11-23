import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePaths } from '../server/config.js';

test('打包资源只读、个人资料和缓存写入独立用户目录', () => {
  const paths = resolvePaths({
    resourceRoot: '/srv/claudio/app',
    dataRoot: '/data',
  });

  assert.equal(paths.root, '/srv/claudio/app');
  assert.equal(paths.web, '/srv/claudio/app/web');
  assert.equal(paths.prompts, '/srv/claudio/app/prompts');
  assert.equal(paths.user, '/data/user');
  assert.equal(paths.cache, '/data/cache');
  assert.equal(paths.state, '/data/cache/state.json');
});

