import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { openSystemBrowser } from './open-url.js';

// 使用官方 Grok CLI 的公开 OAuth client（无 secret），走 RFC 8628 设备码：
// 弹出浏览器登录 SuperGrok / X Premium+，token 只落在本机 cache。
export const GROK_OAUTH = Object.freeze({
  deviceCodeUrl: 'https://auth.x.ai/oauth2/device/code',
  tokenUrl: 'https://auth.x.ai/oauth2/token',
  clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
  scope: 'openid profile email offline_access grok-cli:access api:access conversations:read conversations:write',
  deviceGrant: 'urn:ietf:params:oauth:grant-type:device_code',
});

const REFRESH_SKEW_MS = 5 * 60 * 1000;

function decodeJwt(token) {
  if (typeof token !== 'string') return {};
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[1].length / 4) * 4, '=');
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readExpiresAt(tokens) {
  const claims = decodeJwt(tokens.accessToken);
  if (Number.isFinite(claims.exp)) return claims.exp * 1000;
  if (Number.isFinite(tokens.expiresAt)) return Number(tokens.expiresAt);
  return 0;
}

function readEmail(tokens) {
  const claims = decodeJwt(tokens.idToken) || decodeJwt(tokens.accessToken);
  return typeof claims.email === 'string' && claims.email.trim() ? claims.email.trim() : '';
}

function oauthError(payload, fallback) {
  const error = payload?.error || payload?.error_description || fallback;
  return String(error);
}

async function readJsonSafe(res) {
  const text = await res.text().catch(() => '');
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 200) }; }
}

