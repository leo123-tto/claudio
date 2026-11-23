import test from 'node:test';
import assert from 'node:assert/strict';

import { playInRoom } from '../server/headless-play.js';
import {
  chooseOutput,
  cleanMusicQuery,
  createAckWaiter,
  djUserInput,
  episodeTrack,
  lyricLines,
  libraryRequest,
  shortenSay,
  normalizeControl,
  pickLibrarySong,
  remoteCallerAllowed,
  resolvePlayRequest,
  songEpisode,
} from '../server/remote-play.js';

test('只有本机和 REMOTE_ALLOW 里的设备可以点歌', () => {
  assert.equal(remoteCallerAllowed('127.0.0.1'), true);
  assert.equal(remoteCallerAllowed('::ffff:192.0.2.30'), false);
  assert.equal(remoteCallerAllowed('::ffff:192.0.2.30', ['192.0.2.30']), true);
  assert.equal(remoteCallerAllowed('192.0.2.31', ['192.0.2.30']), false);
  assert.equal(remoteCallerAllowed(''), false);
  assert.equal(remoteCallerAllowed('192.0.2.20'), false);
  assert.equal(remoteCallerAllowed('192.0.2.20', ['192.0.2.20']), true);
});

test('没点歌名交给原来的 DJ，点名仍留下歌名', () => {
  assert.equal(djUserInput('你推荐一首'), '');
  assert.equal(djUserInput('推荐一首流行的'), '推荐一首流行的');
  assert.equal(djUserInput('播放周杰伦的晴天'), null);
  const track = episodeTrack({
    say: '这首接得上你最近听的。',
    queue: [
      { type: 'tts', url: '/tts/a.mp3' },
      { type: 'song', url: 'https://music.126.net/a.mp3', meta: { title: '晴天', artist: '周杰伦', genre: '流行' } },
    ],
  });
  assert.equal(track.title, '晴天');
  assert.equal(track.say, '这首接得上你最近听的。');
  assert.equal(episodeTrack({ say: '', queue: [] }), null);
  const long = '下午的阳光晒进屋里，正好配点有画面的歌。先给你接一首安静的，顺着刚才那份温柔继续往下走，再把后面那句也说完。';
  const short = shortenSay(long, 45);
  assert.ok(short.length <= 45);
  assert.ok(short.length < long.length);
  assert.deepEqual(lyricLines('[00:01]第一句\n作词：某人\n第二句\n第三句'), ['第一句', '第二句']);
});

test('推荐从曲库里挑，点名仍留下歌名', () => {
  assert.equal(libraryRequest('你推荐一首').recommend, true);
  assert.equal(libraryRequest('推荐一首流行的').genre, '流行');
  assert.equal(libraryRequest('播放周杰伦的晴天').recommend, false);
  assert.equal(libraryRequest('播放周杰伦的晴天').query, '周杰伦的晴天');
  const songs = [
    { title: '晴天', artist: '周杰伦', genre: '流行 / 华语' },
    { title: '七里香', artist: '周杰伦', genre: '流行 / 华语' },
    { title: '酒店', artist: '王菲', genre: '爵士' },
  ];
  assert.equal(pickLibrarySong(songs, { genre: '爵士', random: () => 0.9 }).title, '酒店');
  assert.equal(pickLibrarySong(songs, { genre: '金属', random: () => 0 }).title, '晴天');
});

test('点名留下歌名，没点名交给下一期', () => {
  assert.equal(cleanMusicQuery('播放周杰伦的晴天'), '周杰伦的晴天');
  assert.equal(cleanMusicQuery('来一首七里香'), '七里香');
  assert.equal(cleanMusicQuery('晴天'), '晴天');
  assert.equal(cleanMusicQuery('放一首歌'), '');
  assert.equal(cleanMusicQuery('random'), '');
});

