const fs = require('fs')
const os = require('os')
const path = require('path')

const packageRoot = path.resolve(__dirname, '../app/node_modules/NeteaseCloudMusicApi')
const { buildModuleDefs } = require('./ncm-modules.cjs')

async function main() {
  const tokenFile = path.join(os.tmpdir(), 'anonymous_token')
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, '', 'utf8')
  await require(path.join(packageRoot, 'generateConfig'))()
  const app = await require(path.join(packageRoot, 'server')).serveNcmApi({
    port: Number(process.env.PORT || 3000),
    host: process.env.HOST || '127.0.0.1',
    checkVersion: false,
    moduleDefs: buildModuleDefs(packageRoot),
  })

  const parentPid = Number(process.env.CLAUDIO_PARENT_PID)
  if (Number.isInteger(parentPid) && parentPid > 1) {
    const timer = setInterval(() => {
      try { process.kill(parentPid, 0) }
      catch { process.exit(0) }
    }, 1500)
    timer.unref()
  }

  const shutdown = () => {
    if (app.server) app.server.close(() => process.exit(0))
    else process.exit(0)
    setTimeout(() => process.exit(1), 1500).unref()
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}

main().catch((error) => {
  console.error('[ncm runtime]', error)
  process.exit(1)
})
