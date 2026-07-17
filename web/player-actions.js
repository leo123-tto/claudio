const clampVolume = (value) => Math.max(0, Math.min(100, Number(value) || 0));

export function executePlayerAction(control = {}, handlers = {}) {
  const action = String(control.action || 'none');
  if (['pause', 'resume', 'next', 'previous', 'stop', 'favorite', 'dislike'].includes(action)) {
    const handler = handlers[action];
    if (typeof handler !== 'function') return false;
    handler();
    return true;
  }
  if (action === 'volume_up' || action === 'volume_down' || action === 'volume_set') {
    if (typeof handlers.setVolume !== 'function') return false;
    const current = clampVolume(handlers.getVolume?.());
    const value = action === 'volume_up'
      ? current + 10
      : action === 'volume_down'
        ? current - 10
        : control.actionValue;
    handlers.setVolume(clampVolume(value));
    return true;
  }
  return false;
}
