import test from 'node:test';
import assert from 'node:assert/strict';
import { correctSay } from '../server/episode-coherence.js';
import { episodeCandidates } from '../server/episode-candidates.js';
const a = { title: '甲歌', artist: '甲乐队' };
const b = { title: '乙歌', artist: '乙乐队' };
const c = { title: '丙歌', artist: '丙乐队' };
test('歌名和顺序相同则原样保留', () => {
  const say = '休息一下。先听甲乐队的《甲歌》，再听乙乐队的《乙歌》。';
  assert.equal(correctSay(say, [a,b,c], [a,b]), say);
});
test('候选失败保留中性首句并按实际歌重写', () => {
  assert.equal(correctSay('休息一下。先听甲乐队的《甲歌》。', [a,b], [b]), '休息一下。先听乙乐队的《乙歌》。');
});
test('可播候选重挑或顺序改变时重写', () => {
  assert.equal(correctSay('先听《甲歌》，再听《乙歌》。', [a,b,c], [b,c]), '先听《乙歌》，再听《丙歌》。');
  assert.equal(correctSay('先听《甲歌》，再听《乙歌》。', [a,b], [b,a]), '先听《乙歌》，再听《甲歌》。');
});
test('指代旧歌的句子不能留作前缀', () => {
  for (const word of ['它', '这首', '那首', '这支', '这段旋律', '这把嗓子']) {
    assert.equal(correctSay(`歇一会儿。${word}很温柔。听《甲歌》。`, [a,b], [b]), '歇一会儿。听《乙歌》。');
  }
});
test('晨间说词只点名最终第一首时原样保留', () => {
  const songs = [{title:'Demons',artist:'Imagine Dragons'}, {title:'APT.',artist:'ROSÉ'}];
  const say = '早上好呀……先给你放一首带电影感的《Demons》，让脑子慢慢醒过来，再接一首当下很流行、节奏有点上头的歌……';
  assert.equal(correctSay(say, songs, songs), say);
});
test('夜间说词没有点名歌曲时原样保留', () => {
  const say = '这么晚了还醒着……我挑了两首给你，一首是……另一首是风格挺不一样的……';
  assert.equal(correctSay(say, [a,b], [a,b]), say);
});
test('雨夜说词只点名最终第一首的歌手时原样保留', () => {
  const songs = [{title:'晚安',artist:'陈俞瑾'}, b];
  const say = '雨夜适合把声音放低一点。先接一首从你偏爱的独立氛围延过来的陈俞瑾……';
  assert.equal(correctSay(say, songs, songs), say);
});
test('只点名最终后续歌曲也是有序子序列', () => {
  const say = '稍后听《乙歌》。';
  assert.equal(correctSay(say, [a,b,c], [a,b,c]), say);
});
test('没有最终歌曲且没有点名歌曲时原样保留', () => {
  const say = '先歇一会儿，喝口水。';
  assert.equal(correctSay(say, [a,b], []), say);
});
test('短裸歌名与单字歌手不会误判普通词', () => {
  const rain = {title:'雨',artist:'甲'};
  const say = '雨夜适合把声音放低一点，先把盔甲卸下来。';
  assert.equal(correctSay(say, [rain,a,b], [a,b]), say);
});
test('短歌名用书名号点名后失败会重写', () => {
  const rain = {title:'雨',artist:'甲'};
  assert.equal(correctSay('休息一下。先听《雨》。', [rain,b], [b]), '休息一下。先听《乙歌》。');
});
test('四字裸歌名点名后失败会重写', () => {
  const old = {title:'四字歌名',artist:'甲'};
  assert.equal(correctSay('休息一下。先听四字歌名。', [old,b], [b]), '休息一下。先听《乙歌》。');
});
test('只点名失败候选的歌手也会重写', () => {
  assert.equal(correctSay('休息一下。先听甲乐队。', [a,b], [b]), '休息一下。先听乙乐队。');
});
test('重写时短裸歌名不截断中性首句', () => {
  const rain = {title:'雨',artist:'甲'};
  assert.equal(correctSay('雨夜适合把声音放低一点。先听《甲歌》。', [rain,a,b], [b]), '雨夜适合把声音放低一点。先听《乙歌》。');
});
test('明确安静钢琴要求的兜底必须同时有乐器与情绪证据', () => {
  const pool = [{...a,genre:'流行'}, {...b,genre:'piano',tags:['soft']}, {...c,genre:'piano'}];
  const result = episodeCandidates({intent:'recommend',play:[]},pool,'来点安静的钢琴');
  assert.deepEqual(result.map((s) => s.title), ['乙歌']);
});

test('重写口播时名字要念得顺：多位歌手只念第一位，歌名去掉末尾版本括号', () => {
  const x = { title: '默 (Live)', artist: '李荣浩 / 周杰伦' };
  const y = { title: 'DANCING WITH THE SUNSHINE(ENGLISH VERSION)', artist: 'Cathi Linn' };
  const old = { title: '旧歌', artist: '旧人' };
  assert.equal(correctSay('夜里慢一点。先听旧人的《旧歌》。', [old, x, y], [x, y]),
    '夜里慢一点。先听李荣浩的《默》。');
});

test('选歌落空时保留大脑原话，只把歌名换成实际播的；没歌可换的那句删掉', () => {
  const p1 = { title: '暗里着迷', artist: '刘德华' };
  const p2 = { title: 'Lonely', artist: 'Nana' };
  const s1 = { title: '恋人', artist: '李荣浩' };
  const say = '夜深了，风停了。先放刘德华的《暗里着迷》，那种藏在心里的喜欢，最适合这个点。它会慢慢把你接住。再听Nana的《Lonely》。';
  assert.equal(correctSay(say, [p1, p2], [s1]),
    '夜深了，风停了。先放李荣浩的《恋人》，那种藏在心里的喜欢，最适合这个点。它会慢慢把你接住。');
});

test('几首候选是同一位歌手时，光提歌手名不算点了备选，说的两首都在放就原样保留', () => {
  const planned = [{ title: '沙龙', artist: '陈奕迅' }, { title: '十面埋伏', artist: '陈奕迅' }, { title: '富士山下', artist: '陈奕迅' }];
  const say = '陈奕迅的歌今天挑两首叙事感的，先听《沙龙》，再听《十面埋伏》。';
  assert.equal(correctSay(say, planned, planned.slice(0, 2)), say);
  // 说到的第二首放不了、换成备选：照旧按歌名换掉
  assert.equal(correctSay(say, planned, [planned[0], planned[2]]), '陈奕迅的歌今天挑两首叙事感的，先听《沙龙》，再听《富士山下》。');
});
