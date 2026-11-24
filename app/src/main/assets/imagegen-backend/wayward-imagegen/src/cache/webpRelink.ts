import fs from 'node:fs'
import path from 'node:path'
import { safeJoin, toPosix } from './paths.ts'

export function ImageStudio_WebP후보목록만들기(paths: Set<string>): Map<string, string[]> {
  const candidates = new Map<string, string[]>()
  for (const relative of paths) {
    if (!/\.webp$/i.test(relative)) continue
    const name = path.posix.basename(toPosix(relative)).toLowerCase()
    const group = candidates.get(name) ?? []
    group.push(relative)
    candidates.set(name, group)
  }
  return candidates
}

export function ImageStudio_WebP파일확인하기(imagesDir: string, relative: string): boolean {
  let descriptor: number | undefined
  try {
    const full = safeJoin(imagesDir, relative)
    const inside = path.relative(fs.realpathSync(imagesDir), fs.realpathSync(full))
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || !fs.statSync(full).isFile()) return false
    descriptor = fs.openSync(full, 'r')
    const header = Buffer.alloc(12)
    return fs.readSync(descriptor, header, 0, 12, 0) === 12
      && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP'
  } catch { return false }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor) }
}

/** Match the entire original basename, including timestamp; ambiguous moves stay unresolved. */
export function ImageStudio_WebP대체경로읽기(imagesDir: string, relative: string, candidates: Map<string, string[]>): string | null {
  if (!/\.(png|webp)$/i.test(relative)) return null
  try { safeJoin(imagesDir, relative) } catch { return null }
  const sameFolder = toPosix(relative).replace(/\.(png|webp)$/i, '.webp')
  if (ImageStudio_WebP파일확인하기(imagesDir, sameFolder)) return sameFolder
  const matches = candidates.get(path.posix.basename(sameFolder).toLowerCase()) ?? []
  if (matches.length !== 1) return null
  return ImageStudio_WebP파일확인하기(imagesDir, matches[0]!) ? matches[0]! : null
}
