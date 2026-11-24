/** Offline packs use cache/pack metadata, never guesses from truncated filenames. */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Config, ImagePathVerifier } from '../config.ts'
import type { CacheStore } from '../cache/cacheStore.ts'
import type { PackEntry, ImagePack } from '../cache/packProjection.ts'
import { safeJoin, toPosix } from '../cache/paths.ts'
import { Router, HttpError, sendJson } from '../http/router.ts'
import { readJson } from '../http/body.ts'

export interface CustomPackResult {
  wife: string
  filename: string
  file: string
  directory: string
  images: number
  missingFiles: number
  unindexedFiles: number
  duplicateVariants: number
  backupPath: string | null
  warnings: string[]
}

export interface HStatusPackResult {
  character: string
  filename: string
  file: string
  images: number
  missingFiles: number
  backupPath: string | null
}

function customPackOwns(wife: string, talentName: string): boolean {
  const lower = talentName.toLowerCase()
  return lower === wife || lower.startsWith(wife + '_') || lower.startsWith('tavern_' + wife + '_')
    || (lower.startsWith('situation_') && lower.split('__')[1] === wife)
}

/** Read the two shipped data-only wrappers without executing arbitrary JS. */
function customPackReadEntries(file: string): Record<string, PackEntry & { createdAt?: number }> {
  const source = fs.readFileSync(file, 'utf8')
  const encoded = /entries\s*:\s*JSON\.parse\(\s*("(?:\\.|[^"\\])*")\s*\)/.exec(source)
  if (encoded) return JSON.parse(JSON.parse(encoded[1]))
  const plain = /\.push\((\{[\s\S]*\})\)\s*;?\s*\}\)\(\);?\s*$/.exec(source)
  if (plain) {
    const pack = JSON.parse(plain[1])
    if (pack.packFormat === 1 && pack.entries && typeof pack.entries === 'object') return pack.entries
  }
  throw new Error('지원하지 않는 이미지팩 데이터 형식')
}

