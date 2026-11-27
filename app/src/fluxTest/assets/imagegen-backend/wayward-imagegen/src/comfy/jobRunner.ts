/**
 * The generation lifecycle: submit, poll, save, cache.
 *
 * Four pieces of bookkeeping here look redundant and are not. Each covers a
 * race that produced duplicate renders or duplicate files in practice:
 *
 *  - `pendingSubmissions` covers the window between a cache miss and the job
 *    landing in the map. Without it two concurrent identical requests both see
 *    no in-flight job and queue two ComfyUI prompts.
 *  - `finalizing` is claimed SYNCHRONOUSLY before any await in the completion
 *    path, so two poll ticks cannot both save the same output.
 *  - `latestDesiredKey` lets a newer foreground request flush older queued ones.
 *    ComfyUI cannot cheaply preempt a running sampler, but it can be stopped
 *    from working through a backlog of states the player has already left.
 *  - `bulk` marks batch work as exempt from that flush, or one click in the game
 *    would cancel hundreds of queued overnight renders.
 *
 * Jobs live in memory only. A restart loses them, which is why the server is not
 * run under a file watcher by default — a reload mid-render leaves the client
 * polling a promptId that no longer exists.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { ImageStudioReference } from './reference.ts'
import { MAX_PROMPT_BATCH_SIZE, type Config, type WorkflowType } from '../config.ts'
import type { ComfyClient, ComfyOutput, HistoryResult } from './client.ts'
import type { CacheStore } from '../cache/cacheStore.ts'
import { derivePromptHash, jobKey, sanitizeName } from '../naming.ts'
import { buildComfyPrompt, buildMultiPromptComfyPrompt, PROMPT_BATCH_NODE, promptBatchOutputNode, type GenOverrides } from './workflows/index.ts'
import { saveImage, saveVideo, type SavedMedia } from './media.ts'
import { ImageStudioDraftStore } from '../routes/studioDrafts.ts'
import { randomUUID } from 'node:crypto'
import { NovelAI_이미지생성하기 } from '../nai/client.ts'

export type JobStatus = 'queued' | 'processing' | 'completed' | 'error'

export interface GenerationJob {
  promptId: string
  /** Batch children have distinct API IDs but share a ComfyUI execution. */
  comfyPromptId?: string
  outputNodeId?: string
  talentId: string
  talentName: string
  imageType: string
  promptHash: string
  prompt: string
  /** Kept so the cache entry can record it — see CacheEntry.negativePrompt. */
  negativePrompt?: string
  /** Likewise: the hash folds these in, so an entry needs them to be checkable. */
  genParams?: GenOverrides
  workflow: WorkflowType
  status: JobStatus
  startedAt: number
  completedAt?: number
  mediaKind: 'image' | 'video'
  /** Set once saved. The client turns this into a URL; no base64 changes hands. */
  media?: SavedMedia
  error?: string
  cancelRequested?: boolean
  /** Batch work: exempt from foreground supersedence. */
  bulk?: boolean
  debug?: Record<string, unknown>
  reviewOnly?: boolean
  draftId?: string
}

/** Completed jobs linger this long so a client poll can still collect them. */
const JOB_TTL_MS = 60_000

