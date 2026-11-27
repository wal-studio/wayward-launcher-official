import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Config, AnimaLoraSetting } from '../config.ts'
import { MAX_PROMPT_BATCH_SIZE, sdxl_normalizeDimension, normalizePromptBatchSize } from '../config.ts'
import { ComfyClient } from '../comfy/client.ts'
import { PROMPT_BATCH_NODE } from '../comfy/workflows/index.ts'
import { Router, sendJson, HttpError } from '../http/router.ts'
import { readJson } from '../http/body.ts'
import { ImageStudio_아내LoRA정리하기, type CharacterLoraSettings } from '../characterLoras.ts'
import { NAI_MODELS, NAI_SAMPLERS, NAI_SCHEDULES, NovelAI_연결확인하기 } from '../nai/client.ts'

export interface CharacterPrompt extends CharacterLoraSettings {
  id: string
  name: string
  prompt: string
  negativePrompt: string
  originalPrompt: string
  originalNegativePrompt: string
}

export interface GenerationSettings {
  version: number
  imageProvider: 'sdxl' | 'anima' | 'nai' | 'flux'
  fluxWorkerUrl: string
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
  animaSaveToIllustrious: boolean
  comfyUrl: string
  promptBatchSize: number
  modelsDirectory: string

  sdxlCheckpoint: string
  sdxlLora: string
  sdxlLoraStrength: number
  sdxlSteps: number
  sdxlCfg: number
  sdxlSampler: string
  sdxlScheduler: string
  sdxlClipSkip: number
  sdxlWidth: number
  sdxlHeight: number
  sdxlPositivePrompt: string
  sdxlNegativePrompt: string

  model: string
  clip: string
  clipDevice: 'default' | 'cpu'
  vae: string
  loraDirectory: string
  width: number
  height: number
  steps: number
  cfg: number
  sampler: string
  scheduler: string
  positivePrompt: string
  negativePrompt: string
  loras: AnimaLoraSetting[]
  characters: CharacterPrompt[]
}

const ORIGINAL_CHARACTERS: CharacterPrompt[] = [
  {
    id: 'elena', name: '엘레나',
    prompt: 'kisaragi_chihaya, long dark hair, brown eyes, soft features, gentle face, pale skin, slim build, medium breasts, slim waist',
    negativePrompt: 'tattoo, piercing, makeup heavy', originalPrompt: '', originalNegativePrompt: '',
  },
  {
    id: 'mara', name: '마라',
    prompt: 'medium hair, shoulder-length brown hair, straight hair, hazel eyes, sharper features, strong jawline, fair skin, athletic build, medium breasts, narrow waist',
    negativePrompt: 'long hair, tattoo, piercing, makeup heavy', originalPrompt: '', originalNegativePrompt: '',
  },
  {
    id: 'pippa', name: '피파',
    prompt: '(Kyouko Toshinou:1.2), (straight blonde hair:1.1), cute face, bright green eyes, freckles, petite slim build, small breasts, quirky',
    negativePrompt: 'child, loli, blonde hair, black hair, long hair, tall, curvy, large breasts, tattoo, piercing, makeup heavy', originalPrompt: '', originalNegativePrompt: '',
  },
  { id: 'patron', name: '손님 공통 분류', prompt: '', negativePrompt: '', originalPrompt: '', originalNegativePrompt: '' },
]

function settingsFile(config: Config): string {
  // Keep EasyGen's filename so an existing Anima setup is imported once.
  return path.join(config.stateDir, 'anima-settings.json')
}

