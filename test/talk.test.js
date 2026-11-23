// 口播频率（server/talk.js）：听懂一句话、今天的临时档、四档的开口规则、上一次开口的记录。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TALK_LEVELS, talkFromText, effectiveTalk, nextMidnight, applyTalk, talkAck,
  shouldSpeak, speakReasons, createTalkTracker, createTodayFile, hourKeyOf,
} from '../server/talk.js';

test('听懂：四档的常见说法；今天 / 今晚 / 这会儿只管今天', () => {
  assert.deepEqual(talkFromText('少说点'), { level: 'quiet', today: false });
  assert.deepEqual(talkFromText('安静点。'), { level: 'quiet', today: false });
  assert.deepEqual(talkFromText('话少点吧'), { level: 'quiet', today: false });
  assert.deepEqual(talkFromText('你安静一点'), { level: 'quiet', today: false });
  assert.deepEqual(talkFromText('多聊聊'), { level: 'chatty', today: false });
  assert.deepEqual(talkFromText('多说点吧'), { level: 'chatty', today: false });
  assert.deepEqual(talkFromText('今天别打扰我'), { level: 'minimal', today: true });
  assert.deepEqual(talkFromText('别说话了'), { level: 'minimal', today: false });
  assert.deepEqual(talkFromText('只放歌'), { level: 'minimal', today: false });
  assert.deepEqual(talkFromText('今晚只放歌就行'), { level: 'minimal', today: true });
  assert.deepEqual(talkFromText('这会儿少说点'), { level: 'quiet', today: true });
  assert.deepEqual(talkFromText('正常说话'), { level: 'normal', today: false });
  assert.deepEqual(talkFromText('恢复正常'), { level: 'normal', today: false });
  assert.deepEqual(talkFromText('今天恢复正常吧'), { level: 'normal', today: true });
});

test('听懂：否定、聊别的事、整句里只是带到这几个字，都不算', () => {
  for (const text of [
    '只放歌手陈奕迅的歌', '只放歌剧', '来点安静的歌', '放一首安静点的歌', '不用少说点', '别安静', '不要少说点话',
    '多说点这首歌的背景', '多聊聊这首歌', '他叫我别说话了', '我今天不想说话', '网络恢复正常了', '今天天气不错',
    '别打扰我朋友', '安静的夜晚', '少说点废话的歌', '这首歌正常说话的节奏', '', '   ',
    '今天少说点歌词比较多的那种', '请把音量调到恢复正常之后的位置',
  ]) assert.equal(talkFromText(text), null, text);
});

test('今天的档到本地午夜为止；再说长期档会清掉今天的', () => {
  const at = new Date(2026, 10, 23, 20, 30).getTime();
  const midnight = new Date(2026, 10, 24).getTime();
  assert.equal(nextMidnight(at), midnight);
  let stored = { level: 'normal' };
  stored = applyTalk(stored, { level: 'minimal', today: true }, { now: at });
  assert.deepEqual(stored, { level: 'normal', today: { level: 'minimal', until: midnight } });
  assert.equal(effectiveTalk(stored, at), 'minimal');
  assert.equal(effectiveTalk(stored, midnight - 1), 'minimal');
  assert.equal(effectiveTalk(stored, midnight), 'normal');
  stored = applyTalk(stored, { level: 'quiet', today: false }, { now: at });
  assert.deepEqual(stored, { level: 'quiet' });
  assert.equal(effectiveTalk(stored, at), 'quiet');
  assert.equal(effectiveTalk(null, at), 'normal');
  assert.equal(effectiveTalk({ level: 'bogus' }, at), 'normal');
  // 公用版按北京时间：不管容器在哪个时区，午夜都是北京的 24 点
  const bj = Date.UTC(2026, 10, 23, 13, 0); // 北京 21:00
  assert.equal(nextMidnight(bj, 8 * 3600_000), Date.UTC(2026, 10, 23, 16, 0));
  assert.notEqual(hourKeyOf(bj, 8 * 3600_000), hourKeyOf(bj + 3600_000, 8 * 3600_000));
  assert.equal(hourKeyOf(bj, 8 * 3600_000), hourKeyOf(bj + 59 * 60_000, 8 * 3600_000));
  assert.match(talkAck({ level: 'quiet', today: true }), /今天/);
  assert.ok(TALK_LEVELS.every((level) => talkAck({ level, today: false })));
});