test('解析到可播直链才组成一首的队列', async () => {
  const found = await resolvePlayRequest('放晴天', {
    resolve: async () => ({ id: 1, title: '晴天', artist: '周杰伦', url: 'https://music.126.net/a.mp3', playable: true }),
  });
  assert.equal(found.mode, 'track');
  assert.deepEqual(songEpisode(found.song).queue[0].meta.title, '晴天');
  assert.equal(found.episode.queue[0].type, 'song');

  const missing = await resolvePlayRequest('没有的歌', {
    resolve: async () => ({ playable: false, url: null }),
  });
  assert.equal(missing.ok, false);
  const busy = await resolvePlayRequest('晴天', {
    resolve: async () => ({ playable: false, url: null, error: 'ncm /search -> 405' }),
  });
  assert.equal(busy.error, '网易云这会儿太忙，等一会儿再点');

  const any = await resolvePlayRequest('随便', { resolve: async () => { throw new Error('不该搜'); } });
  assert.equal(any.mode, 'next');
});

test('控制只接受播放器已经认识的动作', () => {
  assert.equal(normalizeControl({ action: 'pause' }).control.action, 'pause');
  assert.equal(normalizeControl({ action: 'volume_set', value: 140 }).control.actionValue, 100);
  assert.equal(normalizeControl({ action: 'delete' }).ok, false);
});

test('播放器超时没回话就失败', async () => {
  const waiter = createAckWaiter(20);
  const pending = waiter.expect('abc');
  const result = await pending;
  assert.equal(result.ok, false);
});

test('房间名对应家里的音箱，开发板单独算', () => {
  const items = [
    { id: 'airplay:a9', deviceName: 'BeoPlay A9', name: 'BeoPlay A9' },
    { id: 'airplay:bed', deviceName: '卧室 (3)', name: '卧室 (3)' },
    { id: 'airplay:tv', deviceName: '客厅 (4)', name: '客厅 (4)' },
  ];
  assert.equal(chooseOutput(items, '客厅').outputId, 'airplay:a9');
  assert.equal(chooseOutput(items, '卧室').outputId, 'airplay:bed');
  assert.equal(chooseOutput(items, 'HomePod').name, '卧室 (3)');
  assert.equal(chooseOutput(items, '开发板').target, 'board');
  assert.equal(chooseOutput(items, 'SoundOne').ok, false);
});

test('房间播放优先送进已接上的音箱', async () => {
  const calls = [];
  const result = await playInRoom({
    song: { title: '晴天', artist: '周杰伦', url: 'https://music.126.net/a.mp3' },
    where: '卧室',
    items: [{ id: 'airplay:bed', deviceName: '卧室 (3)', name: '卧室 (3)' }],
    io: {
      selectOutput: async (id) => { calls.push(id); return { ok: true, uid: 'uid-bed' }; },
      stopExclusive: async () => {},
      playExclusive: async ({ uid }) => { calls.push(uid); },
      materialize: async () => { throw new Error('不该下载'); },
      playFile: () => { throw new Error('不该走系统输出'); },
    },
  });
  assert.equal(result.mode, 'room');
  assert.deepEqual(calls, ['airplay:bed', 'uid-bed']);
});

test('选设备或下载期间取消，不得播放或记录迟到的远程节目', async () => {
  const { forgetHeadless, headlessStatus } = await import('../server/headless-play.js');
  for (const stage of ['selection', 'download', 'exclusive']) {
    forgetHeadless();
    const controller = new AbortController();
    let started = 0;
    const cancel = () => controller.abort(new Error('节目已更新'));
    const work = playInRoom({
      song: { id: 'stale', title: '旧歌', artist: '乐队', url: 'https://music.126.net/stale.mp3' },
      where: '卧室', items: [{ id: 'bed', name: '卧室' }], signal: controller.signal,
      io: {
        selectOutput: async () => { if (stage === 'selection') cancel(); return { ok: true, uid: stage === 'exclusive' ? 'bed' : '' }; },
        stopExclusive: async () => {},
        materialize: async (_url, { signal }) => { assert.equal(signal, controller.signal); cancel(); return '/tmp/stale.mp3'; },
        playExclusive: async ({ signal }) => { assert.equal(signal, controller.signal); cancel(); },
        playFile: () => { started++; },
      },
    });
    await assert.rejects(work, /节目已更新/);
    assert.equal(started, 0);
    assert.equal(headlessStatus().title, '');
    assert.equal(headlessStatus().playing, false);
  }
});

