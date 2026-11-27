/**
 * The image generation routes — the ones the game actually calls.
 *
 * Wire-compatible with what the game already sends, with one deliberate change:
 * responses carry a URL (`imageUrl`) rather than a base64 data URL. The old
 * shape meant 1-3 MB of JSON per image, no browser caching, and an image the
 * client could not address or re-find after a reload. `?inline=1` restores the
 * old behaviour for callers that genuinely want bytes.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Config, WorkflowType, AnimaLoraSetting } from '../config.ts'
import { ImageStudio_아내LoRA선택하기 } from '../characterLoras.ts'
import type { CacheStore, CacheEntry } from '../cache/cacheStore.ts'
import type { JobRunner, GenerationJob } from '../comfy/jobRunner.ts'
import { derivePromptHash, jobKey } from '../naming.ts'
import { ImageStudio_기준이미지읽기 } from '../comfy/reference.ts'
import { ComfyClient } from '../comfy/client.ts'
import { Router, sendJson, HttpError } from '../http/router.ts'
import { readJson, JSON_BODY_LIMIT } from '../http/body.ts'
import { mimeFor } from '../http/static.ts'
import { removePromptTags, replaceStockCharacterPrompt } from '../prompts/character.ts'
import { NovelAI_프롬프트만들기, NovelAI_생성해시만들기 } from '../nai/client.ts'

const WORKFLOWS: readonly WorkflowType[] = ['anima', 'illustrious', 'z-image', 'nai']

function activeImageWorkflow(requested: WorkflowType, config: Config): WorkflowType {
  // Image Studio and the stock game identify ordinary stills as illustrious.
  // The saved provider setting is authoritative for those normal requests.
  if (config.imageProvider === 'flux') return 'nai'
  if (requested !== 'anima' && requested !== 'illustrious') return requested
  return config.imageProvider === 'nai' ? 'nai' : config.imageProvider === 'anima' ? 'anima' : 'illustrious'
}

/**
 * ComfyUI's dimension presets are matched by exact string, so these cannot be
 * generated from the numbers.
 */
const KNOWN_DIMS: Record<string, string> = {
  '512x512': '512 x 512 (1:1)',
  '768x512': '768 x 512 (1.5:1)',
  '960x512': '960 x 512 (1.875:1)',
  '1024x512': '1024 x 512 (2:1)',
  '1024x576': '1024 x 576 (1.778:1)',
  '1536x640': '1536 x 640 (2.4:1)',
  '1344x768': '1344 x 768 (1.75:1)',
  '1216x832': '1216 x 832 (1.46:1)',
  '1152x896': '1152 x 896 (1.286:1)',
  '1024x1024': '1024 x 1024 (1:1)',
}

export interface GenerateBody {
  talentId?: string
  talentName?: string
  imageType?: string
  prompt?: string
  negativePrompt?: string
  workflow?: string
  promptHash?: string
  seed?: number
  steps?: number
  cfg?: number
  loraStrength?: number
  loras?: AnimaLoraSetting[]
  checkpoint?: string
  width?: number
  height?: number
  dimensions?: string
  bulk?: boolean
  bypassCache?: boolean
  debug?: Record<string, unknown>
  reviewOnly?: boolean
  referenceKey?: string
  referencePath?: string
  denoise?: number
}

export interface ImageRouteDeps {
  config: Config
  cache: CacheStore
  jobs: JobRunner
  comfy?: Pick<ComfyClient, 'upload'>
  /** Append a line to the cache-miss log. Injected so tests need no disk. */
  logMiss?: (line: Record<string, unknown>) => void
}

/**
 * The URL the client loads a render from, relative to the server root.
 *
 * Each segment is encoded separately so a filename containing a space or a
 * `#` survives, without turning the path separators into `%2F`.
 */
export function imageUrlFor(relativePath: string): string {
  return `/images/${relativePath.split('/').map(encodeURIComponent).join('/')}`
}

function sizeOf(cache: CacheStore, entry: CacheEntry): number {
  const full = cache.absolutePathOf(entry)
  if (!full) return 0
  try {
    return fs.statSync(full).size
  } catch {
    return 0
  }
}

