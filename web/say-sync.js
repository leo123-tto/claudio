// 口播字幕跟声音的时间关系。字先出来 lead 秒，之后锁在「当前播放时间 + lead」上，避免稿子先跑完。
export const SAY_LEAD_S = 0.8;
export const SAY_CHARS_PER_S = 4;

export function sayVirtualTime({ playing = false, elapsed = 0, currentTime = 0, lead = SAY_LEAD_S } = {}) {
  if (playing) return Math.max(0, (Number(currentTime) || 0) + lead);
  return Math.min(Math.max(0, Number(elapsed) || 0), lead);
}

export function sayCharsShown(total, virtualTime, duration = NaN, rate = SAY_CHARS_PER_S) {
  const count = Math.max(0, Number(total) || 0);
  if (!count) return 0;
  const time = Math.max(0, Number(virtualTime) || 0);
  if (Number.isFinite(duration) && duration >= 0.3) {
    return Math.min(count, Math.round((Math.min(time, duration) / duration) * count));
  }
  return Math.min(count, Math.round(time * rate));
}