export function buildCustomPack(config: Config, cache: CacheStore, wife: string): CustomPackResult {
  if (!/^[a-z][a-z0-9_-]{0,99}$/.test(wife)) throw new HttpError(400, '아내의 영문 ID가 올바르지 않습니다.')
  if (path.basename(cache.imagesDir).toLowerCase() !== 'images') {
    throw new HttpError(400, '오프라인 팩 생성에는 이름이 images인 이미지 폴더가 필요합니다.')
  }
  const directory = path.dirname(cache.imagesDir)
  const realRoot = fs.realpathSync(cache.imagesDir)
  const knownPaths = new Set<string>()
  const missingPaths = new Set<string>()
  const entries: Record<string, PackEntry & { createdAt: number }> = Object.create(null)
  const ranks = new Map<string, number>()
  const warnings: string[] = []
  let included = 0
  const include = (candidate: Partial<PackEntry> & { createdAt?: number; debug?: Record<string, unknown> }, rank: number) => {
    if (typeof candidate?.talentName !== 'string' || typeof candidate.imagePath !== 'string') return
    if (!customPackOwns(wife, candidate.talentName)) return
    const relative = toPosix(candidate.imagePath)
    let file: string
    let stat: fs.Stats
    try {
      file = safeJoin(cache.imagesDir, relative)
      // 경로 정규화 후 확인하여 ../ 등으로 situation 폴더가 섞이지 않게 합니다.
      if (!toPosix(path.relative(cache.imagesDir, file)).startsWith('illustrious/characters/')) return
      stat = fs.statSync(file)
      const realRelative = path.relative(realRoot, fs.realpathSync(file))
      if (!stat.isFile() || !realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error('unsafe path')
      if (!toPosix(realRelative).startsWith('illustrious/characters/')) return
    } catch {
      missingPaths.add(relative)
      return
    }
    knownPaths.add(toPosix(path.relative(cache.imagesDir, file)))
    included++
    const key = candidate.talentName
    const createdAt = typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt) ? candidate.createdAt : stat.mtimeMs
    const previous = entries[key]
    const previousRank = ranks.get(key) ?? -1
    // Generated/cache art overrides shipped metadata; newest render wins within a source.
    if (previous && (previousRank > rank || (previousRank === rank && previous.createdAt >= createdAt))) return
    const matching = candidate.matching || candidate.debug?.imageMatching
    entries[key] = { talentName: key, imagePath: toPosix(path.relative(cache.imagesDir, file)), imageType: candidate.imageType || 'portrait', createdAt,
      ...(matching && typeof matching === 'object' && !Array.isArray(matching) ? { matching: matching as Record<string, unknown> } : {}) }
    ranks.set(key, rank)
  }
  // Numbered/shipped packs preserve exact keys for older art absent from the cache.
  const prefix = `images-${wife}`
  for (const filename of fs.readdirSync(directory).sort()) {
    if (filename !== `${prefix}.js` && !filename.startsWith(prefix + '-')) continue
    if (!filename.endsWith('.js')) continue
    try {
      for (const candidate of Object.values(customPackReadEntries(path.join(directory, filename)))) include(candidate, 0)
    } catch (error) { warnings.push(`${filename}: ${(error as Error).message}`) }
  }
  for (const candidate of Object.values(cache.entries)) include(candidate, 1)

  // Report files that have no trustworthy condition metadata; do not invent keys.
  let unindexedFiles = 0
  const scan = (folder: string): void => {
    let children: fs.Dirent[]
    try { children = fs.readdirSync(folder, { withFileTypes: true }) } catch { return }
    for (const child of children) {
      const full = path.join(folder, child.name)
      if (child.isDirectory()) scan(full)
      else if (child.isFile() && /\.(png|webp|jpe?g|avif)$/i.test(child.name) && !knownPaths.has(toPosix(path.relative(cache.imagesDir, full)))) unindexedFiles++
    }
  }
  // 미등록 파일 집계도 실제 일반 팩의 허용 폴더 안으로 한정합니다.
  scan(path.join(cache.imagesDir, 'illustrious', 'characters', wife))
  const images = Object.keys(entries).length
  if (!images) throw new HttpError(400, '선택한 아내의 실제 이미지와 조건 기록이 일치하는 항목이 없습니다. 캐시 또는 기존 이미지팩에 등록된 이미지가 필요합니다.')
  const filename = `${prefix}-custom.js`
  const file = path.join(directory, filename)
  let backupPath: string | null = null
  if (fs.existsSync(file)) {
    const backupDirectory = path.join(path.resolve(config.stateDir), 'custom-pack-backups')
    fs.mkdirSync(backupDirectory, { recursive: true })
    backupPath = path.join(backupDirectory, `${Date.now()}-${randomUUID()}-${filename}`)
    fs.copyFileSync(file, backupPath)
  }
  const pack: ImagePack = {
    packFormat: 1, packId: `${wife}-custom-${Date.now()}-${randomUUID()}`,
    generatedAt: new Date().toISOString(), characters: [wife], entryCount: images, entries, priority: 2,
  }
  const script = `/* Image Studio offline pack: ${wife}, ${images} images. Rename -custom to a numbered pack before use. */\n(function(){var P=window.__WAYWARD_IMAGE_PACKS__||(window.__WAYWARD_IMAGE_PACKS__=[]);P.push(${JSON.stringify(pack)});})();\n`
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, script, 'utf8')
    fs.renameSync(temporary, file)
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    throw error
  }
  return { wife, filename, file, directory, images, missingFiles: missingPaths.size, unindexedFiles, duplicateVariants: included - images, backupPath, warnings }
}