function readAsDataUrl(cache: CacheStore, entry: CacheEntry): string | null {
  const full = cache.absolutePathOf(entry)
  if (!full) return null
  try {
    return `data:${mimeFor(full)};base64,${fs.readFileSync(full).toString('base64')}`
  } catch {
    return null
  }
}

/**
 * The identity of a render.
 *
 * The client normally sends its own `promptHash` so both sides agree. When it
 * does not, generation params are folded in — two requests with the same text
 * but different steps/cfg are different pictures and must not share a cell.
 */
export function resolvePromptHash(body: GenerateBody): string {
  if (body.promptHash) return body.promptHash
  return derivePromptHash(body.prompt ?? '', body.negativePrompt ?? '', body)
}

export function resolveDimensions(body: GenerateBody): string | undefined {
  if (body.dimensions) return body.dimensions
  if (!body.width || !body.height) return undefined
  return KNOWN_DIMS[`${body.width}x${body.height}`]
}

function characterPromptFor(config: Config, talentName: string) {
  const lower = talentName.toLowerCase()
  const ids = Object.keys(config.animaCharacterPrompts).sort((a, b) => b.length - a.length)
  const id = ids.find(candidate =>
    lower === candidate
    || lower.startsWith(candidate + '__')
    || lower.startsWith(candidate + '-')
    || lower.startsWith(candidate + '_'),
  )
  return id ? config.animaCharacterPrompts[id] : null
}

function jobResponse(job: GenerationJob, imagesDir: string, inline: boolean) {
  const base: Record<string, unknown> = {
    promptId: job.promptId,
    status: job.status,
    workflow: job.workflow,
  }
  if (job.error) base.error = job.error
  if (job.draftId) {
    base.draftId = job.draftId
    base.reviewOnly = true
    base.imageUrl = `/api/studio/drafts/${job.draftId}/image`
  }
  if (job.media) {
    base.imagePath = job.media.relativePath
    base.imageUrl = imageUrlFor(job.media.relativePath)
    base.bytes = job.media.bytes
    if (inline) {
      try {
        const buf = fs.readFileSync(path.join(imagesDir, job.media.relativePath))
        base.imageData = `data:${job.media.mime};base64,${buf.toString('base64')}`
      } catch { /* the URL is still usable */ }
    }
  }
  return base
}

