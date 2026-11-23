// 总预算到点保留已成功的歌，并真正取消仍在等待的请求。
export async function resolveEpisodeSongs(candidates, { resolve, signal, timeout = 20000, onDrop } = {}) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const completed = [];
  const pending = new Set(candidates.map((_, index) => index));
  const reportDrop = (candidate, reason) => {
    try { onDrop?.(candidate, reason); } catch { /* 诊断不能中断解析。 */ }
  };
  let closed = false;
  let finish;
  const deadline = new Promise((done) => { finish = done; });
  const abort = () => { controller.abort(signal.reason); finish(); };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    for (const index of pending) reportDrop(candidates[index], 'timeout');
    controller.abort(new Error('选歌解析超过预算'));
    finish();
  }, timeout);
  try {
    const work = Promise.all(candidates.map(async (candidate, index) => {
      try {
        const song = await resolve(candidate, { signal: controller.signal });
        if (!closed && !controller.signal.aborted) {
          completed.push({ candidate, resolved: song, index });
          if (!song?.playable || !song?.url) reportDrop(candidate, song?.rateLimited ? 'rate-limited' : 'unplayable');
        }
      } catch {
        if (!closed && !controller.signal.aborted) reportDrop(candidate, 'resolve-error');
      } finally {
        pending.delete(index);
      }
    }));
    await Promise.race([work, deadline]);
    signal?.throwIfAborted();
    return completed.sort((a, b) => a.index - b.index);
  } finally {
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}

export async function refreshEpisodeUrls(episode, { cache, songUrl, signal, timeout = 3000 } = {}) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => { controller.abort(signal.reason); finish(); };
  signal?.addEventListener('abort', abort, { once: true });
  let finish;
  const deadline = new Promise((done) => { finish = done; });
  const timer = setTimeout(() => { controller.abort(); finish(); }, timeout);
  let closed = false;
  try {
    await Promise.race([Promise.all(episode.queue.filter((item) => item.type === 'song').map(async (item) => {
      const id = String(item.meta?.id || '');
      if (cache.has(id)) { item.url = `/media/${id}`; return; }
      try {
        const fresh = await songUrl(id, undefined, { signal: controller.signal });
        if (!closed && !controller.signal.aborted && fresh?.url) {
          item.url = fresh.url;
          item.meta.remoteUrl = fresh.url;
        }
      } catch { /* 直链刷新失败时保留旧地址，仍可尝试播放。 */ }
    })), deadline]);
    signal?.throwIfAborted();
    return episode;
  } finally {
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}
