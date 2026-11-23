// 多设备接力：这台设备是谁（不用登录）。名字按浏览器 / 系统自动认，例如「Mac Chrome」「iPhone Safari」。
export function deviceName(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return [os, browser].filter(Boolean).join(' ') || '另一台设备';
}

export function deviceIdentity({ storage = globalThis.localStorage, ua = globalThis.navigator?.userAgent || '', makeId } = {}) {
  const fresh = () => (makeId ? makeId() : globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let id = '';
  try { id = storage?.getItem('claudio-device') || ''; } catch { /* 隐私模式 */ }
  if (!id) {
    id = fresh();
    try { storage?.setItem('claudio-device', id); } catch { /* 只在这次会话里有效 */ }
  }
  return { id, name: deviceName(ua) };
}
