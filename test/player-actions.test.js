import test from 'node:test';
import assert from 'node:assert/strict';

import { executePlayerAction } from '../web/player-actions.js';

test('播放器动作调用对应能力', () => {
  const calls = [];
  const handlers = {
    pause: () => calls.push('pause'),
    resume: () => calls.push('resume'),
    next: () => calls.push('next'),
    previous: () => calls.push('previous'),
    stop: () => calls.push('stop'),
    favorite: () => calls.push('favorite'),
    dislike: () => calls.push('dislike'),
  };
  for (const action of ['pause', 'resume', 'next', 'previous', 'stop', 'favorite', 'dislike']) {
    assert.equal(executePlayerAction({ action, actionValue: 0 }, handlers), true);
  }
  assert.deepEqual(calls, ['pause', 'resume', 'next', 'previous', 'stop', 'favorite', 'dislike']);
});

test('音量动作会限幅到 0–100', () => {
  let volume = 95;
  const handlers = {
    getVolume: () => volume,
    setVolume: (value) => { volume = value; },
  };
  executePlayerAction({ action: 'volume_up' }, handlers);
  assert.equal(volume, 100);
  executePlayerAction({ action: 'volume_down' }, handlers);
  assert.equal(volume, 90);
  executePlayerAction({ action: 'volume_set', actionValue: -20 }, handlers);
  assert.equal(volume, 0);
  executePlayerAction({ action: 'volume_set', actionValue: 140 }, handlers);
  assert.equal(volume, 100);
});

test('未知动作不执行', () => {
  assert.equal(executePlayerAction({ action: 'dance' }, {}), false);
  assert.equal(executePlayerAction({ action: 'none' }, {}), false);
});
