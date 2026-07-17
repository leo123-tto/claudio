const path = require('path')

const MODULES = [
  ['search', 'search.js', '/search'],
  ['song_url_v1', 'song_url_v1.js', '/song/url/v1'],
  ['lyric', 'lyric.js', '/lyric'],
  ['simi_song', 'simi_song.js', '/simi/song'],
  ['playlist_track_all', 'playlist_track_all.js', '/playlist/track/all'],
]

function buildModuleDefs(packageRoot, loader = require) {
  return MODULES.map(([identifier, file, route]) => ({
    identifier,
    route,
    module: loader(path.join(packageRoot, 'module', file)),
  }))
}

module.exports = { buildModuleDefs }
