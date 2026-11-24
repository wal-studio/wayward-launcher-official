/**
 * The persistent image cache.
 *
 * Character JSON indexes (`<imagesDir>/.image-cache_<name>.json`) map cache keys to the
 * file that satisfies it. This is the memory that makes a render happen once:
 * without it, replaying the same game state would re-run the sampler every
 * time.
 *
 * Instance-scoped rather than module-global so tests can spin one up against a
 * temp directory, and so a future second library needs no new code.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { WorkflowType } from '../config.ts'
import { getCacheKey, isUserCreatedVariant } from '../naming.ts'
import { safeJoin, toPosix } from './paths.ts'
import { ImageStudio_WebP후보목록만들기, ImageStudio_WebP대체경로읽기 } from './webpRelink.ts'
import { CharacterCacheIndex, H_STATUS_CACHE_SHARD, cacheCharacter } from './characterCacheIndex.ts'

export interface CacheEntry {
  promptHash: string
  /** Path relative to the images root, forward-slashed. */
  imagePath: string
  talentName: string
  imageType: string
  createdAt: number
  /** Kept for debugging and for re-deriving a render. */
  prompt: string
  /**
   * The negative prompt, when known.
   *
   * Optional because the historical index does not have it — entries written
   * before this field existed carry only the positive prompt. It matters for
   * contribution bundles: `promptHash` covers BOTH prompts, so without this the
   * receiving end cannot recompute the hash and has nothing to check the image
   * against.
   */
  negativePrompt?: string
  /**
   * The generation settings this render used.
   *
   * Recorded because `promptHash` FOLDS THEM IN when they are present: two
   * requests with the same text but different steps produce different pictures
   * and must not share a cache cell. Without them stored, the hash cannot be
   * recomputed from the entry, so nothing downstream can check that an entry
   * describes what it claims — which is exactly what a contribution bundle
   * needs to prove.
   */
  genParams?: { steps?: number; cfg?: number; loraStrength?: number; checkpoint?: string; width?: number; height?: number;
    sampler?: string; noiseSchedule?: string; seed?: number }
  /** Optional caller-supplied state snapshot; shape is deliberately open. */
  debug?: Record<string, unknown>
  /**
   * Created by an explicit user action rather than by autopilot. Such entries
   * sit at variant indices normal play never reaches, so without this flag a
   * cull would read them as dead weight and delete work someone asked for.
   */
  userCreated?: boolean
}

export interface ImageCacheFile {
  version: 1
  entries: Record<string, CacheEntry>
}

export interface CacheStoreOptions {
  imagesDir: string
  /** The game's `MAX_CACHED_VARIANTS`; indices at or above it are user-created. */
  userVariantThreshold?: number
  /** Injected for tests. */
  now?: () => number
  /** Offline repair tools inspect first and explicitly choose when to write. */
  repairConvertedPaths?: boolean
  /** Inspection tools must not migrate the old index during a dry run. */
  migrateLegacy?: boolean
}

export interface CacheSyncProgress {
  phase: 'scan' | 'check' | 'save'
  processed: number
  total: number
  kept: number
  relinked: number
  missing: number
}
export interface CacheSyncResult {
  before: number; after: number; removed: number; relinked: number; backupPath: string | null
}

export class CacheStore {
  readonly imagesDir: string
  readonly indexPath: string
  private readonly index: CharacterCacheIndex
  private readonly userVariantThreshold: number | undefined
  private readonly now: () => number
  private cache: ImageCacheFile = { version: 1, entries: {} }
  private existingCache: { builtAt: number; set: Set<string> } | null = null
  private indexDigest: string | null = null
  private readonly repairConvertedPaths: boolean
  private readonly migrateLegacy: boolean

  constructor(opts: CacheStoreOptions) {
    this.imagesDir = path.resolve(opts.imagesDir)
    this.indexPath = path.join(this.imagesDir, '.image-cache.json')
    this.index = new CharacterCacheIndex(this.imagesDir)
    this.userVariantThreshold = opts.userVariantThreshold
    this.now = opts.now ?? Date.now
    this.repairConvertedPaths = opts.repairConvertedPaths !== false
    this.migrateLegacy = opts.migrateLegacy !== false
  }

