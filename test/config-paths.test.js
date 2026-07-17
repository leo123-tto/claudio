import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePaths } from '../server/config.js';

test('打包资源只读、个人资料和缓存写入独立用户目录', () => {
  const paths = resolvePaths({
    resourceRoot: '/Applications/Claudio.app/Contents/Resources/runtime/app',
    dataRoot: '/Users/test/Library/Application Support/com.claudio.fm',
  });

  assert.equal(paths.root, '/Applications/Claudio.app/Contents/Resources/runtime/app');
  assert.equal(paths.web, '/Applications/Claudio.app/Contents/Resources/runtime/app/web');
  assert.equal(paths.prompts, '/Applications/Claudio.app/Contents/Resources/runtime/app/prompts');
  assert.equal(paths.user, '/Users/test/Library/Application Support/com.claudio.fm/user');
  assert.equal(paths.cache, '/Users/test/Library/Application Support/com.claudio.fm/cache');
  assert.equal(paths.state, '/Users/test/Library/Application Support/com.claudio.fm/cache/state.json');
});
