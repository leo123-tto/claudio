import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOutputMenu,
  localOutputLabel,
  matchSoundControl,
  parseDnsSdBrowse,
  planOutputChange,
} from '../server/audio-route.js';

test('Bonjour 浏览结果收成音箱名，并去掉本机和重复', () => {
  const text = [
    '16:35:12.865  Add        3  14 local.               _airplay._tcp.       HomePod白',
    '16:35:12.865  Add        2   1 local.               _airplay._tcp.       HomePod白',
    '16:35:12.900  Rmv        0  14 local.               _airplay._tcp.       暂时消失',
    '16:35:15.387  Add        3  14 local.               _raop._tcp.          0009A7067382@BeoPlay A9',
    '16:35:15.387  Add        3  14 local.               _raop._tcp.          AAC43ED54502@这台电脑',
  ].join('\n');
  assert.deepEqual(parseDnsSdBrowse(text), ['HomePod白', 'BeoPlay A9', '这台电脑']);
});

test('菜单里这台 MacBook 和 AirPlay 音箱分开，本机接收器不列进去', () => {
  const menu = buildOutputMenu({
    computerName: '小明的MacBook Pro',
    devices: [
      { uid: 'BuiltInSpeakerDevice', name: 'MacBook Pro扬声器', transport: 'builtin', output: true, default: true },
      { uid: 'boom', name: 'BoomAudio', transport: 'virtual', output: true, default: false },
    ],
    airplayNames: ['HomePod白', 'BeoPlay A9', '小明的MacBook Pro', '客厅 (4)'],
  });
  assert.deepEqual(menu.items.map((item) => [item.id, item.name, item.selected, item.route]), [
    ['local', '这台 MacBook', true, 'coreaudio'],
    ['airplay:HomePod%E7%99%BD', 'HomePod白', false, 'system'],
    ['airplay:BeoPlay%20A9', 'BeoPlay A9', false, 'system'],
    ['airplay:%E5%AE%A2%E5%8E%85%20(4)', '客厅 (4)', false, 'system'],
  ]);
  assert.equal(localOutputLabel('Mac mini扬声器'), '这台 Mac mini');
});

test('已经接上的音箱只送 Claudio，没接上的仍走系统菜单', () => {
  const current = buildOutputMenu({
    devices: [
      { uid: 'built-in', name: 'MacBook Pro扬声器', transport: 'builtin', output: true, default: false },
      { uid: 'hp', name: 'HomePod白', transport: 'airplay', output: true, default: true, audioId: 42 },
    ],
    airplayNames: ['HomePod白', 'homepod黑'],
  });
  const home = current.items.find((item) => item.name === 'HomePod白');
  assert.equal(home.route, 'exclusive');
  assert.equal(home.detail, '只送 Claudio');
  assert.equal(planOutputChange(current, 'local').action, 'coreaudio');
  assert.equal(planOutputChange(current, home.id).action, 'none');
  assert.equal(planOutputChange(current, 'airplay:homepod%E9%BB%91').action, 'system');
  assert.equal(planOutputChange(current, 'missing').ok, false);

  const waiting = buildOutputMenu({
    devices: [
      { uid: 'built-in', name: 'MacBook Pro扬声器', transport: 'builtin', output: true, default: true },
      { uid: 'hp', name: 'HomePod白', transport: 'airplay', output: true, default: false, audioId: 42 },
    ],
    airplayNames: ['HomePod白'],
  });
  assert.equal(planOutputChange(waiting, 'local').action, 'none');
  assert.equal(planOutputChange(waiting, 'airplay:HomePod%E7%99%BD').action, 'exclusive');
});

test('控制中心候选按音箱名精确对应，不点 AirPlay 开关本身', () => {
  const controls = [
    { identifier: 'controlcenter-airplay', description: '开关按钮' },
    { identifier: 'sound-device-HomePod白', description: 'HomePod白', value: '0' },
    { identifier: 'sound-device-homepod黑', description: 'homepod黑', value: '1' },
  ];
  assert.equal(matchSoundControl(controls, 'HomePod白').identifier, 'sound-device-HomePod白');
  assert.equal(matchSoundControl(controls, 'controlcenter-airplay'), null);
});

test('列出已连接的蓝牙和有线输出，未连接蓝牙不从广播伪造', () => {
  const menu = buildOutputMenu({
    devices: [
      { uid: 'local', name: 'Mac mini扬声器', transport: 'builtin', output: true },
      { uid: 'buds', name: '蓝牙耳机', transport: 'bluetooth', output: true, default: true },
      { uid: 'dac', name: 'USB DAC', transport: 'usb', output: true },
      { uid: 'mic', name: '蓝牙麦克风', transport: 'bluetooth', output: false },
      { uid: 'virtual', name: '虚拟环回', transport: 'virtual', output: true },
    ],
  });
  assert.deepEqual(menu.items.map((item) => item.name), ['这台 Mac mini', '蓝牙耳机', 'USB DAC']);
  assert.equal(planOutputChange(menu, 'coreaudio:buds').action, 'none');
  assert.equal(planOutputChange(menu, 'coreaudio:dac').action, 'coreaudio');
  assert.equal(menu.items.find((item) => item.uid === 'buds').selected, true);
});

test('已经连接的AirPlay即使Bonjour短暂漏报也可选择', () => {
  const menu = buildOutputMenu({ devices: [
    { uid: 'built-in', name: 'MacBook扬声器', transport: 'builtin', output: true, default: true },
    { uid: 'a9', name: '客厅 A9', transport: 'airplay', output: true },
  ] });
  assert.equal(menu.items.find((item) => item.name === '客厅 A9').route, 'exclusive');
});
