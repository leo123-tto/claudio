import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyPlaybackFault } from '../web/playback-fault.js';

test('播放失败分成链接失效、没跟上、没有音源和读不出来', () => {
  assert.equal(classifyPlaybackFault({ httpStatus: 410 }).reason, 'link_expired');
  assert.equal(classifyPlaybackFault({ httpStatus: 401 }).reason, 'link_expired');
  assert.equal(classifyPlaybackFault({ mediaError: 2 }).reason, 'underrun');
  assert.equal(classifyPlaybackFault({ stalled: true }).reason, 'underrun');
  assert.equal(classifyPlaybackFault({ mediaError: 4 }).reason, 'unavailable');
  assert.equal(classifyPlaybackFault({ mediaError: 3 }).reason, 'corrupt');
  assert.equal(classifyPlaybackFault({}).reason, 'failed');
  assert.match(classifyPlaybackFault({ httpStatus: 403 }).text, /换一首/);
});