async function fluxGenerate(config: Config, prompt: string): Promise<{ bytes: Buffer; filename: string }> {
  let endpoint: URL
  try { endpoint = new URL(config.fluxWorkerUrl) }
  catch { throw new Error('FLUX Worker 주소가 올바르지 않습니다.') }
  if (endpoint.protocol !== 'https:' || !endpoint.hostname || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash) throw new Error('FLUX Worker는 유효한 HTTPS 주소여야 합니다.')
  if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.trim().length > 2048)
    throw new Error('FLUX prompt는 1~2048자여야 합니다.')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ prompt: prompt.trim() }),
    signal: AbortSignal.timeout(185_000),
  })
  let result: { success?: boolean; image?: string; mimeType?: string; error?: string } | null = null
  try { result = await response.json() as typeof result } catch { /* report below */ }
  if (!response.ok || !result || result.success !== true || typeof result.image !== 'string') {
    const detail = typeof result?.error === 'string' && result.error.trim()
      ? result.error.trim().slice(0, 240) : 'FLUX Worker 요청 실패(HTTP ' + response.status + ').'
    throw new Error(detail)
  }
  if (result.mimeType !== 'image/jpeg' || result.image.length > 36 * 1024 * 1024)
    throw new Error('FLUX Worker가 지원하지 않는 이미지 형식 또는 크기를 반환했습니다.')
  const bytes = Buffer.from(result.image, 'base64')
  if (bytes.length < 4 || bytes.length > 25 * 1024 * 1024
    || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
    throw new Error('FLUX Worker 이미지 데이터가 비어 있거나 JPEG 형식이 아닙니다.')
  return { bytes, filename: 'flux.jpg' }
}

export interface SubmitArgs {
  imageStudioReference?: ImageStudioReference
  talentId: string
  talentName: string
  imageType: string
  prompt: string
  negativePrompt: string
  workflow: WorkflowType
  promptHash: string
  seed?: number
  overrides?: GenOverrides
  referenceImagePath?: string
  bulk?: boolean
  debug?: Record<string, unknown>
  reviewOnly?: boolean
}

export interface JobRunnerOptions {
  config: Config
  comfy: ComfyClient
  cache: CacheStore
  now?: () => number
}

export class JobRunner {
  readonly drafts: ImageStudioDraftStore
  private readonly jobs = new Map<string, GenerationJob>()
  private readonly finalizing = new Set<string>()
  private readonly pendingSubmissions = new Map<string, Promise<string>>()
  private latestDesiredKey: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  // NAI는 계정당 한 장씩 전송합니다. ComfyUI 대기열·폴링과 독립적입니다.
  private novelAITail: Promise<void> = Promise.resolve()
  /** Completion timestamps in the current rolling hour, for the rate cap. */
  private recentCompletions: number[] = []

  private readonly config: Config
  private readonly comfy: ComfyClient
  private readonly cache: CacheStore
  private readonly now: () => number
  private readonly pollIntervalMs: number

  constructor(opts: JobRunnerOptions) {
    this.config = opts.config
    this.comfy = opts.comfy
    this.cache = opts.cache
    this.now = opts.now ?? Date.now
    this.pollIntervalMs = opts.config.pollIntervalMs
    this.drafts = new ImageStudioDraftStore(opts.config, opts.cache)
  }

  get(promptId: string): GenerationJob | undefined {
    return this.jobs.get(promptId)
  }

  async supportsPromptBatch(): Promise<boolean> {
    const info = await this.comfy.objectInfo()
    return Boolean(info?.[PROMPT_BATCH_NODE])
  }

