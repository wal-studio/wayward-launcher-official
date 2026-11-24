/**
 * Overnight pre-generation.
 *
 * The point of this server is that a player can fill in the pictures their own
 * playthrough will ask for, which takes hours. So the queue lives HERE, not in
 * the browser: they submit a list, close the game, and come back to it done.
 *
 * State is a pair of files per job — the work and the results — so a crash, a
 * reboot, or a closed laptop resumes instead of starting over. That shape is
 * borrowed from the CLI runner that already proved it over multi-day runs.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Config, WorkflowType } from '../config.ts'
import type { CacheStore } from '../cache/cacheStore.ts'
import type { JobRunner, SubmitArgs } from '../comfy/jobRunner.ts'
import { ImageStudio_기준이미지읽기 } from '../comfy/reference.ts'
import { promptBatchSignature } from '../comfy/workflows/index.ts'
import { MAX_PROMPT_BATCH_SIZE, normalizePromptBatchSize } from '../config.ts'
import { derivePromptHash } from '../naming.ts'
import { removePromptTags, replaceStockCharacterPrompt } from '../prompts/character.ts'
import { ImageStudio_아내LoRA선택하기, ImageStudio_이미지캐릭터찾기 } from '../characterLoras.ts'
import { NovelAI_프롬프트만들기, NovelAI_생성해시만들기 } from '../nai/client.ts'

export interface BatchItem {
  talentId: string
  referenceKey?: string
  referencePath?: string
  denoise?: number
  prompt: string
  negativePrompt?: string
  workflow?: WorkflowType
  imageType?: string
  steps?: number
  cfg?: number
  loraStrength?: number
  checkpoint?: string
  width?: number
  height?: number
  /** How often play is expected to want this. Higher goes first. */
  weight?: number
  /** Explicit state metadata for image matching; never part of the render hash. */
  debug?: Record<string, unknown>
}

export type ItemOutcome = 'completed' | 'cached' | 'error'

interface ResultLine {
  talentId: string
  outcome: ItemOutcome
  at: number
  error?: string
}

export interface BatchStatus {
  /** Lets chunked clients reject older, queue-replacing servers before writing. */
  enqueueMode: 'append'
  jobId: string | null
  running: boolean
  paused: boolean
  total: number
  done: number
  completed: number
  cached: number
  errored: number
  currentKey: string | null
  currentKeys: string[]
  promptBatchSize: number
  effectiveBatchLimit: number
  startedAt: number | null
  /** Seconds remaining, from the observed rate. Null until enough has finished. */
  etaSeconds: number | null
  lastError: string | null
}

/**
 * Consecutive failures that mean something is broken rather than one bad item —
 * ComfyUI gone, out of disk, a wrong checkpoint name. Stopping beats burning
 * hours failing thousands of times.
 */
const CIRCUIT_BREAK_AFTER = 10

export class BatchQueue {
  private readonly dir: string
  private items: BatchItem[] = []
  private queuedKeys = new Set<string>()
  private results = new Map<string, ResultLine>()
  private jobId: string | null = null
  private running = false
  private paused = false
  private currentKey: string | null = null
  private currentKeys: string[] = []
  private effectiveBatchLimit = MAX_PROMPT_BATCH_SIZE
  private revision = 0
  private startedAt: number | null = null
  private lastError: string | null = null
  private consecutiveFailures = 0
  private stopRequested = false

  constructor(
    private readonly config: Config,
    private readonly cache: CacheStore,
    private readonly jobs: JobRunner,
    private readonly now: () => number = Date.now,
  ) {
    this.dir = path.join(path.resolve(config.stateDir), 'batch')
  }

  private workFile(id: string): string { return path.join(this.dir, `${id}.jsonl`) }
  private resultFile(id: string): string { return path.join(this.dir, `${id}.results.jsonl`) }

  private workflowFor(item: BatchItem): WorkflowType {
    const requested = item.workflow ?? 'illustrious'
    if (requested !== 'anima' && requested !== 'illustrious') return requested
    return this.config.imageProvider === 'nai' || this.config.imageProvider === 'launcher' ? 'nai' : this.config.imageProvider === 'anima' ? 'anima' : 'illustrious'
  }

