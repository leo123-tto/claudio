import { randomUUID } from 'node:crypto';

const CLAIM_TTL = 15 * 60 * 1000;
const SAY_TTL = 40 * 60 * 1000;
const songItems = (ep) => (ep?.queue || []).filter((item) => item.type === 'song');

// 只有这条调度车道可以调用大脑；领取和语音都不占这条车道。
export function createEpisodeBuffer({
  capacity = 2, build, refresh = async (ep) => ep, commit = () => {},
  synthesize, emit = () => {}, hasClients = () => false, now = Date.now,
  enabled = () => true, offline = () => false, changed = () => {}, listening = () => true,
  speaks = () => true, // 口播频率：领取时问一次这一期说不说（server/talk.js）
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
  // 领取时定这一期开不开口，只定一次（同一个领取编号重复领取要拿到同样的结果）。
  // 不开口：停掉这期的语音（连在合成的也停，免得 voiceReady 又把口播塞回去），交出去的是去掉口播的副本；
  // 备好的原件的 say 不动（对话记录、避重复靠它），只标 muted。
  function deliver(ep) {
    stale(ep);
    if (ep.muted === undefined) ep.muted = Boolean(ep.say) && !speaks(ep);
    if (!ep.muted) return ep;
    skipVoice(ep);
    return { ...ep, say: '', sayTts: '', voice: { status: 'skipped' }, queue: ep.queue.filter((item) => item.type !== 'tts') };
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
      // sayTts：带时段语气和演出标记、只给语音念的版本（server/tone.js）；页面和记录用 say
      const audio = await synthesize(ep.sayTts || ep.say, { signal: controller.signal });
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
  // 驾驶模式开关变了：备好的节目照常放，只改口播（改短后重新合成；来不及合成时开播会跳过口播）。
  // 不作废节目，免得一进驾驶模式按「下一首」就得等现场重新生成。正在放的不动。
  // voiceText：改短后的口播怎么念（驾驶档的语气提示）；不给就念干净的 say。
  function reviseSays(rewrite, voiceText = null) {
    const pending = [...buffer, ...[...claims.values()].filter((c) => !c.invalid).map((c) => c.episode)];
    let revised = 0;
    for (const ep of pending) {
      if (!ep?.say || ep.muted || ep === current) continue;
      const say = String(rewrite(ep.say) || '').trim();
      if (!say || say === ep.say) continue;
      voiceJobs.get(ep.id)?.abort();
      voiceJobs.delete(ep.id);
      ep.say = say;
      ep.sayTts = voiceText ? voiceText(say) : say;
      ep.queue = ep.queue.filter((item) => item.type !== 'tts');
      ep.voice = { status: ep.voice?.status === 'skipped' ? 'skipped' : 'pending' };
      ep.voiceFailures = 0;
      revised += 1;
      emit({ kind: 'sayRevised', episodeId: ep.id, say, voice: ep.voice.status });
      void voice(ep);
    }
    if (revised) notifyChange();
    return revised;
  }
  async function claim(claimId) {
    expire();
    if (!claimId) throw new Error('缺少领取编号');
    const old = claims.get(claimId);
    if (old) {
      if (old.invalid) throw new Error('节目已更新，请重新领取');
      await old.ready;
      return deliver(old.episode);
    }
    const prior = started.get(claimId);
    if (prior) {
      if (prior.episode.epoch !== epoch || now() - prior.at >= CLAIM_TTL) throw new Error('节目已失效，请重新领取');
      return deliver(prior.episode);
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
    return deliver(ep);
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
    ensure, idle, claim, release, start, invalidate, reviseSays, runForeground, retryVoices, exclusions, held,
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