  /** Reserve every scene independently; one sampler execution returns one job per scene. */
  async submitBatch(requests: SubmitArgs[]): Promise<GenerationJob[]> {
    if (requests.length === 1) return [await this.submit(requests[0]!)]
    if (requests.length < 2 || requests.length > MAX_PROMPT_BATCH_SIZE || requests.some(request => !request.bulk || request.referenceImagePath || request.imageStudioReference || request.overrides?.img2imgSource || request.reviewOnly)) {
      throw new Error(`multi-prompt batch requires 2–${MAX_PROMPT_BATCH_SIZE} bulk still-image requests`)
    }
    const fresh: { args: SubmitArgs; index: number; key: string; resolve: (id: string) => void; reject: (error: unknown) => void }[] = []
    const results: (GenerationJob | Promise<GenerationJob>)[] = []
    const keys = requests.map(args => jobKey(args.talentName, args.imageType, args.promptHash, args.workflow))
    if (new Set(keys).size !== keys.length) throw new Error('duplicate scene in prompt batch')
    for (const [index, args] of requests.entries()) {
      const key = keys[index]!
      const existing = this.findActiveByKey(key)
      const pending = this.pendingSubmissions.get(key)
      if (existing) { results[index] = existing; continue }
      if (pending) {
        results[index] = pending.then(id => {
          const job = this.jobs.get(id)
          if (!job) throw new Error('joined batch job no longer exists')
          return job
        })
        continue
      }
      let resolve!: (id: string) => void, reject!: (error: unknown) => void
      const claim = new Promise<string>((ok, fail) => { resolve = ok; reject = fail })
      void claim.catch(() => {})
      this.pendingSubmissions.set(key, claim)
      fresh.push({ args, index, key, resolve, reject })
    }
    try {
      if (fresh.length) {
        const config = { ...this.config }
        const graphInputs = fresh.map(({ args }) => ({ ...args, filenamePrefix: filenamePrefixFor(args.talentName, args.imageType) }))
        const first = graphInputs[0]!
        const graph = fresh.length === 1
          ? buildComfyPrompt(config, first.prompt, first.negativePrompt, first.filenamePrefix, first.workflow, first.seed, first.overrides)
          : buildMultiPromptComfyPrompt(config, graphInputs)
        const executionId = await this.comfy.submit(graph, false)
        for (const [slot, reservation] of fresh.entries()) {
          const { args, index, resolve } = reservation
          const promptId = slot === 0 ? executionId : `${executionId}__wwis_${slot}`
          const job: GenerationJob = {
            ...args, promptId, genParams: args.overrides,
            ...(fresh.length > 1 ? { comfyPromptId: executionId, outputNodeId: promptBatchOutputNode(slot) } : {}),
            status: 'queued', startedAt: this.now(), mediaKind: 'image', bulk: true,
          }
          this.jobs.set(promptId, job)
          results[index] = job
          resolve(promptId)
        }
      }
      return await Promise.all(results)
    } catch (error) {
      for (const reservation of fresh) reservation.reject(error)
      throw error
    } finally {
      for (const reservation of fresh) this.pendingSubmissions.delete(reservation.key)
    }
  }

  /** Jobs still queued or sampling. */
  activeJobs(): GenerationJob[] {
    return [...this.jobs.values()].filter(j => isActive(j))
  }

  /** How many interactive jobs are waiting — used to refuse an overlong queue. */
  queuedCount(): number {
    return this.activeJobs().filter(j => !j.bulk).length
  }

  /** Interactive images finished in the last rolling hour, for the per-hour ceiling. */
  completionsThisHour(): number {
    const cutoff = this.now() - 3_600_000
    this.recentCompletions = this.recentCompletions.filter(t => t > cutoff)
    return this.recentCompletions.length
  }

