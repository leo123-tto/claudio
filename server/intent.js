const REPLIES = Object.freeze({
  pause: '好，先暂停。',
  resume: '好，继续播放。',
  next: '好，换一首。',
  previous: '回到上一首。',
  stop: '好，音乐停下了。',
  favorite: '记下了，这首加入喜欢。',
  dislike: '记住了，以后少放这类。',
  volume_up: '音量调大一点。',
  volume_down: '音量调小一点。',
});

function control(action, actionValue = 0, reply = REPLIES[action]) {
  return { intent: 'control', action, actionValue, reply };
}

// 只拦截短而明确的播放器命令，让暂停/切歌等操作立即响应；
// 较长或有歧义的话继续交给模型理解，避免“我不喜欢别人催我”被误判成踩歌。
export function classifyDirectControl(input = '') {
  const text = String(input).trim().replace(/[。！!？?，,；;]+$/g, '').trim();
  if (!text || text.length > 24) return null;

  const volume = text.match(/^(?:请|麻烦)?(?:把)?(?:音量|声音)(?:调|设|设置)?到\s*(\d{1,3})\s*%?(?:吧)?$/);
  if (volume) {
    const actionValue = Math.max(0, Math.min(100, Number(volume[1])));
    return control('volume_set', actionValue, `音量调到 ${actionValue}%。`);
  }
  if (/^(?:请|麻烦)?(?:把)?(?:音量|声音)(?:再)?(?:调)?(?:大|高)(?:一?点|一些)?(?:吧)?$/.test(text)) return control('volume_up');
  if (/^(?:请|麻烦)?(?:把)?(?:音量|声音)(?:再)?(?:调)?(?:小|低)(?:一?点|一些)?(?:吧)?$/.test(text)) return control('volume_down');

  if (/^(?:请|麻烦)?(?:先)?(?:把)?(?:音乐|这首歌)?(?:暂停(?:一下)?|停一下)(?:播放|音乐)?(?:吧)?$/.test(text)) return control('pause');
  if (/^(?:请|麻烦)?(?:继续(?:播放)?|接着放|恢复播放|开始播放)(?:音乐|这首歌)?(?:吧)?$/.test(text)) return control('resume');
  if (/^(?:请|麻烦)?(?:下一首(?:歌)?|下一个|换一首|换首歌|切歌|跳过(?:这首)?)(?:吧)?$/.test(text)) return control('next');
  if (/^(?:请|麻烦)?(?:上一首(?:歌)?|上一个|回到上一首)(?:吧)?$/.test(text)) return control('previous');
  if (/^(?:请|麻烦)?(?:停止播放|停止音乐|关掉音乐|不要放了)(?:吧)?$/.test(text)) return control('stop');
  if (/^(?:请|麻烦)?(?:收藏(?:一下)?(?:这首(?:歌)?)?|喜欢这首(?:歌)?)(?:吧)?$/.test(text)) return control('favorite');
  if (/^(?:我)?(?:不喜欢这首(?:歌)?|这首(?:歌)?不好听|以后别放这首(?:歌)?)(?:了|吧)?$/.test(text)) return control('dislike');
  return null;
}