  /**
   * Read character indexes individually, preserving all historical keys.
   * A corrupt index stops loading so it cannot be overwritten with empty data.
   */
  load(): this {
    this.cache = this.index.load()
    if (this.migrateLegacy) this.index.migrate(this.cache.entries)
    this.indexDigest = this.index.revision
    const hStatusMigration = this.ImageStudio_HStatus캐시이전하기()
    if (hStatusMigration.moved || hStatusMigration.relinked) {
      console.log(`[cache] moved ${hStatusMigration.moved} legacy H_Status images; relinked ${hStatusMigration.relinked}`)
    }
    console.log(`[cache] loaded ${this.size} entries from ${this.index.paths.length} character index files`)
    if (this.repairConvertedPaths && this.size) {
      try {
        const result = this.ImageStudio_WebP캐시복원하기()
        if (result.relinked) console.log(`[cache] linked ${result.relinked} converted/moved WebP images`)
      } catch (error) { console.warn('[cache] WebP path repair deferred:', (error as Error).message) }
    }
    return this
  }

  save(characters?: readonly string[]): void {
    this.index.save(this.cache.entries, characters)
    this.indexDigest = this.index.revision
  }

  /** Active files; indexPath remains only the legacy import location. */
  get indexPaths(): string[] { return this.index.paths }
  get legacyBackupPath(): string | null { return this.index.legacyBackupPath }

  get entries(): Readonly<Record<string, CacheEntry>> {
    return this.cache.entries
  }

  get size(): number {
    return Object.keys(this.cache.entries).length
  }

