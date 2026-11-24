// 실행(검사): bun wml/mods/imagestudio/backend/wayward-imagegen/src/repairWebpCache.ts --config wayward-imagegen/wayward-imagegen.config.json
// 실행(적용): 위 명령 뒤에 --apply를 추가합니다. 이미지 서버를 먼저 종료해야 합니다.
import net from 'node:net'
import { resolveConfig, type Config } from './config.ts'
import { CacheStore } from './cache/cacheStore.ts'

const argv = process.argv.slice(2)
const dryRun = !argv.includes('--apply') || argv.includes('--dry-run')
const config = resolveConfig(argv)

async function ImageStudio_서버실행확인하기(config: Config): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: config.host === '0.0.0.0' ? '127.0.0.1' : config.host, port: config.port })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', error => {
      socket.destroy()
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') resolve(false)
      else reject(error)
    })
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('Could not verify that the image server is stopped.')) })
  })
}

try {
  if (!dryRun && await ImageStudio_서버실행확인하기(config)) throw new Error('Close the image server before applying cache repair. It could overwrite the repaired index.')
  const cache = new CacheStore({ imagesDir: config.imagesDir, repairConvertedPaths: false, migrateLegacy: !dryRun })
  cache.load()
  const result = cache.ImageStudio_WebP캐시복원하기({ backupDirectory: `${config.stateDir}/cache-backups`, restoreBackups: true, dryRun })
  console.log(JSON.stringify({ dryRun, indexPaths: cache.indexPaths, ...result }, null, 2))
} catch (error) {
  console.error((error as Error).message)
  process.exitCode = 1
}