function defaults(config: Config): GenerationSettings {
  return {
    version: 19,
    imageProvider: config.imageProvider,
    fluxWorkerUrl: config.fluxWorkerUrl,
    naiToken: config.naiToken,
    naiModel: config.naiModel,
    naiWidth: config.naiWidth,
    naiHeight: config.naiHeight,
    naiSteps: config.naiSteps,
    naiScale: config.naiScale,
    naiSampler: config.naiSampler,
    naiNoiseSchedule: config.naiNoiseSchedule,
    naiCommonPrompt: config.naiCommonPrompt,
    naiArtistPrompt: config.naiArtistPrompt,
    naiNegativePrompt: config.naiNegativePrompt,
    animaSaveToIllustrious: config.animaSaveToIllustrious === true,
    comfyUrl: config.comfyUrl,
    promptBatchSize: normalizePromptBatchSize(config.promptBatchSize),
    modelsDirectory: config.animaUnetDir ? path.dirname(config.animaUnetDir) : '',
    sdxlCheckpoint: config.checkpoint,
    sdxlLora: config.lora,
    sdxlLoraStrength: config.loraStrength,
    sdxlSteps: config.steps,
    sdxlCfg: config.cfg,
    sdxlSampler: config.sampler,
    sdxlScheduler: config.scheduler,
    sdxlClipSkip: config.clipSkip,
    sdxlWidth: config.sdxlWidth,
    sdxlHeight: config.sdxlHeight,
    sdxlPositivePrompt: config.sdxlPositivePrompt,
    sdxlNegativePrompt: config.sdxlNegativePrompt,
    model: config.animaUnet,
    clip: config.animaClip,
    clipDevice: config.animaClipDevice,
    vae: config.animaVae,
    loraDirectory: config.animaLoraDir,
    width: config.animaWidth,
    height: config.animaHeight,
    steps: config.animaSteps,
    cfg: config.animaCfg,
    sampler: config.animaSampler,
    scheduler: config.animaScheduler,
    positivePrompt: config.animaCommonPrompt,
    negativePrompt: config.animaNegativePrompt,
    loras: config.animaLoras,
    characters: ORIGINAL_CHARACTERS.map(character => ({ ...character, ...ImageStudio_아내LoRA정리하기(config.characterLoras?.[character.id] || {}) })),
  }
}

function cleanCharacter(raw: Partial<CharacterPrompt>): CharacterPrompt {
  const id = String(raw.id || '').trim().toLowerCase()
  return {
    id,
    name: String(raw.name || id).trim().slice(0, 100) || id,
    prompt: String(raw.prompt || '').trim(),
    negativePrompt: String(raw.negativePrompt || '').trim(),
    originalPrompt: String(raw.originalPrompt || '').trim(),
    originalNegativePrompt: String(raw.originalNegativePrompt || '').trim(),
    ...ImageStudio_아내LoRA정리하기(raw),
  }
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback))
}

