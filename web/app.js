import { resolveAirPlayMode } from './airplay.js';
import { executePlayerAction } from './player-actions.js';

// Claudio · Nothing 风格播放器
// 双音轨交叉淡入 + 歌词滚动 + 波形 + 预生成 + 完整控件 + 时钟 + 主题切换。
const $ = (id) => document.getElementById(id);
const el = {};
[
  'clockCanvas', 'weekday', 'date', 'waveBig', 'nowTitle', 'nowState',
  'prevBtn', 'playBtn', 'nextBtn', 'stopBtn', 'dislikeBtn', 'favBtn', 'vol',
  'curTime', 'durTime', 'bar', 'barFill', 'queueCount',
  'liveTag', 'connMsg', 'stream', 'nowPlaying', 'moodInput', 'sleepBtn', 'sleepBadge', 'sendBtn', 'connState',
  'fishCredit', 'fishCreditVal', 'miniLyric', 'airplayBtn',
  'settingsBtn', 'settingsBackdrop', 'settingsClose', 'providerSelect', 'modelSelect', 'effortSelect',
  'codexSettings', 'claudeSettings', 'deepseekSettings', 'grokSettings', 'claudeAccessSelect', 'claudeModelSelect',
  'deepseekModelSelect', 'deepseekApiKey', 'deepseekKeyHint',
  'grokModelSelect', 'grokEffortSelect', 'grokLoginHint', 'grokLoginBtn', 'grokLogoutBtn', 'grokOpenVerifyBtn', 'grokLoginResult',
  'fishApiKey', 'fishModelSelect', 'fishVoiceId', 'fishKeyStatus', 'testFishBtn', 'fishTestResult', 'fishPreview',
  'recommendationSelect', 'providerHint', 'testModelBtn', 'saveSettingsBtn', 'settingsResult',
  'favoritesCount', 'favoritePlaylistInput', 'importFavoritesBtn', 'favoritesImportResult',
  'profileSummary', 'refreshProfileBtn',
].forEach((id) => (el[id] = $(id)));

// ── Fish Audio 余额：右上角小组件，点一下开充值页（按量计费，低于 $1 标红提醒）──
const FISH_RECHARGE = 'https://fish.audio/zh-CN/app/developers/';
async function loadFishCredit() {
  try {
    const j = await (await fetch('/api/fish-credit')).json();
    if (j.ok && j.credit != null) {
      const v = Number(j.credit);
      el.fishCreditVal.textContent = `$${v.toFixed(2)}`;
      el.fishCredit.classList.toggle('low', v < 1);
      el.fishCredit.title = `Fish Audio 余额 $${v.toFixed(2)}（按量计费）· 点击去充值`;
    } else {
      el.fishCreditVal.textContent = '—';
      el.fishCredit.title = 'Fish Audio 余额暂取不到 · 点击去充值页';
    }
  } catch { el.fishCreditVal.textContent = '—'; }
}
// Tauri webview 里 window.open 是 no-op（没浏览器开新标签页）→ 交后端用系统默认浏览器打开；普通浏览器仍直接开新标签
function openExternal(url) {
  if (window.__TAURI__) fetch('/api/open?url=' + encodeURIComponent(url)).catch(() => {});
  else window.open(url, '_blank', 'noopener');
}
el.fishCredit.addEventListener('click', () => openExternal(FISH_RECHARGE));
loadFishCredit();
setInterval(loadFishCredit, 5 * 60 * 1000); // 每 5 分钟刷新

