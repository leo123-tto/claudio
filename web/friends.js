// 好友互荐（两版共用的界面）：好友面板、推荐给谁、「来自 XX」。
// 播放引擎换歌时发 claudio:now（detail = 正在放的歌，带 rec 就是朋友推荐来的），这里跟着更新；
// 「最近听过」里的 .rec-btn 也走这里。公用版推荐只送歌的 id（服务端从自己的记录里取歌的信息），个人版送整首歌的信息。
const $ = (id) => document.getElementById(id);
let mode = 'public';
let now = null;
let pickSong = null;
let pickTo = '';
let view = null;

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || '没成功，稍后再试');
  return data;
}

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (text, cls, fn) => {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
};
function say(id, text, kind = '') {
  const node = $(id);
  node.textContent = text;
  node.className = `result${kind ? ` ${kind}` : ''}`;
}

function open(id) { $(id).classList.remove('hidden'); }
function close(id) { $(id).classList.add('hidden'); }

// ---- 正在放 ----
function paintNow() {
  $('recBtn').disabled = !now?.id;
  const from = now?.rec?.from;
  $('recFrom').classList.toggle('hidden', !from);
  $('recFrom').textContent = from ? `来自 ${from}` : '';
}

// ---- 好友面板 ----
const SENT = { sent: '已送达', played: '已播', expired: '过期了', unplayable: '对方放不了' };
const RECEIVED = { new: '待播', played: '已播', expired: '过期了', unplayable: '放不了' };

function songLine(rec, extra) {
  const li = el('li');
  const text = el('div', 'rec-text');
  text.append(el('span', '', `${rec.song.title}${rec.song.artist ? ` · ${rec.song.artist}` : ''}`));
  text.append(el('span', 'dim', extra));
  if (rec.note) text.append(el('span', 'rec-note', `「${rec.note}」`));
  li.append(text);
  return li;
}

function render() {
  const v = view;
  $('friendNick').value = v.me.nick || '';
  $('friendNick').placeholder = v.me.name;
  for (const b of $('friendAccept').querySelectorAll('button')) b.setAttribute('aria-checked', String((b.dataset.value === 'on') === v.me.accept));
  $('friendCount').textContent = v.friends.length ? String(v.friends.length) : '';

  const list = $('friendList');
  list.textContent = '';
  for (const f of v.friends) {
    const li = el('li', 'row');
    li.append(el('span', '', f.accept ? f.name : `${f.name}（暂不接收）`));
    const acts = el('span', 'acts');
    acts.append(
      button('删除', 'btn-line', async () => { await act('remove', { id: f.id }); }),
      button('屏蔽', 'btn-line danger', async () => { await act('block', { id: f.id }); }),
    );
    li.append(acts);
    list.append(li);
  }
  $('friendEmpty').classList.toggle('hidden', v.friends.length > 0);

  const inbox = $('recInbox');
  inbox.textContent = '';
  for (const r of v.inbox) {
    const li = songLine(r, `${r.from.name} · ${RECEIVED[r.status] || ''}`);
    if (r.liked) li.append(el('span', 'liked', '♥'));
    else if (r.status !== 'unplayable') li.append(button('好听', 'btn-line', async () => { await act('like', { rec: r.id }); }));
    inbox.append(li);
  }
  $('recInboxGroup').classList.toggle('hidden', !v.inbox.length);

  const sent = $('recSent');
  sent.textContent = '';
  for (const r of v.sent) {
    const notes = { rejected: ' · 附言没通过', pending: ' · 附言检查中' };
    const li = songLine(r, `给 ${r.to.name} · ${SENT[r.status] || ''}${notes[r.noteState] || ''}`);
    if (r.liked) li.append(el('span', 'liked', '♥ 好听'));
    sent.append(li);
  }
  $('recSentGroup').classList.toggle('hidden', !v.sent.length);

  const blocked = $('blockedList');
  blocked.textContent = '';
  for (const b of v.me.blocked) {
    const li = el('li', 'row');
    li.append(el('span', '', b.name), button('解除', 'btn-line', async () => { await act('unblock', { id: b.id }); }));
    blocked.append(li);
  }
  $('blockedGroup').classList.toggle('hidden', !v.me.blocked.length);
}

async function load() {
  try {
    view = await api('/api/friends');
    render();
  } catch (error) { say('friendMsg', error.message, 'error'); }
}