function clean(raw: Partial<GenerationSettings>, base: GenerationSettings): GenerationSettings {
  const width = Math.round(finiteNumber(raw.width, base.width, 64, 4096) / 16) * 16
  const height = Math.round(finiteNumber(raw.height, base.height, 64, 4096) / 16) * 16
  const characters = Array.isArray(raw.characters)
    ? raw.characters.map(character => cleanCharacter({ ...base.characters.find(existing => existing.id === String(character.id || '').trim().toLowerCase()), ...character })).filter(character => /^[a-z0-9][a-z0-9_-]{0,99}$/.test(character.id))
    : base.characters
  const mergedCharacters = characters.length ? characters : base.characters
  const modelsDirectory = String(raw.modelsDirectory || '').trim()
  const loraDirectory = String(raw.loraDirectory || '').trim()
  const selectedIsComfyRoot = Boolean(modelsDirectory && loraDirectory
    && path.resolve(modelsDirectory, 'loras').toLowerCase() === path.resolve(loraDirectory).toLowerCase())
  return {
    version: 19,
    imageProvider: raw.imageProvider === 'flux' ? 'flux' : raw.imageProvider === 'nai' ? 'nai' : raw.imageProvider === 'anima' ? 'anima' : raw.imageProvider === 'sdxl' ? 'sdxl' : base.imageProvider,
    fluxWorkerUrl: String(raw.fluxWorkerUrl ?? base.fluxWorkerUrl).trim(),
    // 화면의 토큰 빈칸은 기존 값을 유지합니다. 삭제는 별도 명시 요청으로 처리합니다.
    naiToken: raw.naiToken === undefined || raw.naiToken === '' ? base.naiToken : String(raw.naiToken).trim(),
    naiModel: String(raw.naiModel ?? base.naiModel),
    naiWidth: Number(raw.naiWidth ?? base.naiWidth),
    naiHeight: Number(raw.naiHeight ?? base.naiHeight),
    naiSteps: Number(raw.naiSteps ?? base.naiSteps),
    naiScale: Number(raw.naiScale ?? base.naiScale),
    naiSampler: String(raw.naiSampler ?? base.naiSampler),
    naiNoiseSchedule: String(raw.naiNoiseSchedule ?? base.naiNoiseSchedule),
    naiCommonPrompt: String(raw.naiCommonPrompt ?? base.naiCommonPrompt),
    naiArtistPrompt: String(raw.naiArtistPrompt ?? base.naiArtistPrompt),
    naiNegativePrompt: String(raw.naiNegativePrompt ?? base.naiNegativePrompt),
    animaSaveToIllustrious: typeof raw.animaSaveToIllustrious === 'boolean' ? raw.animaSaveToIllustrious : base.animaSaveToIllustrious,
    comfyUrl: String(raw.comfyUrl || base.comfyUrl).trim().replace(/\/+$/, ''),
    promptBatchSize: normalizePromptBatchSize(raw.promptBatchSize, base.promptBatchSize),
    modelsDirectory,
    sdxlCheckpoint: String(raw.sdxlCheckpoint || base.sdxlCheckpoint).trim(),
    sdxlLora: String(raw.sdxlLora ?? base.sdxlLora).trim(),
    sdxlLoraStrength: finiteNumber(raw.sdxlLoraStrength, base.sdxlLoraStrength, -20, 20),
    sdxlSteps: Math.round(finiteNumber(raw.sdxlSteps, base.sdxlSteps, 1, 150)),
    sdxlCfg: finiteNumber(raw.sdxlCfg, base.sdxlCfg, 0, 100),
    sdxlSampler: String(raw.sdxlSampler || base.sdxlSampler).trim(),
    sdxlScheduler: String(raw.sdxlScheduler || base.sdxlScheduler).trim(),
    sdxlClipSkip: Math.round(finiteNumber(raw.sdxlClipSkip, base.sdxlClipSkip, -24, 0)),
    sdxlWidth: sdxl_normalizeDimension(raw.sdxlWidth, base.sdxlWidth),
    sdxlHeight: sdxl_normalizeDimension(raw.sdxlHeight, base.sdxlHeight),
    sdxlPositivePrompt: String(raw.sdxlPositivePrompt || ''),
    sdxlNegativePrompt: String(raw.sdxlNegativePrompt || ''),
    model: String(raw.model || base.model).trim(),
    clip: String(raw.clip || base.clip).trim(),
    clipDevice: raw.clipDevice === 'default' ? 'default' : 'cpu',
    vae: String(raw.vae || base.vae).trim(),
    loraDirectory,
    width,
    height,
    steps: Math.round(finiteNumber(raw.steps, base.steps, 1, 150)),
    cfg: finiteNumber(raw.cfg, base.cfg, 0, 100),
    sampler: String(raw.sampler || base.sampler).trim(),
    scheduler: String(raw.scheduler || base.scheduler).trim(),
    positivePrompt: String(raw.positivePrompt || ''),
    negativePrompt: String(raw.negativePrompt || ''),
    loras: Array.isArray(raw.loras)
      ? raw.loras.filter(item => item && item.name).map(item => ({
          name: selectedIsComfyRoot ? String(item.name).trim().replace(/^loras[\\/]/i, '') : String(item.name).trim(), enabled: item.enabled === true,
          strength: finiteNumber(item.strength, 1, -20, 20),
        }))
      : base.loras,
    characters: mergedCharacters,
  }
}

function load(config: Config): GenerationSettings {
  const base = defaults(config)
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(config), 'utf8')) as Partial<GenerationSettings>
    return clean(saved, base)
  } catch {
    return base
  }
}