test('四档：当面说话和朋友的推荐永远开口；话多 / 适中每段都说；安静只在时刻；几乎不说只有开头和道别', () => {
  const none = {};
  for (const level of TALK_LEVELS) {
    assert.equal(shouldSpeak(level, { userSpoke: true }), true, level);
    assert.equal(shouldSpeak(level, { recommended: true }), true, level);
  }
  assert.equal(shouldSpeak('chatty', none), true);
  assert.equal(shouldSpeak('normal', none), true);
  assert.equal(shouldSpeak('quiet', none), false);
  assert.equal(shouldSpeak('minimal', none), false);
  for (const key of ['first', 'closing', 'themeChanged', 'tierChanged', 'hourChanged']) {
    assert.equal(shouldSpeak('quiet', { [key]: true }), true, `quiet ${key}`);
    assert.equal(shouldSpeak('minimal', { [key]: true }), key === 'first' || key === 'closing', `minimal ${key}`);
  }
  assert.deepEqual(speakReasons('quiet', { first: true, hourChanged: true }), ['first', 'hourChanged']);
  assert.equal(shouldSpeak('没有这一档', none), true); // 认不出的当适中
});

test('上一次开口：30 分钟没在放歌才算开头（只是没开口不算）；主题 / 时段 / 整点各自变化；道别只算一次', () => {
  const t = createTalkTracker();
  const base = Date.UTC(2026, 10, 23, 11, 0); // 北京 19:00
  const off = 8 * 3600_000;
  const ctx = (min, extra = {}) => t.context({ at: base + min * 60_000, tier: 'evening', mood: '', hourKey: hourKeyOf(base + min * 60_000, off), ...extra });
  assert.equal(ctx(0).first, true);
  t.markSpoken({ at: base, tier: 'evening', mood: '', hourKey: hourKeyOf(base, off) });
  let c = ctx(10);
  assert.deepEqual([c.first, c.themeChanged, c.tierChanged, c.hourChanged], [false, false, false, false]);
  assert.equal(ctx(10, { mood: '爵士' }).themeChanged, true);
  assert.equal(ctx(10, { tier: 'night' }).tierChanged, true);
  c = ctx(61);
  assert.equal(c.hourChanged, true);
  assert.equal(c.first, true); // 超过 30 分钟没放过歌
  t.markPlayed(base + 50 * 60_000); // 一直在放歌，只是没开口：不算新一轮开头
  c = ctx(61);
  assert.deepEqual([c.first, c.hourChanged], [false, true]);
  const closing = t.context({ at: base + 60_000, tier: 'evening', hourKey: hourKeyOf(base, off), closing: true });
  assert.equal(closing.closing, true);
  t.markSpoken({ at: base + 60_000, tier: 'evening', hourKey: hourKeyOf(base, off), closing: true });
  assert.equal(t.context({ at: base + 120_000, tier: 'evening', hourKey: hourKeyOf(base, off), closing: true }).closing, false);
});

test('今天的临时档文件：读不到、过期、坏文件都当没有', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-'));
  const file = path.join(dir, 'sub', 'talk.json');
  let now = 1000;
  const store = createTodayFile(file, { now: () => now });
  assert.equal(store.read(), null);
  store.write({ level: 'minimal', until: 5000 });
  assert.deepEqual(store.read(), { level: 'minimal', until: 5000 });
  now = 5000;
  assert.equal(store.read(), null);
  fs.writeFileSync(file, '{坏');
  assert.equal(store.read(), null);
  store.write(null);
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
