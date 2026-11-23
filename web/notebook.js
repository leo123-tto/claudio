// 「Vera 的笔记本」前端：看、改、删、标「别再提」。
// 四栏固定（人 / 习惯 / 歌 / 事）；没有进度条、没有数字 —— 关系进度只体现在她说话的方式上。
const el = {
  cols: document.getElementById('nbCols'),
  empty: document.getElementById('nbEmpty'),
  inline: document.getElementById('nbInline'),
  kind: document.getElementById('nbKind'),
  text: document.getElementById('nbText'),
  quote: document.getElementById('nbQuote'),
  songs: document.getElementById('nbSongs'),
  add: document.getElementById('nbAdd'),
  card: document.getElementById('nbCard'),
};
const KIND_ORDER = ['person', 'habit', 'song', 'event'];
const KIND_HINT = { person: '你身边的人', habit: '作息与习惯', song: '歌单与雷区', event: '发生过的事' };
let state = { kinds: KIND_ORDER.map((key) => ({ key, label: key })), notes: [], editing: null };

const say = (text) => { el.inline.textContent = text || ''; };
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let message = '出错了，稍再试';
    try { message = (await res.json()).message || message; } catch { /* 忽略 */ }
    throw new Error(message);
  }
  return res.json();
}

// 「歌名 / 歌手，歌名2」→ [{title, artist}]
function parseSongs(raw) {
  return String(raw || '').split(/[,，;；]/).map((piece) => {
    const [title, artist] = piece.split(/\s*\/\s*/);
    return { title: String(title || '').trim(), artist: String(artist || '').trim() };
  }).filter((song) => song.title).slice(0, 6);
}
const songsText = (songs = []) => songs.map((song) => `${song.title}${song.artist ? ` / ${song.artist}` : ''}`).join('，');

function kindLabel(key) {
  return (state.kinds.find((item) => item.key === key) || {}).label || '事';
}

