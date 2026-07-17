export function episodeCandidates(result = {}, poolSongs = []) {
  if (result.intent !== 'recommend') return [];
  const fallback = (Array.isArray(poolSongs) ? poolSongs : []).map((song) => ({
    ...song,
    discoveryType: 'adjacent',
    bridgeFrom: '网易云相似关系候选',
    score: 55,
  }));
  return [...(Array.isArray(result.play) ? result.play : []), ...fallback];
}
