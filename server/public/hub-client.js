// 公用版调 hub 的 /claudio/v1/*（申请、邀请链接、设备、配对码、额度、状态同步）。
// 只拿 claudio-invite scope 的服务 key；hub 连不上时一律按「不让进」处理（fail closed）。
import crypto from 'node:crypto';
import { createTimeoutSignal } from '../llm/openai-chat.js';

export class HubError extends Error {
  constructor(status, reason, message) {
    super(message || reason);
    this.status = status;
    this.reason = reason;
  }
}

export function createHubClient({ base, key, fetchFn = fetch, verifyTtlMs = 5000, now = () => Date.now() }) {
  const verifyCache = new Map();

  async function call(method, pathname, body) {
    const { signal, clear } = createTimeoutSignal(8000);
    try {
      let res;
      try {
        res = await fetchFn(new URL(pathname, base), {
          method,
          signal,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      } catch {
        throw new HubError(503, 'hub_unreachable', '后台暂时连不上');
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new HubError(res.status, data?.error?.type || 'error', data?.error?.message || `hub ${res.status}`);
      }
      return data;
    } finally {
      clear();
    }
  }

  const tokenKey = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

  return {
    apply: (body) => call('POST', '/claudio/v1/apply', body),
    redeemLink: (token, label) => call('POST', '/claudio/v1/link/redeem', { token, label }),
    pairCreate: (deviceToken) => call('POST', '/claudio/v1/pair/create', { device_token: deviceToken }),
    pairRedeem: (code, label) => call('POST', '/claudio/v1/pair/redeem', { code, label }),
    async logout(deviceToken) {
      verifyCache.delete(tokenKey(deviceToken));
      return call('POST', '/claudio/v1/device/logout', { device_token: deviceToken });
    },
    // 每个请求都核一次设备；只缓存几秒，停用 / 踢设备基本立即生效
    async verify(deviceToken) {
      const k = tokenKey(deviceToken);
      const hit = verifyCache.get(k);
      if (hit && hit.until > now()) return hit.value;
      const value = await call('POST', '/claudio/v1/device/verify', { device_token: deviceToken });
      verifyCache.set(k, { value, until: now() + verifyTtlMs });
      if (verifyCache.size > 2000) verifyCache.delete(verifyCache.keys().next().value);
      return value;
    },
    forget(deviceToken) { verifyCache.delete(tokenKey(deviceToken)); },
    consume: (memberId, kind) => call('POST', '/claudio/v1/consume', { member_id: memberId, kind }),
    states: () => call('GET', '/claudio/v1/states'),
    report: (items) => call('POST', '/claudio/v1/report', { items }),
  };
}
