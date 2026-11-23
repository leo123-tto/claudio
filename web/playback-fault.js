// 把浏览器报的播放错误收成电台能说清的原因。
export function classifyPlaybackFault({ mediaError = 0, httpStatus = 0, stalled = false } = {}) {
  const status = Number(httpStatus) || 0;
  const code = Number(mediaError) || 0;
  if (status === 401 || status === 403 || status === 410) {
    return { reason: 'link_expired', text: '这首的播放链接失效了，换一首' };
  }
  if (code === 2 || stalled) return { reason: 'underrun', text: '网络没跟上，这首先跳过' };
  if (code === 4) return { reason: 'unavailable', text: '这首没有可播的音源' };
  if (code === 3) return { reason: 'corrupt', text: '这首音频读不出来' };
  return { reason: 'failed', text: '这首暂时无法播放，换下一首' };
}
