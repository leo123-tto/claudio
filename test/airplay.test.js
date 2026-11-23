import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAirPlayMode, resolveAudioEngine } from '../web/airplay.js';

test('浏览器优先使用 WebKit 系统选择器', () => {
  for (const outputMenu of [false, true]) {
    assert.deepEqual(resolveAirPlayMode({ webkitPicker: true, outputMenu }), {
      visible: true,
      nativePicker: false,
      webkitPicker: true,
      directMedia: true,
      outputMenu: false,
    });
  }
});

test('浏览器没有 WebKit 选择器时保留设备菜单回退', () => {
  assert.deepEqual(resolveAirPlayMode({ webkitPicker: false, outputMenu: true }), {
    visible: true,
    nativePicker: false,
    webkitPicker: false,
    directMedia: true,
    outputMenu: true,
  });
  assert.deepEqual(resolveAirPlayMode({ webkitPicker: false, outputMenu: false }), {
    visible: false,
    nativePicker: false,
    webkitPicker: false,
    directMedia: false,
    outputMenu: false,
  });
});

test('未提供能力信息时隐藏 AirPlay', () => {
  assert.deepEqual(resolveAirPlayMode(), {
    visible: false,
    nativePicker: false,
    webkitPicker: false,
    directMedia: false,
    outputMenu: false,
  });
});

test('Safari 里要求走 WebAudio 时不接系统投放，音量走 GainNode', () => {
  assert.deepEqual(resolveAirPlayMode({ webkitPicker: true, webAudio: true }), {
    visible: false,
    nativePicker: false,
    webkitPicker: false,
    directMedia: false,
    outputMenu: false,
  });
});

test('音频引擎：地址参数优先，其次上次的选择，默认直连', () => {
  assert.equal(resolveAudioEngine('', ''), 'direct');
  assert.equal(resolveAudioEngine('?audio=webaudio', ''), 'webaudio');
  assert.equal(resolveAudioEngine('', 'webaudio'), 'webaudio');
  assert.equal(resolveAudioEngine('?audio=direct', 'webaudio'), 'direct');
  assert.equal(resolveAudioEngine('?audio=xx', 'bogus'), 'direct');
});
