// 演示口播频率：模拟一个晚上 12 首歌，在「安静」档下 Vera 每首说不说、为什么。
// 用法：node scripts/demo-talk.mjs [chatty|normal|quiet|minimal]（默认 quiet）
import { TALK_LABELS, TALK_LEVELS, createTalkTracker, hourKeyOf, speakReasons } from '../server/talk.js';
import { TIERS, toneKey } from '../server/tone.js';

const WHY = {
  userSpoke: '回你的话', recommended: '朋友推荐', chatty: '话多档每首都说', normal: '适中档每首都说',
  first: '开头', closing: '道别', themeChanged: '换主题', tierChanged: '换时段', hourChanged: '整点',
};
const level = TALK_LEVELS.includes(process.argv[2]) ? process.argv[2] : 'quiet';

const tracker = createTalkTracker();
const clock = (hh, mm) => new Date(2026, 10, 23, hh, mm);
const moods = new Map([[8, '爵士']]); // 第 8 首前听众点了爵士，主题换了
let mood = '';
console.log(`口播频率：${TALK_LABELS[level]}（${level}）\n`);
for (let i = 0; i < 12; i += 1) {
  const now = clock(19, 44 + i * 8);
  const at = now.getTime();
  mood = moods.get(i) ?? mood;
  const tier = toneKey({ now });
  const hourKey = hourKeyOf(at);
  const why = speakReasons(level, { ...tracker.context({ at, tier, mood, hourKey }) });
  if (why.length) tracker.markSpoken({ at, tier, mood, hourKey });
  else tracker.markPlayed(at);
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  console.log(`第 ${String(i + 1).padStart(2)} 首  ${time}  ${TIERS[tier].label}${mood ? `  主题「${mood}」` : '        '}  ${why.length ? `说  ← ${why.map((k) => WHY[k]).join('、')}` : '只放歌'}`);
}