// ── 设置：模型供应商 / ChatGPT 模型 / 推荐探索度，均为运行时切换 ──
let settingsPayload = null;
let grokPollTimer = null;
const PROVIDER_NAMES = { codex: 'ChatGPT', claude: 'Claude', deepseek: 'DeepSeek', grok: 'Grok' };
function showSettingsResult(text, kind = '') {
  el.settingsResult.textContent = text;
  el.settingsResult.className = `settings-result ${kind}`.trim();
}
function showFishResult(text, kind = '') {
  el.fishTestResult.textContent = text;
  el.fishTestResult.className = `settings-result ${kind}`.trim();
}
function showGrokResult(text, kind = '') {
  el.grokLoginResult.textContent = text;
  el.grokLoginResult.className = `settings-result ${kind}`.trim();
}
function grokAuthState() {
  return settingsPayload?.auth?.grok || { loggedIn: false, email: '', pending: null };
}
function syncGrokLoginUi() {
  const grok = grokAuthState();
  const pending = grok.pending?.status === 'pending' ? grok.pending : null;
  el.grokLoginBtn.classList.toggle('hidden', Boolean(grok.loggedIn));
  el.grokLogoutBtn.classList.toggle('hidden', !grok.loggedIn);
  el.grokOpenVerifyBtn.classList.toggle('hidden', !pending?.verificationUriComplete && !pending?.verificationUri);
  el.grokLoginBtn.disabled = Boolean(pending);
  if (pending) {
    el.grokLoginHint.textContent = `请在打开的浏览器里完成验证${pending.userCode ? `，验证码 ${pending.userCode}` : ''}。`;
    showGrokResult(pending.browserOpened === false
      ? '未能自动打开浏览器，请点「打开验证页」。'
      : '已弹出系统浏览器，正在等待验证…');
  } else if (grok.loggedIn) {
    el.grokLoginHint.textContent = grok.email
      ? `已登录 Grok 订阅（${grok.email}）。登录态保存在本机，下次打开 App 无需再验证。`
      : '已登录 Grok 订阅。登录态保存在本机，下次打开 App 无需再验证。';
    showGrokResult('Grok 订阅可用。切换后从下一次推荐开始生效。', 'ok');
  } else if (grok.pending?.status === 'error') {
    el.grokLoginHint.textContent = '登录未完成，可以重新弹出浏览器验证。';
    showGrokResult(grok.pending.error || '登录失败', 'error');
  } else {
    el.grokLoginHint.textContent = '尚未登录 Grok 订阅。点登录后会弹出系统浏览器，用 SuperGrok / X Premium+ 账号验证。';
    showGrokResult('登录态只保存在这台电脑，界面不会回显 token。');
  }
}
function stopGrokPoll() {
  if (grokPollTimer) {
    clearInterval(grokPollTimer);
    grokPollTimer = null;
  }
}
async function refreshGrokStatus() {
  try {
    const data = await (await fetch('/api/settings/grok')).json();
    if (!data.ok) throw new Error(data.error || '读取失败');
    if (data.settings) settingsPayload = data.settings;
    else if (settingsPayload) settingsPayload.auth = { ...(settingsPayload.auth || {}), grok: data.grok };
    syncGrokLoginUi();
    syncProviderControls();
    const pending = grokAuthState().pending?.status === 'pending';
    if (!pending) stopGrokPoll();
  } catch (error) {
    showGrokResult(`登录状态读取失败：${error.message}`, 'error');
  }
}
function startGrokPoll() {
  stopGrokPoll();
  grokPollTimer = setInterval(refreshGrokStatus, 1500);
}
function showFavoritesResult(text, kind = '') {
  el.favoritesImportResult.textContent = text;
  el.favoritesImportResult.className = `settings-result ${kind}`.trim();
}
function syncProviderControls() {
  const provider = el.providerSelect.value;
  const available = settingsPayload?.availability?.[provider];
  el.codexSettings.classList.toggle('hidden', provider !== 'codex');
  el.claudeSettings.classList.toggle('hidden', provider !== 'claude');
  el.deepseekSettings.classList.toggle('hidden', provider !== 'deepseek');
  el.grokSettings.classList.toggle('hidden', provider !== 'grok');
  const descriptions = {
    codex: '使用 ChatGPT 订阅；Luna 默认最快且质量平衡。',
    grok: '使用 Grok 订阅；在浏览器验证一次后，登录态保存在本机。',
    claude: '使用 Claude 订阅，可联动选择 Sonnet 或 Opus。',
    deepseek: '使用 DeepSeek API，可联动选择 V4 Flash 或 V4 Pro。',
  };
  el.providerHint.textContent = `${descriptions[provider]} ${available ? '已检测到接入入口，可用“保存并测速”确认账号状态。' : '当前未检测到接入入口，请先确认登录或 API 配置。'}`;
}
async function loadSettings() {
  try {
    const data = await (await fetch('/api/settings')).json();
    if (!data.ok) throw new Error(data.error || '读取失败');
    settingsPayload = data.settings;
    el.providerSelect.value = settingsPayload.llm.provider;
    el.modelSelect.value = settingsPayload.llm.models.codex;
    el.claudeModelSelect.value = settingsPayload.llm.models.claude;
    el.deepseekModelSelect.value = settingsPayload.llm.models.deepseek;
    el.grokModelSelect.value = settingsPayload.llm.models.grok || 'grok-4.6';
    el.effortSelect.value = settingsPayload.llm.reasoningEffort;
    el.grokEffortSelect.value = settingsPayload.llm.reasoningEffort;
    el.fishModelSelect.value = settingsPayload.tts.fish.model;
    el.fishVoiceId.value = settingsPayload.tts.fish.referenceId || '';
    el.recommendationSelect.value = settingsPayload.recommendation.mode;
    const deepseekReady = settingsPayload.credentials.deepseek;
    const fishReady = settingsPayload.credentials.fish;
    el.deepseekApiKey.value = '';
    el.fishApiKey.value = '';
    el.deepseekApiKey.placeholder = deepseekReady ? '已配置 · 留空不修改' : '填写后保存在本机';
    el.fishApiKey.placeholder = fishReady ? '已配置 · 留空不修改' : '填写后保存在本机';
    el.deepseekKeyHint.textContent = deepseekReady ? 'API Key 已配置，界面不会回显原值。' : '尚未配置 API Key。';
    el.fishKeyStatus.textContent = fishReady ? 'API 已配置' : '未配置 API';
    syncGrokLoginUi();
    if (grokAuthState().pending?.status === 'pending') startGrokPoll();
    else stopGrokPoll();
    syncProviderControls();
  } catch (error) {
    showSettingsResult(`设置读取失败：${error.message}`, 'error');
  }
}
async function saveSettings({ quiet = false } = {}) {
  try {
    const credentialResponse = await fetch('/api/settings/credentials', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deepseekApiKey: el.deepseekApiKey.value,
        fishApiKey: el.fishApiKey.value,
      }),
    });
    const credentialData = await credentialResponse.json();
    if (!credentialData.ok) throw new Error(credentialData.error || '密钥保存失败');
    const response = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        llm: {
          provider: el.providerSelect.value,
          models: {
            codex: el.modelSelect.value,
            claude: el.claudeModelSelect.value,
            deepseek: el.deepseekModelSelect.value,
            grok: el.grokModelSelect.value,
          },
          reasoningEffort: el.providerSelect.value === 'grok' ? el.grokEffortSelect.value : el.effortSelect.value,
        },
        tts: {
          provider: 'fish',
          fish: { model: el.fishModelSelect.value, referenceId: el.fishVoiceId.value },
        },
        recommendation: { mode: el.recommendationSelect.value },
      }),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || '保存失败');
    settingsPayload = data.settings;
    el.deepseekApiKey.value = '';
    el.fishApiKey.value = '';
    el.deepseekApiKey.placeholder = settingsPayload.credentials.deepseek ? '已配置 · 留空不修改' : '填写后保存在本机';
    el.fishApiKey.placeholder = settingsPayload.credentials.fish ? '已配置 · 留空不修改' : '填写后保存在本机';
    el.deepseekKeyHint.textContent = settingsPayload.credentials.deepseek ? 'API Key 已配置，界面不会回显原值。' : '尚未配置 API Key。';
    el.fishKeyStatus.textContent = settingsPayload.credentials.fish ? 'API 已配置' : '未配置 API';
    syncGrokLoginUi();
    syncProviderControls();
    if (!quiet) showSettingsResult('已保存，从下一次推荐开始生效。', 'ok');
    return true;
  } catch (error) {
    showSettingsResult(`保存失败：${error.message}`, 'error');
    return false;
  }
}
async function loadProfileSummary() {
  el.profileSummary.textContent = '正在读取…';
  try {
    const data = await (await fetch('/api/profile')).json();
    if (!data.ok) throw new Error(data.error || '读取失败');
    const profile = data.profile;
    const artists = profile.topArtists.filter((item) => item.score > 0).slice(0, 6)
      .map((item) => `${item.artist} ${item.score > 0 ? '+' : ''}${item.score}`).join(' · ');
    const memories = profile.stableMemories.slice(-5).map((item) => `• ${item.value}`).join('\n');
    el.profileSummary.textContent = [
      artists ? `目前偏好的歌手方向：${artists}` : '还没有足够的真实听歌行为，先从口味档案开始。',
      memories || '稳定记忆尚在积累；模型推断需要至少两次独立证据才会确认。',
      profile.pendingMemoryCount ? `另有 ${profile.pendingMemoryCount} 条候选记忆等待更多证据。` : '',
    ].filter(Boolean).join('\n');
  } catch (error) {
    el.profileSummary.textContent = `画像读取失败：${error.message}`;
  }
}
async function loadFavoritesSummary() {
  try {
    const data = await (await fetch('/api/favorites')).json();
    if (!data.ok) throw new Error(data.error || '读取失败');
    el.favoritesCount.textContent = `${data.total} 首`;
  } catch (error) {
    el.favoritesCount.textContent = '读取失败';
  }
}
function openSettings() {
  el.settingsBackdrop.classList.remove('hidden');
  el.settingsBackdrop.setAttribute('aria-hidden', 'false');
  loadSettings();
  loadFavoritesSummary();
  loadProfileSummary();
}
function closeSettings() {
  el.settingsBackdrop.classList.add('hidden');
  el.settingsBackdrop.setAttribute('aria-hidden', 'true');
  stopGrokPoll();
}
el.settingsBtn.addEventListener('click', openSettings);
el.settingsClose.addEventListener('click', closeSettings);
el.settingsBackdrop.addEventListener('click', (event) => { if (event.target === el.settingsBackdrop) closeSettings(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeSettings(); });
el.providerSelect.addEventListener('change', syncProviderControls);
el.saveSettingsBtn.addEventListener('click', () => saveSettings());
el.refreshProfileBtn.addEventListener('click', loadProfileSummary);
el.grokLoginBtn.addEventListener('click', async () => {
  el.grokLoginBtn.disabled = true;
  showGrokResult('正在打开系统浏览器…');
  try {
    const data = await (await fetch('/api/settings/grok/login', { method: 'POST' })).json();
    if (!data.ok) throw new Error(data.error || '无法开始登录');
    if (data.settings) settingsPayload = data.settings;
    else if (settingsPayload) settingsPayload.auth = { ...(settingsPayload.auth || {}), grok: data.grok };
    syncGrokLoginUi();
    const pending = grokAuthState().pending;
    const verifyUrl = pending?.verificationUriComplete || pending?.verificationUri;
    if (verifyUrl && pending?.browserOpened === false) openExternal(verifyUrl);
    startGrokPoll();
  } catch (error) {
    el.grokLoginBtn.disabled = false;
    showGrokResult(`无法开始登录：${error.message}`, 'error');
  }
});
el.grokLogoutBtn.addEventListener('click', async () => {
  stopGrokPoll();
  try {
    const data = await (await fetch('/api/settings/grok/logout', { method: 'POST' })).json();
    if (!data.ok) throw new Error(data.error || '退出失败');
    if (data.settings) settingsPayload = data.settings;
    else if (settingsPayload) settingsPayload.auth = { ...(settingsPayload.auth || {}), grok: data.grok };
    syncGrokLoginUi();
    syncProviderControls();
  } catch (error) {
    showGrokResult(`退出失败：${error.message}`, 'error');
  }
});
el.grokOpenVerifyBtn.addEventListener('click', () => {
  const pending = grokAuthState().pending;
  const verifyUrl = pending?.verificationUriComplete || pending?.verificationUri;
  if (verifyUrl) openExternal(verifyUrl);
});
el.importFavoritesBtn.addEventListener('click', async () => {
  const playlist = el.favoritePlaylistInput.value.trim();
  if (!playlist) return showFavoritesResult('请先粘贴网易云歌单链接或歌单 ID。', 'error');
  el.importFavoritesBtn.disabled = true;
  showFavoritesResult('正在读取歌单并合并…');
  try {
    const response = await fetch('/api/favorites/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playlist }),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || '导入失败');
    el.favoritePlaylistInput.value = '';
    el.favoritesCount.textContent = `${data.total} 首`;
    showFavoritesResult(`导入完成：读取 ${data.received} 首，新增 ${data.added} 首，跳过重复 ${data.duplicates} 首。`, 'ok');
  } catch (error) {
    showFavoritesResult(`导入失败：${error.message}`, 'error');
  } finally {
    el.importFavoritesBtn.disabled = false;
  }
});
el.testModelBtn.addEventListener('click', async () => {
  el.testModelBtn.disabled = true;
  showSettingsResult('正在保存并测速…');
  try {
    if (!await saveSettings({ quiet: true })) return;
    const data = await (await fetch('/api/settings/test', { method: 'POST' })).json();
    if (!data.ok) throw new Error(data.error || '测速失败');
    const timing = data.timing;
    showSettingsResult(`${PROVIDER_NAMES[timing.provider] || timing.provider} · ${timing.model}：首字 ${(timing.firstTextMs / 1000).toFixed(1)} 秒，完成 ${(timing.totalMs / 1000).toFixed(1)} 秒。`, 'ok');
  } catch (error) {
    showSettingsResult(`测速失败：${error.message}`, 'error');
  } finally {
    el.testModelBtn.disabled = false;
  }
});
el.testFishBtn.addEventListener('click', async () => {
  el.testFishBtn.disabled = true;
  el.fishPreview.pause();
  el.fishPreview.classList.add('hidden');
  showFishResult('正在保存并生成测试语音…');
  try {
    if (!await saveSettings({ quiet: true })) throw new Error('设置保存失败');
    const data = await (await fetch('/api/settings/test-fish', { method: 'POST' })).json();
    if (!data.ok) throw new Error(data.error || 'Fish 测试失败');
    el.fishPreview.src = data.audioUrl;
    el.fishPreview.classList.remove('hidden');
    const timing = data.timing;
    showFishResult(`${timing.model}：首段音频 ${(timing.firstAudioMs / 1000).toFixed(1)} 秒，完成 ${(timing.totalMs / 1000).toFixed(1)} 秒。`, 'ok');
    try { await el.fishPreview.play(); } catch { /* WebView 阻止自动播放时保留手动播放控件 */ }
    loadFishCredit();
  } catch (error) {
    showFishResult(`语音测试失败：${error.message}`, 'error');
  } finally {
    el.testFishBtn.disabled = false;
  }
});

// ── 全局指针：把鼠标位置写进 CSS 变量 --mx/--my（px）与 --mxr/--myr（0~1），
//    驱动光晕跟随 / 点阵聚光 / 卡片响应。逐帧只写一次（dirty flag），纯合成层、零 canvas。
//    仅在「精确指针 + 支持 hover」的桌面注册；触屏/竖屏完全跳过。──
if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
  let px = 0, py = 0, pdirty = false;
  addEventListener('pointermove', (e) => {
    px = e.clientX; py = e.clientY;
    if (pdirty) return;
    pdirty = true;
    requestAnimationFrame(() => {
      pdirty = false;
      const r = document.documentElement.style;
      r.setProperty('--mx', px + 'px');
      r.setProperty('--my', py + 'px');
      r.setProperty('--mxr', (px / innerWidth).toFixed(4));
      r.setProperty('--myr', (py / innerHeight).toFixed(4));
    });
  }, { passive: true });
}

// ── 时钟 ──
const WEEK = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function tick() {
  const d = new Date();
  el.weekday.textContent = WEEK[d.getDay()];
  el.date.textContent = `${String(d.getDate()).padStart(2, '0')} · ${MON[d.getMonth()]} · ${d.getFullYear()}`;
}
tick();
setInterval(tick, 1000);

// ── LED 点阵时钟（canvas 自绘：冒号垂直居中 + 呼吸 + 鼠标照亮点阵）──
const DIGITS = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};
const clk = el.clockCanvas;
const cctx = clk.getContext('2d');
let cmx = -999, cmy = -999;
clk.addEventListener('mousemove', (e) => { const r = clk.getBoundingClientRect(); cmx = (e.clientX - r.left) * devicePixelRatio; cmy = (e.clientY - r.top) * devicePixelRatio; });
clk.addEventListener('mouseleave', () => { cmx = cmy = -999; });

