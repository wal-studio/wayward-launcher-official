/**
 * Configuration — the one place that resolves settings.
 *
 * Precedence: CLI flags > environment > config file > defaults.
 *
 * Every path the server touches hangs off `imagesDir`, so a player can point
 * a second instance at a second art library without any other change. Nothing
 * here reads `process.cwd()` implicitly — the caller decides.
 */

import * as path from 'node:path'
import type { CharacterLoraSettings } from './characterLoras.ts'
import * as fs from 'node:fs'

/** What the game ships pointed at. v17 replaced v12 on 2026-09-21 after a blind
 *  A/B on the game's own prompts (`gin images ab-checkpoint`); the cache key
 *  does not carry the default checkpoint, so art rendered on v12 keeps serving
 *  and only new renders use this. */
export const DEFAULT_CHECKPOINT = 'waiIllustriousSDXL_v170.safetensors'

export const MAX_PROMPT_BATCH_SIZE = 128

export function normalizePromptBatchSize(value: unknown, fallback = 1): number {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value)
  return Math.min(MAX_PROMPT_BATCH_SIZE, Math.max(1, Math.trunc(Number.isFinite(number) ? number : fallback)))
}

export type WorkflowType = 'z-image' | 'illustrious' | 'anima' | 'nai'

export interface AnimaLoraSetting {
  name: string
  enabled: boolean
  strength: number
}

// 호환 모드는 저장 위치와 추가 이미지 경로 검사만 등록합니다.
// 실제 생성·파일 저장·캐시 처리는 항상 본체 구현을 통과합니다.
export interface ImageStorageRule {
  id: string
  directoryFor(talentName: string, character: string): string | null
  /** Optional readable descriptor; core still validates and writes the final filename. */
  descriptorFor?(talentName: string, character: string): string | null
}

export type ImagePathVerifier = (relativePath: string) => boolean | null

export interface Config {
  /** Runtime extension hooks; these functions are never written to settings JSON. */
  imageStorageRules?: ImageStorageRule[]
  imagePathVerifiers?: ImagePathVerifier[]
  /** Interface to bind. Loopback unless the operator explicitly opts out. */
  host: string
  port: number
  /** Root of the art library. Holds `.image-cache_<name>.json` and `<workflow>/characters/...`. */
  imagesDir: string
  /** Where per-run state lives (hits, batch queues, miss log). */
  stateDir: string
  /** Base URL of the ComfyUI instance. */
  comfyUrl: string
  /** Distinct prompts per bulk sampler run, sharing one model. */
  promptBatchSize: number
  /** Wan i2v workflow JSON. Video routes 501 without it rather than crashing. */
  wanWorkflowPath: string | null

  /**
   * Origins allowed to call the API, beyond the always-allowed loopback set.
   *
   * Deliberately not `*`: this server writes files and commands a GPU, and
   * Chrome's Local Network Access explicitly exempts `file://` pages, so the
   * browser will not stop a hostile local page on our behalf.
   */
  allowedOrigins: string[]

  /** `DELETE /api/image/delete` is off unless the operator asks for it. */
  allowDelete: boolean

  /** Refuse new writes once the art library passes this size. 0 = no ceiling. */
  maxDiskGb: number
  /** Concurrent ComfyUI submissions for interactive work. */
  concurrency: number
  /** Cap on queued interactive jobs; batch work has its own queue. */
  maxQueued: number
  /** Interactive images per rolling hour. Bounds a drive-by to "GPU was busy". */
  maxImagesPerHour: number

  /** Folder names under `<imagesDir>/<workflow>/characters/`. */
  characterDirs: string[]

  /** Illustrious workflow knobs — the ones worth changing without editing source. */
  checkpoint: string
  steps: number
  cfg: number
  sampler: string
  scheduler: string
  clipSkip: number
  lora: string
  loraStrength: number
  characterLoras: Record<string, CharacterLoraSettings>

  /** Saved provider for ordinary game images and conditional queues. */
  imageProvider: 'sdxl' | 'anima' | 'nai'
  naiToken: string
  naiModel: string
  naiWidth: number
  naiHeight: number
  naiSteps: number
  naiScale: number
  naiSampler: string
  naiNoiseSchedule: string
  naiCommonPrompt: string
  naiArtistPrompt: string
  naiNegativePrompt: string

  /** Prompt fragments prepended to the game's ordinary SDXL prompts. */
  sdxlWidth: number
  sdxlHeight: number
  sdxlPositivePrompt: string
  sdxlNegativePrompt: string

