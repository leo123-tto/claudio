// 先问服务端这是哪一版、开了哪些功能，再决定显示哪些控件、加载哪个播放引擎。
// 界面（index.html / styles.css / ui.js / lyrics.js / window-mode.js）两版同一份；播放引擎两个：
// 个人版 app.js（后台备节目、两路交叉淡入、口播、接力）、公用版 public.js（单个 <audio> 顺序放）。
// 带 data-cap 的控件默认藏着，对应功能开着才露出来，没有的功能不会先闪一下。
const VERSION = 35;
// 只有服务明确回 404（老的个人版服务，还没有这个接口）才按个人版全开。别的失败（隧道 502、超时、断网）
// 不猜：停在启动画面，退避重试——猜错了会让公用版的朋友看到老板的设置和按钮。
const PERSONAL = {
  mode: 'personal',
  features: { settings: true, dislike: true, prev: true, stop: true, outputs: true, sleep: true, voice: true, meter: true, webFonts: true },
};

async function loadMode() {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch('/api/mode', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout?.(5000) });
      if (res.status === 404) return PERSONAL;
      if (res.ok) {
        const data = await res.json();
        if (data?.mode === 'personal' || data?.mode === 'public') return data;
      }
    } catch { /* 下面重试 */ }
    await new Promise((r) => setTimeout(r, Math.min(10_000, 1000 * 2 ** attempt)));
  }
}

const cfg = await loadMode();
const features = cfg.features || {};
document.body.classList.add(`mode-${cfg.mode}`);
for (const node of document.querySelectorAll('[data-cap]')) node.classList.toggle('hidden', !features[node.dataset.cap]);

// 点阵字体从 Google Fonts 拉；公用版不拉（国内常连不上，CSP 也不放行），退回等宽字体
if (features.webFonts) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Doto:wght@400;600;800&family=Space+Mono:wght@400;700&display=swap';
  document.head.append(link);
}

if (cfg.mode === 'public') {
  await import(`./public.js?v=${VERSION}`);
} else {
  document.getElementById('loading').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  await import(`./app.js?v=${VERSION}`);
}
