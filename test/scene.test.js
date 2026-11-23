import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSceneStore, currentScene, defaultScene, sceneFromText, sceneText } from '../server/scene.js';
import { createEventStore } from '../server/events.js';
import { sceneMemory } from '../server/context.js';

// 2026-11-23 是周一。
const mon = (h, m = 0) => new Date(2026, 10, 23, h, m);
const sat = (h, m = 0) => new Date(2026, 10, 28, h, m);
const fri = (h, m = 0) => new Date(2026, 10, 27, h, m);
const sun = (h, m = 0) => new Date(2026, 10, 29, h, m);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-scene-'));

test('默认场景：工作日上班时段是工作模式，午休、下班后、周末放开', () => {
  assert.equal(defaultScene(mon(10)).key, 'work');
  assert.equal(defaultScene(mon(15)).key, 'work');
  assert.equal(defaultScene(mon(12, 30)).key, 'lunch');
  assert.equal(defaultScene(mon(8)).key, 'commute');
  assert.equal(defaultScene(mon(20)).key, 'evening');
  assert.equal(defaultScene(mon(23, 30)).key, 'late');
  assert.equal(defaultScene(sat(10)).key, 'weekend');
  assert.equal(defaultScene(sat(21)).key, 'weekend');
  const notes = { fridayEveningNote: '周五下班，通常回家', sundayEveningNote: '周日晚上，通常要出门' };
  assert.match(defaultScene(fri(19), notes).note, /回家/);
  assert.match(defaultScene(sun(20), notes).note, /出门/);
  assert.equal(defaultScene(fri(19), {}).note, '');
});

test('听众此刻在干什么才算，「适合跑步」不算在跑步', () => {
  assert.equal(sceneFromText('我在上班，推荐点不吵的'), 'work');
  assert.equal(sceneFromText('在单位呢'), 'work');
  assert.equal(sceneFromText('我在公司'), 'work');
  assert.equal(sceneFromText('我不在办公室'), '');
  assert.equal(sceneFromText('下班了'), 'relax');
  assert.equal(sceneFromText('我在跑步'), 'workout');
  assert.equal(sceneFromText('来一首节奏快一点的，适合跑步'), '');
  assert.equal(sceneFromText('随便放点'), '');
  for (const said of ['我不上班', '今天不在单位', '我工作日喜欢听轻的', '现在工作日', '我喜欢跑步', '我想跑步',
    '等我下班了再放', '来点睡前听的', '明天在路上听']) assert.equal(sceneFromText(said), '', said);
  assert.equal(sceneFromText('我在工作'), 'work');
  assert.equal(sceneFromText('正在跑步'), 'workout');
  assert.equal(sceneFromText('要睡了，放点安静的'), 'sleep');
});

test('听众说的场景压过默认规则，到点失效', () => {
  const store = createSceneStore(path.join(tmp(), 'scene.json'));
  assert.equal(currentScene(sat(10), store).key, 'weekend');
  store.noteFromText('我在上班', sat(10));
  const scene = currentScene(sat(11), store);
  assert.equal(scene.key, 'work');
  assert.match(sceneText(scene), /听众 10:00 说「我在上班」，19:00 前按这个来/);
  assert.equal(currentScene(sat(19, 5), store).key, 'weekend');
  store.noteFromText('我在上班', mon(10));
  assert.equal(currentScene(mon(12, 30), store).key, 'lunch');
  assert.equal(currentScene(mon(14), store).key, 'work');
  store.noteFromText('我还在上班', mon(12, 10));
  assert.equal(currentScene(mon(12, 40), store).key, 'work');
  store.noteFromText('下班了', mon(17));
  assert.equal(currentScene(mon(17, 30), store).key, 'relax');
  assert.equal(currentScene(mon(23), store).key, 'relax');
  assert.equal(currentScene(new Date(2026, 10, 24, 10), store).key, 'work');
});

test('行为记录带上当时的场景，同场景的喜欢和跳过会进提示词', () => {
  const file = path.join(tmp(), 'events.jsonl');
  let key = 'work';
  const store = createEventStore(file, { scene: () => key });
  store.append({ type: 'favorite', song: { title: '轻歌', artist: '甲' }, source: 'button' });
  store.append({ type: 'skip', song: { title: '吵歌', artist: '乙' }, listenedSec: 8, listenRatio: 0.03 });
  key = 'weekend';
  store.append({ type: 'favorite', song: { title: '周末歌', artist: '丙' }, source: 'button' });
  const events = store.read();
  assert.deepEqual(events.map((e) => e.scene), ['work', 'work', 'weekend']);
  const text = sceneMemory(events, { key: 'work', label: '工作模式' });
  assert.match(text, /## 这个场景（工作模式）以前/);
  assert.match(text, /喜欢或听完：轻歌 - 甲/);
  assert.match(text, /很快跳过或不喜欢：吵歌 - 乙/);
  assert.doesNotMatch(text, /周末歌/);
  assert.equal(sceneMemory(events, { key: 'late', label: '深夜' }), '');
});

test('工作日上班时段的自动节目，桥接和发现位也服从场景；周末不加', async () => {
  const { buildPromptBundle } = await import('../server/context.js');
  const none = { declared: () => null };
  const at = (now) => buildPromptBundle({ now, scene: currentScene(now, none) }).prompt;
  assert.match(at(mon(10)), /此刻是工作模式：桥接和发现位都必须符合/);
  assert.match(at(mon(10)), /## 此刻场景（选歌和口播长度按这个来）\n工作日（周一）上午 · 工作模式/);
  assert.doesNotMatch(at(sat(21)), /桥接和发现位都必须符合/);
});
