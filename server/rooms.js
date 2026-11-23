// 播放设备的房间别名，以及「放到客厅」这种短句。别名只改显示，不改设备本身。

const ALIAS_MAX = 12;

export function normalizeAlias(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, ALIAS_MAX);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function applyRoomAliases(menu, aliases = {}) {
  const items = (menu?.items || []).map((item) => {
    const alias = normalizeAlias(aliases?.[item.id]);
    if (!alias) return { ...item, deviceName: item.deviceName || item.name };
    return {
      ...item,
      deviceName: item.deviceName || item.name,
      alias,
      name: alias,
      detail: `${item.deviceName || item.name} · ${item.detail || ''}`.replace(/ · $/, ''),
    };
  });
  return { ...menu, items };
}

export function looksLikeRoomCommand(input = '') {
  const text = String(input || '').trim();
  return text.length > 1 && text.length <= 32 && /(?:放|切|换)到|在.{1,16}(?:上|里)?放/.test(text);
}

export function matchRoomCommand(input = '', items = []) {
  const text = String(input || '').trim().replace(/[。！!？?，,；;]+$/g, '').trim();
  if (!looksLikeRoomCommand(text)) return null;
  const names = [];
  for (const item of items) {
    for (const label of [item.alias, item.deviceName, item.name]) {
      const name = normalizeAlias(label) || String(label || '').trim();
      if (name.length < 2) continue;
      names.push({ item, name });
    }
  }
  names.sort((a, b) => b.name.length - a.name.length);
  for (const { item, name } of names) {
    const escaped = escapeRegExp(name);
    const pattern = new RegExp(
      `^(?:请|麻烦)?(?:把(?:声音|歌|音乐)?)?(?:放|切|换)到${escaped}(?:上|里)?(?:播放|放歌|放)?(?:吧)?$`
      + `|^(?:请|麻烦)?(?:在)${escaped}(?:上|里)?(?:播放|放歌|放)(?:吧)?$`,
    );
    if (!pattern.test(text)) continue;
    const spoken = item.alias || item.deviceName || item.name;
    return {
      intent: 'control',
      action: 'output',
      actionValue: 0,
      outputId: item.id,
      reply: `好，放到${spoken}。`,
    };
  }
  return null;
}