  /** Anima/Qwen image workflow. These values can be changed live in Image Studio. */
  animaSaveToIllustrious: boolean
  animaUnet: string
  animaUnetDir: string
  animaClip: string
  animaClipDevice: 'default' | 'cpu'
  animaVae: string
  animaWidth: number
  animaHeight: number
  animaSteps: number
  animaCfg: number
  animaSampler: string
  animaScheduler: string
  animaCommonPrompt: string
  animaNegativePrompt: string
  animaLoraDir: string
  animaLoras: AnimaLoraSetting[]
  animaCharacterPrompts: Record<string, {
    prompt: string
    negativePrompt: string
    originalPrompt: string
    originalNegativePrompt: string
  }>

  /**
   * Re-encode renders as WebP when possible.
   *
   * Anime-style renders shrink roughly eightfold with no visible loss, which is
   * the difference between a 3 GB art library and a 20 GB one. Needs the
   * optional `sharp` package; without it renders stay PNG and nothing breaks,
   * since every cache entry records the extension it actually wrote.
   */
  webp: boolean

  /**
   * Refuse to start when WebP is on but `sharp` will not load. For a library
   * that must stay all-WebP (the game's own): a silent PNG fallback there went
   * unnoticed for ten days and 26,000 renders.
   */
  requireWebp: boolean

  /**
   * How often to ask ComfyUI whether a job has finished. The default matches
   * how long a render takes; a test drives it far faster.
   */
  pollIntervalMs: number

  /**
   * Exit when this process id is gone.
   *
   * `bun run dev` passes its own pid. Without it, force-killing the parent (or
   * just closing the terminal window — Windows gives a child no interceptable
   * signal for that) leaves this server alive, holding the port and driving the
   * GPU behind a window that looks closed. Orphaned background GPU work is a
   * failure this project has been bitten by before; a liveness check removes
   * the whole class rather than relying on a handler that cannot always run.
   */
  parentPid: number | null

  /** Verbose request logging. */
  verbose: boolean
}

export const DEFAULT_PORT = 8189

/**
 * Character folders shipped with the game.
 *
 * The game's own list lives in `src/data/imageCharacters.ts`. This package is
 * published on its own and must not import across that boundary, so it carries
 * its own default; a test in the private repo asserts the two agree. A player
 * adding their own character overrides it via config.
 */
export const DEFAULT_CHARACTER_DIRS = ['elena', 'mara', 'pippa', 'patron']

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  return raw === '1' || raw.toLowerCase() === 'true'
}

/** Parse `--flag value`, `--flag=value`, and bare `--bool-flag`. */
/** Whether `host` exposes the server beyond this machine. */
export function boundBeyondLoopback(host: string): boolean {
  return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1'
}

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next != null && !next.startsWith('--')) {
      out[key] = next
      i++
    } else {
      out[key] = 'true'
    }
  }
  return out
}

function readConfigFile(file: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(file)) return {}
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>
  } catch (err) {
    console.warn(`[config] ignoring unreadable ${file}: ${(err as Error).message}`)
    return {}
  }
}

/** SDXL's latent grid uses eight pixels per cell. */
export function sdxl_normalizeDimension(value: unknown, fallback = 1024): number {
  const parsed = value === null || value === undefined || value === '' ? NaN : Number(value)
  const size = Number.isFinite(parsed) ? parsed : fallback
  return Math.round(Math.min(4096, Math.max(64, size)) / 8) * 8
}

