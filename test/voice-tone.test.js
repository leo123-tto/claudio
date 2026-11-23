import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { plainText, sanitizeTags, splitLead, stripTags, textForProvider } from '../server/tts/tags.js';
import { readToneExtension, toneFor, toneKey, tonePrompt, ttsText, TIERS } from '../server/tone.js';
import { normalizeResult } from '../server/llm/normalize.js';

const at = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); const d = new Date(2026, 10, 23, h, m); return d; };

test('标记清洗：只留白名单，白名单外的连标记去掉、字留着', () => {
  assert.equal(sanitizeTags('[giggle]笑[laughing]了<slow>慢</slow>点'), '笑[laughing]了慢点');
  assert.equal(sanitizeTags('【叹气】好吧'), '[sigh]好吧');
  assert.equal(sanitizeTags('[Small  Laugh]好'), '[small laugh]好');
  assert.equal(sanitizeTags('半截<whisp'), '半截');
  assert.equal(sanitizeTags('尾巴[sig'), '尾巴');
  assert.equal(sanitizeTags('</whisper>多余'), '多余');
  assert.equal(sanitizeTags('<whisper></whisper>空的'), '空的');
});

test('成对标记：没收口的补上，不嵌套，不跨句号（下一句接着开）', () => {
  assert.equal(sanitizeTags('<whisper>没闭合'), '<whisper>没闭合</whisper>');
  assert.equal(sanitizeTags('<whisper>a<soft>b</soft>c</whisper>'), '<whisper>abc</whisper>');
  assert.equal(sanitizeTags('<whisper>慢慢听，别急。下一首</whisper>给你。'),
    '<whisper>慢慢听，别急</whisper>。<whisper>下一首</whisper>给你。');
});

test('标记数量上限，并可按档收窄', () => {
  assert.equal(sanitizeTags('[sigh]一[pause]二[sigh]三'), '[sigh]一[pause]二三');
  assert.equal(sanitizeTags('[sigh]一<whisper>二</whisper>', { maxTags: 1, maxPairs: 0 }), '[sigh]一二');
  assert.equal(sanitizeTags('[laughing]一<whisper>二</whisper>', { points: new Set(['pause']), pairs: new Set(['soft']) }), '一二');
});

test('页面和记录用的版本一个标记都不留；不认标记的语音连开头的语气提示也去掉', () => {
  assert.equal(stripTags('[sigh]今天<whisper>真</whisper>累 。'), '今天真累。');
  assert.equal(plainText('[intimate, low and breathy] <soft>晚安</soft>。'), '晚安。');
  assert.equal(textForProvider('[a, b] [sigh]你好', 'fish'), '你好');
  assert.equal(textForProvider('[a, b] [sigh]你好', 'pc5090'), '[a, b] [sigh]你好');
  assert.deepEqual(splitLead('[sigh] 你好'), { lead: '', body: '[sigh] 你好' });
});

test('大脑写的 say：去标记的给页面，原样的另存给语音', () => {
  const result = normalizeResult({ say: '[sigh]夜深了，<whisper>这首慢慢听</whisper>。', intent: 'chat', play: [] });
  assert.equal(result.say, '夜深了，这首慢慢听。');
  assert.equal(result.sayTagged, '[sigh]夜深了，<whisper>这首慢慢听</whisper>。');
});

test('语气档：按钟点分，场景说上班 / 午休 / 睡前听场景的，驾驶模式不管几点都是驾驶档', () => {
  assert.equal(toneKey({ now: at('07:30') }), 'morning');
  assert.equal(toneKey({ now: at('15:00') }), 'day');
  assert.equal(toneKey({ now: at('15:00'), scene: { key: 'work' } }), 'work');
  assert.equal(toneKey({ now: at('12:30'), scene: { key: 'lunch' } }), 'lunch');
  assert.equal(toneKey({ now: at('19:00') }), 'evening');
  assert.equal(toneKey({ now: at('21:30') }), 'night');
  assert.equal(toneKey({ now: at('23:30') }), 'late');
  assert.equal(toneKey({ now: at('02:00') }), 'late');
  assert.equal(toneKey({ now: at('23:30'), drive: true }), 'drive');
  assert.equal(toneKey({ now: at('21:30'), bounds: { morning: 300, day: 540, evening: 1080, night: 1320, late: 1380 } }), 'evening');
});

test('念的版本带这一档的导演提示；驾驶档、上班档不耳语', () => {
  const said = '<whisper>夜深了</whisper>，[sigh]这首慢慢听。';
  assert.equal(ttsText(said, toneFor('drive')), `${TIERS.drive.style} 夜深了，这首慢慢听。`);
  assert.doesNotMatch(ttsText(said, toneFor('work')), /whisper/);
  assert.match(ttsText(said, toneFor('night')), /^\[intimate[^\]]*\] <whisper>夜深了<\/whisper>，\[sigh\]这首慢慢听。$/);
  assert.match(tonePrompt(toneFor('drive')), /不写任何标记/);
  assert.match(tonePrompt(toneFor('late')), /<whisper>…<\/whisper> 耳语/);
});

test('公用版默认降一档：夜里不撩、不耳语', () => {
  const mild = toneFor('night', { mild: true });
  assert.doesNotMatch(mild.style, /sultry|whisper/);
  assert.equal(mild.pairs.has('whisper'), false);
  assert.equal(toneFor('late', { mild: true }).pairs.has('whisper'), false);
  assert.doesNotMatch(ttsText('<whisper>晚安</whisper>。', toneFor('late', { mild: true })), /whisper/);
  assert.match(toneFor('night').style, /sultry/);
  assert.deepEqual(toneFor('work', { mild: true }), toneFor('work'));
});

test('本地语气扩展：文件在才有，只追加到它写的档，上班 / 驾驶 / 清晨档永远不加', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tone-ext-'));
  const file = path.join(dir, 'tone-extension.md');
  assert.equal(readToneExtension(file), null);
  fs.writeFileSync(file, '---\nlabel: 夜里的我\ntiers: night, work, drive\n---\n本地追加的要求。\n');
  const extension = readToneExtension(file);
  assert.deepEqual(extension, { label: '夜里的我', tiers: ['night'], body: '本地追加的要求。' });
  assert.match(tonePrompt(toneFor('night'), { extension }), /本地追加的要求/);
  assert.doesNotMatch(tonePrompt(toneFor('work'), { extension }), /本地追加的要求/);
  assert.doesNotMatch(tonePrompt(toneFor('late'), { extension }), /本地追加的要求/);
  // 睡前场景 21 点前就是深夜档，但钟点还没到夜里，扩展不加
  const both = { ...extension, tiers: ['night', 'late'] };
  const sleepTone = toneFor(toneKey({ now: at('20:00'), scene: { key: 'sleep' } }));
  assert.equal(sleepTone.key, 'late');
  assert.doesNotMatch(tonePrompt(sleepTone, { extension: both, now: at('20:00') }), /本地追加的要求/);
  assert.match(tonePrompt(sleepTone, { extension: both, now: at('23:30') }), /本地追加的要求/);
  fs.writeFileSync(file, '只有正文\n');
  assert.deepEqual(readToneExtension(file).tiers, ['night', 'late']);
  fs.rmSync(dir, { recursive: true, force: true });
});