async function act(name, body) {
  try {
    await api(`/api/friends/${name}`, body);
    say('friendMsg', '');
    await load();
  } catch (error) { say('friendMsg', error.message, 'error'); }
}

// ---- 推荐给谁 ----
function openRecommend(song) {
  if (!song?.id) return;
  pickSong = song;
  pickTo = '';
  $('recTitle').textContent = `推荐《${song.title}》`;
  $('recNote').value = '';
  say('recMsg', '');
  $('recSend').disabled = true;
  $('recPick').textContent = '';
  open('recBackdrop');
  api('/api/friends').then((v) => {
    view = v;
    const usable = v.friends.filter((f) => f.accept);
    for (const f of v.friends) {
      const b = button(f.name, 'pick', () => {
        pickTo = f.id;
        for (const x of $('recPick').children) x.setAttribute('aria-checked', String(x === b));
        $('recSend').disabled = v.dayLeft <= 0;
      });
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.disabled = !f.accept;
      if (!f.accept) b.title = '暂不接收推荐';
      $('recPick').append(b);
    }
    if (!v.friends.length) say('recMsg', '还没有好友。在「好友」里互加好友码。');
    else if (!usable.length) say('recMsg', '好友都暂时不接收推荐。');
    else if (v.dayLeft <= 0) say('recMsg', '今天的推荐用完了，明天再来。');
    else say('recMsg', `今天还能推荐 ${v.dayLeft} 首`);
  }).catch((error) => say('recMsg', error.message, 'error'));
}

async function sendRecommend() {
  if (!pickSong || !pickTo) return;
  $('recSend').disabled = true;
  const note = $('recNote').value.trim();
  const body = mode === 'public'
    ? { to: pickTo, songId: pickSong.id, note }
    : { to: pickTo, song: { id: pickSong.id, title: pickSong.title, artist: pickSong.artist, cover: pickSong.cover || '', duration: pickSong.duration || 0 }, note };
  try {
    const out = await api('/api/friends/recommend', body);
    say('recMsg', out.rec?.noteState === 'pending' ? '推荐出去了，附言检查过了才给对方看。' : '推荐出去了。', 'ok');
    setTimeout(() => close('recBackdrop'), 1200);
  } catch (error) {
    say('recMsg', error.message, 'error');
    $('recSend').disabled = false;
  }
}

export function initFriends({ mode: m = 'public' } = {}) {
  mode = m;
  document.body.classList.add('has-friends');
  window.addEventListener('claudio:now', (event) => { now = event.detail || null; paintNow(); });
  paintNow();
  $('recBtn').addEventListener('click', () => openRecommend(now));
  $('friendsBtn').addEventListener('click', () => { say('friendMsg', ''); $('friendCode').value = ''; $('myCode').classList.add('hidden'); open('friendsBackdrop'); load(); });
  // 「最近听过」里每首后面的推荐键
  document.addEventListener('click', (event) => {
    const b = event.target.closest?.('.rec-btn');
    if (!b) return;
    try { openRecommend(JSON.parse(b.dataset.song)); } catch { /* 坏数据不理 */ }
  });
  for (const id of ['friendsBackdrop', 'recBackdrop']) {
    $(id).addEventListener('click', (event) => { if (event.target === $(id) || event.target.closest('[data-close]')) close(id); });
  }
  $('recSend').addEventListener('click', sendRecommend);
  $('myCodeBtn').addEventListener('click', async () => {
    try {
      const out = await api('/api/friends/code', {});
      $('myCode').textContent = out.code;
      $('myCode').classList.remove('hidden');
      say('friendMsg', '15 分钟内有效，用一次就失效');
    } catch (error) { say('friendMsg', error.message, 'error'); }
  });
  const add = async () => {
    const code = $('friendCode').value.replace(/\s+/g, '');
    if (!code) return;
    try {
      const out = await api('/api/friends/add', { code });
      $('friendCode').value = '';
      say('friendMsg', `和${out.friend.name}成了好友`, 'ok');
      await load();
    } catch (error) { say('friendMsg', error.message, 'error'); }
  };
  $('friendAdd').addEventListener('click', add);
  $('friendCode').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) add(); });
  $('friendNick').addEventListener('change', () => act('profile', { nick: $('friendNick').value.trim() }));
  for (const b of $('friendAccept').querySelectorAll('button')) {
    b.addEventListener('click', () => act('profile', { accept: b.dataset.value === 'on' }));
  }
}

