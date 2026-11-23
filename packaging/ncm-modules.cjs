const path = require('path')

const MODULES = [
  ['search', 'search.js', '/search'],
  ['song_url_v1', 'song_url_v1.js', '/song/url/v1'],
  ['lyric', 'lyric.js', '/lyric'],
  ['simi_song', 'simi_song.js', '/simi/song'],
  ['playlist_track_all', 'playlist_track_all.js', '/playlist/track/all'],
  ['song_detail', 'song_detail.js', '/song/detail'],
  ['song_wiki_summary', 'song_wiki_summary.js', '/song/wiki/summary'],
]

// 公用版（NCM_MODULES=public）另外要扫码登录、读本人歌单 / 喜欢 / 每日推荐 / 私人 FM、加红心；个人版不开这些
const PUBLIC_MODULES = [
  ['login_qr_key', 'login_qr_key.js', '/login/qr/key'],
  ['login_qr_create', 'login_qr_create.js', '/login/qr/create'],
  ['login_qr_check', 'login_qr_check.js', '/login/qr/check'],
  ['user_account', 'user_account.js', '/user/account'],
  ['user_playlist', 'user_playlist.js', '/user/playlist'],
  ['likelist', 'likelist.js', '/likelist'],
  ['recommend_songs', 'recommend_songs.js', '/recommend/songs'],
  ['personal_fm', 'personal_fm.js', '/personal_fm'],
  ['like', 'like.js', '/like'],
]

function buildModuleDefs(packageRoot, loader = require, { publicModules = process.env.NCM_MODULES === 'public' } = {}) {
  return [...MODULES, ...(publicModules ? PUBLIC_MODULES : [])].map(([identifier, file, route]) => ({
    identifier,
    route,
    module: loader(path.join(packageRoot, 'module', file)),
  }))
}

module.exports = { buildModuleDefs }