function applyRuntime(config: Config, comfy: ComfyClient, settings: GenerationSettings): void {
  config.imageProvider = settings.imageProvider
  config.fluxWorkerUrl = settings.fluxWorkerUrl
  config.naiToken = settings.naiToken
  config.naiModel = settings.naiModel
  config.naiWidth = settings.naiWidth
  config.naiHeight = settings.naiHeight
  config.naiSteps = settings.naiSteps
  config.naiScale = settings.naiScale
  config.naiSampler = settings.naiSampler
  config.naiNoiseSchedule = settings.naiNoiseSchedule
  config.naiCommonPrompt = settings.naiCommonPrompt
  config.naiArtistPrompt = settings.naiArtistPrompt
  config.naiNegativePrompt = settings.naiNegativePrompt
  config.animaSaveToIllustrious = settings.animaSaveToIllustrious
  config.comfyUrl = settings.comfyUrl
  config.promptBatchSize = settings.promptBatchSize
  comfy.setBaseUrl(settings.comfyUrl)
  config.checkpoint = settings.sdxlCheckpoint
  config.lora = settings.sdxlLora
  config.loraStrength = settings.sdxlLoraStrength
  config.characterLoras = Object.fromEntries(settings.characters.map(character => [character.id, ImageStudio_아내LoRA정리하기(character)]))
  config.steps = settings.sdxlSteps
  config.cfg = settings.sdxlCfg
  config.sampler = settings.sdxlSampler
  config.scheduler = settings.sdxlScheduler
  config.clipSkip = settings.sdxlClipSkip
  config.sdxlWidth = settings.sdxlWidth
  config.sdxlHeight = settings.sdxlHeight
  config.sdxlPositivePrompt = settings.sdxlPositivePrompt
  config.sdxlNegativePrompt = settings.sdxlNegativePrompt
  config.animaUnetDir = settings.modelsDirectory ? path.join(settings.modelsDirectory, 'diffusion_models') : ''
  config.animaUnet = settings.model
  config.animaClip = settings.clip
  config.animaClipDevice = settings.clipDevice
  config.animaVae = settings.vae
  config.animaLoraDir = settings.loraDirectory || (settings.modelsDirectory ? path.join(settings.modelsDirectory, 'loras') : '')
  config.animaWidth = settings.width
  config.animaHeight = settings.height
  config.animaSteps = settings.steps
  config.animaCfg = settings.cfg
  config.animaSampler = settings.sampler
  config.animaScheduler = settings.scheduler
  config.animaCommonPrompt = settings.positivePrompt
  config.animaNegativePrompt = settings.negativePrompt

  const comfyLoraRoot = settings.modelsDirectory ? path.resolve(settings.modelsDirectory, 'loras') : ''
  const selectedLoraRoot = config.animaLoraDir ? path.resolve(config.animaLoraDir) : ''
  const selectedIsComfyRoot = Boolean(comfyLoraRoot && selectedLoraRoot && comfyLoraRoot.toLowerCase() === selectedLoraRoot.toLowerCase())
  config.animaLoras = settings.loras.map(lora => ({
    ...lora,
    // EasyGen v1.2 could persist "loras\\file" while the selected root was
    // already <models>/loras. ComfyUI expects only the path below that root.
    name: selectedIsComfyRoot ? lora.name.replace(/^loras[\\/]/i, '') : lora.name,
  }))
  const discoveredCharacterDirs = settings.characters
    .map(character => String(character.id || '').trim().toLowerCase())
    .filter(id => /^[a-z0-9][a-z0-9_-]{0,99}$/.test(id))
  config.characterDirs = [...new Set([...(config.characterDirs || []), ...discoveredCharacterDirs])]
  config.animaCharacterPrompts = Object.fromEntries(settings.characters.map(character => {
    const original = ORIGINAL_CHARACTERS.find(item => item.id === character.id)
    return [character.id, {
      prompt: character.prompt,
      negativePrompt: character.negativePrompt,
      originalPrompt: character.originalPrompt || original?.prompt || character.prompt,
      originalNegativePrompt: character.originalNegativePrompt || original?.negativePrompt || '',
    }]
  }))
}

function save(config: Config, comfy: ComfyClient, settings: GenerationSettings): void {
  fs.mkdirSync(config.stateDir, { recursive: true })
  // NovelAI credentials are supplied by the launcher from Android Keystore.
  // Keep the active token in memory, but never persist it in this JSON file.
  const persistedSettings = { ...settings, naiToken: '' }
  fs.writeFileSync(settingsFile(config), JSON.stringify(persistedSettings, null, 2) + '\n')
  applyRuntime(config, comfy, settings)
}