  /**
   * Submit a render, or join one already in flight for the same state.
   *
   * The dedup key is (workflow, talentName, imageType, promptHash) — the same
   * identity the persistent cache uses, so "already rendering" and "already
   * rendered" agree on what sameness means.
   */
  async submit(args: SubmitArgs): Promise<GenerationJob> {
    const key = (args.reviewOnly ? 'review:' : '') + jobKey(args.talentName, args.imageType, args.promptHash, args.workflow)

    const inFlight = this.findActiveByKey(key)
    if (inFlight) return inFlight

    const pending = this.pendingSubmissions.get(key)
    if (pending) {
      const promptId = await pending
      const job = this.jobs.get(promptId)
      if (job) return job
    }

    // Claim the key SYNCHRONOUSLY, before any await. Everything below yields at
    // least once, and a concurrent request for the same state must join this
    // submission rather than start a second render of the same picture.
    let claimed!: (promptId: string) => void
    let failed!: (err: unknown) => void
    this.pendingSubmissions.set(key, new Promise<string>((resolve, reject) => {
      claimed = resolve
      failed = reject
    }))
    void this.pendingSubmissions.get(key)!.catch(() => {})

    try {
      if (args.workflow === 'nai') {
        if (this.config.imageProvider === 'nai' && !this.config.naiToken.trim()) throw new Error('NovelAI API 토큰을 이미지 생성 방식 설정에서 저장하세요.')
        if (this.config.imageProvider === 'flux' && !this.config.fluxWorkerUrl.trim()) throw new Error('Cloudflare FLUX Worker 주소를 런처에 입력하세요.')
        if (args.referenceImagePath || args.imageStudioReference || args.overrides?.img2imgSource)
          throw new Error('NovelAI 연결은 텍스트 이미지 생성을 지원합니다. 기준 이미지 생성에는 SDXL 또는 Anima를 선택하세요.')
        const job: GenerationJob = { ...args, promptId: 'nai_' + randomUUID(), genParams: args.overrides,
          status: 'queued', startedAt: this.now(), mediaKind: 'image' }
        const config = { ...this.config }
        this.jobs.set(job.promptId, job)
        // 등록과 중복 요청 합류를 먼저 마친 뒤 외부 API 호출을 시작합니다.
        this.novelAITail = this.novelAITail.then(async () => {
          if (!isActive(job)) return
          if (this.stopped) { this.markCancelled(job, '서버가 종료되어 NAI 대기 요청을 중단했습니다.'); return }
          job.status = 'processing'
          try {
            if (config.imageProvider === 'flux') {
              const rendered = await fluxGenerate(config, job.prompt)
              await this.finalize(job, [{ filename: rendered.filename, subfolder: '', type: 'output' }], [], undefined, rendered.bytes)
            } else {
              const result = await NovelAI_이미지생성하기(config, job.prompt, job.negativePrompt || '', args.seed)
              job.genParams = { ...job.genParams, seed: result.seed }
              await this.finalize(job, [{ filename: 'novelai.png', subfolder: '', type: 'output' }], [], undefined, result.bytes)
            }
          } catch (error) {
            job.status = 'error'; job.error = (error as Error).message; job.completedAt = this.now()
          }
        })
        claimed(job.promptId)
        return job
      }
      if (!args.bulk) {
        this.latestDesiredKey = key
        // Flush queued foreground work the player has already moved past —
        // BEFORE submitting. Doing it concurrently is a self-cancel: a new
        // prompt reaches ComfyUI's queue before it reaches our job map, so the
        // sweep reads it as an unrecognised prompt of ours and drops the very
        // render it was called for.
        await this.supersede(key)
      }

      if(args.imageStudioReference){
        const ref=args.imageStudioReference
        const source=await this.comfy.upload(fs.readFileSync(ref.path),'wwis-reference-'+derivePromptHash(ref.identity,'')+path.extname(ref.path))
        if(!source)throw new Error('ComfyUI에 기준 이미지를 전송하지 못했습니다.')
        args={...args,overrides:{...args.overrides,img2imgSource:source,denoise:ref.denoise}}
      }
      const graph = buildComfyPrompt(
        this.config,
        args.prompt,
        args.negativePrompt,
        filenamePrefixFor(args.talentName, args.imageType),
        args.workflow,
        args.seed,
        args.overrides,
        args.referenceImagePath,
      )

      // 부위별 img2img는 얼굴 식별 경로와 분리하고 원본 픽셀을 VAE로 인코딩합니다.
      if (args.overrides?.img2imgSource) {
        const anima = args.workflow === 'anima';
        if (!anima && args.workflow !== 'illustrious') throw new Error('img2img supports SDXL and Anima only');
        const samplerId = anima ? '97' : '1536';
        const decoderId = anima ? '94' : '1291';
        const sampler = graph[samplerId] as { inputs: Record<string, unknown> };
        const decoder = graph[decoderId] as { inputs: { vae: unknown } };
        graph['wwis_reference_load'] = { class_type: 'LoadImage', inputs: { image: args.overrides.img2imgSource } };
        graph['wwis_reference_scale'] = { class_type: 'ImageScale', inputs: { image: ['wwis_reference_load', 0], upscale_method: 'lanczos',
          width: args.overrides.width ?? (anima ? this.config.animaWidth : this.config.sdxlWidth),
          height: args.overrides.height ?? (anima ? this.config.animaHeight : this.config.sdxlHeight), crop: 'disabled' } };
        graph['wwis_reference_encode'] = { class_type: 'VAEEncode', inputs: { pixels: ['wwis_reference_scale', 0], vae: decoder.inputs.vae } };
        sampler.inputs.latent_image = ['wwis_reference_encode', 0];
        sampler.inputs.denoise = args.overrides.denoise;
      }

      // Foreground work jumps the queue; batch work waits its turn.
      const promptId = await this.comfy.submit(graph, !args.bulk)

      const job: GenerationJob = {
        promptId,
        talentId: args.talentId,
        talentName: args.talentName,
        imageType: args.imageType,
        promptHash: args.promptHash,
        prompt: args.prompt,
        negativePrompt: args.negativePrompt,
        genParams: args.overrides,
        workflow: args.workflow,
        status: 'queued',
        startedAt: this.now(),
        mediaKind: 'image',
        bulk: args.bulk,
        debug: args.debug,
        reviewOnly: args.reviewOnly,
      }
      // Registered BEFORE the claim resolves, so a joiner always finds it.
      this.jobs.set(promptId, job)
      claimed(promptId)
      return job
    } catch (err) {
      failed(err)
      throw err
    } finally {
      this.pendingSubmissions.delete(key)
    }
  }