function drawClock() {
  const dpr = devicePixelRatio;
  const W = clk.clientWidth * dpr, H = clk.clientHeight * dpr;
  if (clk.width !== W || clk.height !== H) { clk.width = W; clk.height = H; }
  cctx.clearRect(0, 0, W, H);

  const now = new Date();
  const s = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
  const COLS = 25, ROWS = 7;
  const cell = Math.min(W / (COLS + 2), H / (ROWS + 1.5));
  const dotR = cell * 0.22; // 点更细 → LED 更精致（Nothing 风格）
  const ox = (W - COLS * cell) / 2, oy = (H - ROWS * cell) / 2;
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim() || '#00e08a';
  const fg = css.getPropertyValue('--fg').trim() || '#fff';

  function dot(cx, cy, on, color, alpha) {
    const near = Math.max(0, 1 - Math.hypot(cx - cmx, cy - cmy) / (cell * 5));
    cctx.beginPath();
    cctx.arc(cx, cy, dotR, 0, Math.PI * 2);
    if (on) {
      cctx.shadowColor = color; cctx.shadowBlur = dotR * 1.4 + near * 12;
      cctx.fillStyle = color; cctx.globalAlpha = alpha ?? 1;
    } else {
      cctx.shadowBlur = 0; cctx.fillStyle = fg; cctx.globalAlpha = 0.05 + near * 0.45;
    }
    cctx.fill();
  }
  function digit(ch, colOff) {
    const pat = DIGITS[ch] || DIGITS['0'];
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
      dot(ox + (colOff + c) * cell + cell / 2, oy + r * cell + cell / 2, pat[r][c] === '1', fg);
    }
  }
  digit(s[0], 0); digit(s[1], 6);
  const colonAlpha = 0.3 + 0.7 * Math.abs(Math.sin(performance.now() / 700));
  for (const r of [2, 4]) dot(ox + 12 * cell + cell / 2, oy + r * cell + cell / 2, true, accent, colonAlpha);
  digit(s[2], 14); digit(s[3], 20);

  cctx.shadowBlur = 0; cctx.globalAlpha = 1;
  requestAnimationFrame(drawClock);
}
drawClock();

// ── 主题切换 ──
const savedTheme = localStorage.getItem('claudio-theme') || 'dark';
document.documentElement.dataset.theme = savedTheme;
syncThemeBtns(savedTheme);
document.querySelectorAll('[data-theme-btn]').forEach((b) => {
  b.addEventListener('click', () => {
    const t = b.dataset.themeBtn;
    const apply = () => {
      document.documentElement.dataset.theme = t;
      localStorage.setItem('claudio-theme', t);
      syncThemeBtns(t);
    };
    // 支持的浏览器用 View Transitions 做柔和揭示，不支持则即时切换（零风险回退）
    if (document.startViewTransition) document.startViewTransition(apply);
    else apply();
  });
});
function syncThemeBtns(t) {
  document.querySelectorAll('[data-theme-btn]').forEach((b) => b.classList.toggle('active', b.dataset.themeBtn === t));
}

// （已去掉中/外切换：默认中文女声口播，选歌不限语言、看情况混搭）

// ── 播放引擎 ──
const MUSIC_LEAD = 6; // 口播结束前多少秒，下一首歌以背景音垫进来（用户要 5~6 秒）
const BG_VOL = 0.13; // 口播/交互时音乐压到的背景音量（约 13%，让口播更突出）
const SAY_GAIN = 1.25; // 口播增益：TTS 人声 RMS 比音乐低，用 GainNode 放大到 1.25x 提响（element.volume 上限 1.0 做不到）
const SLEEP_MIN = 30; // 睡眠定时时长（分钟）
const trackA = new Audio(), trackB = new Audio();
[trackA, trackB].forEach((a) => (a.preload = 'auto'));
let active = trackA, idle = trackB;
const AIRPLAY_MODE = resolveAirPlayMode({
  tauri: Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__),
  webkitPicker: typeof trackA.webkitShowPlaybackTargetPicker === 'function',
});

