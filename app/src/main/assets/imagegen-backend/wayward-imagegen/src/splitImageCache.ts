/** Inspect by default. --apply requires the image server to be stopped. */
import net from 'node:net'
import { resolveConfig } from './config.ts'
import { CacheStore } from './cache/cacheStore.ts'
import { cacheCharacter } from './cache/characterCacheIndex.ts'

const args = process.argv.slice(2), config = resolveConfig(args)
const apply = args.includes('--apply') && !args.includes('--dry-run')
try {
  if (apply) {
    const running = await new Promise<boolean>((resolve, reject) => {
      const socket = net.createConnection({ host: config.host === '0.0.0.0' ? '127.0.0.1' : config.host, port: config.port })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', error => {
        socket.destroy()
        if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') resolve(false)
        else reject(error)
      })
      socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('Could not verify that the image server is stopped.')) })
    })
    if (running) throw new Error('Close the image server before splitting its cache. No files were changed.')
  }
  const cache = new CacheStore({ imagesDir: config.imagesDir, repairConvertedPaths: false, migrateLegacy: false }).load()
  const counts: Record<string, number> = Object.create(null)
  for (const entry of Object.values(cache.entries)) {
    const character = cacheCharacter(entry)
    counts[character] = (counts[character] || 0) + 1
  }
  if (apply) cache.save()
  console.log(JSON.stringify({ apply, entries: cache.size, characters: counts, indexPaths: cache.indexPaths, legacyBackupPath: cache.legacyBackupPath }, null, 2))
} catch (error) {
  console.error((error as Error).message)
  process.exitCode = 1
}