  /** Move pre-1.23 H_Status renders out of characters/unknown and update their single cache shard. */
  ImageStudio_HStatus캐시이전하기(): { moved: number; relinked: number } {
    const changed: { key: string; previous: CacheEntry; next: CacheEntry }[] = []
    const moved: { from: string; to: string }[] = []
    const sourceDirectories = new Set<string>()
    for (const [key, entry] of Object.entries(this.cache.entries)) {
      const match = /^situation_(fluid|vulva|status|observation|event)__([a-z][a-z0-9_-]{0,99}?)__(.+)$/i.exec(entry.talentName)
      if (!match) continue
      const kind = match[1]!.toLowerCase()
      const character = match[2]!.toLowerCase()
      const currentRelative = toPosix(entry.imagePath).replace(/^\/+/, '')
      if (currentRelative.startsWith('illustrious/situation/')) continue
      const branch = kind === 'fluid' || kind === 'vulva' ? 'info' : kind
      const expectedPrefix = `illustrious/situation/${branch}/${character}/`
      const currentAbsolute = this.absolutePathOf(entry)
      if (!currentAbsolute || !fs.existsSync(currentAbsolute)) continue
      const originalName = path.posix.basename(currentRelative)
      const legacyPrefix = `situation_${kind}_${character}_`
      const filename = originalName.toLowerCase().startsWith(legacyPrefix.toLowerCase())
        ? originalName.slice(legacyPrefix.length)
        : originalName
      const nextRelative = `${expectedPrefix}${filename}`
      const nextAbsolute = safeJoin(this.imagesDir, nextRelative)
      // A pre-existing destination must not replace this entry's distinct image.
      if (fs.existsSync(nextAbsolute)) continue
      fs.mkdirSync(path.dirname(nextAbsolute), { recursive: true })
      if (!fs.existsSync(nextAbsolute)) {
        fs.renameSync(currentAbsolute, nextAbsolute)
        moved.push({ from: currentAbsolute, to: nextAbsolute })
        sourceDirectories.add(path.dirname(currentAbsolute))
      }
      const next = { ...entry, imagePath: nextRelative }
      changed.push({ key, previous: entry, next })
      this.cache.entries[key] = next
    }
    if (!changed.length) return { moved: 0, relinked: 0 }
    try {
      this.save([H_STATUS_CACHE_SHARD])
      for (const directory of sourceDirectories) {
        try { if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory) } catch { /* keep non-empty legacy folders */ }
      }
      this.existingCache = null
      return { moved: moved.length, relinked: changed.length }
    } catch (error) {
      for (const item of changed) this.cache.entries[item.key] = item.previous
      for (const item of moved.reverse()) {
        try { fs.mkdirSync(path.dirname(item.from), { recursive: true }); fs.renameSync(item.to, item.from) } catch { /* preserve the original error */ }
      }
      throw error
    }
  }

  /** Absolute path of an entry's file, or null if the entry's path is unsafe. */
  absolutePathOf(entry: CacheEntry): string | null {
    try {
      return safeJoin(this.imagesDir, entry.imagePath)
    } catch {
      return null
    }
  }

  /**
   * Look up a render, verifying the file is still there.
   *
   * The existence check is not paranoia: players move and prune art folders,
   * and an index pointing at a deleted file produces a broken image with no
   * error anywhere. A miss self-heals by dropping the stale entry.
   */
  get(
    talentName: string,
    imageType: string,
    promptHash: string,
    workflow: WorkflowType,
  ): CacheEntry | null {
    const key = getCacheKey(talentName, imageType, promptHash, workflow)
    const entry = this.cache.entries[key]
    if (!entry) return null

    let full = this.absolutePathOf(entry)
    if (full && !fs.existsSync(full) && /\.(png|webp)$/i.test(entry.imagePath)) {
      const result = this.ImageStudio_WebP캐시복원하기()
      const updated = this.cache.entries[key]
      const repairedFull = updated && this.absolutePathOf(updated)
      if (result.relinked && repairedFull && fs.existsSync(repairedFull)) return updated!
      full = this.absolutePathOf(entry)
    }
    if (!full || !fs.existsSync(full)) {
      console.log(`[cache] file gone, dropping entry: ${key}`)
      delete this.cache.entries[key]
      try { this.save([cacheCharacter(entry)]) }
      catch (error) { this.cache.entries[key] = entry; throw error }
      return null
    }
    return entry
  }

  add(args: {
    talentName: string
    imageType: string
    promptHash: string
    /** Relative to the images root. Stored forward-slashed. */
    imagePath: string
    prompt: string
    negativePrompt?: string
    genParams?: { steps?: number; cfg?: number; loraStrength?: number; checkpoint?: string; width?: number; height?: number }
    workflow: WorkflowType
    debug?: Record<string, unknown>
    userCreated?: boolean
  }): CacheEntry {
    const key = getCacheKey(args.talentName, args.imageType, args.promptHash, args.workflow)
    const entry: CacheEntry = {
      promptHash: args.promptHash,
      imagePath: toPosix(args.imagePath),
      talentName: args.talentName,
      imageType: args.imageType,
      createdAt: this.now(),
      prompt: args.prompt,
      ...(args.negativePrompt ? { negativePrompt: args.negativePrompt } : {}),
      ...(args.genParams && Object.values(args.genParams).some(v => v !== undefined)
        ? { genParams: args.genParams } : {}),
      ...(args.debug ? { debug: args.debug } : {}),
      ...(args.userCreated || isUserCreatedVariant(args.talentName, this.userVariantThreshold)
        ? { userCreated: true }
        : {}),
    }
    const previous = this.cache.entries[key]
    this.cache.entries[key] = entry
    this.existingCache = null
    try { this.save([...new Set([cacheCharacter(entry), ...(previous ? [cacheCharacter(previous)] : [])])]) }
    catch (error) {
      if (previous) this.cache.entries[key] = previous
      else delete this.cache.entries[key]
      throw error
    }
    return entry
  }

  /** Remove one entry by key. Returns whether it was there. */
  remove(key: string): boolean {
    if (!(key in this.cache.entries)) return false
    const previous = this.cache.entries[key]!
    delete this.cache.entries[key]
    this.existingCache = null
    try { this.save([cacheCharacter(previous)]) }
    catch (error) { this.cache.entries[key] = previous; throw error }
    return true
  }

  private ImageStudio_캐시갱신저장하기(entries: Record<string, CacheEntry>, backupDirectory: string, character?: string): string {
    this.index.assertUnchanged()
    const original = JSON.stringify(character ? { version: 1, entries: Object.fromEntries(
      Object.entries(this.cache.entries).filter(([, entry]) => cacheCharacter(entry) === character)) } : this.cache)
    fs.mkdirSync(backupDirectory, { recursive: true })
    const backupPath = path.join(backupDirectory, `image-cache-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`)
    fs.writeFileSync(backupPath, original, { flag: 'wx' })
    const next: ImageCacheFile = { version: 1, entries }
    this.index.save(entries, character ? [character] : undefined)
    this.cache = next
    this.indexDigest = this.index.revision
    this.existingCache = null
    return backupPath
  }

  ImageStudio_WebP캐시복원하기(options: { backupDirectory?: string; restoreBackups?: boolean; dryRun?: boolean } = {}): {
    before: number; after: number; relinked: number; restored: number; skippedBackups: number; backupPath: string | null
  } {
    const backupDirectory = options.backupDirectory ?? path.join(this.imagesDir, '.state', 'cache-backups')
    const before = this.size
    const paths = this.existingImagePaths(0)
    const candidates = ImageStudio_WebP후보목록만들기(paths)
    const entries = { ...this.cache.entries }
    let relinked = 0, restored = 0, skippedBackups = 0
    for (const [key, entry] of Object.entries(entries)) {
      if (paths.has(toPosix(entry.imagePath))) continue
      const replacement = ImageStudio_WebP대체경로읽기(this.imagesDir, entry.imagePath, candidates)
      if (replacement) { entries[key] = { ...entry, imagePath: replacement }; relinked++ }
    }
    if (options.restoreBackups && fs.existsSync(backupDirectory)) {
      const backups = fs.readdirSync(backupDirectory).filter(name => name.endsWith('.json')).sort().reverse()
      for (const name of backups) {
        let previous: ImageCacheFile
        try {
          previous = JSON.parse(fs.readFileSync(path.join(backupDirectory, name), 'utf8')) as ImageCacheFile
          if (previous.version !== 1 || !previous.entries) throw new Error('invalid cache backup')
        } catch { skippedBackups++; continue }
        for (const [key, entry] of Object.entries(previous.entries)) {
          if (key in entries || !entry || typeof entry.imagePath !== 'string' || typeof entry.promptHash !== 'string'
            || typeof entry.talentName !== 'string' || typeof entry.imageType !== 'string' || typeof entry.prompt !== 'string') continue
          const replacement = ImageStudio_WebP대체경로읽기(this.imagesDir, entry.imagePath, candidates)
          if (replacement) { entries[key] = { ...entry, imagePath: replacement }; restored++ }
        }
      }
    }
    const backupPath = (relinked || restored) && !options.dryRun ? this.ImageStudio_캐시갱신저장하기(entries, backupDirectory) : null
    return { before, after: Object.keys(entries).length, relinked, restored, skippedBackups, backupPath }
  }

  /** Relink converted images before removing genuinely missing/unsafe files. */
  syncMissing(backupDirectory = path.join(this.imagesDir, '.state', 'cache-backups'), character?: string): CacheSyncResult {
    const steps = this.ImageStudio_캐시대조단계읽기(backupDirectory, character)
    let step = steps.next()
    while (!step.done) step = steps.next()
    return step.value
  }

  async syncMissingWithProgress(backupDirectory: string, progress: (value: CacheSyncProgress) => void, signal?: AbortSignal, character?: string): Promise<CacheSyncResult> {
    const steps = this.ImageStudio_캐시대조단계읽기(backupDirectory, character)
    try {
      while (true) {
        if (signal?.aborted) throw new Error('Cache sync cancelled before saving')
        const step = steps.next()
        if (step.done) return step.value
        progress(step.value)
        // Let the response flush and other HTTP requests run between batches.
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    } finally { steps.return(undefined as never) }
  }

  private *ImageStudio_캐시대조단계읽기(backupDirectory: string, character?: string): Generator<CacheSyncProgress, CacheSyncResult> {
    if (character !== undefined && !/^[a-z][a-z0-9_-]{0,99}$/.test(character)) throw new Error('Invalid cache character')
    const records = Object.entries(this.cache.entries).filter(([, entry]) => !character || cacheCharacter(entry) === character)
    const before = records.length
    const originalDigest = this.indexDigest
    const entries: Record<string, CacheEntry> = character ? { ...this.cache.entries } : {}
    let processed = 0, kept = 0, relinked = 0
    const report = (phase: CacheSyncProgress['phase']): CacheSyncProgress => ({ phase, processed, total: before, kept, relinked, missing: processed - kept })
    yield report('scan')
    const onDisk = this.existingImagePaths(0)
    const candidates = ImageStudio_WebP후보목록만들기(onDisk)
    const realRoot = fs.realpathSync(this.imagesDir)
    const check = (original: CacheEntry): CacheEntry | null => {
      let entry = original
      let full = this.absolutePathOf(entry)
      // The directory inventory already checked regular files and resolved
      // each parent once. Repeating stat+realpath for every render blocks all
      // HTTP requests for tens of seconds on a large Windows library.
      if (full && onDisk.has(toPosix(entry.imagePath))) {
        return entry
      }
      if (full && !fs.existsSync(full)) {
        const replacement = ImageStudio_WebP대체경로읽기(this.imagesDir, entry.imagePath, candidates)
        if (replacement && (!character || cacheCharacter({ ...entry, imagePath: replacement }) === character)) {
          entry = { ...entry, imagePath: replacement }; full = this.absolutePathOf(entry); relinked++
        }
      }
      try {
        if (!full || !fs.statSync(full).isFile()) return null
        const relative = path.relative(realRoot, fs.realpathSync(full))
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
        return entry
      } catch { return null }
    }
    yield report('check')
    for (const [key, original] of records) {
      const entry = check(original)
      if (entry) { entries[key] = entry; kept++ }
      else if (character) delete entries[key]
      processed++
      if (processed % 25 === 0) yield report('check')
    }
    if (processed % 25) yield report('check')
    yield report('save')
    // Generation may finish while an asynchronous scan yields. Never replace
    // that newer index with the snapshot taken at the start of this scan.
    if (this.indexDigest !== originalDigest) throw new Error('생성 작업으로 캐시가 변경됐습니다. 생성이 끝난 뒤 캐시 최신화를 다시 실행해 주세요.')
    const after = kept
    let backupPath: string | null = null
    if (after !== before || relinked) backupPath = this.ImageStudio_캐시갱신저장하기(entries, backupDirectory, character)
    this.existingCache = null
    return { before, after, removed: before - after, relinked, backupPath }
  }

  /** Every entry for a talentName, newest first. */
  variantsOf(talentName: string): CacheEntry[] {
    return Object.values(this.cache.entries)
      .filter(e => e.talentName === talentName)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * The set of art files actually present, forward-slashed.
   *
   * The index and the folder drift apart in normal use: players prune art,
   * move folders, or restore an old library. An entry pointing at a file that
   * is gone renders as a broken image, so anything that reports what a player
   * can SEE — the catalogue, the per-character counts — filters through this.
   *
   * Built from a handful of directory listings rather than one `existsSync`
   * per entry, and cached briefly, because there are tens of thousands of them.
   */
  existingImagePaths(maxAgeMs = 30_000): Set<string> {
    const now = this.now()
    if (this.existingCache && now - this.existingCache.builtAt < maxAgeMs) {
      return this.existingCache.set
    }

    const set = new Set<string>()
    const workflowsDir = this.imagesDir
    let workflows: string[]
    try {
      workflows = fs.readdirSync(workflowsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .map(d => d.name)
    } catch {
      workflows = []
    }

    // Packs also contain situation/info, status and scenario subtrees. The
    // previous characters-only inventory forced a stat+realpath round trip
    // for every one of those tens of thousands of valid images.
    const walk = (directory: string, relative: string): void => {
      let files: fs.Dirent[]
      try {
        files = fs.readdirSync(directory, { withFileTypes: true })
      } catch {
        return
      }
      for (const file of files) {
        const child = `${relative}/${file.name}`
        // Dirent's file/directory checks exclude symbolic links and junctions.
        if (file.isDirectory() && !file.name.startsWith('.')) walk(path.join(directory, file.name), child)
        else if (file.isFile()) set.add(child)
      }
    }
    for (const workflow of workflows) walk(path.join(workflowsDir, workflow), workflow)

    this.existingCache = { builtAt: now, set }
    return set
  }

  /** Total bytes of the art library, for the disk ceiling. Walks lazily. */
  diskUsageBytes(): number {
    let total = 0
    const walk = (dir: string): void => {
      let items: fs.Dirent[]
      try {
        items = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const item of items) {
        const full = path.join(dir, item.name)
        if (item.isDirectory()) walk(full)
        else {
          try { total += fs.statSync(full).size } catch { /* vanished mid-walk */ }
        }
      }
    }
    walk(this.imagesDir)
    return total
  }
}
