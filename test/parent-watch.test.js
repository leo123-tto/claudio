import test from 'node:test';
import assert from 'node:assert/strict';

import { isProcessAlive } from '../server/parent-watch.js';

test('父进程探测只把 kill(0) 成功视为存活', () => {
  assert.equal(isProcessAlive(123, () => {}), true);
  assert.equal(isProcessAlive(123, () => { throw new Error('ESRCH'); }), false);
  assert.equal(isProcessAlive(0, () => {}), false);
});
