import test from 'node:test';
import assert from 'node:assert/strict';

import { renderTasteDigest } from '../server/taste-digest.js';

test('品味摘要保留锚点，并要求继续掺新风格、流行和老歌', () => {
  const text = renderTasteDigest({
    profile: {
      artists: [
        { artist: '林俊杰', score: 80 },
        { artist: '少放的人', score: -20 },
      ],
      songs: [{ title: '江南', artist: '林俊杰', score: 100 }],
      memories: { stable: [{ value: '晚上喜欢轻一点' }] },
    },
    events: [
      { type: 'favorite', song: { title: '江南', artist: '林俊杰' } },
      { type: 'play_started', song: { title: '不该当喜欢', artist: '别人' } },
    ],
  });

  assert.match(text, /林俊杰/);
  assert.match(text, /江南/);
  assert.match(text, /新风格/);
  assert.match(text, /当下流行/);
  assert.match(text, /老歌/);
  assert.match(text, /晚上喜欢轻一点/);
  assert.doesNotMatch(text, /不该当喜欢/);
});

test('还没有明确喜欢时，摘要说明怎么记下', () => {
  assert.match(renderTasteDigest({}), /说「好听」或点爱心/);
});

test('摘要不把已取消的爱心和垫歌当成最近明确喜欢', () => {
  const text = renderTasteDigest({ events: [
    { type: 'favorite', song: { title: '已取消', artist: '甲' }, source: 'button' },
    { type: 'unfavorite', song: { title: '已取消', artist: '甲' }, source: 'button' },
    { type: 'favorite', song: { title: '垫歌', artist: '乙' }, source: 'filler' },
    { type: 'explicit_like', song: { title: '亲口喜欢', artist: '丙' }, source: 'chat' },
  ] });
  assert.doesNotMatch(text, /已取消|垫歌/);
  assert.match(text, /亲口喜欢/);
});