export function createGrokAuth({
  file,
  fetchFn = fetch,
  openBrowser = openSystemBrowser,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  let tokens = null;
  let pending = null;
  let loginGeneration = 0;
  let refreshPromise = null;

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.accessToken && parsed?.refreshToken) {
      tokens = {
        accessToken: String(parsed.accessToken),
        refreshToken: String(parsed.refreshToken),
        idToken: typeof parsed.idToken === 'string' ? parsed.idToken : '',
        expiresAt: Number(parsed.expiresAt) || 0,
        email: typeof parsed.email === 'string' ? parsed.email : '',
      };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[grok-auth] 登录态文件无效，忽略：', error.message);
  }

  function persist(next) {
    tokens = next;
    if (!next) {
      try { fs.unlinkSync(file); } catch (error) {
        if (error.code !== 'ENOENT') console.warn('[grok-auth] 清除登录态失败：', error.message);
      }
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    const body = {
      accessToken: next.accessToken,
      refreshToken: next.refreshToken,
      idToken: next.idToken || '',
      expiresAt: next.expiresAt,
      email: next.email || '',
    };
    fs.writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  }

  function storeFromTokenResponse(payload) {
    const accessToken = payload?.access_token;
    const refreshToken = payload?.refresh_token || tokens?.refreshToken;
    if (typeof accessToken !== 'string' || !accessToken || typeof refreshToken !== 'string' || !refreshToken) {
      throw new Error('Grok 登录未返回完整 token');
    }
    const next = {
      accessToken,
      refreshToken,
      idToken: typeof payload.id_token === 'string' ? payload.id_token : '',
      expiresAt: 0,
      email: '',
    };
    const ttlMs = Number(payload.expires_in) > 0 ? Number(payload.expires_in) * 1000 : 0;
    next.expiresAt = ttlMs ? now() + ttlMs : readExpiresAt(next);
    next.email = readEmail(next);
    persist(next);
    return next;
  }

  async function postForm(url, body) {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(body).toString(),
    });
    const payload = await readJsonSafe(res);
    return { res, payload };
  }

  function publicPending() {
    if (!pending) return null;
    return {
      status: pending.status,
      userCode: pending.userCode,
      verificationUri: pending.verificationUri,
      verificationUriComplete: pending.verificationUriComplete,
      expiresAt: pending.expiresAt,
      browserOpened: pending.browserOpened,
      error: pending.error || null,
    };
  }

  function publicStatus() {
    return {
      loggedIn: Boolean(tokens?.accessToken && tokens?.refreshToken),
      email: tokens?.email || '',
      pending: publicPending(),
    };
  }

  function isLoggedIn() {
    return Boolean(tokens?.accessToken && tokens?.refreshToken);
  }

  async function refreshTokens() {
    if (!tokens?.refreshToken) throw new Error('尚未登录 Grok 订阅');
    const { res, payload } = await postForm(GROK_OAUTH.tokenUrl, {
      grant_type: 'refresh_token',
      client_id: GROK_OAUTH.clientId,
      refresh_token: tokens.refreshToken,
    });
    if (res.status === 403) {
      throw new Error('Grok 订阅已登录，但当前档位未开通编程接口。请改用 API Key，或升级 SuperGrok。');
    }
    if (!res.ok) {
      const code = oauthError(payload, `HTTP ${res.status}`);
      if (res.status === 400 || res.status === 401 || code === 'invalid_grant') {
        persist(null);
        throw new Error('Grok 登录已失效，请重新在浏览器中验证');
      }
      throw new Error(`Grok token 刷新失败：${code}`);
    }
    return storeFromTokenResponse(payload);
  }

  async function getAccessToken() {
    if (!tokens?.refreshToken) throw new Error('尚未登录 Grok 订阅，请先在设置里用浏览器验证');
    if (tokens.accessToken && readExpiresAt(tokens) - REFRESH_SKEW_MS > now()) {
      return tokens.accessToken;
    }
    if (!refreshPromise) {
      refreshPromise = refreshTokens().finally(() => { refreshPromise = null; });
    }
    const next = await refreshPromise;
    return next.accessToken;
  }

  async function pollLogin(generation, device) {
    const deadline = now() + Math.max(30, Number(device.expires_in) || 900) * 1000;
    let interval = Math.max(1, Number(device.interval) || 5) * 1000;
    while (now() < deadline) {
      if (generation !== loginGeneration) return;
      await sleep(interval);
      if (generation !== loginGeneration) return;
      const { res, payload } = await postForm(GROK_OAUTH.tokenUrl, {
        grant_type: GROK_OAUTH.deviceGrant,
        client_id: GROK_OAUTH.clientId,
        device_code: device.device_code,
      });
      if (generation !== loginGeneration) return;
      const code = oauthError(payload, '');
      if (res.ok && payload.access_token) {
        storeFromTokenResponse(payload);
        pending = null;
        return;
      }
      if (code === 'authorization_pending') continue;
      if (code === 'slow_down') {
        interval = Math.min(30_000, interval + 5000);
        continue;
      }
      if (code === 'access_denied' || code === 'authorization_denied') {
        pending = { ...pending, status: 'error', error: '已取消浏览器验证' };
        return;
      }
      if (code === 'expired_token') {
        pending = { ...pending, status: 'error', error: '验证码已过期，请重新登录' };
        return;
      }
      pending = { ...pending, status: 'error', error: `Grok 登录失败：${code || `HTTP ${res.status}`}` };
      return;
    }
    if (generation === loginGeneration && pending?.status === 'pending') {
      pending = { ...pending, status: 'error', error: '登录超时，请重新打开浏览器验证' };
    }
  }

  async function startLogin() {
    if (pending?.status === 'pending' && pending.expiresAt > now()) {
      return publicStatus();
    }
    const generation = ++loginGeneration;
    const { res, payload } = await postForm(GROK_OAUTH.deviceCodeUrl, {
      client_id: GROK_OAUTH.clientId,
      scope: GROK_OAUTH.scope,
    });
    if (!res.ok || !payload.device_code || !payload.user_code) {
      throw new Error(`无法开始 Grok 登录：${oauthError(payload, `HTTP ${res.status}`)}`);
    }
    const verificationUri = payload.verification_uri_complete || payload.verification_uri;
    pending = {
      status: 'pending',
      userCode: String(payload.user_code),
      verificationUri: payload.verification_uri || verificationUri,
      verificationUriComplete: verificationUri,
      expiresAt: now() + Math.max(30, Number(payload.expires_in) || 900) * 1000,
      browserOpened: false,
      error: null,
    };
    try {
      openBrowser(pending.verificationUriComplete);
      pending.browserOpened = true;
    } catch (error) {
      pending.browserOpened = false;
      console.warn('[grok-auth] 无法自动打开浏览器：', error.message);
    }
    pollLogin(generation, payload).catch((error) => {
      if (generation !== loginGeneration) return;
      pending = { ...pending, status: 'error', error: error.message || 'Grok 登录失败' };
    });
    return publicStatus();
  }

  function logout() {
    loginGeneration += 1;
    pending = null;
    persist(null);
    return publicStatus();
  }

  return { isLoggedIn, publicStatus, startLogin, logout, getAccessToken };
}

export const grokAuth = createGrokAuth({
  file: path.join(config.paths.cache, 'grok-auth.json'),
});
