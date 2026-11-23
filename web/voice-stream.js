// 口播边收边播。/api/tts/stream/*.mp3 是边合成边推的 mp3，直接设成 <audio> 的 src 时，浏览器要攒够数据才 canplay，
// 开头那句只有一秒多，常常等到整段收完才开口。能用 MediaSource 的浏览器把收到的块直接喂给解码器，首块到就能开口；
// 不支持（或打开失败）就照旧直接设 src。iPhone 只有 ManagedMediaSource，它要求关掉该元素的 remote playback。
const TYPE = 'audio/mpeg';
const OPEN_TIMEOUT_MS = 2000;

export function pickMediaSource(scope = globalThis) {
  for (const name of ['MediaSource', 'ManagedMediaSource']) {
    const Impl = scope[name];
    try { if (Impl?.isTypeSupported?.(TYPE)) return { Impl, managed: name === 'ManagedMediaSource' }; } catch { /* 当作不支持 */ }
  }
  return null;
}

export function isLiveVoiceUrl(url) {
  return /\/api\/tts\/stream\//.test(String(url));
}

// 把 url 接到 audio 上。返回 { mode: 'stream' | 'direct', abort() }。
export function attachVoice(audio, url, { scope = globalThis, fetchFn = scope.fetch?.bind(scope), onFallback } = {}) {
  const picked = isLiveVoiceUrl(url) && fetchFn && scope.URL?.createObjectURL ? pickMediaSource(scope) : null;
  if (!picked) { audio.src = url; return { mode: 'direct', abort() {} }; }
  const { Impl, managed } = picked;
  const ctrl = new AbortController();
  const source = new Impl();
  const objectUrl = scope.URL.createObjectURL(source);
  let appended = false, finished = false, openTimer = null;
  const cleanup = () => { clearTimeout(openTimer); try { scope.URL.revokeObjectURL(objectUrl); } catch { /* 已撤销 */ } };
  const fallback = (why) => {
    if (finished) return;
    finished = true; ctrl.abort(); cleanup();
    onFallback?.(why);
    audio.src = url;
  };
  if (managed) audio.disableRemotePlayback = true;
  openTimer = setTimeout(() => fallback('sourceopen timeout'), OPEN_TIMEOUT_MS);
  source.addEventListener('sourceopen', async () => {
    clearTimeout(openTimer);
    if (finished) return;
    let buffer;
    try { buffer = source.addSourceBuffer(TYPE); } catch (error) { fallback(error.message); return; }
    const idle = () => (buffer.updating ? new Promise((resolve) => buffer.addEventListener('updateend', resolve, { once: true })) : null);
    try {
      const res = await fetchFn(url, { signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`voice stream -> ${res.status}`);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || finished) break;
        if (!value?.byteLength) continue;
        await idle();
        if (finished) break;
        buffer.appendBuffer(value);
        appended = true;
      }
      await idle();
      if (!finished && source.readyState === 'open') source.endOfStream();
      finished = true;
      cleanup();
    } catch (error) {
      if (ctrl.signal.aborted && finished) return;
      if (!appended) { fallback(error.message); return; }
      // 收到一半断了：放完已经收到的，播完照常走 ended。
      finished = true; cleanup();
      try { await idle(); if (source.readyState === 'open') source.endOfStream(); } catch { /* 元素自己会报错或停住，交给看门狗 */ }
    }
  }, { once: true });
  audio.src = objectUrl;
  return {
    mode: 'stream',
    abort() { if (finished) return; finished = true; ctrl.abort(); cleanup(); },
  };
}
