// 申请页：同一份表单也可以放在别的站点上（跨域提交到本站 /api/apply，来源要在 PUBLIC_APPLY_ORIGINS 里）。
const $ = (id) => document.getElementById(id);
const API = window.CLAUDIO_APPLY_API || '/api/apply';
let token = '';

async function setupCaptcha() {
  const cfg = await fetch(`${API}/config`).then((r) => r.json()).catch(() => ({}));
  if (!cfg.turnstileSiteKey) return;
  window.onTurnstileLoad = () => {
    window.turnstile.render('#captcha', { sitekey: cfg.turnstileSiteKey, callback: (t) => { token = t; } });
  };
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad&render=explicit';
  s.async = true;
  document.head.appendChild(s);
}

$('apply-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('name').value, note: $('note').value, wechat: $('wechat').value, turnstileToken: token }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || '没提交成功');
    $('apply-form').classList.add('hidden');
    $('msg').textContent = '收到了。通过后会把邀请链接发给你。';
  } catch (error) {
    $('msg').textContent = error.message;
    window.turnstile?.reset();
    token = '';
    button.disabled = false;
  }
});

setupCaptcha();