  /** Register an externally-submitted video job so the poller finalizes it. */
  trackVideo(job: Omit<GenerationJob, 'status' | 'startedAt' | 'mediaKind'>): GenerationJob {
    const full: GenerationJob = {
      ...job,
      status: 'queued',
      startedAt: this.now(),
      mediaKind: 'video',
    }
    this.jobs.set(job.promptId, full)
    return full
  }

  /**
   * Cancel one job if ComfyUI has not started sampling it. A running job is
   * left to finish — interrupting the sampler is not cheap — and its result is
   * simply ignored.
   */
  async cancel(promptId: string): Promise<{ cancelled: boolean; running: boolean; queueState: string }> {
    const job = this.jobs.get(promptId)
    if (!job || !isActive(job)) {
      return { cancelled: false, running: false, queueState: 'missing' }
    }
    job.cancelRequested = true

    if (job.workflow === 'nai') {
      // 이미 전송한 요청은 과금 여부가 불확실하므로 중단·재시도하지 않고 결과를 보존합니다.
      if (job.status === 'processing') return { cancelled: false, running: true, queueState: 'running' }
      this.markCancelled(job, 'cancelled')
      return { cancelled: true, running: false, queueState: 'pending' }
    }

    const executionId = job.comfyPromptId ?? promptId
    const queueState = await this.comfy.queueStateOf(executionId)
    if (queueState !== 'pending') {
      return { cancelled: false, running: queueState === 'running', queueState }
    }
    if (!await this.comfy.deletePending([executionId])) {
      return { cancelled: false, running: false, queueState }
    }

    for (const sibling of this.jobs.values()) {
      if ((sibling.comfyPromptId ?? sibling.promptId) === executionId) this.markCancelled(sibling, 'cancelled')
    }
    return { cancelled: true, running: false, queueState }
  }