export function resolveConfig(argv: string[] = [], cwd = process.cwd()): Config {
  const flags = parseArgs(argv)
  const file = readConfigFile(path.resolve(cwd, flags['config'] ?? 'wayward-imagegen.config.json'))

  // An env var that is SET BUT EMPTY is an intentional empty value, not an
  // absent one: `COMFYUI_LORA=''` is how you disable the speed LoRA for a
  // checkpoint that already has acceleration baked in. Falling back to the
  // default there would silently re-enable it.
  const pick = (flag: string, env: string, fileKey: string, fallback: string): string => {
    if (flags[flag] != null) return flags[flag]
    const e = process.env[env]
    if (e != null) return e
    const f = file[fileKey]
    if (typeof f === 'string') return f
    return fallback
  }
  const pickNum = (flag: string, env: string, fileKey: string, fallback: number): number => {
    if (flags[flag] != null) {
      const n = Number(flags[flag])
      if (Number.isFinite(n)) return n
    }
    const f = file[fileKey]
    const base = typeof f === 'number' && Number.isFinite(f) ? f : fallback
    return envNumber(env, base)
  }

  const imagesDir = path.resolve(cwd, pick('images-dir', 'WAYWARD_IMAGES_DIR', 'imagesDir', 'images'))
  const stateDir = path.resolve(cwd, pick('state-dir', 'WAYWARD_STATE_DIR', 'stateDir', path.join(imagesDir, '.state')))

  const wanRaw = pick('wan-workflow', 'WAYWARD_WAN_WORKFLOW', 'wanWorkflowPath', '')
  const wanWorkflowPath = wanRaw ? path.resolve(cwd, wanRaw) : null

  const originsRaw = flags['allow-origin']
    ?? process.env.WAYWARD_ALLOW_ORIGIN
    ?? (Array.isArray(file.allowedOrigins) ? (file.allowedOrigins as string[]).join(',') : '')
  const allowedOrigins = originsRaw
    ? originsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : []

  const charsRaw = flags['characters']
    ?? process.env.WAYWARD_CHARACTER_DIRS
    ?? (Array.isArray(file.characterDirs) ? (file.characterDirs as string[]).join(',') : '')
  const characterDirs = charsRaw
    ? charsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_CHARACTER_DIRS

  const fileLoras = Array.isArray(file.animaLoras)
    ? (file.animaLoras as AnimaLoraSetting[]).filter(item => item && typeof item.name === 'string')
    : []
  const animaUnetDirRaw = pick('anima-unet-dir', 'ANIMA_UNET_DIR', 'animaUnetDir', '')
  const animaLoraDirRaw = pick('anima-lora-dir', 'ANIMA_LORA_DIR', 'animaLoraDir', '')

  return {
    host: pick('host', 'WAYWARD_HOST', 'host', '127.0.0.1'),
    port: pickNum('port', 'WAYWARD_PORT', 'port', DEFAULT_PORT),
    imagesDir,
    stateDir,
    comfyUrl: pick('comfy-url', 'COMFYUI_URL', 'comfyUrl', 'http://127.0.0.1:8188').replace(/\/+$/, ''),
    promptBatchSize: normalizePromptBatchSize(pickNum('prompt-batch-size', 'WAYWARD_PROMPT_BATCH_SIZE', 'promptBatchSize', 1)),
    wanWorkflowPath,

    allowedOrigins,

    allowDelete: flags['allow-delete'] === 'true' || envBool('WAYWARD_ALLOW_DELETE', file.allowDelete === true),

    maxDiskGb: pickNum('max-disk-gb', 'WAYWARD_MAX_DISK_GB', 'maxDiskGb', 0),
    concurrency: pickNum('concurrency', 'WAYWARD_CONCURRENCY', 'concurrency', 2),
    maxQueued: pickNum('max-queued', 'WAYWARD_MAX_QUEUED', 'maxQueued', 64),
    maxImagesPerHour: pickNum('max-images-per-hour', 'WAYWARD_MAX_IMAGES_PER_HOUR', 'maxImagesPerHour', 400),

    characterDirs,

    checkpoint: pick('checkpoint', 'COMFYUI_CHECKPOINT', 'checkpoint', DEFAULT_CHECKPOINT),
    steps: pickNum('steps', 'COMFYUI_STEPS', 'steps', 9),
    cfg: pickNum('cfg', 'COMFYUI_CFG', 'cfg', 1.5),
    sampler: pick('sampler', 'COMFYUI_SAMPLER', 'sampler', 'euler_ancestral'),
    scheduler: pick('scheduler', 'COMFYUI_SCHEDULER', 'scheduler', 'simple'),
    clipSkip: pickNum('clip-skip', 'COMFYUI_CLIP_SKIP', 'clipSkip', -2),
    lora: pick('lora', 'COMFYUI_LORA', 'lora', 'sdxl_lightning_8step_lora.safetensors'),
    loraStrength: pickNum('lora-strength', 'COMFYUI_LORA_STRENGTH', 'loraStrength', 1),
    characterLoras: file.characterLoras ?? {},

    imageProvider: file.imageProvider === 'nai' ? 'nai' : file.imageProvider === 'anima' ? 'anima' : 'sdxl',
    naiToken: pick('nai-token', 'NAI_TOKEN', 'naiToken', ''),
    naiModel: pick('nai-model', 'NAI_MODEL', 'naiModel', 'nai-diffusion-5-full'),
    naiWidth: pickNum('nai-width', 'NAI_WIDTH', 'naiWidth', 832),
    naiHeight: pickNum('nai-height', 'NAI_HEIGHT', 'naiHeight', 1216),
    naiSteps: pickNum('nai-steps', 'NAI_STEPS', 'naiSteps', 28),
    naiScale: pickNum('nai-scale', 'NAI_SCALE', 'naiScale', 6.5),
    naiSampler: pick('nai-sampler', 'NAI_SAMPLER', 'naiSampler', 'k_euler_ancestral'),
    naiNoiseSchedule: pick('nai-noise-schedule', 'NAI_NOISE_SCHEDULE', 'naiNoiseSchedule', 'karras'),
    naiCommonPrompt: pick('nai-common-prompt', 'NAI_COMMON_PROMPT', 'naiCommonPrompt', ''),
    naiArtistPrompt: pick('nai-artist-prompt', 'NAI_ARTIST_PROMPT', 'naiArtistPrompt', ''),
    naiNegativePrompt: pick('nai-negative-prompt', 'NAI_NEGATIVE_PROMPT', 'naiNegativePrompt', ''),
    sdxlWidth: sdxl_normalizeDimension(pickNum('sdxl-width', 'SDXL_WIDTH', 'sdxlWidth', 1024)),
    sdxlHeight: sdxl_normalizeDimension(pickNum('sdxl-height', 'SDXL_HEIGHT', 'sdxlHeight', 1024)),
    sdxlPositivePrompt: pick('sdxl-positive-prompt', 'SDXL_POSITIVE_PROMPT', 'sdxlPositivePrompt', ''),
    sdxlNegativePrompt: pick('sdxl-negative-prompt', 'SDXL_NEGATIVE_PROMPT', 'sdxlNegativePrompt', ''),

    animaSaveToIllustrious: file.animaSaveToIllustrious === true,
    animaUnet: pick('anima-unet', 'ANIMA_UNET', 'animaUnet', 'anima-base-v1.0.safetensors'),
    animaUnetDir: animaUnetDirRaw ? path.resolve(cwd, animaUnetDirRaw) : '',
    animaClip: pick('anima-clip', 'ANIMA_CLIP', 'animaClip', 'qwen_3_06b_base.safetensors'),
    // CPU is slower, but avoids a native CUDA access violation seen when the
    // Anima Qwen encoder is loaded on 8 GB Blackwell cards.
    animaClipDevice: file.animaClipDevice === 'default' ? 'default' : 'cpu',
    animaVae: pick('anima-vae', 'ANIMA_VAE', 'animaVae', 'qwen_image_vae.safetensors'),
    animaWidth: pickNum('anima-width', 'ANIMA_WIDTH', 'animaWidth', 832),
    animaHeight: pickNum('anima-height', 'ANIMA_HEIGHT', 'animaHeight', 1216),
    animaSteps: pickNum('anima-steps', 'ANIMA_STEPS', 'animaSteps', 30),
    animaCfg: pickNum('anima-cfg', 'ANIMA_CFG', 'animaCfg', 4),
    animaSampler: pick('anima-sampler', 'ANIMA_SAMPLER', 'animaSampler', 'er_sde'),
    // Match ComfyUI's bundled Anima workflow. Other schedulers remain
    // selectable from ImageStudio, but "simple" is the known-good baseline.
    animaScheduler: pick('anima-scheduler', 'ANIMA_SCHEDULER', 'animaScheduler', 'simple'),
    animaCommonPrompt: pick('anima-common-prompt', 'ANIMA_COMMON_PROMPT', 'animaCommonPrompt', ''),
    animaNegativePrompt: pick('anima-negative', 'ANIMA_NEGATIVE_PROMPT', 'animaNegativePrompt', 'worst quality, low quality, blurry, bad anatomy, extra digits, missing fingers, text, watermark, censored'),
    animaLoraDir: animaLoraDirRaw ? path.resolve(cwd, animaLoraDirRaw) : '',
    animaLoras: fileLoras,
    animaCharacterPrompts: {},

    webp: flags['no-webp'] === 'true' ? false : flags.webp === 'true' ? true : !envBool('WAYWARD_NO_WEBP', file.webp === false),
    requireWebp: flags['require-webp'] === 'true' || envBool('WAYWARD_REQUIRE_WEBP', file.requireWebp === true),

    pollIntervalMs: pickNum('poll-interval-ms', 'WAYWARD_POLL_INTERVAL_MS', 'pollIntervalMs', 2000),

    parentPid: (() => {
      const raw = flags['parent-pid'] ?? process.env.WAYWARD_PARENT_PID
      if (!raw) return null
      const n = Number(raw)
      return Number.isFinite(n) && n > 0 ? n : null
    })(),

    verbose: flags['verbose'] === 'true' || envBool('WAYWARD_VERBOSE', false),
  }
}
