import test from 'node:test';
import assert from 'node:assert/strict';
import { openBluetoothSettings, selectSystemDevice } from '../server/audio-route-mac.js';

test('AirPlay把设备名作为第一个脚本参数，光标始终恢复', async () => {
  let restored = false;
  const result = await selectSystemDevice('客厅 A9', {
    helperJson: async (args) => args[0] === 'icon' ? { x: 99, y: 16 } : { x: 12, y: 13 },
    clickMenuBar: async () => {},
    restoreCursor: async (point) => { restored = point.x === 12 && point.y === 13; },
    run: async (command, args) => ({ code: command === '/usr/bin/osascript' && args.length === 2 && args[1] === '客厅 A9' ? 0 : 1 }),
  });
  assert.equal(result.ok, true);
  assert.equal(restored, true);
});

test('蓝牙入口只打开系统设置，系统打开失败会明确返回失败', async () => {
  const opened = await openBluetoothSettings({ run: async (command, args) => ({
    code: command === '/usr/bin/open' && args[0] === 'x-apple.systempreferences:com.apple.BluetoothSettings' ? 0 : 1,
  }) });
  assert.equal(opened.ok, true);
  assert.equal((await openBluetoothSettings({ run: async () => ({ code: 1 }) })).ok, false);
});
