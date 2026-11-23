import test from 'node:test';
import assert from 'node:assert/strict';

import { SAY_LEAD_S, sayCharsShown, sayVirtualTime } from '../web/say-sync.js';

test('出声前字幕只走到领先量，出声后锁在播放时间上', () => {
  assert.equal(sayVirtualTime({ playing: false, elapsed: 0.3 }), 0.3);
  assert.equal(sayVirtualTime({ playing: false, elapsed: 5 }), SAY_LEAD_S);
  assert.equal(sayVirtualTime({ playing: true, currentTime: 0 }), SAY_LEAD_S);
  assert.equal(sayVirtualTime({ playing: true, currentTime: 2 }), 2.8);
});

test('有总时长时字幕和声音一起结束，没有时按语速估算', () => {
  assert.equal(sayCharsShown(0, 1), 0);
  assert.equal(sayCharsShown(20, 0), 0);
  assert.equal(sayCharsShown(20, 0.8), 3);
  assert.equal(sayCharsShown(20, 0.8, 4), 4);
  assert.equal(sayCharsShown(20, 4, 4), 20);
  assert.equal(sayCharsShown(20, 9, 4), 20);
});
