export function isProcessAlive(pid, signal = process.kill) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { signal(pid, 0); return true; } catch { return false; }
}

export function watchParentFromEnv({ intervalMs = 1500 } = {}) {
  const parentPid = Number(process.env.CLAUDIO_PARENT_PID);
  if (!Number.isInteger(parentPid) || parentPid <= 1) return null;
  const timer = setInterval(() => {
    if (!isProcessAlive(parentPid)) process.exit(0);
  }, intervalMs);
  timer.unref();
  return timer;
}