  private promptsFor(item: BatchItem, workflow: WorkflowType): { prompt: string; negativePrompt: string } {
    if (workflow === 'nai') return this.config.imageProvider === 'launcher'
      ? { prompt: item.prompt, negativePrompt: item.negativePrompt?.trim() ?? '' }
      : NovelAI_프롬프트만들기(this.config, item.prompt, item.negativePrompt)
    if (workflow !== 'anima') {
      return {
        prompt: [this.config.sdxlPositivePrompt.trim(), item.prompt].filter(Boolean).join(', '),
        negativePrompt: [this.config.sdxlNegativePrompt.trim(), item.negativePrompt?.trim()].filter(Boolean).join(', '),
      }
    }
    const id = ImageStudio_이미지캐릭터찾기(item.talentId, Object.keys(this.config.animaCharacterPrompts))
    const character = id ? this.config.animaCharacterPrompts[id] : null
    const withCharacter = character
      ? replaceStockCharacterPrompt(item.prompt, character.prompt, character.originalPrompt)
      : item.prompt
    const scenePrompt = removePromptTags(withCharacter, ['masterpiece', 'best quality'])
    const withoutCommonDuplicates = removePromptTags(scenePrompt, this.config.animaCommonPrompt.split(',').map(tag => tag.trim()).filter(Boolean))
    return {
      prompt: [this.config.animaCommonPrompt.trim(), withoutCommonDuplicates].filter(Boolean).join(', '),
      negativePrompt: [this.config.animaNegativePrompt.trim(), character?.negativePrompt?.trim(), item.negativePrompt?.trim()].filter(Boolean).join(', '),
    }
  }

  private generationParams(item: BatchItem, workflow: WorkflowType): BatchItem {
    if (this.config.imageProvider === 'launcher') {
      return { ...item, width: item.width ?? this.config.sdxlWidth, height: item.height ?? this.config.sdxlHeight }
    }
    return workflow === 'anima'
      ? { ...item, steps: this.config.animaSteps, cfg: this.config.animaCfg, width: this.config.animaWidth, height: this.config.animaHeight }
      : workflow === 'illustrious' && (this.config.sdxlWidth !== 1024 || this.config.sdxlHeight !== 1024 || item.width !== undefined || item.height !== undefined)
        ? { ...item, width: this.config.sdxlWidth, height: this.config.sdxlHeight }
        : item
  }

  /** Pick up an unfinished job left by a previous run. */
  resume(): this {
    let names: string[]
    try {
      names = fs.readdirSync(this.dir)
    } catch {
      return this
    }
    const jobs = names.filter(n => n.endsWith('.jsonl') && !n.endsWith('.results.jsonl'))
      .map(n => n.replace(/\.jsonl$/, ''))
      .sort()
    const latest = jobs[jobs.length - 1]
    if (!latest) return this

    try {
      this.items = fs.readFileSync(this.workFile(latest), 'utf-8')
        .split('\n').filter(Boolean).map(l => JSON.parse(l) as BatchItem)
      this.queuedKeys = new Set(this.items.map(item => item.talentId))
      this.jobId = latest
      this.loadResults(latest)
      const left = this.items.length - this.results.size
      if (left > 0) {
        console.log(`[batch] resuming ${latest}: ${left} of ${this.items.length} left`)
        // Paused on resume: an overnight run that restarts on its own after a
        // crash is a surprise. The operator restarts it.
        this.paused = true
      }
    } catch (err) {
      console.warn('[batch] could not resume:', (err as Error).message)
    }
    return this
  }

  private loadResults(id: string): void {
    this.results.clear()
    try {
      for (const line of fs.readFileSync(this.resultFile(id), 'utf-8').split('\n')) {
        if (!line) continue
        const parsed = JSON.parse(line) as ResultLine
        this.results.set(parsed.talentId, parsed)
      }
    } catch { /* no results yet */ }
  }