function scanModelFiles(directory: string, extensions = ['.safetensors']): string[] {
  const files: string[] = []
  const allowed = new Set(extensions.map(extension => extension.toLowerCase()))
  const visit = (folder: string, relative = ''): void => {
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      const childRelative = relative ? path.join(relative, item.name) : item.name
      const childPath = path.join(folder, item.name)
      if (item.isDirectory()) visit(childPath, childRelative)
      else if (item.isFile() && allowed.has(path.extname(item.name).toLowerCase())) files.push(childRelative.replace(/\//g, '\\'))
    }
  }
  try { if (directory) visit(directory) } catch { /* an empty list explains a missing folder */ }
  return files.sort((a, b) => a.localeCompare(b))
}

async function comfyModelFiles(comfyUrl: string, folder: string, extensions = ['.safetensors']): Promise<string[]> {
  try {
    const response = await fetch(`${comfyUrl}/models/${folder}`, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) return []
    const names = await response.json() as unknown
    if (!Array.isArray(names)) return []
    const allowed = extensions.map(extension => extension.toLowerCase())
    return names.filter((name): name is string => typeof name === 'string' && allowed.some(extension => name.toLowerCase().endsWith(extension)))
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

export function loadGenerationSettings(config: Config, comfy: ComfyClient): GenerationSettings {
  const settings = load(config)
  applyRuntime(config, comfy, settings)
  return settings
}

export function registerGenerationSettingsRoutes(router: Router, config: Config, comfy: ComfyClient): void {
  router.get('/api/generation/settings', ctx => sendJson(ctx.res, 200, NovelAI_공개설정만들기(load(config))))

  router.get('/api/generation/capabilities', async ctx => {
    const settings = load(config)
    const naiOnly = [
      'naiToken', 'naiModel', 'naiWidth', 'naiHeight', 'naiSteps', 'naiScale',
      'naiSampler', 'naiNoiseSchedule', 'naiCommonPrompt', 'naiArtistPrompt', 'naiNegativePrompt',
    ]
    const comfyOnly = [
      'sdxlCheckpoint', 'sdxlLora', 'sdxlLoraStrength', 'sdxlSteps', 'sdxlCfg',
      'sdxlSampler', 'sdxlScheduler', 'sdxlClipSkip', 'sdxlWidth', 'sdxlHeight',
      'sdxlPositivePrompt', 'sdxlNegativePrompt', 'model', 'clip', 'clipDevice',
      'vae', 'loraDirectory', 'width', 'height', 'steps', 'cfg', 'sampler',
      'scheduler', 'positivePrompt', 'negativePrompt', 'loras', 'modelsDirectory',
      'animaLoraMode', 'animaLoras', 'sdxlLoraMode', 'sdxlLoras',
      'animaSaveToIllustrious', 'promptBatchSize',
    ]
    if (settings.imageProvider === 'nai') {
      sendJson(ctx.res, 200, {
        provider: 'nai', providerLabel: 'NAI', unsupportedLabel: 'NAI 미지원',
        unsupportedSettings: comfyOnly, ready: Boolean(settings.naiToken),
      })
      return
    }
    if (settings.imageProvider === 'flux') {
      let ready = false
      try {
        const response = await fetch(settings.fluxWorkerUrl, {
          method: 'OPTIONS',
          signal: AbortSignal.timeout(1500),
        })
        ready = response.ok
      } catch { /* worker unavailable */ }
      sendJson(ctx.res, ready ? 200 : 503, {
        provider: 'flux', providerLabel: 'Cloudflare FLUX', unsupportedLabel: 'FLUX 미지원',
        unsupportedSettings: comfyOnly, ready,
      })
      return
    }

    const info = await comfy.objectInfo()
    const unsupported = [...naiOnly]
    const hasInput = (nodeName: string, inputName: string): boolean => {
      const node = info?.[nodeName] as { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } } | undefined
      return Boolean(node?.input?.required?.[inputName] || node?.input?.optional?.[inputName])
    }
    const hasNode = (nodeName: string): boolean => Boolean(info?.[nodeName])
    const workflow = settings.imageProvider === 'anima' ? 'anima' : 'illustrious'
    if (workflow === 'anima') {
      if (!hasInput('UNETLoader', 'unet_name')) unsupported.push('model')
      if (!hasInput('CLIPLoader', 'clip_name')) unsupported.push('clip')
      if (!hasInput('VAELoader', 'vae_name')) unsupported.push('vae')
      if (!hasInput('KSampler', 'sampler_name')) unsupported.push('sampler')
      if (!hasInput('KSampler', 'scheduler')) unsupported.push('scheduler')
      if (settings.clipDevice !== 'default' && !hasInput('CLIPLoader', 'device')) unsupported.push('clipDevice')
      if (settings.loras.some(item => item.enabled && item.strength !== 0) && !hasNode('LoraLoaderModelOnly')) unsupported.push('loras')
    } else {
      if (!hasInput('CheckpointLoaderSimple', 'ckpt_name')) unsupported.push('sdxlCheckpoint')
      if (!hasInput('KSampler', 'sampler_name')) unsupported.push('sdxlSampler')
      if (!hasInput('KSampler', 'scheduler')) unsupported.push('sdxlScheduler')
      if (settings.sdxlClipSkip !== 0 && !hasInput('CLIPSetLastLayer', 'stop_at_clip_layer')) unsupported.push('sdxlClipSkip')
      const hasCharacterLora = settings.characters.some(character =>
        character.sdxlLoras?.some(item => item.enabled && item.strength !== 0))
      if ((settings.sdxlLora || hasCharacterLora) && !hasNode('LoraLoader')) unsupported.push('sdxlLora')
    }
    sendJson(ctx.res, 200, {
      provider: 'comfy', providerLabel: 'Comfy', unsupportedLabel: 'Comfy 미지원',
      unsupportedSettings: [...new Set(unsupported)], ready: Boolean(info), workflow,
    })
  })
  router.post('/api/nai/check', async ctx => {
    try { sendJson(ctx.res, 200, await NovelAI_연결확인하기(config)) }
    catch (error) { throw new HttpError(502, (error as Error).message) }
  })

  router.get('/api/generation/prompt-batch-support', async ctx => {
    const url = ctx.query.get('comfyUrl')?.trim() || config.comfyUrl
    const info = await new ComfyClient(url).objectInfo()
    sendJson(ctx.res, 200, { reachable: info !== null, supported: Boolean(info?.[PROMPT_BATCH_NODE]), maxPrompts: MAX_PROMPT_BATCH_SIZE })
  })

  router.get('/api/generation/resources', async ctx => {
    const settings = load(config)
    const root = ctx.query.get('modelsDirectory')?.trim() || settings.modelsDirectory
    const comfyUrl = (ctx.query.get('comfyUrl')?.trim() || settings.comfyUrl).replace(/\/+$/, '')
    const local = {
      checkpoints: scanModelFiles(root ? path.join(root, 'checkpoints') : ''),
      loras: scanModelFiles(root ? path.join(root, 'loras') : ''),
      diffusionModels: scanModelFiles(root ? path.join(root, 'diffusion_models') : ''),
      textEncoders: scanModelFiles(root ? path.join(root, 'text_encoders') : '', ['.safetensors', '.gguf']),
      vaes: scanModelFiles(root ? path.join(root, 'vae') : ''),
    }
    const useRemote = !Object.values(local).some(list => list.length)
    const remote = useRemote ? await Promise.all([
      comfyModelFiles(comfyUrl, 'checkpoints'),
      comfyModelFiles(comfyUrl, 'loras'),
      comfyModelFiles(comfyUrl, 'diffusion_models'),
      comfyModelFiles(comfyUrl, 'text_encoders', ['.safetensors', '.gguf']),
      comfyModelFiles(comfyUrl, 'vae'),
    ]) : null
    sendJson(ctx.res, 200, {
      source: remote ? 'comfyui' : 'folder',
      comfyUrl,
      modelsDirectory: root,
      checkpoints: remote?.[0] ?? local.checkpoints,
      loras: remote?.[1] ?? local.loras,
      diffusionModels: remote?.[2] ?? local.diffusionModels,
      textEncoders: remote?.[3] ?? local.textEncoders,
      vaes: remote?.[4] ?? local.vaes,
    })
  })

  router.add('POST', '/api/generation/select-models-folder', ctx => {
    if (process.platform !== 'win32') throw new HttpError(501, '폴더 선택 창은 Windows에서만 지원됩니다.')
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$dialog.Description = 'ComfyUI의 models 폴더를 선택하세요'",
      '$dialog.ShowNewFolderButton = $false',
      "if ($dialog.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $dialog.SelectedPath }",
    ].join('; ')
    const selected = execFileSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { encoding: 'utf8', windowsHide: false }).trim()
    if (!selected) { sendJson(ctx.res, 200, { cancelled: true }); return }
    const directory = path.resolve(selected)
    if (!fs.statSync(directory).isDirectory()) throw new HttpError(400, '선택한 경로가 폴더가 아닙니다.')
    if (!['checkpoints', 'diffusion_models', 'loras', 'text_encoders', 'vae'].some(name => fs.existsSync(path.join(directory, name)))) {
      throw new HttpError(400, 'ComfyUI의 models 폴더를 선택해 주세요.')
    }
    sendJson(ctx.res, 200, { cancelled: false, modelsDirectory: directory })
  })

  function discoverCharacter(settings: GenerationSettings, raw: Partial<CharacterPrompt>) {
    const incoming = cleanCharacter(raw)
    if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(incoming.id)) throw new HttpError(400, 'invalid character id')
    const existing = settings.characters.find(character => character.id === incoming.id)
    if (existing) {
      if (incoming.name && existing.name === existing.id) existing.name = incoming.name
      if (!existing.originalPrompt && incoming.originalPrompt) existing.originalPrompt = incoming.originalPrompt
      if (!existing.originalNegativePrompt && incoming.originalNegativePrompt) existing.originalNegativePrompt = incoming.originalNegativePrompt
    } else {
      settings.characters.push(incoming)
    }
    return { added: !existing, character: existing ?? incoming }
  }
  router.post('/api/generation/characters/discover-batch', async ctx => {
    const body = await readJson<{ characters?: Partial<CharacterPrompt>[] }>(ctx.req, 2 * 1024 * 1024)
    if (!Array.isArray(body.characters) || body.characters.length > 200 || body.characters.some(item => !item || typeof item !== 'object')) {
      throw new HttpError(400, 'characters must contain at most 200 character objects')
    }
    const settings = load(config)
    const results = body.characters.map(character => discoverCharacter(settings, character))
    if (results.length) save(config, comfy, settings)
    sendJson(ctx.res, 200, { results })
  })
  router.post('/api/generation/characters/discover', async ctx => {
    const incoming = await readJson<Partial<CharacterPrompt>>(ctx.req, 128 * 1024)
    const settings = load(config)
    const result = discoverCharacter(settings, incoming)
    save(config, comfy, settings)
    sendJson(ctx.res, 200, result)
  })

  router.add('PUT', '/api/generation/settings', async ctx => {
    const raw = await readJson<Partial<GenerationSettings> & { naiTokenClear?: boolean }>(ctx.req, 2 * 1024 * 1024)
    const settings = clean(raw, load(config))
    if (raw.naiTokenClear === true) settings.naiToken = ''
    NovelAI_설정검사하기(settings)
    save(config, comfy, settings)
    sendJson(ctx.res, 200, { saved: true, settings: NovelAI_공개설정만들기(settings) })
  })
}

