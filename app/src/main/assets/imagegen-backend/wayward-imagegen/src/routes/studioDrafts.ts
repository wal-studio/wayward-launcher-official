// ImageStudio 검수용 결과는 승인 전까지 서버 메모리에만 보관합니다.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Config, WorkflowType } from '../config.ts'
import type { CacheStore } from '../cache/cacheStore.ts'
import { saveImage, type SavedMedia } from '../comfy/media.ts'
import { Router, sendJson, HttpError } from '../http/router.ts'
import { readJson } from '../http/body.ts'

export interface StudioDraft {
  id: string; talentName: string; imageType: string; workflow: WorkflowType; promptHash: string
  prompt: string; negativePrompt?: string; createdAt: number; bytes: Buffer; mime: string
  genParams?: Record<string, unknown>; debug?: Record<string, unknown>
  saved?: { absolutePath: string; imageUrl?: string }; saving?: boolean
}

export class ImageStudioDraftStore {
  readonly entries = new Map<string, StudioDraft>()
  constructor(private config: Config, private cache: CacheStore) {}
  ImageStudio_임시그림추가하기(value: Omit<StudioDraft, 'id' | 'createdAt' | 'mime'>, sourceFilename: string): StudioDraft {
    const used = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes.length, 0)
    if (this.entries.size >= 100 || used + value.bytes.length > 256 * 1024 * 1024)
      throw new Error('검수 대기 이미지가 가득 찼습니다. 저장하거나 삭제한 뒤 다시 생성하세요.')
    const extension = path.extname(sourceFilename).toLowerCase()
    const mime = extension === '.webp' ? 'image/webp' : ['.jpg', '.jpeg'].includes(extension) ? 'image/jpeg' : 'image/png'
    const entry = { ...value, id: randomUUID(), createdAt: Date.now(), mime }
    this.entries.set(entry.id, entry)
    return entry
  }
  ImageStudio_임시그림읽기(id: string): StudioDraft {
    const entry = this.entries.get(id)
    if (!entry) throw new HttpError(404, '검수 이미지가 없습니다. 서버를 재시작했다면 다시 생성하세요.')
    return entry
  }
  ImageStudio_임시정보읽기(entry: StudioDraft) {
    return { id: entry.id, talentName: entry.talentName, imageType: entry.imageType, workflow: entry.workflow,
      prompt: entry.prompt, negativePrompt: entry.negativePrompt || '', createdAt: entry.createdAt,
      bytes: entry.bytes.length, mime: entry.mime, imageUrl: `/api/studio/drafts/${entry.id}/image`,
      saved: entry.saved || null, saving: !!entry.saving }
  }
  async ImageStudio_승인저장하기(id: string, directory?: string, filename?: string) {
    const entry = this.ImageStudio_임시그림읽기(id)
    if (entry.saving) throw new HttpError(409, '이 이미지를 저장 중입니다.')
    entry.saving = true
    try {
      let media: SavedMedia
      if (directory !== undefined || filename !== undefined) {
        const name = String(filename || '').trim()
        if (!name || name.length > 240 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)
          || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
          throw new HttpError(400, '파일 이름만 입력하세요. 경로와 파일 이름은 별도 칸에 지정합니다.')
        const extension = path.extname(name).toLowerCase()
        const allowed = entry.mime === 'image/webp' ? ['.webp'] : entry.mime === 'image/jpeg' ? ['.jpg', '.jpeg'] : ['.png']
        if (!allowed.includes(extension)) throw new HttpError(400, `파일 확장자는 ${allowed.join(' / ')}를 사용하세요.`)
        const folder = directory?.trim() ? path.resolve(this.config.imagesDir, directory.trim()) : this.config.imagesDir
        fs.mkdirSync(folder, { recursive: true })
        const absolutePath = path.join(folder, name)
        try { fs.writeFileSync(absolutePath, entry.bytes, { flag: 'wx' }) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new HttpError(409, '같은 이름의 파일이 있습니다. 다른 이름을 지정하세요.')
          throw error
        }
        media = { absolutePath, relativePath: path.relative(this.config.imagesDir, absolutePath).replaceAll('\\', '/'), bytes: entry.bytes.length, mime: entry.mime }
      } else {
        media = await saveImage({ imagesDir: this.config.imagesDir, bytes: entry.bytes, talentName: entry.talentName,
          imageType: entry.imageType, workflow: entry.workflow, animaSaveToIllustrious: this.config.animaSaveToIllustrious,
          characters: this.config.characterDirs, storageRules: this.config.imageStorageRules,
          webp: this.config.webp, requireWebp: this.config.requireWebp })
      }
      const inLibrary = !media.relativePath.startsWith('../') && !path.isAbsolute(media.relativePath)
      if (inLibrary) this.cache.add({ talentName: entry.talentName, imageType: entry.imageType, workflow: entry.workflow,
        promptHash: entry.promptHash, prompt: entry.prompt, negativePrompt: entry.negativePrompt,
        imagePath: media.relativePath, genParams: entry.genParams, debug: entry.debug, userCreated: true })
      entry.saved = { absolutePath: media.absolutePath,
        ...(inLibrary ? { imageUrl: '/images/' + media.relativePath.split('/').map(encodeURIComponent).join('/') } : {}) }
      // A successful save owns a disk copy. Drop the review buffer and slot;
      // failed saves retain both so the user can retry.
      entry.bytes = Buffer.alloc(0)
      this.entries.delete(id)
      return entry.saved
    } finally { entry.saving = false }
  }
  ImageStudio_임시그림삭제하기(id: string) {
    const entry = this.ImageStudio_임시그림읽기(id)
    if (entry.saving) throw new HttpError(409, '저장 중에는 삭제할 수 없습니다.')
    this.entries.delete(id)
    // 삭제는 검수 대기 결과만 버립니다. 승인해서 저장한 사용자 파일은 유지합니다.
    return { discarded: true, savedFilePreserved: !!entry.saved }
  }
}

export function ImageStudio_검수경로등록하기(router: Router, drafts: ImageStudioDraftStore, config: Config) {
  router.get('/api/studio/drafts', ctx => sendJson(ctx.res, 200,
    { supportsReviewDrafts: true, supportsImg2img: true, defaultDirectory: config.imagesDir, entries: [...drafts.entries.values()].map(entry => drafts.ImageStudio_임시정보읽기(entry)) }))
  router.get('/api/studio/drafts/:id/image', ctx => {
    const entry = drafts.ImageStudio_임시그림읽기(ctx.params.id)
    ctx.res.writeHead(200, { 'Content-Type': entry.mime, 'Content-Length': entry.bytes.length, 'Cache-Control': 'no-store' })
    ctx.res.end(entry.bytes)
  })
  router.post('/api/studio/drafts/:id/save', async ctx => {
    const body = await readJson<{ directory?: string; filename?: string }>(ctx.req, 16 * 1024)
    if (body.directory !== undefined && typeof body.directory !== 'string' || body.filename !== undefined && typeof body.filename !== 'string')
      throw new HttpError(400, '저장 경로와 파일 이름은 문자열이어야 합니다.')
    sendJson(ctx.res, 200, await drafts.ImageStudio_승인저장하기(ctx.params.id, body.directory, body.filename))
  })
  router.delete('/api/studio/drafts/:id', ctx => sendJson(ctx.res, 200, drafts.ImageStudio_임시그림삭제하기(ctx.params.id)))
}