  /** Drop queued foreground prompts other than `exceptKey`. */
  private async supersede(exceptKey: string): Promise<number> {
    const { all, ours } = await this.comfy.pendingIds()
    if (all.size === 0) return 0

    const toCancel: string[] = []
    for (const [promptId, job] of this.jobs) {
      if (!isActive(job)) continue
      if (!all.has(promptId)) continue
      if (job.bulk) continue
      if ((job.reviewOnly ? 'review:' : '') + jobKey(job.talentName, job.imageType, job.promptHash, job.workflow) === exceptKey) continue
      job.cancelRequested = true
      toCancel.push(promptId)
    }

    // Prompts we recognise as ours but have no job record for — left over from
    // a previous run of this server. Safe to drop; still never anyone else's.
    for (const promptId of ours) {
      if (toCancel.includes(promptId)) continue
      if (this.jobs.get(promptId)?.bulk) continue
      toCancel.push(promptId)
    }

    if (toCancel.length === 0) return 0
    if (!await this.comfy.deletePending(toCancel)) return 0

    for (const promptId of toCancel) {
      const job = this.jobs.get(promptId)
      if (job) this.markCancelled(job, 'superseded')
    }
    return toCancel.length
  }

  private markCancelled(job: GenerationJob, reason: string): void {
    job.cancelRequested = true
    job.status = 'error'
    job.error = reason
    job.completedAt = this.now()
  }

  private findActiveByKey(key: string): GenerationJob | null {
    for (const job of this.jobs.values()) {
      if (!isActive(job)) continue
      if ((job.reviewOnly ? 'review:' : '') + jobKey(job.talentName, job.imageType, job.promptHash, job.workflow) === key) return job
    }
    return null
  }

  private reapStale(): void {
    const cutoff = this.now() - JOB_TTL_MS
    for (const [promptId, job] of this.jobs) {
      if (job.completedAt !== undefined && job.completedAt < cutoff) {
        this.jobs.delete(promptId)
      }
    }
  }

  /** One poll pass. Exposed so a test can drive it without the timer. */
  async tick(): Promise<void> {
    this.reapStale()

    const pending = [...this.jobs.entries()].filter(
      ([promptId, job]) => job.workflow !== 'nai' && isActive(job) && !this.finalizing.has(promptId),
    )
    if (pending.length === 0) return

    const histories = new Map<string, Promise<HistoryResult>>()

    for (const [promptId, job] of pending) {
      // Re-check: an earlier iteration's await may have let another tick in.
      if (this.finalizing.has(promptId) || !isActive(job)) continue

      try {
        const executionId = job.comfyPromptId ?? promptId
        if (!histories.has(executionId)) histories.set(executionId, this.comfy.history(executionId))
        const result = await histories.get(executionId)!
        if (this.finalizing.has(promptId) || !isActive(job)) continue

        if (result.error) {
          job.status = 'error'
          job.error = result.error
          job.completedAt = this.now()
          continue
        }
        if (!result.done) {
          job.status = 'processing'
          continue
        }

        // Claim synchronously, before any further await, so no other path can
        // enter the save.
        this.finalizing.add(promptId)
        try {
          await this.finalize(job, job.outputNodeId ? result.imageNodes?.[job.outputNodeId] ?? [] : result.images ?? [], result.videos ?? [], result.report)
        } finally {
          this.finalizing.delete(promptId)
        }
      } catch (err) {
        console.error(`[jobs] error polling ${promptId}:`, (err as Error).message)
        job.status = 'error'
        job.error = (err as Error).message
        job.completedAt = this.now()
      }
    }
  }