/** 응답에는 토큰 대신 설정 유무만 보냅니다. 다른 생성 방식으로 저장해도 토큰을 유지합니다. */
function NovelAI_공개설정만들기(settings: GenerationSettings) {
  const { naiToken, ...publicSettings } = settings
  return { ...publicSettings, naiTokenConfigured: Boolean(naiToken), naiModels: NAI_MODELS, naiSamplers: NAI_SAMPLERS, naiNoiseSchedules: NAI_SCHEDULES }
}

/** NAI 값은 임의로 반올림하거나 보정하지 않고 저장 시점에 알려 줍니다. */
function NovelAI_설정검사하기(settings: GenerationSettings): void {
  if (!NAI_MODELS.includes(settings.naiModel)) throw new HttpError(400, '지원하는 NovelAI 모델을 선택하세요.')
  if (!NAI_SAMPLERS.includes(settings.naiSampler) || !NAI_SCHEDULES.includes(settings.naiNoiseSchedule))
    throw new HttpError(400, '지원하는 NovelAI 샘플러와 노이즈 스케줄을 선택하세요.')
  if (![settings.naiWidth, settings.naiHeight].every(value => Number.isInteger(value) && value >= 64 && value <= 2048 && value % 64 === 0)
    || settings.naiWidth * settings.naiHeight > 3_145_728) throw new HttpError(400, 'NAI 크기는 64~2048px의 64 배수이며 총 3,145,728픽셀 이하여야 합니다.')
  if (!Number.isInteger(settings.naiSteps) || settings.naiSteps < 1 || settings.naiSteps > 50
    || !Number.isFinite(settings.naiScale) || settings.naiScale < 0 || settings.naiScale > 10) throw new HttpError(400, 'NAI Steps는 1~50 정수, Guidance는 0~10입니다.')
  if (settings.imageProvider === 'nai' && !settings.naiToken) throw new HttpError(400, 'NovelAI API 토큰을 입력하세요.')
  if (settings.imageProvider === 'flux') {
    try {
      const endpoint = new URL(settings.fluxWorkerUrl)
      if (endpoint.protocol !== 'https:' || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
        throw new Error('invalid endpoint')
    } catch {
      throw new HttpError(400, 'Cloudflare FLUX Worker HTTPS 주소를 입력하세요.')
    }
  }
}
