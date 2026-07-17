import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAirPlayMode } from '../web/airplay.js';

test('Tauri 只在 WebKit 媒体选择器可用时显示 AirPlay，并保持直连媒体音频', () => {
  assert.deepEqual(resolveAirPlayMode({ tauri: true, webkitPicker: true }), {
    visible: true,
    nativePicker: false,
    webkitPicker: true,
    directMedia: true,
  });
  assert.deepEqual(resolveAirPlayMode({ tauri: true, webkitPicker: false }), {
    visible: false,
    nativePicker: false,
    webkitPicker: false,
    directMedia: false,
  });
});

test('Safari 使用 WebKit 系统选择器，其他浏览器明确不可用', () => {
  assert.deepEqual(resolveAirPlayMode({ tauri: false, webkitPicker: true }), {
    visible: true,
    nativePicker: false,
    webkitPicker: true,
    directMedia: true,
  });
  assert.deepEqual(resolveAirPlayMode({ tauri: false, webkitPicker: false }), {
    visible: false,
    nativePicker: false,
    webkitPicker: false,
    directMedia: false,
  });
});
