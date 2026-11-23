import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeVoiceAudio, transcriptText } from '../server/voice.js';

test('转写只取文字，录音太短或太长直接拒绝', () => {
  assert.equal(transcriptText({ text: '  换一首  ' }), '换一首');
  assert.equal(transcriptText({ transcript: '暂停' }), '暂停');
  assert.equal(transcriptText(null), '');
  const audio = Buffer.alloc(1000, 1).toString('base64');
  assert.equal(decodeVoiceAudio(audio).length, 1000);
  assert.throws(() => decodeVoiceAudio(''), /没听清/);
  assert.throws(() => decodeVoiceAudio('abc'), /没听清/);
});