  private recordResult(line: ResultLine): void {
    this.results.set(line.talentId, line)
    if (!this.jobId) return
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.appendFileSync(this.resultFile(this.jobId), JSON.stringify(line) + '\n')
    } catch (err) {
      console.error('[batch] could not record result:', (err as Error).message)
    }
  }

  /**
   * Accept a list of work.
   *
   * Anything already rendered is dropped here rather than queued and skipped
   * later, so the reported total is the work that will actually happen — an
   * honest number to show a progress bar against.
   */
  enqueue(items: BatchItem[], jobId?: string): { accepted: number; alreadyCached: number; alreadyQueued: number; jobId: string } {
    // Chunks with the same id belong to one upload. A new upload also joins
    // unfinished work instead of deleting it (including a currently rendering item).
    const append = this.jobId !== null && (
      jobId === this.jobId || this.running || this.items.length > this.results.size
    )
    const id = append ? this.jobId! : jobId ?? `${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
    const keys = new Set<string>()
    const fresh: BatchItem[] = []
    let alreadyCached = 0
    let alreadyQueued = 0

    for (const item of items) {
      // Also makes a retried POST idempotent after a lost HTTP response.
      if ((append && this.queuedKeys.has(item.talentId)) || keys.has(item.talentId)) {
        alreadyQueued++
        continue
      }
      const request = this.prepare(item)
      if (this.cache.get(item.talentId, request.imageType, request.promptHash, request.workflow)) {
        alreadyCached++
        continue
      }
      fresh.push(item)
      keys.add(item.talentId)
    }

    // Highest demand first: an overnight run rarely finishes the whole space,
    // so what it does get through should be what play actually asks for.
    fresh.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))

    // Persist only the new chunk: rewriting the full growing list per request
    // would make large uploads quadratic. A failed write must not report success.
    fs.mkdirSync(this.dir, { recursive: true })
    const lines = fresh.map(i => JSON.stringify(i)).join('\n')
    if (append) {
      if (fresh.length) fs.appendFileSync(this.workFile(id), lines + '\n')
      // Do not replace or sort an array being traversed by run(). Its iterator
      // will pick up the appended items after the existing work.
      this.items.push(...fresh)
      for (const key of keys) this.queuedKeys.add(key)
    } else {
      fs.writeFileSync(this.workFile(id), lines + '\n')
      // A stale results file from a reused id would make everything look done.
      fs.rmSync(this.resultFile(id), { force: true })
      this.jobId = id
      this.items = fresh
      this.queuedKeys = keys
      this.results.clear()
      this.stopRequested = false
      this.consecutiveFailures = 0
      this.lastError = null
      this.startedAt = null
    }

    return { accepted: fresh.length, alreadyCached, alreadyQueued, jobId: id }
  }

  start(): void {
    this.paused = false
    this.stopRequested = false
    if (this.running) return
    this.items.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    void this.run()
  }

  pause(): void { this.paused = true }

  clear(): void {
    this.revision++
    this.stopRequested = true
    this.paused = true
    this.items = []
    this.queuedKeys.clear()
    this.results.clear()
    this.currentKey = null
    this.currentKeys = []
    if (this.jobId) {
      try {
        fs.rmSync(this.workFile(this.jobId), { force: true })
        fs.rmSync(this.resultFile(this.jobId), { force: true })
      } catch { /* best effort */ }
    }
    this.jobId = null
  }

  status(): BatchStatus {
    const outcomes = [...this.results.values()]
    const completed = outcomes.filter(r => r.outcome === 'completed').length
    const cached = outcomes.filter(r => r.outcome === 'cached').length
    const errored = outcomes.filter(r => r.outcome === 'error').length
    const done = outcomes.length

    let etaSeconds: number | null = null
    // Needs a few finished items before the rate means anything.
    if (this.running && this.startedAt !== null && done >= 3 && done < this.items.length) {
      const elapsed = (this.now() - this.startedAt) / 1000
      etaSeconds = Math.round((elapsed / done) * (this.items.length - done))
    }

    return {
      enqueueMode: 'append',
      jobId: this.jobId,
      running: this.running,
      paused: this.paused,
      total: this.items.length,
      done,
      completed,
      cached,
      errored,
      currentKey: this.currentKey,
      currentKeys: this.currentKeys,
      promptBatchSize: normalizePromptBatchSize(this.config.promptBatchSize),
      effectiveBatchLimit: Math.min(normalizePromptBatchSize(this.config.promptBatchSize), this.effectiveBatchLimit),
      startedAt: this.startedAt,
      etaSeconds,
      lastError: this.lastError,
    }
  }

  private async run(): Promise<void> {
    this.running = true
    this.startedAt = this.now()
    this.effectiveBatchLimit = MAX_PROMPT_BATCH_SIZE
    const revision = this.revision
    let checkedNode = false
    try {
      let cursor = 0
      while (cursor < this.items.length && !this.stopRequested && !this.paused && revision === this.revision) {
        const requests: SubmitArgs[] = []
        let signature: string | null = null
        const limit = this.config.imageProvider === 'nai' || this.config.imageProvider === 'launcher' ? 1 : Math.min(normalizePromptBatchSize(this.config.promptBatchSize), this.effectiveBatchLimit)
        while (cursor < this.items.length && requests.length < limit) {
          const item = this.items[cursor]!
          if (this.results.has(item.talentId)) { cursor++; continue }
          const request = this.prepare(item)
          if (this.cache.get(request.talentName, request.imageType, request.promptHash, request.workflow)) {
            cursor++
            this.recordResult({ talentId: item.talentId, outcome: 'cached', at: this.now() })
            continue
          }
          const nextSignature = request.workflow === 'nai' ? 'nai' : promptBatchSignature(this.config, request)
          if (requests.length && (nextSignature !== signature || request.workflow === 'nai' || request.workflow === 'z-image' || request.imageStudioReference || requests[0]?.imageStudioReference)) break
          cursor++
          requests.push(request)
          signature = nextSignature
          if (request.workflow === 'nai' || request.workflow === 'z-image' || request.imageStudioReference) break
        }
        if (!requests.length) continue
        if (requests.length > 1 && !checkedNode) {
          if (!await this.jobs.supportsPromptBatch()) {
            this.paused = true
            this.lastError = '동시 프롬프트 생성 노드가 없습니다. 모드의 Install_ComfyUI_PromptBatch.cmd로 노드를 설치하고 ComfyUI를 재시작하거나 동시 프롬프트 전달 개수를 1로 설정하세요.'
            break
          }
          checkedNode = true
        }
        if (revision !== this.revision || this.stopRequested || this.paused) break
        this.currentKeys = requests.map(request => request.talentId)
        this.currentKey = this.currentKeys[0] ?? null
        const outcomes = await this.renderPrepared(requests, revision)
        if (revision !== this.revision || this.stopRequested) break
        for (const result of outcomes) {
          this.recordResult({ talentId: result.request.talentId, outcome: result.outcome, at: this.now(), ...(result.error ? { error: result.error } : {}) })
          if (result.outcome === 'error') {
            this.lastError = result.error ?? 'render failed'
            this.consecutiveFailures++
          } else this.consecutiveFailures = 0
        }
        if (this.consecutiveFailures >= CIRCUIT_BREAK_AFTER) {
          this.paused = true
          this.lastError = `stopped after ${this.consecutiveFailures} failures in a row: ${this.lastError}`
        }
      }
    } catch (error) {
      this.lastError = (error as Error).message
      this.paused = true
    } finally {
      this.running = false
      this.currentKey = null
      this.currentKeys = []
      if (revision !== this.revision && !this.paused && !this.stopRequested) this.start()
    }
  }

  private prepare(item: BatchItem): SubmitArgs {
    const workflow = this.workflowFor(item)
    const imageType = item.imageType ?? 'portrait'
    const prompts = this.promptsFor(item, workflow)
    const generationParams = this.generationParams(item, workflow)
    const loras = ImageStudio_아내LoRA선택하기(this.config, item.talentId, workflow)
    const reference=ImageStudio_기준이미지읽기(this.config,this.cache,item,workflow)
    const baseHash = workflow === 'nai' && this.config.imageProvider === 'launcher'
      ? derivePromptHash(prompts.prompt, prompts.negativePrompt, { ...generationParams, launcherProviderSignature: this.config.launcherProviderSignature })
      : workflow === 'nai' ? NovelAI_생성해시만들기(this.config, prompts.prompt, prompts.negativePrompt)
        : derivePromptHash(prompts.prompt, prompts.negativePrompt, { ...generationParams, loras })
    const promptHash=reference?derivePromptHash(baseHash+'|reference:'+reference.identity+'|denoise:'+reference.denoise,''):baseHash

    return {
      ...(reference ? { imageStudioReference: reference } : {}),
      talentId: item.talentId,
      talentName: item.talentId,
      debug: reference ? {...item.debug,img2img:{referenceKey:item.referenceKey,referencePath:item.referencePath,denoise:item.denoise}} : item.debug,
      imageType,
      prompt: prompts.prompt,
      negativePrompt: prompts.negativePrompt,
      workflow,
      promptHash,
      overrides: {
        steps: generationParams.steps,
        cfg: generationParams.cfg,
        loraStrength: item.loraStrength,
        loras,
        checkpoint: item.checkpoint,
        width: generationParams.width,
        height: generationParams.height,
        ...(workflow === 'nai' && this.config.imageProvider === 'nai' ? { steps: this.config.naiSteps, cfg: this.config.naiScale, checkpoint: this.config.naiModel,
          width: this.config.naiWidth, height: this.config.naiHeight, sampler: this.config.naiSampler, noiseSchedule: this.config.naiNoiseSchedule } : {}),
      },
      // Always bulk: this must not cancel — or be cancelled by — whatever the
      // player is looking at, and it must not trip the interactive rate caps.
      bulk: true,
    }
  }

  private async renderPrepared(requests: SubmitArgs[], revision: number): Promise<{ request: SubmitArgs; outcome: ItemOutcome; error?: string }[]> {
    let outcomes: { request: SubmitArgs; outcome: ItemOutcome; error?: string }[]
    try {
      const jobs = requests.length === 1 ? [await this.jobs.submit(requests[0]!)] : await this.jobs.submitBatch(requests)
      const deadline = this.now() + Math.max(15, requests.length * 3) * 60_000
      while (this.now() < deadline) {
        if (this.stopRequested || revision !== this.revision) throw new Error('cancelled')
        if (jobs.every(job => job.status === 'completed' || job.status === 'error')) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      outcomes = jobs.map((job, index) => ({ request: requests[index]!, outcome: job.status === 'completed' ? 'completed' : 'error',
        ...(job.status === 'completed' ? {} : { error: job.error ?? 'timed out waiting for the render' }) }))
    } catch (error) {
      outcomes = requests.map(request => ({ request, outcome: 'error', error: (error as Error).message }))
    }
    const failed = outcomes.filter(result => result.outcome === 'error')
    if (requests.length > 1 && failed.length && !this.stopRequested && revision === this.revision
      && failed.every(result => /out of memory|allocation.*failed|batch token lengths/i.test(result.error ?? ''))) {
      const limit = Math.max(1, Math.floor(requests.length / 2))
      this.effectiveBatchLimit = Math.min(this.effectiveBatchLimit, limit)
      this.lastError = `배치 메모리 또는 토큰 길이 제한으로 이번 실행의 동시 프롬프트 수를 ${limit}개로 줄여 재시도합니다. 저장한 설정은 유지합니다.`
      const retried = new Map<string, { request: SubmitArgs; outcome: ItemOutcome; error?: string }>()
      for (let index = 0; index < failed.length; index += limit) {
        for (const result of await this.renderPrepared(failed.slice(index, index + limit).map(result => result.request), revision)) retried.set(result.request.talentId, result)
      }
      outcomes = outcomes.map(result => retried.get(result.request.talentId) ?? result)
    }
    return outcomes
  }
}
