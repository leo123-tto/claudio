import { matchesStyle, styleConstraints } from './style-request.js';
const LANES = new Set(['popular', 'fresh', 'classic']);

export function episodeCandidates(result = {}, poolSongs = [], request = '') {
  if (result.intent !== 'recommend') return [];
  // 模型 play[] 的先后就是口播里提到歌的先后；记下位置，挑完歌后按它排播放顺序。发现池兜底的歌没有位置。
  const direct = (Array.isArray(result.play) ? result.play : []).map((song, playOrder) => ({ ...song, playOrder }));
  const constraints = styleConstraints(request);
  const fallback = (Array.isArray(poolSongs) ? poolSongs : []).filter((song) => matchesStyle(song, constraints)).map((song) => {
    const lane = LANES.has(song.lane) ? song.lane : '';
    return {
      ...song,
      ...(lane ? { lane } : {}),
      discoveryType: lane ? 'explore' : 'adjacent',
      bridgeFrom: song.bridgeFrom || (lane ? `发现池 ${lane}` : '网易云相似关系候选'),
      score: lane ? 58 : 55,
    };
  });
  return [...direct, ...fallback];
}
