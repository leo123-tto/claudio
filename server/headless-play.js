// Mac mini 上没有浏览器窗口。点了房间就把歌送到那只音箱，并能暂停、换一首、换房间。
import { spawn } from 'node:child_process';

import { chooseOutput, isBoardTarget } from './remote-play.js';

let fileChild = null;

function emptySession() {
  return {
    where: '',
    name: '',
    outputId: '',
    uid: '',
    via: '',
    title: '',
    artist: '',
    url: '',
    file: '',
    id: '',
    query: '',
    volume: 1,
    paused: false,
    history: [],
    index: -1,
  };
}

let session = emptySession();

export function headlessStatus() {
  return {
    where: session.where,
    name: session.name,
    title: session.title,
    artist: session.artist,
    paused: session.paused,
    playing: Boolean(fileChild) || session.via === 'exclusive',
  };
}

export function stopHeadlessPlayback() {
  const proc = fileChild;
  fileChild = null;
  session.paused = false;
  if (!proc) return;
  try { proc.kill('SIGTERM'); } catch { /* 已经停了 */ }
}

export function forgetHeadless() {
  stopHeadlessPlayback();
  session = emptySession();
}

export function playDefaultFile(file, spawnFn = spawn) {
  stopHeadlessPlayback();
  const volume = Math.max(0, Math.min(1, Number(session.volume) || 0));
  fileChild = spawnFn('/usr/bin/afplay', ['-v', String(volume), file], { stdio: 'ignore' });
  const current = fileChild;
  current.on('exit', () => {
    if (fileChild === current) fileChild = null;
  });
  return { started: true };
}

function remember(song, file = '') {
  const item = {
    id: song.id || song.url,
    title: song.title || session.title,
    artist: song.artist || '',
    url: song.url,
    file: file || song.file || '',
  };
  const current = session.history[session.index];
  if (!current || current.id !== item.id) {
    session.history = session.history.slice(0, session.index + 1);
    session.history.push(item);
    session.index = session.history.length - 1;
  } else if (file) {
    current.file = file;
  }
  session.title = item.title;
  session.artist = item.artist;
  session.url = item.url;
  session.file = item.file;
  session.id = item.id;
  session.paused = false;
  return item;
}

async function replay(item, io) {
  session.title = item.title;
  session.artist = item.artist;
  session.url = item.url;
  session.id = item.id;
  session.file = item.file || '';
  session.paused = false;
  session.index = Math.max(0, session.history.findIndex((entry) => entry.id === item.id));
  if (session.via === 'exclusive' && session.uid) {
    await io.stopExclusive?.();
    await io.playExclusive({ uid: session.uid, url: item.url, volume: session.volume });
    return { ok: true, mode: 'room', via: 'exclusive', name: session.name, title: item.title, artist: item.artist };
  }
  const file = item.file || await io.materialize(item.url);
  item.file = file;
  session.file = file;
  io.playFile(file);
  return { ok: true, mode: 'room', via: 'speakers', name: session.name, title: item.title, artist: item.artist };
}

export async function playInRoom({ song, where, items = [], io, query = '', signal }) {
  signal?.throwIfAborted();
  const choice = chooseOutput(items, where);
  if (!choice.ok || choice.target !== 'room') return choice;
  const selected = await io.selectOutput(choice.outputId);
  signal?.throwIfAborted();
  if (!selected?.ok) return { ok: false, status: 502, error: selected?.error || '没能切到这只音箱' };
  const file = selected.uid ? '' : await io.materialize(song.url, { signal });
  signal?.throwIfAborted();
  await io.stopExclusive?.();
  signal?.throwIfAborted();
  stopHeadlessPlayback();
  if (selected.uid) {
    await io.playExclusive({ uid: selected.uid, url: song.url, volume: session.volume, signal });
    signal?.throwIfAborted();
  } else {
    io.playFile(file);
  }
  // 等待设备和音频期间可能失效，真正开始后才记录新播放状态。
  session.where = where;
  session.name = choice.name;
  session.outputId = choice.outputId;
  session.uid = selected.uid || '';
  session.via = selected.uid ? 'exclusive' : 'speakers';
  if (query) session.query = query;
  remember(song, file);
  return { ok: true, mode: 'room', via: session.via, name: choice.name, title: song.title, artist: song.artist };
}