export function registerImageRoutes(router: Router, deps: ImageRouteDeps): void {
  const { config, cache, jobs } = deps

  router.post('/api/image/generate', async ctx => {
    const body = await readJson<GenerateBody>(ctx.req, JSON_BODY_LIMIT)

    const talentName = body.talentName ?? body.talentId
    if (!talentName) throw new HttpError(400, 'talentId is required')
    const requestPrompt = body.prompt
    if (typeof requestPrompt !== 'string' || requestPrompt.length === 0) {
      throw new HttpError(400, 'prompt is required')
    }

    const requestedWorkflow = (body.workflow ?? 'illustrious') as WorkflowType
    if (!WORKFLOWS.includes(requestedWorkflow)) {
      throw new HttpError(400, `unknown workflow: ${requestedWorkflow}. available: ${WORKFLOWS.join(', ')}`)
    }
    const workflow = activeImageWorkflow(requestedWorkflow, config)

    if (workflow === 'nai' && body.seed !== undefined && (typeof body.seed !== 'number' || !Number.isInteger(body.seed) || body.seed < 0 || body.seed > 0xffffffff)) {
      throw new HttpError(400, 'NovelAI Seed는 0부터 4294967295 사이의 정수여야 합니다.')
    }
    const reference=ImageStudio_기준이미지읽기(config,cache,body,workflow)
    let img2imgSource: string | undefined
    const referenceIdentity=reference?.identity||''
    if(reference){
      if(!deps.comfy)throw new HttpError(501,'img2img를 지원하는 공통 서버가 필요합니다.')
      const uploaded=await deps.comfy.upload(fs.readFileSync(reference.path),'wwis-reference-'+derivePromptHash(reference.identity,'')+path.extname(reference.path))
      if(!uploaded)throw new HttpError(502,'ComfyUI에 기준 이미지를 전송하지 못했습니다.')
      img2imgSource=uploaded
    }
    const imageType = body.imageType ?? 'portrait'
    const character = workflow === 'anima' || workflow === 'nai' ? characterPromptFor(config, talentName) : null
    const withCharacter = character
      ? replaceStockCharacterPrompt(requestPrompt, character.prompt, character.originalPrompt)
      : requestPrompt
    const scenePrompt = workflow === 'anima'
      ? removePromptTags(withCharacter, ['masterpiece', 'best quality'])
      : withCharacter
    const characterNegativePrompt = typeof character?.negativePrompt === 'string' ? character.negativePrompt.trim() : ''
    const requestNegativePrompt = typeof body.negativePrompt === 'string' ? body.negativePrompt.trim() : ''
    const naiNegativePrompt = [characterNegativePrompt, requestNegativePrompt].filter(Boolean).join(', ')
    const naiPrompts = workflow === 'nai' && config.imageProvider !== 'flux' ? NovelAI_프롬프트만들기(config, scenePrompt, naiNegativePrompt) : null
    const prompt = config.imageProvider === 'flux' ? scenePrompt : naiPrompts ? naiPrompts.prompt : workflow === 'anima'
      ? [config.animaCommonPrompt.trim(), removePromptTags(scenePrompt, config.animaCommonPrompt.split(',').map(tag => tag.trim()).filter(Boolean))].filter(Boolean).join(', ')
      : [config.sdxlPositivePrompt.trim(), scenePrompt].filter(Boolean).join(', ')
    const negativePrompt = config.imageProvider === 'flux' ? requestNegativePrompt : naiPrompts ? naiPrompts.negativePrompt : workflow === 'anima'
      ? [config.animaNegativePrompt.trim(), character?.negativePrompt?.trim(), body.negativePrompt?.trim()].filter(Boolean).join(', ')
      : [config.sdxlNegativePrompt.trim(), body.negativePrompt?.trim()].filter(Boolean).join(', ')
    // Keep historical hashes for unchanged default-size requests. A size
    // setting or explicit size must identify the actual server-selected pixels.
    const sdxlSizedRequest = workflow === 'illustrious' && (config.sdxlWidth !== 1024 || config.sdxlHeight !== 1024 || body.width !== undefined || body.height !== undefined || body.dimensions !== undefined)
    const effectiveBody: GenerateBody = workflow === 'anima'
      ? { ...body, prompt, negativePrompt, promptHash: undefined, steps: config.animaSteps, cfg: config.animaCfg, width: config.animaWidth, height: config.animaHeight }
      : sdxlSizedRequest
        ? { ...body, prompt, negativePrompt, promptHash: undefined, width: config.sdxlWidth, height: config.sdxlHeight }
        : { ...body, prompt, negativePrompt }
    const loras = ImageStudio_아내LoRA선택하기(config, talentName, workflow)
    effectiveBody.loras = loras
    if (loras !== undefined) effectiveBody.promptHash = undefined
    const baseHash = workflow === 'nai' ? NovelAI_생성해시만들기(config, prompt, negativePrompt, body.seed) : resolvePromptHash(effectiveBody)
    const promptHash = img2imgSource ? derivePromptHash(baseHash+'|reference:'+referenceIdentity+'|denoise:'+body.denoise, '') : baseHash
    const bulk = body.bulk === true || body.reviewOnly === true
    const bypassCache = body.bypassCache === true
    const inline = ctx.query.get('inline') === '1'

    // The refresh button: the player said this image is bad. Drop EVERY entry
    // for this talentName, not just the matching hash — prompts drift between
    // sessions, so one state routinely has several hashes, and leaving the
    // others alive means the bad image reappears on the next remount.
    if (bypassCache && !body.reviewOnly) {
      let dropped = 0
      for (const [key, entry] of Object.entries(cache.entries)) {
        if (entry.talentName !== talentName) continue
        const full = cache.absolutePathOf(entry)
        if (full && fs.existsSync(full)) {
          try { fs.unlinkSync(full) } catch { /* the entry still goes */ }
        }
        cache.remove(key)
        dropped++
      }
      if (dropped > 0) console.log(`[generate] bypass dropped ${dropped} entr(y/ies) for ${talentName}`)
    }

    const cached = bypassCache || body.reviewOnly ? null : cache.get(talentName, imageType, promptHash, workflow)
    if (cached) {
      const response: Record<string, unknown> = {
        promptId: `cached_${promptHash}`,
        status: 'completed',
        workflow,
        cached: true,
        imagePath: cached.imagePath,
        imageUrl: imageUrlFor(cached.imagePath),
        // Reported so a caller does not have to fetch the bytes just to size
        // them — the bulk runner tallies this per image.
        bytes: sizeOf(cache, cached),
      }
      if (inline) {
        const data = readAsDataUrl(cache, cached)
        if (data) response.imageData = data
      }
      sendJson(ctx.res, 200, response)
      return
    }

    // Only genuine runtime misses are logged: not batch work, not an explicit
    // regen. That keeps the log answering one question — the game asked for
    // something new, was it a truly new state or the same state under a drifted
    // prompt? See `gin images cache-audit`.
    if (!bulk && !bypassCache && deps.logMiss) {
      let priorVariants = 0
      for (const [k, e] of Object.entries(cache.entries)) {
        if (e.talentName === talentName && e.imageType === imageType && k.startsWith(workflow + '_')) {
          priorVariants++
        }
      }
      deps.logMiss({
        at: new Date().toISOString(),
        kind: priorVariants > 0 ? 'drift' : 'new',
        priorVariants,
        talentName,
        imageType,
        workflow,
        promptHash,
        prompt: prompt.slice(0, 300),
      })
    }

    // Bound the damage a runaway or hostile caller can do.
    //
    // The rate ceilings apply to INTERACTIVE work only. Batch work is the
    // operator's own overnight run — it has its own queue and paces itself, and
    // throttling it at a few hundred an hour would quietly stall the
    // pre-generation this server exists to do.
    if (!bulk) {
      if (jobs.queuedCount() >= config.maxQueued) {
        throw new HttpError(429, `too many queued requests (${config.maxQueued})`)
      }
      if (config.maxImagesPerHour > 0 && jobs.completionsThisHour() >= config.maxImagesPerHour) {
        throw new HttpError(429, `hourly image limit reached (${config.maxImagesPerHour})`)
      }
    }
    // The disk ceiling DOES apply to everything: filling the drive is just as
    // bad whoever asked for it.
    if (config.maxDiskGb > 0) {
      const usedGb = cache.diskUsageBytes() / 1024 ** 3
      if (usedGb >= config.maxDiskGb) {
        throw new HttpError(507, `art library is at the ${config.maxDiskGb} GB ceiling`)
      }
    }

    const job = await jobs.submit({
      talentId: body.talentId ?? talentName,
      talentName,
      imageType,
      prompt,
      negativePrompt,
      workflow,
      promptHash,
      seed: body.seed,
      overrides: {
        ...(workflow === 'nai' ? { sampler: config.naiSampler, noiseSchedule: config.naiNoiseSchedule } : {}),
        steps: workflow === 'nai' ? config.naiSteps : workflow === 'anima' ? config.animaSteps : body.steps,
        cfg: workflow === 'nai' ? config.naiScale : workflow === 'anima' ? config.animaCfg : body.cfg,
        ...(img2imgSource ? { img2imgSource, denoise: body.denoise } : {}),
        loraStrength: body.loraStrength,
        loras,
        checkpoint: workflow === 'nai' ? config.naiModel : body.checkpoint,
        dimensions: workflow === 'illustrious' ? undefined : resolveDimensions(body),
        width: workflow === 'nai' ? config.naiWidth : workflow === 'anima' ? config.animaWidth : workflow === 'illustrious' ? (sdxlSizedRequest ? config.sdxlWidth : undefined) : body.width,
        height: workflow === 'nai' ? config.naiHeight : workflow === 'anima' ? config.animaHeight : workflow === 'illustrious' ? (sdxlSizedRequest ? config.sdxlHeight : undefined) : body.height,
      },
      bulk,
      debug: reference ? {...body.debug,img2img:{referenceKey:body.referenceKey,referencePath:body.referencePath,denoise:body.denoise}} : body.debug,
      reviewOnly: body.reviewOnly === true,
    })

    sendJson(ctx.res, 200, jobResponse(job, config.imagesDir, inline))
  })

  router.get('/api/image/status/:promptId', ctx => {
    const { promptId } = ctx.params
    const job = jobs.get(promptId)
    if (!job) {
      // A completed job is reaped after its TTL. 404 is honest: we no longer
      // know. The client falls back to the catalogue, which by then has it.
      throw new HttpError(404, 'unknown promptId')
    }
    const inline = ctx.query.get('inline') === '1'
    const body = jobResponse(job, config.imagesDir, inline)
    // 202 while pending keeps a polling client from treating "not yet" as done.
    sendJson(ctx.res, job.status === 'queued' || job.status === 'processing' ? 202 : 200, body)
  })

  router.post('/api/image/cancel', async ctx => {
    const body = await readJson<{ promptId?: string }>(ctx.req)
    if (!body.promptId) throw new HttpError(400, 'promptId is required')
    const result = await jobs.cancel(body.promptId)
    sendJson(ctx.res, 200, { status: 'ok', ...result })
  })

  router.get('/api/image/check', ctx => {
    const name = ctx.query.get('name')
    const hash = ctx.query.get('hash')
    if (!name || !hash) throw new HttpError(400, 'name and hash are required')
    const imageType = ctx.query.get('type') ?? 'portrait'
    const requestedWorkflow = (ctx.query.get('workflow') ?? 'illustrious') as WorkflowType
    const workflow = activeImageWorkflow(requestedWorkflow, config)

    const entry = cache.get(name, imageType, hash, workflow)
    if (!entry) {
      sendJson(ctx.res, 200, { exists: false })
      return
    }
    const response: Record<string, unknown> = {
      exists: true,
      cached: true,
      imagePath: entry.imagePath,
      imageUrl: imageUrlFor(entry.imagePath),
    }
    if (ctx.query.get('inline') === '1') {
      const data = readAsDataUrl(cache, entry)
      if (data) response.imageData = data
    }
    sendJson(ctx.res, 200, response)
  })

  // Deleting art is off unless the operator asks for it. Nothing in the game
  // needs it; it exists for the review UI, on a machine whose owner opted in.
  router.delete('/api/image/delete', ctx => {
    if (!config.allowDelete) {
      throw new HttpError(403, 'deletion is disabled; start with --allow-delete to enable it')
    }
    const name = ctx.query.get('name')
    if (!name) throw new HttpError(400, 'name is required')
    const imageType = ctx.query.get('type') ?? 'portrait'
    const workflow = ctx.query.get('workflow') ?? 'illustrious'

    let deleted = 0
    for (const [key, entry] of Object.entries(cache.entries)) {
      if (entry.talentName !== name) continue
      if (entry.imageType !== imageType) continue
      if (!key.startsWith(workflow + '_')) continue
      const full = cache.absolutePathOf(entry)
      if (full && fs.existsSync(full)) {
        try { fs.unlinkSync(full) } catch { /* the entry still goes */ }
      }
      // Removing the entry as well as the file — the dev server deleted files
      // but left the index pointing at them, which produced phantom entries
      // that every later consumer had to filter out.
      cache.remove(key)
      deleted++
    }
    sendJson(ctx.res, 200, { deleted })
  })
}

/** Exposed for the health route's queue summary. */
export function describeJobs(jobs: JobRunner): Record<string, unknown> {
  const active = jobs.activeJobs()
  return {
    active: active.length,
    queued: jobs.queuedCount(),
    completedThisHour: jobs.completionsThisHour(),
    keys: active.slice(0, 20).map(j => jobKey(j.talentName, j.imageType, j.promptHash, j.workflow)),
  }
}
