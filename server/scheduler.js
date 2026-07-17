// 节律调度：对齐到整点触发，把"早间/情绪"等理由交给 onTrigger。
// 触发后做不做、怎么做，由 index.js 决定（例如没人在听就跳过，省额度）。
//   07:00 规划当日 · 09:00 早间节目 · 其余整点情绪检查。
export function startScheduler({ onTrigger } = {}) {
  if (typeof onTrigger !== 'function') return { stop() {} };
  let timer = null;
  let stopped = false;

  function fire(hour) {
    if (hour === 7) onTrigger('morning-plan');
    else if (hour === 9) onTrigger('morning-show');
    else onTrigger('hourly-mood');
  }

  function scheduleNext() {
    if (stopped) return;
    const now = new Date();
    const next = new Date(now);
    next.setHours(now.getHours() + 1, 0, 0, 0); // 下一个整点
    timer = setTimeout(() => {
      if (stopped) return;
      fire(next.getHours());
      scheduleNext();
    }, next - now);
    if (timer.unref) timer.unref();
  }

  scheduleNext();
  return { stop() { stopped = true; clearTimeout(timer); } };
}