export function buildHStatusPack(config: Config, cache: CacheStore, character: string): HStatusPackResult {
  if (!/^[a-z][a-z0-9_-]{0,99}$/.test(character)) throw new HttpError(400, '캐릭터의 영문 ID가 올바르지 않습니다.')
  if (path.basename(cache.imagesDir).toLowerCase() !== 'images') throw new HttpError(400, 'H_Status 팩 생성에는 이름이 images인 이미지 폴더가 필요합니다.')
  const gameRoot = path.dirname(cache.imagesDir)
  const modDirectory = path.join(gameRoot, 'wml', 'mods', 'h-status')
  if (!fs.existsSync(path.join(modDirectory, 'mod.js'))) throw new HttpError(400, '게임의 wml/mods/h-status 폴더를 찾지 못했습니다.')
  const escaped = character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const owns = new RegExp(`^situation_(?:fluid|vulva|status|observation|event)__${escaped}__`, 'i')
  const entries: Record<string, PackEntry & { createdAt?: number | string }> = Object.create(null)
  const ranks = new Map<string, number>()
  const missing = new Set<string>()
  const include = (candidate: Partial<PackEntry> & { createdAt?: number | string }, rank: number) => {
    if (typeof candidate.talentName !== 'string' || typeof candidate.imagePath !== 'string' || !owns.test(candidate.talentName)) return
    const relative = toPosix(candidate.imagePath).replace(/^\/+/, '')
    if (!relative.startsWith(`illustrious/situation/`) || !relative.includes(`/${character}/`)) return
    let file: string
    let stat: fs.Stats
    try { file = safeJoin(cache.imagesDir, relative); stat = fs.statSync(file); if (!stat.isFile()) throw new Error('not a file') }
    catch { missing.add(relative); return }
    const createdAt = typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.parse(String(candidate.createdAt || '')) || stat.mtimeMs
    const previous = entries[candidate.talentName]
    const previousRank = ranks.get(candidate.talentName) ?? -1
    const previousTime = previous ? (typeof previous.createdAt === 'number' ? previous.createdAt : Date.parse(String(previous.createdAt || '')) || 0) : 0
    if (previous && (previousRank > rank || (previousRank === rank && previousTime >= createdAt))) return
    entries[candidate.talentName] = { talentName: candidate.talentName, imagePath: relative,
      imageType: candidate.talentName.split('__', 1)[0] || 'situation', createdAt,
      ...(candidate.matching && typeof candidate.matching === 'object' ? { matching: candidate.matching } : {}) }
    ranks.set(candidate.talentName, rank)
  }
  for (const filename of fs.readdirSync(modDirectory).filter(name => /^images-situation-.+\.js$/i.test(name)).sort()) {
    try { for (const candidate of Object.values(customPackReadEntries(path.join(modDirectory, filename)))) include(candidate, 0) } catch { /* unrelated legacy pack */ }
  }
  for (const candidate of Object.values(cache.entries)) include(candidate, 1)
  const images = Object.keys(entries).length
  if (!images) throw new HttpError(400, '선택한 캐릭터의 H_Status 이미지와 조건 기록이 일치하는 항목이 없습니다.')
  const filename = `images-situation-${character}.js`
  const file = path.join(modDirectory, filename)
  let backupPath: string | null = null
  if (fs.existsSync(file)) {
    const backupDirectory = path.join(path.resolve(config.stateDir), 'h-status-pack-backups')
    fs.mkdirSync(backupDirectory, { recursive: true })
    backupPath = path.join(backupDirectory, `${Date.now()}-${randomUUID()}-${filename}`)
    fs.copyFileSync(file, backupPath)
  }
  const pack: ImagePack = { packFormat: 1, packId: `wayward-situation-${character}-custom-v1`, priority: 110,
    generatedAt: new Date().toISOString(), characters: [character], entryCount: images, entries: entries as Record<string, PackEntry> }
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, `/* ImageStudio H_Status pack: ${character}, ${images} images. */\n(function(){var p=window.__WAYWARD_IMAGE_PACKS__||(window.__WAYWARD_IMAGE_PACKS__=[]);p.push(${JSON.stringify(pack)});})();\n`, 'utf8')
    fs.renameSync(temporary, file)
  } catch (error) { fs.rmSync(temporary, { force: true }); throw error }
  return { character, filename, file, images, missingFiles: missing.size, backupPath }
}

