export function abortReason(signal) {
  return signal?.reason || new DOMException('语音已取消', 'AbortError');
}

// 除了把 signal 交给网络/子进程，还要及时结束本地等待；迟到的结果不可继续落盘或发给前端。
export function withAbort(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(abortReason(signal)); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    Promise.resolve(promise).then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(abortReason(signal));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}