// 歌曲直链跨域，走后端 /proxy 转成同源才能做真频谱；口播 /tts 本就同源不变
const proxyUrl = (u) => (typeof u === 'string' && /^https?:\/\//.test(u) && !u.startsWith(location.origin)) ? `/proxy?url=${encodeURIComponent(u)}` : u;

// WebAudio 真频谱：AudioContext + AnalyserNode 接两条音轨。须在用户手势内激活（autoplay 同款限制）；
// 两个 MediaElementSource 都汇入同一 analyser → destination，交叉淡入两轨同响时是混合频谱（正合适）。
let actx = null, analyser = null, freqData = null;
const sourced = new WeakSet(); // 记录已建过 MediaElementSource 的轨：同一 audio 元素重复 createMediaElementSource 会抛错，只建一次
const gains = new WeakMap();   // track → GainNode：音量走 gain。关键——WKWebView 下音频一旦接入 WebAudio 图，element.volume 对输出无效，必须用 GainNode 控音量
const volMap = new WeakMap();  // track → 意向音量 0~1：读音量的真源（element.volume 被 gain 接管后不再可靠）
function trackVol(track) { return volMap.has(track) ? volMap.get(track) : track.volume; }
function setTrackVol(track, v) {
  v = Math.max(0, v); // 允许 >1：GainNode 可放大（用于口播提响）；element.volume 回退路径下方再夹到 ≤1
  volMap.set(track, v);
  const g = gains.get(track);
  if (g) { try { g.gain.value = Math.min(v, 4); } catch {} if (track.volume !== 1) track.volume = 1; } // 走 gain（可 >1）；元素音量设满
  else track.volume = Math.min(1, v); // WebAudio 未起（或建图失败）→ 退回元素音量（上限 1.0）
}
function initAudio() {
  // AirPlay 必须让 HTMLMediaElement 保持原生直连输出；接进 WebAudio 后，
  // WebKit 的播放目标选择器可能能选设备却没有声音。直连模式仍保留音量、ducking、淡入淡出，
  // 波形自动使用已有的拟态回退。
  if (AIRPLAY_MODE.directMedia) return;
  if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    actx = new AC();
    analyser = actx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.8;
    freqData = new Uint8Array(analyser.frequencyBinCount);
    analyser.connect(actx.destination); // 先连输出再逐个接源——任一源创建后立即有声路径，不致静音双音轨皇冠
    for (const t of [trackA, trackB]) {
      if (sourced.has(t)) continue; // 已建过源的轨不重复建（防部分失败后重入抛 InvalidStateError、FFT 永久退化）
      const src = actx.createMediaElementSource(t);
      const g = actx.createGain();
      g.gain.value = trackVol(t); // 继承当前意向音量（默认 1）
      src.connect(g).connect(analyser); // source → gain → analyser → destination：音量走 gain，WKWebView 下才真生效
      gains.set(t, g);
      t.volume = 1; // 元素音量交给 gain，自身设满
      sourced.add(t);
    }
  } catch (e) {
    console.warn('[audio] FFT 初始化失败，退回音量波形', e.message);
    actx = null; analyser = null;
  }
}
let queue = [], idx = -1;
let activeEpisode = null;
let started = false, busy = false, crossing = false, lastLyric = -1;
let lrc = null, masterVol = 1;
let sleepEnd = null, sleepTimer = null, sleepBadgeTimer = null;
let ducked = false; // 是否处于「说话时当前歌背景小声续播」态
let overlaying = false; // 是否处于「口播叠在背景歌之上」阶段（此时 active 是旧歌、不归常规进度/blend 管）
let streamingActive = false; // 本次交互是否走流式（WS sayReady/episode 驱动）
let streamPending = null; // 流式中后到的完整 episode（歌）
let sayEnded = false; // 口播是否已念完（在等歌）
let streamDone = false; // finishAfterSay 是否已执行（WS 与 HTTP 可能都触发，防重）
let responseHeard = false; // 本轮 Fish 已真正开始播放；一旦开口，就不再因 HTTP 尚未收尾而误报 15 秒超时
let watchdog = null; // 看门狗：duck/overlay 后必须有界时间内接管或强制恢复，兜住所有失败路径
let sayOnEnd = null; // 当前 overlay 监听的 AbortController，重入时 abort，防泄漏与错时触发
const favs = new Set(JSON.parse(localStorage.getItem('claudio-favs') || '[]'));
const handledEpisodeActions = new Set();
let songSession = null;
const lastSongStarts = new Map();

function reportListeningEvent(type, extra = {}) {
  fetch('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, ...extra }),
  }).catch(() => {});
}

function closeSongSession(reason = 'skip') {
  if (!songSession) return;
  const session = songSession;
  songSession = null;
  const currentTime = Number(session.track?.currentTime || 0);
  const duration = Number(session.track?.duration || 0);
  const listenRatio = duration > 0 ? Math.min(1, currentTime / duration) : (reason === 'completed' ? 1 : 0);
  if (reason === 'completed') {
    reportListeningEvent('play_completed', {
      song: session.song,
      listenedSec: currentTime,
      durationSec: duration,
      listenRatio,
      discoveryType: session.discoveryType,
    });
  } else if (reason === 'skip') {
    reportListeningEvent('skip', {
      song: session.song,
      listenedSec: currentTime,
      durationSec: duration,
      listenRatio,
      discoveryType: session.discoveryType,
    });
  }
}

function startSongSession(item) {
  closeSongSession('skip');
  const song = { title: item.meta.title, artist: item.meta.artist };
  const key = `${song.title}|${song.artist}`;
  if (lastSongStarts.has(key)) reportListeningEvent('replay', { song, source: 'player' });
  lastSongStarts.set(key, Date.now());
  songSession = {
    song,
    track: active,
    discoveryType: item.meta.discoveryType || 'adjacent',
    progressSent: false,
  };
  reportListeningEvent('play_started', {
    song,
    discoveryType: songSession.discoveryType,
    source: 'player',
  });
}

