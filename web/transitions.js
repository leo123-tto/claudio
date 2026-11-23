const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));

// 用绝对时间求值；改写包络时可把此刻的值当作新的 from，避免音量跳变。
export function envelopeValue({ from, to, start, duration, curve = 'smooth' }, now) {
  if (now < start) return from;
  if (duration <= 0 || now >= start + duration) return to;
  const k = clamp((now - start) / duration);
  const progress = curve === 'linear' ? k : (1 - Math.cos(Math.PI * k)) / 2;
  return from + (to - from) * progress;
}

export function equalPower(k) {
  const progress = clamp(k);
  if (progress === 0) return { old: 1, new: 0 };
  if (progress === 1) return { old: 0, new: 1 };
  return { old: Math.cos(progress * Math.PI / 2), new: Math.sin(progress * Math.PI / 2) };
}

const SHORT_CROSSFADE = /piano|classical|jazz|ambient|acoustic|纯音乐|钢琴|古典|轻音乐/i;

export function crossfadeDuration(oldMeta, newMeta) {
  const genres = [oldMeta?.genre, oldMeta?.tags, newMeta?.genre, newMeta?.tags].flat().filter(Boolean).join(' ');
  return SHORT_CROSSFADE.test(genres) ? 1200 : 3000;
}

const LOCAL_MEDIA_PATH = /^\/(?:media|tts)(?:\/|[?#]|$)/i;

export function mediaDeadline(url) {
  const source = String(url || '');
  if (LOCAL_MEDIA_PATH.test(source)) return 10000;
  try {
    // HTMLMediaElement 会把相对 src 展开成本机服务的完整 URL。
    const parsed = new URL(source);
    if (['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && LOCAL_MEDIA_PATH.test(parsed.pathname)) return 10000;
  } catch {}
  return 20000;
}

function waitForMedia(media, { signal, timeoutMs } = {}, { event, label, start }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let eventReady = event === 'canplay' && media.readyState >= 3;
    let startReady = !start;
    const cleanup = () => {
      media.removeEventListener(event, onReady);
      media.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      if (timer !== undefined) clearTimeout(timer);
    };
    const finish = error => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const checkReady = () => { if (eventReady && startReady) finish(); };
    const onReady = () => { eventReady = true; checkReady(); };
    const onError = cause => finish(new Error(`音频${label}失败`, { cause: media.error || cause }));
    const onAbort = () => {
      const error = new Error(`音频${label}已取消`);
      error.name = 'AbortError';
      finish(error);
    };

    if (signal?.aborted) { onAbort(); return; }
    if (media.error) { onError(media.error); return; }
    media.addEventListener(event, onReady);
    media.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort);
    timer = setTimeout(() => finish(new Error(`音频${label}超时`)), timeoutMs ?? mediaDeadline(media.currentSrc || media.src));

    if (start) {
      try {
        // playing 可能早于 play() 的 Promise，也可能晚于它；两边都确认后才能切歌。
        Promise.resolve(start()).then(() => { startReady = true; checkReady(); }, onError);
      } catch (error) {
        onError(error);
      }
    }
    checkReady();
  });
}

export function waitForPlaying(media, options = {}) {
  return waitForMedia(media, options, { event: 'playing', label: '播放', start: () => media.play() });
}

export function waitForCanPlay(media, options = {}) {
  return waitForMedia(media, options, { event: 'canplay', label: '加载' });
}