  private async finalize(
    job: GenerationJob,
    images: ComfyOutput[],
    videos: ComfyOutput[],
    report?: string,
    renderedBytes?: Buffer,
  ): Promise<void> {
    const outputs = job.mediaKind === 'video' ? videos : images
    if (outputs.length === 0) {
      // ComfyUI said the prompt finished and handed back nothing we can save.
      // The bare fact is useless to a player, so say what ComfyUI DID report:
      // it saw the wrong media kind, or it was cancelled, or it errored, or —
      // when there is genuinely nothing — where to go and look.
      const wrongKind = job.mediaKind === 'video' ? images : videos
      const detail =
        wrongKind.length > 0
          ? `it returned ${wrongKind.length} ${job.mediaKind === 'video' ? 'still' : 'animation'}(s) instead`
          : report
            ?? 'ComfyUI listed no outputs at all — the run was cancelled, or the graph no '
              + 'longer ends in a Save Image node'
      job.status = 'error'
      job.error = `completed without a readable ${job.mediaKind} output — ${detail}`
      job.completedAt = this.now()
      console.error(`[jobs] ${job.promptId}: ${job.error}`)
      console.error(`[jobs] what ComfyUI recorded: ${this.config.comfyUrl}/history/${job.comfyPromptId ?? job.promptId}`)
      return
    }

    const bytes = renderedBytes ?? await this.comfy.view(outputs[0])
    if (!bytes) {
      job.status = 'error'
      job.error = 'could not read the rendered file from ComfyUI'
      job.completedAt = this.now()
      return
    }

    if (job.reviewOnly) {
      try {
        const draft = this.drafts.ImageStudio_임시그림추가하기({ talentName: job.talentName, imageType: job.imageType,
          workflow: job.workflow, promptHash: job.promptHash, prompt: job.prompt, negativePrompt: job.negativePrompt,
          genParams: job.genParams, debug: job.debug, bytes }, outputs[0].filename)
        job.draftId = draft.id
      } catch (error) {
        job.status = 'error'; job.error = (error as Error).message; job.completedAt = this.now(); return
      }
    } else if (job.mediaKind === 'video') {
      job.media = saveVideo({
        imagesDir: this.config.imagesDir,
        bytes,
        talentId: job.talentId,
        promptHash: job.promptHash,
        sourceFilename: outputs[0].filename,
        now: this.now,
      })
    } else {
      job.media = await saveImage({
        imagesDir: this.config.imagesDir,
        bytes,
        talentName: job.talentName,
        imageType: job.imageType,
        workflow: job.workflow,
        animaSaveToIllustrious: this.config.animaSaveToIllustrious,
        characters: this.config.characterDirs,
        storageRules: this.config.imageStorageRules,
        webp: this.config.webp,
        requireWebp: this.config.requireWebp,
        now: this.now,
      })
      this.cache.add({
        talentName: job.talentName,
        imageType: job.imageType,
        promptHash: job.promptHash,
        imagePath: job.media.relativePath,
        prompt: job.prompt,
        negativePrompt: job.negativePrompt,
        genParams: job.genParams && {
          steps: job.genParams.steps,
          cfg: job.genParams.cfg,
          loraStrength: job.genParams.loraStrength,
          checkpoint: job.genParams.checkpoint,
          width: job.genParams.width,
          height: job.genParams.height,
          ...(job.workflow === 'nai' ? { sampler: job.genParams.sampler, noiseSchedule: job.genParams.noiseSchedule, seed: job.genParams.seed } : {}),
        },
        workflow: job.workflow,
        debug: job.debug,
      })
    }

    job.status = 'completed'
    job.completedAt = this.now()
    // The hourly ceiling is for interactive work; a batch run must not spend it.
    if (!job.bulk) this.recentCompletions.push(job.completedAt)
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setTimeout(() => void this.loop(), this.pollIntervalMs)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /**
   * Recurring timeout rather than an interval: the next tick is scheduled only
   * after the current one finishes, so a slow poll cannot pile up re-entrant runs.
   */
  private async loop(): Promise<void> {
    if (this.stopped) return
    try {
      await this.tick()
    } catch (err) {
      console.error('[jobs] poll threw:', (err as Error).message)
    }
    if (this.stopped) return
    this.timer = setTimeout(() => void this.loop(), this.pollIntervalMs)
  }
}

function isActive(job: GenerationJob): boolean {
  return job.status === 'queued' || job.status === 'processing'
}

/**
 * ComfyUI writes output files under this prefix. It must keep the
 * `<name>_<imageType>` shape: the cancel path identifies our own queued prompts
 * by matching it, and a change here would make us start flushing the player's
 * manual ComfyUI work instead.
 */
function filenamePrefixFor(talentName: string, imageType: string): string {
  return `${sanitizeName(talentName)}_${imageType}`
}