export function ImageStudio_카탈로그실파일확인하기(
  cache: CacheStore, paths: string[], refresh = false,
  extraVerifiers: readonly ImagePathVerifier[] = [],
): { checked: number; missing: string[] } {
  const onDisk = cache.existingImagePaths(refresh ? 0 : 30_000)
  const realRoot = fs.realpathSync(cache.imagesDir)
  const missing: string[] = []
  for (const original of paths) {
    const relative = toPosix(original).replace(/^\.\//, '')
    try {
      // 호환 모드 내부의 예전 이미지 경로는 그 확장이 직접 검증합니다.
      let extraResult: boolean | undefined
      for (const verify of extraVerifiers) {
        const result = verify(relative)
        if (result !== null) { extraResult = result; break }
      }
      if (extraResult === true) continue
      if (extraResult === false) throw new Error('missing extension image')
      const full = safeJoin(cache.imagesDir, relative)
      if (onDisk.has(relative)) continue
      const inside = path.relative(realRoot, fs.realpathSync(full))
      if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || !fs.statSync(full).isFile()) throw new Error('missing file')
    } catch { missing.push(relative) }
  }
  return { checked: paths.length, missing }
}

export function registerCustomPackRoutes(router: Router, config: Config, cache: CacheStore): void {
  router.get('/api/custom-pack/capabilities', ctx => sendJson(ctx.res, 200, {
    directory: 'illustrious/characters/',
  }))
  router.post('/api/image-cache/verify', async ctx => {
    const body = await readJson<{ paths?: unknown; refresh?: boolean }>(ctx.req, 5 * 1024 * 1024)
    if (!Array.isArray(body.paths) || body.paths.length > 2000 || body.paths.some(value => typeof value !== 'string' || !value || value.length > 2048)) {
      throw new HttpError(400, '확인할 이미지 경로는 최대 2000개까지 보낼 수 있습니다.')
    }
    sendJson(ctx.res, 200, ImageStudio_카탈로그실파일확인하기(
      cache, body.paths as string[], body.refresh === true, config.imagePathVerifiers,
    ))
  })
  router.post('/api/custom-pack/build', async ctx => {
    const body = await readJson<{ wife?: string }>(ctx.req, 4096)
    if (typeof body.wife !== 'string') throw new HttpError(400, '아내를 선택해 주세요.')
    sendJson(ctx.res, 200, buildCustomPack(config, cache, body.wife))
  })
  router.post('/api/h-status-pack/build', async ctx => {
    const body = await readJson<{ character?: string }>(ctx.req, 4096)
    if (typeof body.character !== 'string') throw new HttpError(400, '캐릭터를 선택해 주세요.')
    sendJson(ctx.res, 200, buildHStatusPack(config, cache, body.character))
  })
  // A distinct route prevents an old server ignoring a character parameter
  // and accidentally performing a full-library operation.
  for (const scoped of [false, true]) router.post(scoped ? '/api/image-cache/sync-character' : '/api/image-cache/sync', async ctx => {
    const character = scoped ? ctx.query.get('character') : undefined
    if (scoped && (!character || !/^[a-z][a-z0-9_-]{0,99}$/.test(character))) throw new HttpError(400, '초기화할 아내를 선택해 주세요.')
    const scope = character || undefined
    const directory = path.join(path.resolve(config.stateDir), 'cache-backups')
    if (ctx.query.get('progress') !== '1') {
      const result = cache.syncMissing(directory, scope)
      sendJson(ctx.res, 200, { ...result, indexPaths: cache.indexPaths })
      return
    }
    ctx.res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' })
    const controller = new AbortController()
    const cancel = () => controller.abort()
    ctx.res.once('close', cancel)
    const emit = (event: unknown) => { if (!ctx.res.destroyed) ctx.res.write(JSON.stringify(event) + '\n') }
    try {
      const result = await cache.syncMissingWithProgress(directory, value => emit({ type: 'progress', ...value }), controller.signal, scope)
      emit({ type: 'result', result: { ...result, indexPaths: cache.indexPaths } })
    } catch (error) { emit({ type: 'error', error: (error as Error).message }) }
    finally {
      ctx.res.off('close', cancel)
      if (!ctx.res.destroyed) ctx.res.end()
    }
  })
}