test('无头播放可以暂停、换下一首，也可以换房间', async () => {
  const { controlHeadless, forgetHeadless, playDefaultFile, playInRoom } = await import('../server/headless-play.js');
  forgetHeadless();
  const signals = [];
  const proc = {
    kill(signal) { signals.push(signal); },
    on() {},
  };
  const items = [
    { id: 'airplay:a9', deviceName: 'BeoPlay A9', name: 'BeoPlay A9' },
    { id: 'airplay:bed', deviceName: '卧室 (3)', name: '卧室 (3)' },
  ];
  const io = {
    selectOutput: async () => ({ ok: true }),
    stopExclusive: async () => {},
    playExclusive: async () => { throw new Error('不该走独占'); },
    materialize: async () => '/tmp/song.mp3',
    playFile: () => playDefaultFile('/tmp/song.mp3', () => proc),
  };
  const started = await playInRoom({
    song: { id: '1', title: '晴天', artist: '周杰伦', url: 'https://music.126.net/a.mp3' },
    where: '客厅',
    query: '周杰伦的晴天',
    items,
    io,
  });
  assert.equal(started.name, 'BeoPlay A9');
  const paused = await controlHeadless({ action: 'pause', io });
  assert.equal(paused.ok, true);
  const resumed = await controlHeadless({ action: 'resume', io });
  assert.equal(resumed.ok, true);
  assert.deepEqual(signals, ['SIGSTOP', 'SIGCONT']);

  const played = [];
  const next = await controlHeadless({
    action: 'next',
    io: {
      ...io,
      playFile: (file) => played.push(file),
      resolveNext: async (query, excludeIds) => {
        assert.equal(query, '周杰伦的晴天');
        assert.deepEqual(excludeIds, ['1']);
        return { id: '2', title: '七里香', artist: '周杰伦', url: 'https://music.126.net/b.mp3' };
      },
      materialize: async () => '/tmp/next.mp3',
    },
  });
  assert.equal(next.title, '七里香');
  assert.deepEqual(played, ['/tmp/next.mp3']);

  const selected = [];
  const moved = await controlHeadless({
    action: 'resume',
    where: '卧室',
    listOutputs: async () => ({ items }),
    io: {
      ...io,
      selectOutput: async (id) => { selected.push(id); return { ok: true }; },
      playFile: () => {},
      materialize: async () => '/tmp/next.mp3',
    },
  });
  assert.equal(moved.ok, true);
  assert.deepEqual(selected, ['airplay:bed']);
  forgetHeadless();
});

test('播放器回话会解开等待', async () => {
  const waiter = createAckWaiter(1000);
  const pending = waiter.expect('abc');
  assert.equal(waiter.receive({ id: 'abc', ok: true }), true);
  assert.deepEqual(await pending, { ok: true, error: '' });
});
test('无头DJ抽取缓存歌曲时返回上游直链，独立节目也带epoch', () => {
  const item={type:'song',url:'/media/42',meta:{id:'42',title:'测试',artist:'甲',remoteUrl:'https://m.126.net/42'}};
  assert.equal(episodeTrack({queue:[item]}).url,'https://m.126.net/42');
  const episode=songEpisode({id:'42',title:'测试',artist:'甲',url:'https://m.126.net/42'},{epoch:7});
  assert.equal(episode.epoch,7);assert.equal(episode.voice.status,'skipped');assert.ok(episode.id);
});