function cardFor(note) {
  const card = el.card.content.firstElementChild.cloneNode(true);
  const date = new Date(note.at);
  card.dataset.id = note.id;
  card.classList.toggle('muted', note.status === 'muted');
  card.querySelector('.nb-date').textContent = Number.isNaN(date.getTime())
    ? '' : `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
  const tags = [];
  if (note.sensitive === 'quiet') tags.push('<span class="nb-tag quiet">她不会主动提</span>');
  if (note.status === 'muted') tags.push('<span class="nb-tag muted">别再提</span>');
  if (note.source === 'legacy' || note.source === 'inferred') tags.push('<span class="nb-tag">她自己记的</span>');
  card.querySelector('.nb-tags').innerHTML = tags.join('');
  card.querySelector('.nb-text').textContent = note.text;
  const quote = card.querySelector('.nb-quote');
  quote.textContent = note.quote ? `你的原话：${note.quote}` : '这条没有原话。';
  quote.classList.add('hidden');
  card.querySelector('.nb-songs').innerHTML = (note.songs || [])
    .map((song) => `<span class="nb-song">${escapeHtml(song.title)}${song.artist ? ` · ${escapeHtml(song.artist)}` : ''}</span>`).join('');
  const muteBtn = card.querySelector('[data-act="mute"]');
  muteBtn.textContent = note.status === 'muted' ? '可以再提' : '别再提';
  card.querySelector('[data-act="quote"]').textContent = note.quote ? '原话' : '细节';
  return card;
}

function render() {
  const groups = new Map(KIND_ORDER.map((key) => [key, []]));
  for (const note of state.notes) {
    const key = groups.has(note.kind) ? note.kind : 'event';
    groups.get(key).push(note);
  }
  el.cols.innerHTML = '';
  for (const key of KIND_ORDER) {
    const list = groups.get(key);
    const col = document.createElement('section');
    col.className = 'nb-col';
    col.dataset.kind = key;
    col.innerHTML = `<div class="nb-col-head"><h2>${escapeHtml(kindLabel(key))}</h2><span>${escapeHtml(KIND_HINT[key])}${list.length ? ` · ${list.length}` : ''}</span></div>`;
    // 新的在上面
    for (const note of [...list].reverse()) {
      col.appendChild(state.editing === note.id ? editorFor(note) : cardFor(note));
    }
    el.cols.appendChild(col);
  }
  el.empty.classList.toggle('hidden', state.notes.length > 0);
}

function editorFor(note) {
  const box = document.createElement('article');
  box.className = 'nb-card';
  box.dataset.id = note.id;
  box.innerHTML = `
    <div class="nb-edit">
      <div class="nb-edit-row">
        <select data-field="kind">${state.kinds.map((item) => `<option value="${item.key}"${item.key === note.kind ? ' selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}</select>
      </div>
      <input data-field="text" maxlength="120" value="${escapeHtml(note.text)}" aria-label="内容" />
      <textarea data-field="quote" maxlength="240" placeholder="你的原话（可不填）" aria-label="原话">${escapeHtml(note.quote || '')}</textarea>
      <input data-field="songs" maxlength="120" value="${escapeHtml(songsText(note.songs))}" placeholder="关联的歌：歌名 / 歌手" aria-label="关联的歌" />
      <label class="nb-edit-check"><input type="checkbox" data-field="quiet"${note.sensitive === 'quiet' ? ' checked' : ''} /> 她不会主动提这件事</label>
      <div class="nb-actions">
        <button type="button" data-act="save" class="nb-btn primary">保存</button>
        <button type="button" data-act="cancel">算了</button>
      </div>
    </div>`;
  return box;
}

async function reload() {
  const data = await api('/api/notebook');
  state = { ...state, kinds: data.kinds || state.kinds, notes: data.notes || [], migrated: data.migrated };
  render();
}

async function addNote() {
  const text = el.text.value.trim();
  if (!text) { say('写一句话她才能记住'); el.text.focus(); return; }
  el.add.disabled = true;
  try {
    await api('/api/notebook', {
      method: 'POST',
      body: JSON.stringify({
        kind: el.kind.value,
        text,
        quote: el.quote.value.trim(),
        songs: parseSongs(el.songs.value),
      }),
    });
    el.text.value = ''; el.quote.value = ''; el.songs.value = '';
    say('记下了');
    await reload();
  } catch (error) { say(error.message); } finally { el.add.disabled = false; }
}

async function onCardClick(event) {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const card = button.closest('.nb-card');
  const id = card?.dataset.id;
  if (!id) return;
  const act = button.dataset.act;
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;

  if (act === 'quote') {
    const quote = card.querySelector('.nb-quote');
    quote.classList.toggle('hidden');
    return;
  }
  if (act === 'edit') { state.editing = id; render(); return; }
  if (act === 'cancel') { state.editing = null; render(); return; }
  if (act === 'save') {
    const field = (name) => card.querySelector(`[data-field="${name}"]`);
    button.disabled = true;
    try {
      await api(`/api/notebook/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          kind: field('kind').value,
          text: field('text').value.trim(),
          quote: field('quote').value.trim(),
          songs: parseSongs(field('songs').value),
          sensitive: field('quiet').checked ? 'quiet' : 'normal',
        }),
      });
      state.editing = null;
      say('改好了');
      await reload();
    } catch (error) { say(error.message); button.disabled = false; }
    return;
  }
  if (act === 'mute') {
    const muted = note.status !== 'muted';
    try {
      await api(`/api/notebook/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify({ status: muted ? 'muted' : 'active' }),
      });
      say(muted ? '以后她不会再提这件事' : '她可以再提了');
      await reload();
    } catch (error) { say(error.message); }
    return;
  }
  if (act === 'delete') {
    // 删就是删：不二次确认，也不挽留。失败就只说失败，不许跟着报「删掉了」。
    try {
      await api(`/api/notebook/${encodeURIComponent(id)}`, { method: 'DELETE' });
      say('删掉了，她不会再用到这条');
      await reload();
    } catch (error) { say(error.message); }
  }
}

async function main() {
  // 栏目下拉按服务端给的顺序（人 / 习惯 / 歌 / 事）
  el.kind.innerHTML = KIND_ORDER.map((key) => `<option value="${key}">${escapeHtml(kindLabel(key))}</option>`).join('');
  el.add.addEventListener('click', addNote);
  el.text.addEventListener('keydown', (event) => { if (event.key === 'Enter') addNote(); });
  el.cols.addEventListener('click', onCardClick);
  try {
    await reload();
    el.kind.innerHTML = KIND_ORDER
      .map((key) => `<option value="${key}">${escapeHtml(kindLabel(key))}</option>`).join('');
  } catch (error) {
    say(error.message === 'Failed to fetch' ? '连不上电台服务' : error.message);
  }
}

main();