const fmt = (s) => (isFinite(s) && s >= 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
const setState = (s) => (el.nowState.textContent = s);
const setPlayIcon = (p) => { el.playBtn.textContent = p ? '⏸' : '▶'; document.body.classList.toggle('playing', p); };
// 迷你窗里那一行：显示当前歌词 / 歌名 / 口播态（随播放更新）
const setMiniLyric = (s) => { if (el.miniLyric) el.miniLyric.textContent = s || ''; };
// 当前主轨目标音量：歌曲=原音量，口播=提响（集中一处，避免各路径漏改导致口播音量不一致）
const songVol = () => masterVol;
const sayVol = () => SAY_GAIN * masterVol;
const activeTargetVol = () => (queue[idx]?.type === 'tts' ? sayVol() : songVol());

function loadEpisode(ep) {
  if (!ep || !ep.queue || !ep.queue.length) return;
  closeSongSession('skip');
  disarmWatchdog(); // 直接接管播放，撤看门狗
  cancelBlend(); // 全新接管：停掉可能还在跑的交叉渐入，免得 idle 轨被抢
  activeEpisode = ep;
  queue = ep.queue;
  idx = -1;
  el.queueCount.textContent = `${queue.filter((q) => q.type === 'song').length} TRACKS`;
  renderStream(ep);
  playIndex(0);
}

function playIndex(i) {
  if (i !== idx) closeSongSession('skip');
  if (i >= queue.length) {
    // 聊天 / 控制的 TTS 念完就结束，绝不能因为队列为空自动生成一批歌。
    if (activeEpisode?.intent === 'chat' || activeEpisode?.intent === 'control') {
      active.pause();
      setPlayIcon(false);
      if (activeEpisode.intent === 'control') applyEpisodeAction(activeEpisode);
      else setState('LISTENING');
      return;
    }
    setState('这期放完了'); requestNext(); return;
  }
  if (i < 0) i = 0;
  idx = i;
  const item = queue[i];
  active.src = proxyUrl(item.url);
  setTrackVol(active, item.type === 'tts' ? sayVol() : songVol()); // 口播提响，歌曲原音量
  active.play().then(() => setPlayIcon(true)).catch(() => setState('点 ▶ 授权播放'));
  crossing = false;
  onItemStart(item, i);
}

function onItemStart(item, i) {
  lastLyric = -1;
  if (item.type === 'song') {
    startSongSession(item);
    el.nowTitle.textContent = `${item.meta.title} · ${item.meta.artist}`;
    setState('PLAYING');
    el.favBtn.classList.toggle('fav-on', favs.has(songKey(item.meta)));
    el.dislikeBtn.classList.remove('dislike-on');
    lrc = parseLrc(item.meta.lyric);
    highlightLine(i);
    renderLyric(i);
    setMiniLyric(`♪ ${item.meta.title}`); // 起始先显示歌名，有歌词后由 updateLyric 滚动覆盖
    el.nowPlaying.textContent = `Now playing: ${item.meta.title} — ${item.meta.artist}`;
  } else {
    el.nowTitle.textContent = 'CLAUDIO';
    setState('ON AIR · 口播');
    setMiniLyric('CLAUDIO · 口播');
    lrc = null;
    highlightLine(i);
    // 当前口播逐字流式出（配合念稿节奏）；renderStream 已渲染该 bubble，这里清空重打
    const box = el.stream.querySelector(`.line[data-idx="${i}"] .bubble`);
    if (box && item.text) typewriter(box, item.text, active);
  }
}

[trackA, trackB].forEach((a) => {
  a.addEventListener('timeupdate', () => { if (a === active) onTimeUpdate(); });
  a.addEventListener('ended', () => {
    if (a === active && !crossing && !overlaying && !ducked) {
      if (queue[idx]?.type === 'song') closeSongSession('completed');
      playIndex(idx + 1);
    }
  });
  a.addEventListener('error', () => {
    if (a !== active || crossing || overlaying) return;
    const item = queue[idx];
    if (item?.type === 'tts') {
      setState('Fish 语音失败，继续播放音乐');
      playIndex(idx + 1);
    } else if (item?.type === 'song') {
      closeSongSession('skip');
      setState('这首暂时无法播放，换下一首');
      playIndex(idx + 1);
    }
  });
  // 键盘媒体键 / 系统播放控制直接 play/pause 音频元素时，界面按钮与播放态跟着真实状态走
  // （只在稳态同步：交叉淡入 / 口播叠加期的 play/pause 是内部编排，不动按钮，免得闪烁/串态）
  a.addEventListener('play', () => { if (a === active && !crossing && !overlaying) setPlayIcon(true); });
  a.addEventListener('pause', () => { if (a === active && !crossing && !overlaying && !a.ended) setPlayIcon(false); });
});

function onTimeUpdate() {
  if (overlaying) return; // 口播叠加在背景歌上的阶段，进度/blend 不在这里处理
  const { duration, currentTime } = active;
  if (isFinite(duration) && duration > 0) {
    el.barFill.style.width = (currentTime / duration) * 100 + '%';
    el.curTime.textContent = fmt(currentTime);
    el.durTime.textContent = fmt(duration);
  }
  const item = queue[idx], next = queue[idx + 1];
  if (item && item.type === 'tts' && next && next.type === 'song' && !crossing
      && isFinite(duration) && currentTime > 0.8 && duration - currentTime <= MUSIC_LEAD) {
    startBlend(next, idx + 1);
  }
  if (item && item.type === 'song' && lrc) updateLyric(currentTime);
  if (item?.type === 'song' && songSession && !songSession.progressSent
      && isFinite(duration) && duration > 0 && currentTime / duration >= 0.35) {
    songSession.progressSent = true;
    reportListeningEvent('play_progress', {
      song: songSession.song,
      listenedSec: currentTime,
      durationSec: duration,
      listenRatio: currentTime / duration,
      discoveryType: songSession.discoveryType,
    });
  }
}

// 通用音量渐变：ms 内从当前音量平滑渐到 to（系数会乘 masterVol 由调用方决定），用于 duck / 回升 / 渐入。
// 每次调用打一个递增的 token，旧的 ramp 检测到 token 变了就让位，避免多个 ramp 抢同一个 track。
const rampToken = new WeakMap();
function rampVolume(track, to, ms, done) {
  const my = (rampToken.get(track) || 0) + 1;
  rampToken.set(track, my);
  const from = trackVol(track), t0 = performance.now();
  const step = () => {
    if (rampToken.get(track) !== my) return; // 被更新的 ramp 接管
    const k = ms <= 0 ? 1 : Math.min(1, (performance.now() - t0) / ms);
    setTrackVol(track, from + (to - from) * k);
    if (k < 1) requestAnimationFrame(step);
    else if (done) done();
  };
  requestAnimationFrame(step);
}

// 口播→歌 交叠（电台范儿）：口播念到最后 MUSIC_LEAD 秒，下一首歌「进来即 20% 背景音」（~1.2s 渐入后保持），
// 垫在口播底下；口播一念完 → 停 ~1s → 音乐从 20% 慢慢（~2s）涨回原音量。DJ 讲话时音乐不抢戏，讲完才扬起。
function startBlend(songItem, songIdx) {
  crossing = true;
  idle.src = proxyUrl(songItem.url);
  setTrackVol(idle, 0);
  idle.play().catch(() => {});
  rampVolume(idle, BG_VOL * masterVol, 1200); // 下一首歌 ~1.2s 渐入到 20%，然后保持着垫在口播底下
  const ramp = () => {
    if (!crossing) return;
    const dur = active.duration, ct = active.currentTime;
    const remain = isFinite(dur) ? dur - ct : 0;
    setTrackVol(active, sayVol()); // 口播保持（提响）音量念到底，不淡出
    if (remain <= 0.06 || active.ended) {
      active.pause();
      [active, idle] = [idle, active]; // 音乐成为主轨（此刻是 20% 背景音）
      idx = songIdx;
      crossing = false;
      onItemStart(queue[idx], idx);
      // 口播结束 → 停 ~1s → 从 20% 慢慢（~2s）回到原音量（捕获 track 防这 3s 内 swap 写错轨；rampVolume 自带 token 防抢轨）
      const songTrack = active;
      setTimeout(() => rampVolume(songTrack, songVol(), 2000), 1000);
      return;
    }
    requestAnimationFrame(ramp);
  };
  requestAnimationFrame(ramp);
}

// 取消进行中的口播→歌曲交叉渐入：把 crossing 置 false 让 blend 的 RAF 自行退出，并停掉 idle 轨，
// 免得后到的口播/节目把正在 blend 的 idle 轨抢去改写、再被 blend 误当歌升为主轨（修真竞态）。
function cancelBlend() {
  if (!crossing) return;
  crossing = false;
  try { idle.pause(); } catch {}
}

// —— 说话/流式时的平滑接入：口播叠在背景歌上念，念完再接歌或回升 ——
// 当前歌已被 chat() 压成背景小声续播。口播（idle 轨）淡入叠上去；念完后——
// 有歌则旧歌淡出 + 新歌渐入；只聊天（没歌）则背景歌回升续放。
// 流式（用户说话）：口播先到（sayReady）念、歌后到（episode）补；非流式：一次给完整 ep。统一走这套。
function startSayOverlay(sayUrl, sayText, getEpisode) {
  cancelBlend(); // 先取消进行中的交叉渐入，再让 idle 轨去念口播，避免 blend 抢写 idle / 误把口播音频升为主轨
  // 口播叠加期间背景歌必须小声：不只依赖 chat() 说话瞬间的 duck（live 判断可能漏 → 没压成），
  // 这里以「当前在放的主轨」为准再平滑压一次——口播一开始念，背景就降到 BG_VOL，确保口播听得清。
  if (!ducked && active.src && !active.paused && !active.ended) {
    // 兜底：chat() 已在说话瞬间慢慢压到 20% 了，这里仅在它漏压时才补压（同样 ~1.2s 平滑，不要突然一跳）
    ducked = true;
    rampVolume(active, BG_VOL * masterVol, 1200);
  }
  overlaying = true;
  sayEnded = false;
  streamDone = false;
  idx = 0;
  document.body.classList.remove('thinking'); // 口播开始念 → 退出思考态
  el.nowTitle.textContent = 'CLAUDIO';
  setState('ON AIR · 口播');
  setMiniLyric('CLAUDIO · 口播');
  // 重入先撤掉上一次的监听（AbortController），避免泄漏 + 在错误时机触发 finishAfterSay
  if (sayOnEnd) sayOnEnd.abort();
  const ac = new AbortController();
  sayOnEnd = ac;
  idle.src = sayUrl;
  setTrackVol(idle, 0);
  showSayBubble(sayText, idle); // 必须在 idle.src 设为口播后再启打字机，否则读到旧轨（上一首歌）的时长导致严重拖慢
  // say 念完 → 有歌接歌、没歌等歌；任何「念不出来」(url 坏/解码失败/autoplay 被拦) 也走同一出口，绝不卡死
  const proceed = () => {
    ac.abort(); // 一次性：撤掉 ended/error 两个监听
    const ep = getEpisode();
    if (ep) finishAfterSay(ep);
    else sayEnded = true; // 歌还没到，等 episode 到了再接（看门狗兜底）
  };
  idle.addEventListener('ended', proceed, { signal: ac.signal });
  idle.addEventListener('error', proceed, { signal: ac.signal });
  idle.play()
    .then(() => {
      responseHeard = true;
      rampVolume(idle, sayVol(), 350); // 口播淡入（提响），叠在背景歌上
      // 口播已真正开播 → 撤掉「从说话瞬间起算」的兜底看门狗（长思考后它会在念稿途中误砍口播、被歌顶掉），
      // 改用「口播真实时长 + 8s 余量」重设：只在口播卡死 / ended 不触发时才兜底，绝不在念稿途中砍断（修：歌只顶掉口播三四秒就抢播）
      const armByDur = () => armWatchdog(((isFinite(idle.duration) && idle.duration > 0 ? idle.duration : 30) + 8) * 1000, true);
      if (isFinite(idle.duration) && idle.duration > 0) armByDur();
      else idle.addEventListener('loadedmetadata', armByDur, { once: true, signal: ac.signal });
    })
    .catch(() => proceed());
}

function finishAfterSay(ep) {
  if (streamDone) return; // 防重（WS 与 HTTP 可能都触发）
  streamDone = true;
  disarmWatchdog(); // 接管成功，撤看门狗
  streamingActive = false;
  overlaying = false;
  const songs = ep && ep.queue ? ep.queue.filter((q) => q.type === 'song') : [];
  if (songs.length) {
    closeSongSession('skip');
    activeEpisode = ep;
    queue = ep.queue;
    el.queueCount.textContent = `${songs.length} TRACKS`;
    renderStream(ep);
    const firstSong = songs[0];
    const oldTrack = active;
    rampVolume(oldTrack, 0, 1000, () => oldTrack.pause()); // 旧歌淡出
    [active, idle] = [idle, active]; // 刚念完口播的轨升为主轨
    idx = ep.queue.indexOf(firstSong);
    active.src = proxyUrl(firstSong.url);
    setTrackVol(active, 0);
    active.play().catch(() => {});
    onItemStart(firstSong, idx);
    rampVolume(active, songVol(), 1400); // 新歌渐入
    ducked = false;
  } else {
    if (ep?.intent === 'control') applyEpisodeAction(ep);
    if (ep?.action === 'pause' || ep?.action === 'stop') {
      // 指令确认前背景歌曾被压低；暂停后先恢复目标音量，之后再继续不会只剩背景音量。
      disarmWatchdog();
      ducked = false;
      document.body.classList.remove('thinking');
      setTrackVol(active, activeTargetVol());
    } else {
      unduck(); // 只聊天：背景歌回升续放
    }
  }
}

// 非流式（已有完整 episode）：等价地走同一套接入
function enterEpisodeSmooth(ep) {
  if (!ep || !ep.queue || !ep.queue.length) { unduck(); return; }
  const say = ep.queue[0];
  if (!say || say.type !== 'tts') { loadEpisode(ep); return; }
  startSayOverlay(say.url, say.text, () => ep);
}

// —— 看门狗：chat() 一旦把当前歌 duck 成背景，就必须在有界时间内「成功接管」或「强制恢复」，
//    兜住所有异步失败路径（WS 不来 sayReady / say 播放失败 / 歌一直不到 / 202 反复重试）。——
const WATCHDOG_MS = 15000; // 用户可感知链路以 15 秒为硬边界：到点恢复音乐并明确提示，不无限等待。
function armWatchdog(ms = WATCHDOG_MS, force = false) {
  if (watchdog && !force) return; // 幂等：防 429 重试每次重置 → 看门狗永不触发、背景歌永久小声死锁
  if (watchdog) clearTimeout(watchdog); // force：口播真正开播后用「口播时长 + 余量」重设，替换掉原来从说话瞬间起算的那个，免得长思考后误砍正在念的口播
  watchdog = setTimeout(() => {
    console.warn('[watchdog] 接管超时，强制恢复');
    watchdog = null;
    if (streamPending) { finishAfterSay(streamPending); return; }
    streamingActive = false;
    setState('超时，已恢复播放');
    unduck();
  }, ms);
}
function disarmWatchdog() { clearTimeout(watchdog); watchdog = null; }

function unduck() {
  disarmWatchdog();
  document.body.classList.remove('thinking');
  ducked = false;
  overlaying = false;
  rampVolume(active, activeTargetVol(), 2000); // 口播念完、没切歌 → 音乐 ~2s 慢慢回到原音量
}

// 口播文字打字机：逐字流式显示口播稿，配合念稿节奏（优先用音频时长，否则按中文念速 ~180ms/字 估算）。
// token 机制：新口播一来就 ++typeToken，旧打字机下一拍自行退出，绝不串字。
let typeToken = 0;
function typewriter(box, text, audio) {
  if (!box) return;
  const my = ++typeToken;
  const chars = [...(text || '')];
  let i = 0;
  box.textContent = '';
  box.classList.add('typing');
  // 每字间隔：优先用真实音频时长 / 字数，拿不到则按中文念速 ~180ms/字 估算
  const calcPer = () => {
    const durMs = (audio && isFinite(audio.duration) && audio.duration > 0) ? audio.duration * 1000 : chars.length * 180;
    return Math.max(25, Math.min(300, durMs / Math.max(1, chars.length)));
  };
  let per = calcPer();
  // 口播 src 刚设时 duration 还是 NaN，等元数据到了用真实时长重算，真正配合念稿节奏
  if (audio) audio.addEventListener('loadedmetadata', () => { if (my === typeToken) per = calcPer(); }, { once: true });
  const step = () => {
    if (my !== typeToken) return; // 被新口播打断
    if (i >= chars.length) { box.classList.remove('typing'); return; }
    box.textContent = chars.slice(0, ++i).join('');
    setTimeout(step, per);
  };
  step();
}

// 流式 sayReady 阶段还没有完整 episode，先显示口播气泡（打字机逐字出）
function showSayBubble(text, audio) {
  el.stream.innerHTML = '<div class="line active enter"><span class="who">Claudio</span><div class="bubble"></div></div>';
  typewriter(el.stream.querySelector('.bubble'), text, audio);
}

// ── 字幕流 ──
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderStream(ep) {
  el.stream.innerHTML = '';
  ep.queue.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'line enter' + (item.type === 'song' ? ' song' : '');
    div.dataset.idx = i;
    div.style.animationDelay = `${Math.min(i, 6) * 60}ms`; // 错峰进场
    if (item.type === 'tts') {
      div.innerHTML = `<span class="who">Claudio</span><div class="bubble">${escapeHtml(item.text)}</div>`;
    } else {
      div.dataset.song = '1';
      div.innerHTML = `<span class="who">♪ ${escapeHtml(item.meta.title)} — ${escapeHtml(item.meta.artist)}</span><div class="lyric"></div>`;
    }
    // 进场动画结束就摘掉 enter，避免和后续 active 高亮/滚动叠加
    div.addEventListener('animationend', () => { div.classList.remove('enter'); div.style.animationDelay = ''; }, { once: true });
    el.stream.appendChild(div);
  });
}

