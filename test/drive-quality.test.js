// 驾驶模式（口播一句话、状态过期）和页面标的真实音质（取数 + 显示）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDriveState, oneSentence } from '../server/drive.js';
import { makeQuality, ncmQuality, withFlacHeader, flacInfo } from '../server/audio-quality.js';
import { qualityLabel } from '../web/ui.js';
import { artistOf, speechRecognitionCtor } from '../web/drive.js';

// 造一个 FLAC 文件头：fLaC + 块头 + STREAMINFO（采样率 20 位、声道 3 位、位深 5 位）
function flacHead(sampleRate, bits, channels = 2) {
  const buf = Buffer.alloc(64);
  buf.write('fLaC', 0, 'latin1');
  buf[4] = 0x80; buf[7] = 34;
  const s = 8;
  buf[s + 10] = (sampleRate >> 12) & 0xff;
  buf[s + 11] = (sampleRate >> 4) & 0xff;
  buf[s + 12] = ((sampleRate & 0x0f) << 4) | (((channels - 1) & 0x07) << 1) | (((bits - 1) >> 4) & 0x01);
  buf[s + 13] = ((bits - 1) & 0x0f) << 4;
  return buf;
}

test('口播一句话：留第一句；一句太长在逗号处截；空的不动', () => {
  assert.equal(oneSentence('来首提神的。路上注意安全。'), '来首提神的。');
  assert.equal(oneSentence('好嘞！'), '好嘞！');
  assert.equal(oneSentence(''), '');
  const long = '这首是九十年代末的老歌，那会儿大街小巷都在放，副歌一出来整条街都会跟着唱起来的那种';
  const cut = oneSentence(long);
  assert.ok(cut.length <= 31, cut);
  assert.ok(long.startsWith(cut.slice(0, -1)));
  assert.equal(cut.at(-1), '。');
});

test('驾驶状态：开了过 ttl 自己失效；回报开关有没有变', () => {
  let t = 0;
  const drive = createDriveState({ ttlMs: 1000, now: () => t });
  assert.equal(drive.on(), false);
  assert.equal(drive.set(true), true);
  assert.equal(drive.set(true), false); // 续期，不算变
  t = 900;
  assert.equal(drive.on(), true);
  t = 2000;
  assert.equal(drive.on(), false);
  assert.equal(drive.set(false), false);
  drive.set(true);
  assert.equal(drive.set(false), true);
});

test('音质取数：网易云按 type / br / sr，拿不到的字段不带，乱值丢掉', () => {
  assert.deepEqual(ncmQuality({ type: 'MP3', br: 320000, sr: 44100 }), { format: 'mp3', bitrate: 320000, sampleRate: 44100 });
  assert.deepEqual(ncmQuality({ encodeType: 'flac', br: 0 }), { format: 'flac' });
  assert.equal(ncmQuality({ type: null, br: 0 }), null);
  assert.deepEqual(makeQuality({ format: 'exe', bitrate: 5, sampleRate: 1e9, bits: 3 }), null);
  assert.deepEqual(flacInfo(flacHead(96000, 24)), { sampleRate: 96000, bits: 24 });
});

test('音质取数：FLAC 读文件头补位深；读不到（拒绝 / 不是 FLAC / 超时）原样返回，不猜', async () => {
  const reply = (buf, status = 206) => new Response(buf, { status });
  const q = { format: 'flac', bitrate: 2300000 };
  const seen = [];
  const got = await withFlacHeader(q, 'https://x/1.flac', { fetchFn: async (url, init) => { seen.push(init.headers.Range); return reply(flacHead(96000, 24)); } });
  assert.deepEqual(got, { format: 'flac', bitrate: 2300000, sampleRate: 96000, bits: 24 });
  assert.deepEqual(seen, ['bytes=0-63']);
  assert.deepEqual(await withFlacHeader(q, 'https://x/1.flac', { fetchFn: async () => reply(Buffer.alloc(64), 403) }), q);
  assert.deepEqual(await withFlacHeader(q, 'https://x/1.flac', { fetchFn: async () => reply(Buffer.from('ID3 not flac')) }), q);
  assert.deepEqual(await withFlacHeader(q, 'https://x/1.flac', { timeout: 20, fetchFn: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) }), q);
  // MP3 不去读
  let called = false;
  const mp3 = { format: 'mp3', bitrate: 320000 };
  assert.equal(await withFlacHeader(mp3, 'https://x/1.mp3', { fetchFn: async () => { called = true; } }), mp3);
  assert.equal(called, false);
});

test('音质标签：有什么写什么，缺的不补', () => {
  assert.equal(qualityLabel({ format: 'flac', bitrate: 2300000, sampleRate: 96000, bits: 24 }).text, 'FLAC 24bit/96kHz');
  assert.equal(qualityLabel({ format: 'flac', sampleRate: 44100 }).text, 'FLAC 44.1kHz');
  assert.equal(qualityLabel({ format: 'flac', bitrate: 900000 }).text, 'FLAC 900k');
  assert.equal(qualityLabel({ format: 'flac' }).text, 'FLAC');
  assert.equal(qualityLabel({ format: 'mp3', bitrate: 320000, sampleRate: 44100 }).text, 'MP3 320k');
  assert.equal(qualityLabel({ format: 'mp3', bitrate: 128010 }).text, 'MP3 128k');
  assert.equal(qualityLabel({ bitrate: 192000 }).text, '192k');
  assert.equal(qualityLabel(null).text, '');
  assert.equal(qualityLabel({}).text, '');
  const full = qualityLabel({ format: 'flac', bitrate: 2304000, sampleRate: 96000, bits: 24 });
  assert.equal(full.lossless, true);
  assert.equal(full.detail, 'FLAC · 24 bit · 96 kHz · 2304 kbps');
  assert.equal(qualityLabel({ format: 'mp3', bitrate: 320000 }).lossless, false);
});

test('驾驶模式界面小件：歌手只取第一段；没有语音识别时回 null', () => {
  assert.equal(artistOf('陈粒 · 2016 · 民谣 / 国语'), '陈粒');
  assert.equal(artistOf('周杰伦 / 费玉清'), '周杰伦 / 费玉清');
  assert.equal(artistOf(''), '');
  assert.equal(speechRecognitionCtor({}), null);
  const Fake = function Fake() {};
  assert.equal(speechRecognitionCtor({ webkitSpeechRecognition: Fake }), Fake);
});
