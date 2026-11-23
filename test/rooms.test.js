import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyRoomAliases, looksLikeRoomCommand, matchRoomCommand, normalizeAlias } from '../server/rooms.js';
import { createRoomStore } from '../server/room-store.js';

const items = [
  { id: 'local', name: '这台 MacBook', deviceName: '这台 MacBook', detail: '扬声器' },
  { id: 'airplay:HomePod', name: 'HomePod白', deviceName: 'HomePod白', detail: '只送 Claudio' },
];

test('房间别名只改显示名，设备名留在说明里', () => {
  assert.equal(normalizeAlias('  客厅客厅客厅超出了十二个字  '), '客厅客厅客厅超出了十二个');
  const menu = applyRoomAliases({ items }, { 'airplay:HomePod': '客厅' });
  const speaker = menu.items[1];
  assert.equal(speaker.name, '客厅');
  assert.equal(speaker.alias, '客厅');
  assert.equal(speaker.deviceName, 'HomePod白');
  assert.match(speaker.detail, /HomePod白/);
});

test('放到客厅命中别名，普通聊天不拦截', () => {
  const named = applyRoomAliases({ items }, { 'airplay:HomePod': '客厅' }).items;
  assert.equal(looksLikeRoomCommand('放到客厅'), true);
  assert.equal(looksLikeRoomCommand('在客厅放'), true);
  assert.equal(looksLikeRoomCommand('我不喜欢别人催我'), false);
  assert.equal(looksLikeRoomCommand('好听吗'), false);
  const hit = matchRoomCommand('放到客厅', named);
  assert.equal(hit.action, 'output');
  assert.equal(hit.outputId, 'airplay:HomePod');
  assert.equal(hit.reply, '好，放到客厅。');
  assert.equal(matchRoomCommand('今天天气不错', named), null);
  assert.equal(matchRoomCommand('放到', named), null);
});

test('房间名存在临时文件里，留空就删掉', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-rooms-'));
  const store = createRoomStore(path.join(dir, 'rooms.json'));
  store.set('airplay:HomePod', '客厅');
  assert.equal(store.read()['airplay:HomePod'], '客厅');
  store.set('airplay:HomePod', '   ');
  assert.equal(store.read()['airplay:HomePod'], undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});
