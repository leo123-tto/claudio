import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGrokAuth, GROK_OAUTH } from '../server/grok-auth.js';
import { assertAllowedOpenUrl } from '../server/open-url.js';
import { buildGrokBody, callGrokStream, extractGrokText, extractGrokStreamDelta } from '../server/llm/grok.js';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
    async json() { return body; },
  };
}

function jwtToken({ exp, email } = {}) {
  const payload = Buffer.from(JSON.stringify({
    exp: exp ?? Math.floor(Date.now() / 1000) + 3600,
    email: email || 'leo@example.com',
  })).toString('base64url');
  return `aaa.${payload}.sig`;
}

test('外链白名单只放行 Fish 与 xAI 登录页', () => {
  assert.equal(assertAllowedOpenUrl('https://fish.audio/zh-CN/app/developers/'), 'https://fish.audio/zh-CN/app/developers/');
  assert.equal(
    assertAllowedOpenUrl('https://auth.x.ai/oauth2/device?user_code=ABCD-EFGH'),
    'https://auth.x.ai/oauth2/device?user_code=ABCD-EFGH',
  );
  assert.doesNotThrow(() => assertAllowedOpenUrl('https://accounts.x.ai/sign-in'));
  assert.throws(() => assertAllowedOpenUrl('https://evil.example/phish'));
  assert.throws(() => assertAllowedOpenUrl('https://auth.x.ai.evil.com/oauth2/device'));
  assert.throws(() => assertAllowedOpenUrl('file:///etc/passwd'));
});

test('设备码登录会打开浏览器，并在确认后把 token 以 0600 落盘', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-grok-'));
  const file = path.join(dir, 'grok-auth.json');
  const opened = [];
  const calls = [];
  let nowMs = 1_000_000;
  const access = jwtToken({ email: 'leo@x.ai' });
  const auth = createGrokAuth({
    file,
    openBrowser: (url) => opened.push(url),
    sleep: async (ms) => { nowMs += ms; },
    now: () => nowMs,
    fetchFn: async (url, options) => {
      calls.push({ url, body: String(options.body) });
      if (url === GROK_OAUTH.deviceCodeUrl) {
        return jsonResponse(200, {
          device_code: 'dev-1',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://auth.x.ai/activate',
          verification_uri_complete: 'https://auth.x.ai/activate?user_code=ABCD-EFGH',
          expires_in: 600,
          interval: 1,
        });
      }
      if (calls.filter((item) => item.url === GROK_OAUTH.tokenUrl).length === 1) {
        return jsonResponse(400, { error: 'authorization_pending' });
      }
      return jsonResponse(200, {
        access_token: access,
        refresh_token: 'refresh-1',
        id_token: access,
        expires_in: 900,
      });
    },
  });

  const started = await auth.startLogin();
  assert.equal(started.pending.userCode, 'ABCD-EFGH');
  assert.equal(started.pending.verificationUriComplete, 'https://auth.x.ai/activate?user_code=ABCD-EFGH');
  assert.deepEqual(opened, ['https://auth.x.ai/activate?user_code=ABCD-EFGH']);
  assert.match(calls[0].body, /client_id=/);
  assert.doesNotMatch(JSON.stringify(started), /dev-1|refresh-1/);

  for (let i = 0; i < 30 && !auth.isLoggedIn(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(auth.isLoggedIn(), true);
  assert.equal(auth.publicStatus().email, 'leo@x.ai');
  assert.equal(auth.publicStatus().pending, null);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.refreshToken, 'refresh-1');
  assert.equal(await auth.getAccessToken(), access);
  assert.doesNotMatch(JSON.stringify(auth.publicStatus()), /refresh-1|aaa\./);

  auth.logout();
  assert.equal(auth.isLoggedIn(), false);
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('过期 token 会用 refresh_token 换新对，并拒绝把 token 暴露到公开状态', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-grok-'));
  const file = path.join(dir, 'grok-auth.json');
  const expired = jwtToken({ exp: Math.floor(Date.now() / 1000) - 10, email: 'old@x.ai' });
  const fresh = jwtToken({ email: 'leo@x.ai' });
  fs.writeFileSync(file, JSON.stringify({
    accessToken: expired,
    refreshToken: 'refresh-old',
    idToken: expired,
    expiresAt: Date.now() - 1000,
    email: 'old@x.ai',
  }));

  let refreshed = false;
  const auth = createGrokAuth({
    file,
    fetchFn: async (_url, options) => {
      refreshed = true;
      assert.match(String(options.body), /grant_type=refresh_token/);
      assert.match(String(options.body), /refresh-old/);
      return jsonResponse(200, {
        access_token: fresh,
        refresh_token: 'refresh-new',
        id_token: fresh,
        expires_in: 900,
      });
    },
  });

  assert.equal(auth.isLoggedIn(), true);
  assert.equal(await auth.getAccessToken(), fresh);
  assert.equal(refreshed, true);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.refreshToken, 'refresh-new');
  assert.equal(auth.publicStatus().email, 'leo@x.ai');
  assert.doesNotMatch(JSON.stringify(auth.publicStatus()), /refresh-new|refresh-old/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Grok Responses 请求走订阅代理形状，并抽出口播文本', () => {
  const body = buildGrokBody('返回指定结构', { model: 'grok-4.6', effort: 'low', stream: true });
  assert.equal(body.model, 'grok-4.6');
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.deepEqual(body.reasoning, { effort: 'low' });
  assert.match(body.input.map((item) => item.content).join('\n'), /json/i);

  const fast = buildGrokBody('返回指定结构', { model: 'grok-composer-2.5-fast', effort: 'low' });
  assert.equal(fast.reasoning, undefined);

  assert.equal(extractGrokText({
    output: [{ content: [{ type: 'output_text', text: '{"say":"连接正常"}' }] }],
  }), '{"say":"连接正常"}');
  assert.equal(extractGrokStreamDelta({ type: 'response.output_text.delta', delta: '你好' }), '你好');
});

test('Grok 流式输出会拼接 output_text.delta', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"{\\"say\\":"}\n\n'));
      controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"\\"ok\\"}"}\n\n'));
      controller.close();
    },
  });
  const text = await callGrokStream('返回指定结构', {
    model: 'grok-4.6',
    getAccessToken: async () => 'tok',
    fetchFn: async () => ({ ok: true, status: 200, body: stream }),
  });
  assert.equal(text, '{"say":"ok"}');
});
