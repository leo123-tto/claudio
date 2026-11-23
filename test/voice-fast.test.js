import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribeAudio } from '../server/voice.js';

const bytes = Buffer.alloc(2000, 1);
const json = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });

test('短句先走 Mac mini，出字了就不碰 5090', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(String(url)); return json({ text: '放一首晴天' }); };
  const text = await transcribeAudio(bytes, 'audio/webm', { fetchImpl, base: 'http://gpu:8895', fastBase: 'http://mini:8899' });
  assert.equal(text, '放一首晴天');
  assert.deepEqual(calls, ['http://mini:8899/v1/audio/transcriptions']);
});

test('Mac mini 不通就退回 5090 网关', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('http://mini')) throw new Error('down');
    if (String(url).endsWith('/health')) return json({ engine: 'ready' });
    return json({ text: '暂停' });
  };
  const text = await transcribeAudio(bytes, 'audio/webm', { fetchImpl, base: 'http://gpu:8895', fastBase: 'http://mini:8899' });
  assert.equal(text, '暂停');
  assert.deepEqual(calls, ['http://mini:8899/v1/audio/transcriptions', 'http://gpu:8895/health', 'http://gpu:8895/v1/audio/transcriptions']);
});

test('Mac mini 连得上但没听出字（静音只回标点）就说没听清，不碰 5090', async () => {
  for (const reply of [json({ text: '.' }), json({ text: '' }), json({ error: 'bad audio' }, 400)]) {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(String(url)); return reply; };
    await assert.rejects(transcribeAudio(bytes, 'audio/mp4', { fetchImpl, base: 'http://gpu:8895', fastBase: 'http://mini:8899' }), /没听清/);
    assert.deepEqual(calls, ['http://mini:8899/v1/audio/transcriptions']);
  }
});

test('Mac mini 服务出错（5xx）才退回 5090', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('http://mini')) return json({}, 503);
    if (String(url).endsWith('/health')) return json({ engine: 'ready' });
    return json({ text: '下一首' });
  };
  assert.equal(await transcribeAudio(bytes, 'audio/webm', { fetchImpl, base: 'http://gpu:8895', fastBase: 'http://mini:8899' }), '下一首');
  assert.equal(calls.length, 3);
});
