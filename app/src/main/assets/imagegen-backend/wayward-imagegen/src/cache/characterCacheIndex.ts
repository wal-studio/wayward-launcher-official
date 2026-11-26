/** Character-scoped JSON persistence. Cache keys and entry metadata stay unchanged. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { CacheEntry, ImageCacheFile } from './cacheStore.ts'

export const H_STATUS_CACHE_SHARD = 'h-status_cache'
export const H_STATUS_CACHE_FILENAME = '.image-cache_H-Status_cache.json'
const shardPattern = /^\.image-cache_([a-z0-9][a-z0-9_-]{0,99})\.json$/i
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const validName = (value: string) => /^[a-z0-9][a-z0-9_-]{0,99}$/.test(value)

export function cacheCharacter(entry: CacheEntry): string {
  if (/^situation_(?:fluid|vulva|status|observation|event)__[a-z][a-z0-9_-]{0,99}__/i.test(entry.talentName)) {
    return H_STATUS_CACHE_SHARD
  }
  const folder = entry.imagePath.replaceAll('\\', '/').match(/(?:^|\/)characters\/([^/]+)\//)?.[1]?.toLowerCase()
  if (folder && validName(folder)) return folder
  const name = entry.talentName.toLowerCase()
  const structured = name.startsWith('situation_') ? name.split('__')[1] : name.split('__')[0]
  if (structured && validName(structured) && (name.includes('__') || /^[a-z][a-z0-9]*$/.test(name))) return structured
  // Unattributable historical names are retained, never silently discarded.
  return 'shared'
}

export class CharacterCacheIndex {
  readonly legacyPath: string
  private snapshots = new Map<string, string>()
  private characters = new Set<string>()
  private pendingMigrations = new Set<string>()
  legacyBackupPath: string | null = null

  constructor(private directory: string) {
    this.legacyPath = path.join(directory, '.image-cache.json')
  }

  pathFor(character: string): string {
    if (!validName(character)) throw new Error('Invalid cache character name')
    if (character === H_STATUS_CACHE_SHARD) return path.join(this.directory, H_STATUS_CACHE_FILENAME)
    return path.join(this.directory, `.image-cache_${character}.json`)
  }

  get paths(): string[] { return [...this.snapshots.keys()].sort() }
  get revision(): string { return digest(JSON.stringify([...this.snapshots.entries()].sort())) }

  private diskPaths(): string[] {
    if (!fs.existsSync(this.directory)) return []
    return fs.readdirSync(this.directory).filter(name => name === '.image-cache.json' || shardPattern.test(name))
      .map(name => path.join(this.directory, name)).sort()
  }

  private characterForPath(file: string): string {
    const name = path.basename(file)
    if (name.toLowerCase() === H_STATUS_CACHE_FILENAME.toLowerCase()) return H_STATUS_CACHE_SHARD
    return name.match(shardPattern)?.[1]?.toLowerCase() || 'shared'
  }

  /** Fail closed: a broken character file must not be overwritten with an empty cache. */
  private read(file: string): { text: string; data: ImageCacheFile } {
    const text = fs.readFileSync(file, 'utf8')
    const data = JSON.parse(text) as ImageCacheFile
    if (data?.version !== 1 || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
      throw new Error(`Invalid image cache: ${file}`)
    }
    for (const entry of Object.values(data.entries)) {
      if (!entry || typeof entry.imagePath !== 'string' || typeof entry.talentName !== 'string') {
        throw new Error(`Invalid image cache entry: ${file}`)
      }
    }
    return { text, data }
  }

  load(): ImageCacheFile {
    this.snapshots.clear()
    this.characters.clear()
    this.pendingMigrations.clear()
    const groups = new Map<string, Record<string, CacheEntry>>()
    const files = this.diskPaths()
    // An interrupted migration can leave both formats. A completed shard is
    // authoritative for its whole character, including entries removed from it.
    if (files.includes(this.legacyPath)) {
      const { text, data } = this.read(this.legacyPath)
      this.snapshots.set(this.legacyPath, digest(text))
      for (const [key, entry] of Object.entries(data.entries)) {
        const character = cacheCharacter(entry)
        if (!groups.has(character)) groups.set(character, Object.create(null))
        groups.get(character)![key] = entry
      }
    }
    const migrated: [string, CacheEntry][] = []
    for (const file of files.filter(file => file !== this.legacyPath)) {
      const character = this.characterForPath(file)
      const { text, data } = this.read(file)
      const ownEntries: Record<string, CacheEntry> = Object.create(null)
      for (const [key, entry] of Object.entries(data.entries)) {
        const target = cacheCharacter(entry)
        if (target === character) ownEntries[key] = entry
        else if (target === H_STATUS_CACHE_SHARD) {
          migrated.push([key, entry])
          this.pendingMigrations.add(character)
          this.pendingMigrations.add(target)
        } else throw new Error(`Entry in the wrong character cache: ${file}`)
      }
      groups.set(character, ownEntries)
      this.characters.add(character)
      this.snapshots.set(file, digest(text))
    }
    if (!groups.has(H_STATUS_CACHE_SHARD)) groups.set(H_STATUS_CACHE_SHARD, Object.create(null))
    for (const [key, entry] of migrated) {
      const target = cacheCharacter(entry)
      if (!groups.has(target)) groups.set(target, Object.create(null))
      if (!(key in groups.get(target)!)) groups.get(target)![key] = entry
    }
    const entries: Record<string, CacheEntry> = Object.create(null)
    for (const group of groups.values()) {
      for (const [key, entry] of Object.entries(group)) {
        if (key in entries) throw new Error(`Duplicate key across character caches: ${key}`)
        entries[key] = entry
      }
    }
    return { version: 1, entries }
  }

  assertUnchanged(all = true, affected: readonly string[] = []): void {
    const files = this.diskPaths()
    if (JSON.stringify(files) !== JSON.stringify(this.paths)) throw new Error('Cache changed in another process. Restart the image server.')
    const wanted = all ? files : affected.map(character => this.pathFor(character)).filter(file => this.snapshots.has(file))
    for (const file of wanted) {
      if (digest(fs.readFileSync(file, 'utf8')) !== this.snapshots.get(file)) {
        throw new Error('Cache changed in another process. Restart the image server before saving.')
      }
    }
  }

  /** Stage every affected shard first; only a generation's own character is rewritten. */
  save(entries: Record<string, CacheEntry>, affected?: readonly string[]): void {
    const migrating = this.snapshots.has(this.legacyPath)
    const wanted = new Set(affected ?? [...this.characters, ...Object.values(entries).map(cacheCharacter)])
    if (migrating) for (const entry of Object.values(entries)) wanted.add(cacheCharacter(entry))
    if (migrating && !wanted.size) wanted.add('shared')
    this.assertUnchanged(!affected || migrating, [...wanted])
    fs.mkdirSync(this.directory, { recursive: true })
    const groups = new Map<string, Record<string, CacheEntry>>([...wanted].map(character => [character, Object.create(null)]))
    for (const [key, entry] of Object.entries(entries)) groups.get(cacheCharacter(entry)) && (groups.get(cacheCharacter(entry))![key] = entry)
    const staged: { file: string; temp: string; text: string; original: string | null }[] = []
    const committed: typeof staged = []
    try {
      for (const [character, group] of groups) {
        const file = this.pathFor(character)
        const text = JSON.stringify({ version: 1, entries: group })
        const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
        // Unchanged characters keep both their bytes and modification time.
        if (original === text) continue
        const temp = `${file}.${randomUUID()}.tmp`
        staged.push({ file, temp, text, original })
        fs.writeFileSync(temp, text, { flag: 'wx' })
      }
      this.assertUnchanged(!affected || migrating, [...wanted])
      for (const item of staged) {
        fs.renameSync(item.temp, item.file)
        committed.push(item)
      }
      if (migrating) {
        // Keep the exact old index, and only retire it after every shard landed.
        if (digest(fs.readFileSync(this.legacyPath, 'utf8')) !== this.snapshots.get(this.legacyPath)) {
          throw new Error('Legacy cache changed during migration. Stop the other image server.')
        }
        const backup = `${this.legacyPath}.legacy-${randomUUID()}.bak`
        fs.renameSync(this.legacyPath, backup)
        this.legacyBackupPath = backup
        this.snapshots.delete(this.legacyPath)
      }
      for (const item of staged) this.snapshots.set(item.file, digest(item.text))
      for (const character of wanted) this.characters.add(character)
    } catch (error) {
      // Synchronous commits cannot interleave with this process's render jobs.
      for (const item of committed.reverse()) {
        if (item.original === null) fs.rmSync(item.file, { force: true })
        else fs.writeFileSync(item.file, item.original)
      }
      throw error
    } finally {
      for (const item of staged) fs.rmSync(item.temp, { force: true })
    }
  }

  migrate(entries: Record<string, CacheEntry>): void {
    if (this.snapshots.has(this.legacyPath)) this.save(entries)
    else if (this.pendingMigrations.size) this.save(entries, [...this.pendingMigrations])
    this.pendingMigrations.clear()
  }
}
