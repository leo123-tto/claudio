// 音质菜单（两版共用）：点歌曲信息里的音质角标，弹出可选档位。
// 引擎给三样：state() 现在的选择 / 自动降档 / 是否走 /media；levels(song) 这首能要哪几档（null = 不知道，不标灰）；pick(level) 选了以后换链。
// 驾驶模式不弹（驾驶屏那个角标只是镜像，只读）。
import { qualityLabel } from './ui.js';

export const LEVELS = [
  { key: 'standard', name: '标准', spec: '128k' },
  { key: 'higher', name: '较高', spec: '192k' },
  { key: 'exhigh', name: '极高', spec: '320k' },
  { key: 'lossless', name: '无损', spec: '' },
  { key: 'hires', name: 'Hi-Res', spec: '' },
  { key: 'jymaster', name: '超清母带', spec: '' },
];
const KEYS = LEVELS.map((l) => l.key);
export const isLevel = (key) => KEYS.includes(key);
export const rank = (key) => KEYS.indexOf(key);
export const stepDown = (key) => KEYS[Math.max(0, rank(key) - 1)] || 'standard';
export const minLevel = (a, b) => (!isLevel(a) ? b : !isLevel(b) ? a : rank(a) <= rank(b) ? a : b);

export function createQualityMenu({ chip, specs = {}, state, levels, pick }) {
  const label = (key) => {
    const l = LEVELS.find((x) => x.key === key);
    if (!l) return '';
    const spec = specs[key] ?? l.spec;
    return spec ? `${l.name} ${spec}` : l.name;
  };
  let menu = null;
  let quality = null;
  let showing = false;
  const available = new Map(); // 歌 id → 档位列表 | null

  // 角标：实际音质；拿不到实际音质时写「音质」，好让人能点开；自动降过档时写「已自动降到 xx」
  function paint(q = quality, song = showing) {
    quality = q || null;
    showing = Boolean(song);
    const { text, detail, lossless } = qualityLabel(quality);
    const { auto } = state();
    chip.textContent = auto ? `已自动降到 ${label(auto)}` : text || '音质';
    chip.title = detail ? `实际音质：${detail}` : '';
    chip.classList.toggle('hidden', !showing);
    chip.classList.toggle('lossless', lossless && !auto);
    chip.classList.toggle('auto', Boolean(auto));
  }

  function close() {
    menu?.remove();
    menu = null;
    chip.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
  }
  function outside(event) { if (menu && !menu.contains(event.target) && !chip.contains(event.target)) close(); }
  function onKey(event) { if (event.key === 'Escape') { event.stopPropagation(); close(); chip.focus(); } }

  function place() {
    if (!menu) return;
    const r = chip.getBoundingClientRect();
    const w = menu.offsetWidth;
    const left = Math.max(16, Math.min(r.left, window.innerWidth - w - 16));
    const below = r.bottom + 6;
    const top = below + menu.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - 6 - menu.offsetHeight) : below;
    Object.assign(menu.style, { left: `${left}px`, top: `${top}px` });
  }

  function render(list) {
    const s = state();
    const chosen = s.chosen;
    const head = qualityLabel(quality).detail;
    menu.replaceChildren(...[
      head ? Object.assign(document.createElement('div'), { className: 'qmenu-head', textContent: head }) : null,
      ...LEVELS.map(({ key }) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', String(key === chosen));
        b.dataset.level = key;
        b.textContent = label(key);
        if (Array.isArray(list) && !list.includes(key)) {
          b.disabled = true;
          b.title = '这首没有这一档';
        }
        return b;
      }),
      s.proxied ? Object.assign(document.createElement('div'), { className: 'qmenu-note', textContent: s.proxied }) : null,
    ].filter(Boolean));
    place();
  }

  async function open() {
    const s = state();
    if (!s.song || document.body.classList.contains('drive-on')) return;
    if (menu) return close();
    menu = document.createElement('div');
    menu.className = 'qmenu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '音质');
    document.body.append(menu);
    chip.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
    const id = String(s.song.id ?? '');
    render(available.get(id));
    menu.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
    menu.addEventListener('click', async (event) => {
      const level = event.target.closest('button[data-level]')?.dataset.level;
      if (!level || event.target.closest('button').disabled) return;
      close();
      await pick(level);
      paint();
    });
    if (!id || available.has(id)) return;
    const mine = menu;
    const list = await levels(s.song).catch(() => null);
    available.set(id, Array.isArray(list) ? list : null);
    if (available.size > 200) available.delete(available.keys().next().value);
    if (menu === mine) render(available.get(id));
  }

  chip.setAttribute('aria-haspopup', 'menu');
  chip.setAttribute('aria-expanded', 'false');
  chip.addEventListener('click', open);
  window.addEventListener('resize', place);
  // 进驾驶模式就收起
  if (typeof MutationObserver === 'function') {
    new MutationObserver(() => { if (document.body.classList.contains('drive-on')) close(); })
      .observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  return { paint, close, label };
}
