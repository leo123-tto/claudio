import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyDirectControl } from '../server/intent.js';

test('高置信度播放器指令直接映射为动作', () => {
  assert.deepEqual(classifyDirectControl('暂停一下'), { intent: 'control', action: 'pause', actionValue: 0, reply: '好，先暂停。' });
  assert.equal(classifyDirectControl('继续播放').action, 'resume');
  assert.equal(classifyDirectControl('换一首').action, 'next');
  assert.equal(classifyDirectControl('上一首').action, 'previous');
  assert.equal(classifyDirectControl('停止播放').action, 'stop');
  assert.equal(classifyDirectControl('收藏这首').action, 'favorite');
  assert.equal(classifyDirectControl('这首不好听').action, 'dislike');
});

test('音量指令支持增减和指定百分比', () => {
  assert.equal(classifyDirectControl('声音大一点').action, 'volume_up');
  assert.equal(classifyDirectControl('音量小一点').action, 'volume_down');
  assert.deepEqual(classifyDirectControl('音量调到35%'), {
    intent: 'control', action: 'volume_set', actionValue: 35, reply: '音量调到 35%。',
  });
});

test('含控制词的普通对话不做关键词误判', () => {
  assert.equal(classifyDirectControl('你为什么刚才突然暂停了？'), null);
  assert.equal(classifyDirectControl('下一首歌你觉得会是什么风格？'), null);
  assert.equal(classifyDirectControl('我不喜欢别人催我'), null);
  assert.equal(classifyDirectControl('推荐一些适合暂停工作时听的歌'), null);
});