function highlightLine(i) {
  for (const n of el.stream.querySelectorAll('.line')) {
    n.classList.toggle('active', +n.dataset.idx === i);
  }
  el.stream.querySelector(`.line[data-idx="${i}"]`)?.scrollIntoView({ block: 'nearest' });
}

function renderLyric(i) {
  const box = el.stream.querySelector(`.line[data-idx="${i}"] .lyric`);
  if (!box) return;
  box.innerHTML = '';
  if (!lrc) { box.textContent = '（这首暂无歌词）'; return; }
  lrc.forEach((l, li) => {
    const p = document.createElement('div');
    p.className = 'lyric-line';
    p.dataset.lyric = li;
    p.textContent = l.text;
    box.appendChild(p);
  });
}

function updateLyric(t) {
  let cur = -1;
  for (let i = 0; i < lrc.length; i++) {
    if (lrc[i].t == null) continue;
    if (lrc[i].t <= t) cur = i; else break;
  }
  if (cur === lastLyric) return;
  lastLyric = cur;
  if (cur >= 0 && lrc[cur]) setMiniLyric(lrc[cur].text); // 迷你窗同步当前歌词行
  const box = el.stream.querySelector('.line.active .lyric');
  if (!box) return;
  const lines = box.querySelectorAll('.lyric-line');
  lines.forEach((n, i) => {
    const d = Math.abs(i - cur);
    n.classList.toggle('active', i === cur);
    n.style.opacity = i === cur ? '1' : String(Math.max(0.12, 0.5 - d * 0.13));
  });
  lines[cur]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function parseLrc(text) {
  if (!text) return null;
  const out = [];
  for (const line of text.split('\n')) {
    const tm = line.match(/\[(\d+):(\d+)(?:[.:](\d+))?\]/);
    const body = line.replace(/\[[^\]]*\]/g, '').trim();
    if (!body) continue;
    out.push(tm ? { t: +tm[1] * 60 + +tm[2] + (tm[3] ? +`0.${tm[3]}` : 0), text: body } : { t: null, text: body });
  }
  return out.length ? out : null;
}

// ── 请求一期 ──
async function chat(input = '', mood = '') {
  if (busy) return;
  initAudio(); // 手势链内激活 AudioContext（首次说话/换心情也能起 FFT）
  busy = true; lockUI(true); setState('思考中…');
  document.body.classList.add('thinking'); // THINKING 动效：ducked 时波形静默，需独立 loader 填补等待空窗
  // 感知层：说话的瞬间把当前歌压成背景小声、继续播，不戛然而止
  const live = started && active.src && !active.paused && !active.ended;
  // 当前在放的歌 → 随请求传给后端，让 DJ 知道「这首」指什么、评价时别乱换歌
  const cur = queue[idx];
  const nowPlaying = (cur && cur.type === 'song') ? { type: 'song', title: cur.meta.title, artist: cur.meta.artist } : null;
  if (input) armWatchdog(); // 15 秒硬边界：有无背景歌都不能无限等待模型 / Fish
  // 在听时说话 → 走流式：口播由 WS sayReady 先念、歌由 WS episode 接
  streamingActive = !!input;
  streamPending = null; sayEnded = false; streamDone = false;
  responseHeard = false;
  const controller = new AbortController();
  const requestTimer = setTimeout(() => { if (!responseHeard) controller.abort(); }, 15000);
  try {
    const res = await fetch('/api/chat', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input, mood, nowPlaying, sleep: sleepEnd ? { remainingMin: Math.max(1, Math.ceil((sleepEnd - Date.now()) / 60000)) } : null }) });
    const data = await res.json();
    if (data.ok && data.control) {
      // 高频明确指令走本机直连，不等模型、不消耗 Fish；复杂或含糊的话仍由模型判断。
      streamingActive = false;
      streamPending = null;
      disarmWatchdog();
      busy = false;
      lockUI(false);
      executeControl(data.control);
      showControlReply(data.control.reply);
    }
    else if (data.ok && data.episode) {
      if (data.streamed && streamingActive) {
        streamPending = data.episode;
        if (overlaying) {
          // 口播已经在念（WS sayReady 先到了）：念完会用 streamPending 接歌；这里只在「已念完、在等歌」时补接，绝不重念
          if (sayEnded) finishAfterSay(data.episode);
        } else if (!wsAlive()) {
          // WS 不通且口播还没开始 → 用 HTTP 拿到的 episode 自己念，绝不空等
          streamingActive = false; enterEpisodeSmooth(data.episode);
        }
        // else：WS 通、口播还没开始 → 等 WS sayReady 触发；15 秒看门狗负责恢复
      }
      else if (live) enterEpisodeSmooth(data.episode);
      else loadEpisode(data.episode);
    }
    else if (data.busy) { setState('稍候…'); busy = false; document.body.classList.remove('thinking'); setTimeout(() => chat(input, mood), 2500); return; }
    else { setState('出错：' + (data.error || '?')); streamingActive = false; if (live) unduck(); }
  } catch (e) { setState(e.name === 'AbortError' ? '15 秒内未响应，音乐继续' : '请求失败'); streamingActive = false; if (live) unduck(); }
  finally { clearTimeout(requestTimer); busy = false; lockUI(false); document.body.classList.remove('thinking'); }
}
let emptyStreak = 0; // 连续拿到「无可播歌」的次数，防版权墙下紧密重试反复调用模型
async function requestNext() {
  if (busy) return;
  busy = true; lockUI(true); setState('准备下一首…');
  try {
    const res = await fetch('/api/next');
    const data = await res.json();
    if (data.ok && data.episode) {
      const songs = data.episode.queue.filter((q) => q.type === 'song').length;
      emptyStreak = songs ? 0 : emptyStreak + 1;
      // 连续两期都没有可播的歌（多半撞版权墙）→ 停下不自动续，避免反复烧额度
      if (!songs && emptyStreak >= 2) { setState('暂时找不到可播的歌，点 ▶ 或换个心情再试'); return; }
      loadEpisode(data.episode);
    }
    else if (data.busy) { setState('稍候…'); busy = false; setTimeout(requestNext, 2500); return; }
    else setState('出错：' + (data.error || '?'));
  } catch (e) { setState('请求失败'); }
  finally { busy = false; lockUI(false); }
}
function lockUI(on) { [el.nextBtn, el.sendBtn].forEach((b) => (b.disabled = on)); }

