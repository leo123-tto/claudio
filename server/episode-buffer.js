import { randomUUID } from 'node:crypto';

const CLAIM_TTL = 15 * 60 * 1000;
const SAY_TTL = 40 * 60 * 1000;
const songItems = (ep) => (ep?.queue || []).filter((item) => item.type === 'song');

// 只有这条调度车道可以调用大脑；领取和语音都不占这条车道。
export function createEpisodeBuffer({
  capacity = 2, build, refresh = async (ep) => ep, commit = () => {},
  synthesize, emit = () => {}, hasClients = () => false, now = Date.now,
  enabled = () => true, offline = () => false, changed = () => {}, listening = () => true,
  setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  capacity = Math.max(1, Number(capacity) || 2);
  const buffer = [];
  const claims = new Map();
  const episodes = new Map();
  const started = new Map();
  const voiceJobs = new Map();
  let epoch = 0;
  let current = null;
  let active = null;
  let foreground = null;
  let retryTimer = null;
  let failures = 0;
  let lastError = null;
  let running = false;
  let disposed = false;

  function stale(ep) {
    if (now() - ep.sayWrittenAt > SAY_TTL) skipVoice(ep);
    return ep;
  }
  function skipVoice(ep) {
    ep.voice = { status: 'skipped' };
    ep.queue = ep.queue.filter((item) => item.type !== 'tts');
    voiceJobs.get(ep.id)?.abort();
  }
  function expire() {
    for (const [id, claim] of claims) {
      if (now() - claim.at >= CLAIM_TTL) release(id);
    }
  }
  function held() {
    expire();
    return [current, ...buffer, ...[...claims.values()].filter((c) => !c.invalid).map((c) => c.episode)].filter(Boolean);
  }
  function exclusions() { return held().flatMap((ep) => songItems(ep).map((item) => item.meta)); }
  function valid(ep) { return !disposed && episodes.get(ep.id) === ep && ep.epoch === epoch; }
  function stamp(ep) {
    if (ep.epoch != null && ep.epoch !== epoch) throw new Error('节目已更新，请重试');
    ep.id ||= randomUUID();
    ep.epoch = epoch;
    ep.sayWrittenAt ||= now();
    ep.voice ||= { status: ep.say ? 'pending' : 'skipped' };
    return ep;
  }
  async function voice(ep) {
    stale(ep);
    if (!synthesize || !valid(ep) || ep.voice.status !== 'pending' || voiceJobs.has(ep.id)) return;
    if (offline()) { skipVoice(ep); return; }
    const controller = new AbortController();
    voiceJobs.set(ep.id, controller);
    try {
      const audio = await synthesize(ep.say, { signal: controller.signal });
      if (controller.signal.aborted || !valid(ep) || ep.voice.status !== 'pending') return;
      stale(ep);
      if (ep.voice.status !== 'pending') return;
      ep.voice = { status: 'ready' };
      ep.queue.unshift({ type: 'tts', url: audio.url, text: ep.say });
      emit({ kind: 'voiceReady', episodeId: ep.id, url: audio.url, text: ep.say });
    } catch (error) {
      if (controller.signal.aborted || !valid(ep)) return;
      ep.voiceFailures = (ep.voiceFailures || 0) + 1;
      if (offline() || ep.voiceFailures >= 3 || /离线|offline|未连接|占用|busy/i.test(error.message)) skipVoice(ep);
    } finally {
      if (voiceJobs.get(ep.id) === controller) voiceJobs.delete(ep.id);
    }
  }
  function retryVoices() {
    for (const ep of held()) if (ep !== current) void voice(ep);
  }
  function notifyChange() { changed(held()); }
  function retry() {
    if (retryTimer || !hasClients() || disposed) return;
    const delay = Math.min(120000, 30000 * (2 ** Math.max(0, failures - 1)));
    retryTimer = setTimer(() => { retryTimer = null; ensure(); }, delay);
    retryTimer?.unref?.();
  }
  function schedulePump() { queueMicrotask(pump); }
  function pump() {
    if (disposed || active) return;
    if (foreground) {
      const task = foreground;
      foreground = null;
      active = task;
      Promise.resolve().then(() => { task.controller.signal.throwIfAborted(); return task.run(task.controller.signal); })
        .then((value) => {
          task.controller.signal.throwIfAborted();
          if (active === task) task.resolve(value);
        }, task.reject)
        .catch(task.reject)
        .finally(() => {
          if (active !== task) return;
          active = null;
          schedulePump();
        });
      return;
    }
    // 没人在听（没有网页连着）就不备节目；有网页连上时 ensure 会重新开始。
    if (!running || !enabled() || !listening() || buffer.length >= capacity || retryTimer) return;
    const task = { controller: new AbortController(), epoch, kind: 'background' };
    active = task;
    Promise.resolve().then(() => build({
      signal: task.controller.signal, epoch: task.epoch,
      excludeSongs: exclusions(), recentSays: held().map((ep) => ep.say),
    })).then((ep) => {
      if (active !== task || task.controller.signal.aborted || task.epoch !== epoch) return;
      stamp(ep);
      episodes.set(ep.id, ep);
      buffer.push(ep);
      failures = 0;
      lastError = null;
      notifyChange();
      emit({ kind: 'nextReady', buffered: buffer.length, epoch });
      void voice(ep);
    }).catch((error) => {
      if (active !== task || task.controller.signal.aborted || task.epoch !== epoch) return;
      lastError = error;
      failures += 1;
      retry();
    }).finally(() => {
      if (active !== task) return;
      active = null;
      if (!lastError) schedulePump();
    });
  }
  function ensure() {
    running = true;
    if (lastError && !retryTimer) lastError = null;
    schedulePump();
  }
  // 睡眠定时到点：不再补备节目，停掉在做的后台节目和备节目的口播；下次领取（ensure）自动恢复。
  function idle() {
    running = false;
    if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
    if (active?.kind === 'background') active.controller.abort(new Error('睡眠定时已停'));
    for (const ep of buffer) voiceJobs.get(ep.id)?.abort();
  }
  function runForeground(run) {
    const error = new Error('这次请求已被新的请求替换');
    if (foreground) { foreground.controller.abort(error); foreground.reject(error); }
    if (active) active.controller.abort(error);
    if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
    const controller = new AbortController();
    const promise = new Promise((resolve, reject) => {
      foreground = { kind: 'foreground', run, controller, resolve, reject };
    });
    schedulePump();
    return promise;
  }
  function invalidate() {
    epoch += 1;
    buffer.splice(0).forEach((ep) => { episodes.delete(ep.id); voiceJobs.get(ep.id)?.abort(); });
    for (const claim of claims.values()) { claim.invalid = true; claim.controller?.abort(new Error('节目已更新，请重试')); voiceJobs.get(claim.episode.id)?.abort(); }
    active?.controller.abort(new Error('节目已更新，请重试'));
    if (foreground) { foreground.controller.abort(); foreground.reject(new Error('节目已更新，请重试')); foreground = null; }
    if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
    lastError = null;
    failures = 0;
    emit({ kind: 'episodesInvalidated', epoch });
    notifyChange();
    ensure();
    return epoch;
  }
  async function claim(claimId) {
    expire();
    if (!claimId) throw new Error('缺少领取编号');
    const old = claims.get(claimId);
    if (old) {
      if (old.invalid) throw new Error('节目已更新，请重新领取');
      await old.ready;
      return stale(old.episode);
    }
    const prior = started.get(claimId);
    if (prior) {
      if (prior.episode.epoch !== epoch || now() - prior.at >= CLAIM_TTL) throw new Error('节目已失效，请重新领取');
      return stale(prior.episode);
    }
    const ep = buffer.shift();
    if (!ep) {
      const error = lastError;
      ensure();
      if (error) throw error;
      return null;
    }
    const entry = { at: now(), episode: ep, invalid: false, controller: new AbortController() };
    entry.timer = setTimer(() => { if (claims.get(claimId) === entry) release(claimId); }, CLAIM_TTL);
    entry.timer?.unref?.();
    claims.set(claimId, entry);
    entry.ready = Promise.resolve().then(() => refresh(ep, { signal: entry.controller.signal })).then(() => {
      if (entry.invalid || claims.get(claimId) !== entry) throw new Error('节目已失效，请重新领取');
    });
    notifyChange();
    ensure();
    await entry.ready;
    return stale(ep);
  }
  function release(claimId) {
    const entry = claims.get(claimId);
    if (!entry) return false;
    claims.delete(claimId);
    if (entry.timer) clearTimer(entry.timer);
    entry.controller?.abort(new Error('节目已失效，请重新领取'));
    episodes.delete(entry.episode.id);
    voiceJobs.get(entry.episode.id)?.abort();
    notifyChange();
    return true;
  }
  function start(id, claimId) {
    expire();
    const previous = started.get(claimId);
    if (previous?.episode.id === id) return previous.episode;
    const entry = claims.get(claimId);
    if (!entry || entry.invalid || entry.episode.id !== id || entry.episode.epoch !== epoch) throw new Error('节目已失效，请重新领取');
    const ep = stale(entry.episode);
    if (ep.voice.status === 'pending') skipVoice(ep);
    if (current && current !== ep) episodes.delete(current.id);
    current = ep;
    claims.delete(claimId);
    if (entry.timer) clearTimer(entry.timer);
    started.set(claimId, { episode: ep, at: entry.at });
    if (started.size > 500) started.delete(started.keys().next().value);
    commit(ep);
    notifyChange();
    ensure();
    return ep;
  }
  function getVoice(id) {
    const ep = episodes.get(id);
    if (!ep || !valid(ep)) return { status: 'skipped' };
    stale(ep);
    const item = ep.queue.find((q) => q.type === 'tts');
    return { ...ep.voice, ...(item ? { url: item.url, text: ep.say } : {}) };
  }
  return {
    ensure, idle, claim, release, start, invalidate, runForeground, retryVoices, exclusions, held,
    adopt(ep, claimId) {
      stamp(ep); episodes.set(ep.id, ep);
      const entry = { at: now(), episode: ep, invalid: false, ready: Promise.resolve() };
      entry.timer = setTimer(() => release(claimId), CLAIM_TTL); entry.timer?.unref?.();
      claims.set(claimId, entry);
      notifyChange();
      return ep;
    },
    setCurrent(ep) {
      stamp(ep);
      if (current && current !== ep) episodes.delete(current.id);
      current = ep;
      episodes.set(ep.id, ep);
      notifyChange();
    },
    getVoice, snapshot: () => ({ epoch, buffered: buffer.length, generating: Boolean(active), foreground: active?.kind === 'foreground', next: buffer[0] || null }),
    dispose() {
      disposed = true;
      active?.controller.abort();
      if (foreground) foreground.reject(new Error('电台已停止'));
      for (const controller of voiceJobs.values()) controller.abort();
      for (const claim of claims.values()) { if (claim.timer) clearTimer(claim.timer); claim.controller?.abort(); }
      if (retryTimer) clearTimer(retryTimer);
    },
  };
}
