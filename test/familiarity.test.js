// 隐性关系进度：四个阶段、只升不降、不打卡；界面拿不到任何数字。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RELATION_STAGES,
  currentRelation,
  maxStage,
  measureListening,
  relationText,
  stageByKey,
  stageFromListening,
  stageFromPlays,
} from '../server/familiarity.js';

const day = (offset) => new Date(Date.UTC(2026, 0, 1) + offset * 86400_000).toISOString();
const listen = (offset, minutes) => ({
  type: 'play_completed', at: day(offset), song: { title: 'x', artist: 'y' }, listenedSec: minutes * 60,
});

test('累计时长按 listen 类事件算，推荐和收藏不算一起待过的时间', () => {
  const metrics = measureListening([
    listen(0, 30), listen(0, 20), listen(3, 10),
    { type: 'recommendation', at: day(2) },
    { type: 'favorite', at: day(2), song: { title: 'x', artist: 'y' } },
  ]);
  assert.equal(metrics.minutes, 60);
  assert.equal(metrics.days, 2);
  assert.ok(metrics.sinceDays >= 0);
});

test('四档阈值：熟客 / 老友 / 只对你，靠时间和天数一起走', () => {
  assert.equal(stageFromListening({ minutes: 5, sinceDays: 1 }), 'first');
  assert.equal(stageFromListening({ minutes: 10 * 60, sinceDays: 2 }), 'regular');
  assert.equal(stageFromListening({ minutes: 60, sinceDays: 14 }), 'regular');
  assert.equal(stageFromListening({ minutes: 60 * 60, sinceDays: 60 }), 'oldfriend');
  assert.equal(stageFromListening({ minutes: 60 * 60, sinceDays: 30 }), 'regular');
  assert.equal(stageFromListening({ minutes: 150 * 60, sinceDays: 180, notes: 8 }), 'only');
  // 光有歌单里的记忆、没听够，也上不去
  assert.equal(stageFromListening({ minutes: 150 * 60, sinceDays: 180, notes: 3 }), 'oldfriend');
});

test('公用版按放过的歌数分档，同一套四档', () => {
  assert.equal(stageFromPlays({ plays: 2 }), 'first');
  assert.equal(stageFromPlays({ plays: 8 }), 'regular');
  assert.equal(stageFromPlays({ plays: 40 }), 'oldfriend');
  assert.equal(stageFromPlays({ plays: 200, notes: 8 }), 'only');
  assert.equal(stageFromPlays({ plays: 200, notes: 2 }), 'oldfriend');
});

test('只升不降：数据掉回去也不退档，并且落盘记住最高档', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-familiarity-'));
  const file = path.join(dir, 'familiarity.json');
  try {
    const hot = currentRelation({ events: [listen(0, 150 * 60)], notes: 8, file });
    // sinceDays 取自事件本身（1 月 1 日），够半年以上才到「只对你」；这里换个更早的起点
    const longAgo = currentRelation({
      events: [{ ...listen(0, 150 * 60), at: '2026-01-01T00:00:00.000Z' }],
      notes: 8,
      file,
    });
    assert.equal(maxStage(hot.stage, longAgo.stage), stageByKey(longAgo.stage).key === 'only' ? 'only' : hot.stage);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 再来一次空数据：不能掉档
    const again = currentRelation({ events: [], notes: 0, file });
    assert.equal(again.stage, saved.stage);
    assert.equal(again.carried, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('阶段只影响说话方式：提示词里没有等级数字，界面拿不到数字', () => {
  assert.deepEqual(RELATION_STAGES.map((item) => item.key), ['first', 'regular', 'oldfriend', 'only']);
  for (const stage of RELATION_STAGES) {
    const text = relationText({ stage: stage.key });
    assert.match(text, new RegExp(stage.label));
    assert.doesNotMatch(text, /等级|亲密度|进度|连击|连续\s*\d+\s*天/);
    assert.ok(stage.say.min <= stage.say.max);
  }
  // 未知阶段退回第一档，不炸
  assert.equal(stageByKey('nope').key, 'first');
});