// ── 控件 ──
// 注：前端本机播放是唯一播放层。后端遥控 / 镜像模式（/api/player/*）已随后端播放引擎一并废弃，相关死代码已整段删除。
function resumePlayback() {
  initAudio(); // 用户手势内激活 AudioContext（首播即起 FFT）
  if (!queue.length) { started = true; setTimeout(() => chat(), 0); return; }
  started = true;
  active.play().catch(() => {});
  setPlayIcon(true);
  setState('PLAYING');
}

function pausePlayback() {
  active.pause();
  setPlayIcon(false);
  setState('PAUSED');
}

function previousPlayback() {
  if (queue.length) playIndex(Math.max(0, idx - 1));
}

function nextPlayback() {
  if (idx + 1 < queue.length) playIndex(idx + 1);
  else { closeSongSession('skip'); setTimeout(requestNext, 0); }
}

function stopPlayback() {
  clearTimeout(sleepTimer); clearInterval(sleepBadgeTimer); sleepEnd = null; updateSleepBadge();
  // 清掉所有流式/叠加/duck/看门狗残留态：停了之后即使迟到的 sayReady/episode 到达，也不会把已停的歌恢复
  disarmWatchdog();
  cancelBlend();
  streamingActive = false; streamPending = null; ducked = false; overlaying = false;
  if (sayOnEnd) sayOnEnd.abort();
  closeSongSession('skip');
  active.pause(); idle.pause(); setPlayIcon(false); setState('STOPPED');
  el.barFill.style.width = '0';
}

function dislikeCurrent() {
  const item = queue[idx];
  if (!item || item.type !== 'song') return;
  const song = { title: item.meta.title, artist: item.meta.artist };
  closeSongSession('dislike');
  reportListeningEvent('dislike', { song, discoveryType: item.meta.discoveryType, source: 'button' });
  el.dislikeBtn.classList.add('dislike-on');
  setState('记住了，以后少放这类');
  setTimeout(() => {
    if (idx + 1 < queue.length) playIndex(idx + 1);
    else requestNext();
  }, 260);
}

function favoriteCurrent({ toggle = false } = {}) {
  const item = queue[idx];
  if (!item || item.type !== 'song') return;
  const k = songKey(item.meta);
  if (toggle && favs.has(k)) favs.delete(k); else favs.add(k);
  el.favBtn.classList.toggle('fav-on', favs.has(k));
  el.favBtn.textContent = favs.has(k) ? '♥' : '♡';
  if (favs.has(k)) { el.favBtn.classList.remove('fav-pulse'); void el.favBtn.offsetWidth; el.favBtn.classList.add('fav-pulse'); } // 收藏瞬间心跳
  localStorage.setItem('claudio-favs', JSON.stringify([...favs]));
  if (favs.has(k)) {
    fetch('/api/fav', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: item.meta.title, artist: item.meta.artist }),
    }).catch(() => {});
  }
}

function setMasterVolume(percent) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  masterVol = value / 100;
  el.vol.value = String(value);
  if (!crossing && !ducked && !overlaying) setTrackVol(active, activeTargetVol());
  setState(`VOLUME ${Math.round(value)}%`);
}

function executeControl(control) {
  return executePlayerAction(control, {
    pause: pausePlayback,
    resume: resumePlayback,
    next: nextPlayback,
    previous: previousPlayback,
    stop: stopPlayback,
    favorite: () => favoriteCurrent(),
    dislike: dislikeCurrent,
    getVolume: () => Math.round(masterVol * 100),
    setVolume: setMasterVolume,
  });
}

function applyEpisodeAction(ep) {
  if (!ep?.id || ep.action === 'none' || handledEpisodeActions.has(ep.id)) return false;
  handledEpisodeActions.add(ep.id);
  if (handledEpisodeActions.size > 80) handledEpisodeActions.delete(handledEpisodeActions.values().next().value);
  return executeControl(ep);
}

function showControlReply(text) {
  if (!text) return;
  el.stream.innerHTML = `<div class="line active enter"><span class="who">Claudio</span><div class="bubble">${escapeHtml(text)}</div></div>`;
}

el.playBtn.addEventListener('click', () => {
  if (!started || !queue.length || active.paused) resumePlayback();
  else pausePlayback();
});
el.prevBtn.addEventListener('click', previousPlayback);
el.nextBtn.addEventListener('click', nextPlayback);
el.stopBtn.addEventListener('click', stopPlayback);
el.dislikeBtn.addEventListener('click', dislikeCurrent);
el.favBtn.addEventListener('click', () => favoriteCurrent({ toggle: true }));
el.vol.addEventListener('input', () => setMasterVolume(+el.vol.value));
// ── AirPlay 投放：由 WebKit 的 HTMLMediaElement 系统播放目标选择器控制同一条网页音轨。
// 音轨保持原生直连，避免接进 WebAudio 后出现“选到音箱但无声”。
if (el.airplayBtn) {
  if (!AIRPLAY_MODE.visible) {
    el.airplayBtn.style.display = 'none';
  } else if (AIRPLAY_MODE.webkitPicker) {
    el.airplayBtn.addEventListener('click', () => {
      try { active.webkitShowPlaybackTargetPicker(); } catch (e) { console.warn('[airplay]', e && e.message); }
    });
    [trackA, trackB].forEach((t) => t.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', () => {
      if (t === active) el.airplayBtn.classList.toggle('casting', !!t.webkitCurrentPlaybackTargetIsWireless);
    }));
  }
}
el.sendBtn.addEventListener('click', () => {
  const v = el.moodInput.value.trim(); if (!v) return; el.moodInput.value = '';
  chat(v);
});
el.moodInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.sendBtn.click(); });
el.bar.addEventListener('click', (e) => {
  if (overlaying) return; // 口播叠加期 active 是旧歌，seek 会跳错对象
  if (!isFinite(active.duration)) return;
  const r = el.bar.getBoundingClientRect();
  active.currentTime = ((e.clientX - r.left) / r.width) * active.duration;
});
const songKey = (m) => `${m.title}|${m.artist}`;

// ── 睡眠定时（到点淡出停止 + 晚安）──
// 可见反馈：开=高亮 class + 右上角剩余分钟徽标。emoji 的 color 改不动（旧版「按了没反应」的根因），必须靠 class/徽标。
function updateSleepBadge() {
  const on = !!sleepEnd;
  el.sleepBtn.classList.toggle('sleep-on', on);
  if (on) {
    const rem = Math.max(1, Math.ceil((sleepEnd - Date.now()) / 60000));
    el.sleepBadge.textContent = String(rem);
    el.sleepBtn.title = `睡眠定时 · 剩 ${rem} 分钟，点击取消`;
  } else {
    el.sleepBadge.textContent = '';
    el.sleepBtn.title = `睡眠定时 ${SLEEP_MIN} 分钟`;
  }
}
function fadeOutStop() {
  sleepEnd = null;
  clearInterval(sleepBadgeTimer);
  updateSleepBadge();
  const t = active; // 捕获当前轨，防淡出途中 swap 写到错误轨道
  rampVolume(t, 0, 8000, () => { t.pause(); idle.pause(); setPlayIcon(false); setState('晚安 🌙'); });
}
el.sleepBtn.addEventListener('click', () => {
  if (sleepEnd) {
    sleepEnd = null; clearTimeout(sleepTimer); clearInterval(sleepBadgeTimer);
    updateSleepBadge(); setState('已取消睡眠定时');
  } else {
    sleepEnd = Date.now() + SLEEP_MIN * 60000;
    clearTimeout(sleepTimer);
    sleepTimer = setTimeout(fadeOutStop, SLEEP_MIN * 60000);
    clearInterval(sleepBadgeTimer);
    sleepBadgeTimer = setInterval(updateSleepBadge, 30000); // 每 30s 刷新剩余分钟徽标
    updateSleepBadge();
    setState(`😴 睡眠定时 ${SLEEP_MIN} 分钟`);
    started = true; chat();
  }
});

