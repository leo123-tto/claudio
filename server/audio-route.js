// 把本机扬声器和局域网 AirPlay 名字收成播放器里的一份菜单。
// 真正切换由系统完成：本机走 CoreAudio，音箱走控制中心。这里只决定该点哪一项。

const DNS_LINE = /^\S+\s+(Add|Rmv)\s+\d+\s+\d+\s+\S+\s+(?:_airplay|_raop)\._tcp\.\s+(.*?)\s*$/;

export function normalizeOutputName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function parseDnsSdBrowse(text) {
  const counts = new Map();
  for (const line of String(text || '').split(/\n/)) {
    const match = line.match(DNS_LINE);
    if (!match) continue;
    const name = match[2].trim().replace(/^[0-9a-f]{12}@/i, '');
    if (!name) continue;
    const next = (counts.get(name) || 0) + (match[1] === 'Add' ? 1 : -1);
    counts.set(name, Math.max(0, next));
  }
  return [...counts.entries()].filter(([, count]) => count > 0).map(([name]) => name);
}

export function localOutputLabel(deviceName = '') {
  if (/macbook/i.test(deviceName)) return '这台 MacBook';
  if (/mac mini/i.test(deviceName)) return '这台 Mac mini';
  return '这台 Mac';
}

export function buildOutputMenu({ devices = [], airplayNames = [], computerName = '', exclusiveId = '' } = {}) {
  const outputs = devices.filter((device) => device && device.output && device.uid && device.name);
  const current = outputs.find((device) => device.default) || null;
  const builtin = outputs.find((device) => device.transport === 'builtin')
    || outputs.find((device) => /扬声器|speakers/i.test(device.name) && device.transport !== 'virtual');
  const hidden = new Set([computerName, builtin?.name].filter(Boolean).map(normalizeOutputName));
  const items = [];
  const choosing = Boolean(exclusiveId);
  if (builtin) {
    items.push({
      id: 'local',
      name: localOutputLabel(builtin.name),
      deviceName: localOutputLabel(builtin.name),
      detail: builtin.name,
      kind: 'local',
      route: 'coreaudio',
      uid: builtin.uid,
      selected: choosing ? exclusiveId === 'local' : Boolean(current && current.uid === builtin.uid),
    });
  }
  for (const device of outputs) {
    if (device.uid === builtin?.uid || ['builtin', 'virtual', 'airplay'].includes(device.transport)) continue;
    items.push({
      id: `coreaudio:${encodeURIComponent(device.uid)}`,
      name: device.name,
      deviceName: device.name,
      detail: '',
      kind: device.transport === 'bluetooth' ? 'bluetooth' : 'wired',
      route: 'coreaudio',
      uid: device.uid,
      selected: !choosing && current?.uid === device.uid,
    });
  }
  const seen = new Set();
  const connectedAirplay = outputs.filter((device) => device.transport === 'airplay').map((device) => device.name);
  for (const raw of [...airplayNames, ...connectedAirplay]) {
    const name = String(raw || '').trim();
    const key = normalizeOutputName(name);
    if (!name || !key || seen.has(key) || hidden.has(key)) continue;
    seen.add(key);
    const connected = outputs.find((device) => normalizeOutputName(device.name) === key && device.transport !== 'builtin');
    const id = `airplay:${encodeURIComponent(name)}`;
    items.push({
      id,
      name,
      deviceName: name,
      detail: connected ? '只送 Claudio' : '整台 Mac 一起过去',
      kind: 'airplay',
      route: connected ? 'exclusive' : 'system',
      uid: connected?.uid || '',
      selected: choosing
        ? exclusiveId === id
        : Boolean(current && (connected ? current.uid === connected.uid : normalizeOutputName(current.name) === key)),
    });
  }
  if (current && !items.some((item) => item.selected)) {
    items.unshift({
      id: `coreaudio:${encodeURIComponent(current.uid)}`,
      name: current.name,
      deviceName: current.name,
      detail: '当前输出',
      kind: 'current',
      route: 'coreaudio',
      uid: current.uid,
      selected: !choosing,
    });
  }
  return {
    items,
    note: '已经单独接上的音箱，只送 Claudio 的声音。还没接上的，点一次会让这台 Mac 正在播放的声音一起过去。',
  };
}

export function planOutputChange(menu, id) {
  const item = menu?.items?.find((entry) => entry.id === id);
  if (!item) return { ok: false, error: '没有这台设备' };
  if (item.selected) return { ok: true, action: 'none', item };
  if (item.route === 'exclusive' && item.uid) return { ok: true, action: 'exclusive', item };
  if (item.route === 'coreaudio' && item.uid) return { ok: true, action: 'coreaudio', item };
  if (item.kind === 'airplay' && item.name) return { ok: true, action: 'system', item };
  return { ok: false, error: '这台设备现在切不过去' };
}

export function matchSoundControl(controls, name) {
  const target = normalizeOutputName(name);
  if (!target) return null;
  let fuzzy = null;
  for (const control of controls || []) {
    const identifier = String(control.identifier || '');
    if (!identifier || identifier === 'controlcenter-airplay' || identifier.startsWith('module-')) continue;
    const fromIdentifier = identifier.startsWith('sound-device-') ? identifier.slice('sound-device-'.length) : '';
    const labels = [fromIdentifier, control.title, control.description, control.name]
      .map(normalizeOutputName)
      .filter(Boolean);
    if (labels.some((label) => label === target)) return control;
    if (!fuzzy && labels.some((label) => label.includes(target) || target.includes(label))) fuzzy = control;
  }
  return fuzzy;
}
