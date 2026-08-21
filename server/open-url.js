import { spawn } from 'node:child_process';

// 系统浏览器打开外链：只放行明确的 https 站点，避免 `open` 被当成任意命令。
export const OPEN_URL_ALLOWLIST = [
  /^https:\/\/fish\.audio\//i,
  /^https:\/\/auth\.x\.ai(?:\/|$)/i,
  /^https:\/\/accounts\.x\.ai(?:\/|$)/i,
];

export function assertAllowedOpenUrl(url) {
  const value = String(url || '').trim();
  if (!OPEN_URL_ALLOWLIST.some((pattern) => pattern.test(value))) {
    throw new TypeError('url not allowed');
  }
  return value;
}

export function openSystemBrowser(url) {
  const allowed = assertAllowedOpenUrl(url);
  const child = process.platform === 'darwin'
    ? spawn('open', [allowed], { detached: true, stdio: 'ignore' })
    : process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '', allowed], { detached: true, stdio: 'ignore' })
      : spawn('xdg-open', [allowed], { detached: true, stdio: 'ignore' });
  child.unref();
  return allowed;
}