// ── 大波形（时钟区，跟随播放丝滑波动 + 发光）──
const wctx = el.waveBig.getContext('2d');
function rs() { el.waveBig.width = el.waveBig.clientWidth * devicePixelRatio; el.waveBig.height = el.waveBig.clientHeight * devicePixelRatio; }
rs(); addEventListener('resize', rs);
const BARS = 60;
const hs = Array.from({ length: BARS }, () => 0.06);
const targets = hs.slice();
function drawWave() {
  const w = el.waveBig.width, h = el.waveBig.height, bw = w / BARS;
  wctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const col = css.getPropertyValue('--accent').trim() || '#00e08a';
  // 真频谱优先：WebAudio AnalyserNode（同源代理后才有数据）；否则退回音量驱动的拟态波形
  const playing = !active.paused && active.src && active.readyState > 2 && !active.ended;
  let live = false;
  if (analyser && playing) {
    analyser.getByteFrequencyData(freqData);
    live = true;
    const span = freqData.length * 0.7; // 取低~中频段（能量集中区），右端不至于死寂
    for (let i = 0; i < BARS; i++) targets[i] = Math.max(0.012, freqData[Math.floor((i / BARS) * span)] / 255);
  } else {
    const amp = playing ? Math.max(0, Math.min(1, trackVol(active))) : 0;
    const t = performance.now();
    for (let i = 0; i < BARS; i++) {
      if (amp > 0.012) {
        const shape = (1 - i / BARS) * 0.65 + 0.35; // 低频(左)大、高频(右)小
        const wob = 0.35 + 0.65 * Math.abs(Math.sin(t / (170 + i * 7) + i * 0.7));
        targets[i] = amp * shape * wob * (0.65 + Math.random() * 0.35);
      } else {
        targets[i] = 0.012; // 静音：基本静止
      }
    }
  }
  for (let i = 0; i < BARS; i++) {
    hs[i] += (targets[i] - hs[i]) * 0.25;
    const bh = Math.max(1.5 * devicePixelRatio, hs[i] * h * 0.92);
    wctx.fillStyle = col;
    wctx.shadowColor = col; wctx.shadowBlur = (live || hs[i] > 0.02) ? 7 : 0;
    wctx.fillRect(i * bw + bw * 0.28, (h - bh) / 2, bw * 0.44, bh);
  }
  wctx.shadowBlur = 0;
  requestAnimationFrame(drawWave);
}
drawWave();

// ── WS（带断线指数退避重连）──
let ws = null;
let wsRetry = 0;
function wsAlive() { return ws && ws.readyState === WebSocket.OPEN; }

function setConn(ok) {
  el.connState.textContent = ok ? 'CONNECTED' : 'OFFLINE';
  el.liveTag.textContent = ok ? 'LIVE' : 'OFFLINE';
  el.liveTag.classList.toggle('on', ok);
  el.connMsg.textContent = ok ? 'Connected to Claudio server' : 'Disconnected';
}

function handleWS(e) {
  let msg; try { msg = JSON.parse(e.data); } catch { return; }
  if (msg.kind === 'nextReady' && started) el.connMsg.textContent = 'Next episode ready';
  // 流式：口播先到 → 在背景歌上念；歌随后到 → 念完接上
  if (msg.kind === 'sayReady' && msg.url && streamingActive) {
    setState('THINKING…→ 念口播');
    startSayOverlay(msg.url, msg.say, () => streamPending);
  }
  if (msg.kind === 'episode' && streamingActive && msg.episode) {
    streamPending = msg.episode;
    if (sayEnded) finishAfterSay(msg.episode); // 口播已念完，立即接歌
  }
  if (msg.kind === 'ttsError') {
    setState('Fish 语音失败，音乐继续');
    el.connMsg.textContent = 'Fish Audio 暂时不可用（未切换本地语音）';
  }
  if (msg.kind === 'scheduled' && msg.episode) {
    const labels = { 'morning-plan': '☀️ 清晨节目', 'morning-show': '🌤 早间节目', 'hourly-mood': '🎚 整点更新' };
    el.connMsg.textContent = (labels[msg.reason] || '定时节目') + '已就绪';
    // 叠加(overlaying)/交叉(crossing)期不被定时打断；正在听才平滑切入，没在听只提示（autoplay 需手势）
    if (started && !overlaying && !crossing && active.src && !active.paused && !active.ended) enterEpisodeSmooth(msg.episode);
  }
}

function connectWS() {
  try { ws = new WebSocket(`ws://${location.host}/stream`); }
  catch { setConn(false); scheduleReconnect(); return; }
  ws.onopen = () => { setConn(true); wsRetry = 0; };
  ws.onmessage = handleWS;
  ws.onclose = () => { setConn(false); scheduleReconnect(); };
  ws.onerror = () => { setConn(false); }; // 紧跟的 onclose 负责重连，避免双触发
}
function scheduleReconnect() {
  wsRetry = Math.min(wsRetry + 1, 6);
  const delay = Math.min(30000, 1000 * 2 ** (wsRetry - 1)); // 1s,2s,4s,…,30s 上限
  setTimeout(connectWS, delay);
}
// 点头像看 Claudio 记下的关于你的事（长期记忆，透明可见）；下次播放刷新字幕时自然清掉
document.querySelector('.avatar')?.addEventListener('click', async () => {
  try {
    const j = await (await fetch('/api/memory')).json();
    const mem = (j.ok && (j.memory || '')).trim();
    const div = document.createElement('div');
    div.className = 'line active enter';
    div.innerHTML = `<span class="who">Claudio 记得关于你</span><div class="bubble">${mem ? escapeHtml(mem).replace(/\n/g, '<br>') : '还没记下什么，多陪我聊聊就慢慢懂你了。'}</div>`;
    el.stream.prepend(div);
    div.scrollIntoView({ block: 'nearest' });
  } catch {}
});

// 迷你模式：缩成小窗（只剩 在放什么 + 控制）。Tauri 环境真缩窗口，浏览器仅切布局降级。
// 缩窗 / 置顶：优先 Tauri 标准 window API（任何带 withGlobalTauri + capability 的 .app 都支持，不依赖自定义命令），
// 失败再退到自定义 Rust command；两路都失败就把真实错误显示出来（区分「命令缺失 / 权限不足 / 接口缺失」）。
function tauri() { return window.__TAURI__ || null; }
async function setWin(w, h) {
  const T = tauri();
  if (!T) return; // 浏览器：不缩窗（仅 CSS 切布局）
  try {
    const getCur = T.window && (T.window.getCurrentWindow || T.window.getCurrent);
    const LS = (T.dpi && T.dpi.LogicalSize) || (T.window && T.window.LogicalSize);
    if (getCur && LS) { await getCur.call(T.window).setSize(new LS(w, h)); return; }
  } catch (e1) { console.warn('[mini] 标准 setSize 失败', e1 && e1.message); }
  try {
    if (T.core && T.core.invoke) { await T.core.invoke('resize_window', { width: w, height: h }); return; }
    setState('缩窗不可用：未检测到 Tauri 窗口接口');
  } catch (e2) {
    setState('缩窗失败：' + (e2 && (e2.message || e2)));
    console.warn('[mini] command 失败', e2);
  }
}
async function setOnTop(on) {
  const T = tauri();
  if (!T) return;
  try {
    const getCur = T.window && (T.window.getCurrentWindow || T.window.getCurrent);
    if (getCur) { await getCur.call(T.window).setAlwaysOnTop(on); return; }
  } catch (e1) { console.warn('[mini] 标准 onTop 失败', e1 && e1.message); }
  try { if (T.core && T.core.invoke) await T.core.invoke('set_on_top', { on }); } catch (e2) { console.warn(e2); }
}
let mini = false;
$('miniBtn')?.addEventListener('click', () => {
  mini = !mini;
  document.body.classList.toggle('mini', mini);
  const b = $('miniBtn');
  if (b) { b.textContent = mini ? '△' : '▽'; b.title = mini ? '展开' : '迷你模式（缩小成小窗）'; }
  setWin(mini ? 380 : 440, mini ? 120 : 760);
  setOnTop(mini); // 只在迷你模式置顶（小控制器悬浮）；全窗工作时不置顶、不挡别的 app
});

connectWS();