async function moveTo(where, io, listOutputs) {
  if (!session.url) return { ok: false, status: 409, error: '还没在放，要先说放哪一首' };
  if (isBoardTarget(where)) {
    const url = session.url;
    const title = session.title;
    const artist = session.artist;
    forgetHeadless();
    await io.stopExclusive?.();
    return { ok: true, mode: 'board', title, artist, url };
  }
  const menu = await listOutputs();
  const choice = chooseOutput(menu.items || [], where);
  if (!choice.ok || choice.target !== 'room') return choice;
  const selected = await io.selectOutput(choice.outputId);
  if (!selected?.ok) return { ok: false, status: 502, error: selected?.error || '没能切到这只音箱' };
  session.where = where;
  session.name = choice.name;
  session.outputId = choice.outputId;
  session.uid = selected.uid || '';
  session.via = selected.uid ? 'exclusive' : 'speakers';
  const item = session.history[session.index];
  if (!item) return { ok: false, status: 409, error: '还没在放，要先说放哪一首' };
  return replay(item, io);
}

export async function controlHeadless({ action, value = 0, where = '', listOutputs, io }) {
  if (action === 'stop') {
    stopHeadlessPlayback();
    await io.stopExclusive?.();
    session.via = '';
    return { ok: true, control: { action: 'stop' } };
  }
  if (action === 'move' && !where) {
    return { ok: false, status: 409, error: '要说放到哪：客厅的 A9、卧室，或者开发板' };
  }
  if (where) {
    const moved = await moveTo(where, io, listOutputs);
    if (!moved.ok) return moved;
    if (moved.mode === 'board') return moved;
    if (action !== 'pause' && action !== 'next' && action !== 'previous' && action !== 'resume' && !String(action).startsWith('volume')) {
      return moved;
    }
  }
  if (action === 'pause') {
    if (session.via === 'exclusive') {
      await io.controlExclusive?.('pause');
      session.paused = true;
      return { ok: true, control: { action: 'pause' }, name: session.name };
    }
    if (!fileChild) return { ok: false, status: 409, error: '现在没有在放' };
    try { fileChild.kill('SIGSTOP'); } catch { /* 已经停了 */ }
    session.paused = true;
    return { ok: true, control: { action: 'pause' }, name: session.name };
  }
  if (action === 'resume') {
    if (session.via === 'exclusive') {
      await io.controlExclusive?.('resume');
      session.paused = false;
      return { ok: true, control: { action: 'resume' }, name: session.name };
    }
    if (fileChild && session.paused) {
      try { fileChild.kill('SIGCONT'); } catch { /* 已经不在 */ }
      session.paused = false;
      return { ok: true, control: { action: 'resume' }, name: session.name };
    }
    if (!session.file && !session.url) return { ok: false, status: 409, error: '现在没有在放' };
    return replay(session.history[session.index], io);
  }
  if (action === 'volume_set' || action === 'volume_up' || action === 'volume_down') {
    let next = session.volume;
    if (action === 'volume_set') next = Math.max(0, Math.min(100, Number(value) || 0)) / 100;
    if (action === 'volume_up') next = Math.min(1, session.volume + 0.1);
    if (action === 'volume_down') next = Math.max(0, session.volume - 0.1);
    session.volume = next;
    if (session.via === 'exclusive') {
      await io.controlExclusive?.('volume', next);
      return { ok: true, control: { action }, name: session.name };
    }
    if (session.file) return replay(session.history[session.index], io);
    return { ok: true, control: { action }, name: session.name };
  }
  if (action === 'next' || action === 'previous') {
    if (!session.query && session.index < 0) return { ok: false, status: 409, error: '还没在放，要先说放哪一首' };
    if (action === 'previous') {
      if (session.index <= 0) return { ok: false, status: 409, error: '没有上一首了' };
      return replay(session.history[session.index - 1], io);
    }
    if (session.index + 1 < session.history.length) {
      return replay(session.history[session.index + 1], io);
    }
    const excludeIds = session.history.map((item) => item.id).filter(Boolean);
    const song = await io.resolveNext?.(session.query, excludeIds);
    if (!song?.url) return { ok: false, status: 404, error: '没有下一首了' };
    const item = remember(song);
    return replay(item, io);
  }
  return { ok: false, status: 400, error: '不认识这个操作' };
}
