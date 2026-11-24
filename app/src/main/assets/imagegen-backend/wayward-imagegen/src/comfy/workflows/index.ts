/**
 * ComfyUI graph builders.
 *
 * A "workflow" here is a recipe for turning a prompt pair into the node graph
 * ComfyUI's `/prompt` endpoint accepts. The game never sees these — it sends
 * prompt text and the server decides how to render it — which is exactly why
 * a player can point this at a different checkpoint or sampler without the
 * game knowing or caring.
 *
 * These graphs are behaviour-frozen against `test/fixtures/*.json`. A field
 * that changes renders a different picture into a cache cell the game treats
 * as authoritative, so the fixtures are byte-compared rather than eyeballed.
 */

import type { Config, WorkflowType, AnimaLoraSetting } from '../../config.ts'
import { MAX_PROMPT_BATCH_SIZE, sdxl_normalizeDimension } from '../../config.ts'

export interface GenOverrides {
  sampler?: string
  noiseSchedule?: string
  seed?: number
  steps?: number
  cfg?: number
  loraStrength?: number
  checkpoint?: string
  dimensions?: string
  width?: number
  height?: number
  loras?: AnimaLoraSetting[]
  img2imgSource?: string
  denoise?: number
}

/** Node-graph shape as ComfyUI's API expects it. */
export type ComfyGraph = Record<string, object>

export const PROMPT_BATCH_NODE = 'ImageStudioMultiPrompt'
export const promptBatchOutputNode = (index: number): string => `wwis_batch_save_${index}`

export interface PromptBatchInput {
  prompt: string
  negativePrompt: string
  workflow: WorkflowType
  filenamePrefix: string
  seed?: number
  overrides?: GenOverrides
}

/** Compare the actual model/LoRA/sampler/size graph, excluding prompt and noise. */
export function promptBatchSignature(config: Config, input: Omit<PromptBatchInput, 'filenamePrefix'>): string {
  return JSON.stringify(buildComfyPrompt(config, '', '', '', input.workflow, 0, input.overrides))
}

export function buildMultiPromptComfyPrompt(config: Config, inputs: PromptBatchInput[]): ComfyGraph {
  if (inputs.length < 2 || inputs.length > MAX_PROMPT_BATCH_SIZE) throw new Error(`prompt batch must contain 2–${MAX_PROMPT_BATCH_SIZE} distinct requests`)
  const first = inputs[0]!
  if (first.workflow !== 'anima' && first.workflow !== 'illustrious') throw new Error('multi-prompt batch supports Anima and SDXL only')
  const signature = promptBatchSignature(config, first)
  if (inputs.some(input => input.workflow !== first.workflow || input.seed !== first.seed || promptBatchSignature(config, input) !== signature)) {
    throw new Error('prompt batch requires the same model, LoRAs, sampler and image size')
  }
  const graph = buildComfyPrompt(config, first.prompt, first.negativePrompt, first.filenamePrefix, first.workflow, first.seed, first.overrides)
  const anima = first.workflow === 'anima'
  const sampler = graph[anima ? '97' : '158'] as { inputs: Record<string, unknown> }
  const latent = graph[anima ? '95' : '1457'] as { inputs: Record<string, unknown> }
  graph['wwis_prompt_batch'] = { class_type: PROMPT_BATCH_NODE, inputs: {
    model: sampler.inputs.model, clip: anima ? ['92', 0] : sampler.inputs.clip,
    prompts_json: JSON.stringify(inputs.map(input => ({ positive: input.prompt, negative: input.negativePrompt }))),
  } }
  sampler.inputs.model = ['wwis_prompt_batch', 0]
  sampler.inputs.positive = ['wwis_prompt_batch', 1]
  sampler.inputs.negative = ['wwis_prompt_batch', 2]
  latent.inputs.batch_size = inputs.length
  for (const id of anima ? ['46', '96', '98'] : ['1441', '522', '1440']) delete graph[id]
  for (const [index, input] of inputs.entries()) {
    const split = `wwis_batch_image_${index}`
    graph[split] = { class_type: 'ImageFromBatch', inputs: { image: [anima ? '94' : '1291', 0], batch_index: index, length: 1 } }
    graph[promptBatchOutputNode(index)] = { class_type: 'SaveImage', inputs: { filename_prefix: input.filenamePrefix, images: [split, 0] } }
  }
  return graph
}

/**
 * z-image is fully pinned rather than configurable: it is a second backend
 * kept around for comparison, and nothing in the shipped game selects it.
 * Promote fields to `Config` if that changes.
 */
const Z_IMAGE = {
  unet: 'zit\\moodyPornMix_zitV6.safetensors',
  clip: 'qwen_3_4b.safetensors',
  clipType: 'lumina2',
  vae: 'ae.safetensors',
  steps: 9,
  cfg: 1,
  sampler: 'dpmpp_2m_sde',
  scheduler: 'beta',
  defaultDimensions: '1024 x 1024 (1:1)',
} as const

/** IP-Adapter FaceID settings. Dormant unless a reference image is supplied. */
const FACE_ID = {
  preset: 'FACEID',
  loraStrength: 0.4,
  weight: 2,
  weightV2: 2,
} as const

function randomSeed(): number {
  return Math.floor(Math.random() * 1000000000000000)
}

/** Dispatch to the workflow-specific builder. */
export function buildComfyPrompt(
  cfg: Config,
  textPrompt: string,
  negativePrompt: string,
  filenamePrefix: string,
  workflowType: WorkflowType = 'z-image',
  seed?: number,
  overrides?: GenOverrides,
  referenceImagePath?: string,
): ComfyGraph {
  if (workflowType === 'anima') {
    return buildAnimaPrompt(cfg, textPrompt, negativePrompt, filenamePrefix, seed, overrides)
  }
  if (workflowType === 'illustrious') {
    return buildIllustriousPrompt(cfg, textPrompt, negativePrompt, filenamePrefix, seed, overrides, referenceImagePath)
  }
  return buildZImagePrompt(textPrompt, filenamePrefix, seed, overrides)
}

/**
 * Anima/Qwen workflow. It intentionally uses UNETLoader + a separate text
 * encoder and VAE; loading an Anima file through SDXL's checkpoint node is not
 * equivalent and is the reason the previous model-name-only setup failed.
 */
export function buildAnimaPrompt(
  config: Config,
  textPrompt: string,
  negativePrompt: string,
  filenamePrefix: string,
  seed?: number,
  overrides?: GenOverrides,
): ComfyGraph {
  const actualSeed = seed ?? randomSeed()
  const width = Math.max(64, Math.round((overrides?.width ?? config.animaWidth) / 16) * 16)
  const height = Math.max(64, Math.round((overrides?.height ?? config.animaHeight) / 16) * 16)
  const loras = overrides?.loras ?? config.animaLoras
  const usesGgufTextEncoder = config.animaClip.toLowerCase().endsWith('.gguf')

  const nodes: ComfyGraph = {
    '46': { inputs: { filename_prefix: filenamePrefix, images: ['94', 0] }, class_type: 'SaveImage', _meta: { title: '이미지 저장' } },
    '92': usesGgufTextEncoder
      ? { inputs: { clip_name: config.animaClip, type: 'stable_diffusion' }, class_type: 'CLIPLoaderGGUF', _meta: { title: 'GGUF CLIP 로드' } }
      : { inputs: { clip_name: config.animaClip, type: 'stable_diffusion', device: config.animaClipDevice }, class_type: 'CLIPLoader', _meta: { title: 'CLIP 로드' } },
    '93': { inputs: { vae_name: config.animaVae }, class_type: 'VAELoader', _meta: { title: 'VAE 로드' } },
    '94': { inputs: { samples: ['97', 0], vae: ['93', 0] }, class_type: 'VAEDecode', _meta: { title: 'VAE 디코드' } },
    '95': { inputs: { width, height, batch_size: 1 }, class_type: 'EmptyLatentImage', _meta: { title: '빈 잠재 이미지' } },
    '96': { inputs: { text: negativePrompt, clip: ['92', 0] }, class_type: 'CLIPTextEncode', _meta: { title: 'Negative Prompt' } },
    '98': { inputs: { text: textPrompt, clip: ['92', 0] }, class_type: 'CLIPTextEncode', _meta: { title: 'Positive Prompt' } },
    '99': { inputs: { unet_name: config.animaUnet, weight_dtype: 'default' }, class_type: 'UNETLoader', _meta: { title: 'Anima 모델 로드' } },
  }

  let modelOutput: [string, number] = ['99', 0]
  let nextNode = 200
  for (const lora of loras) {
    if (!lora.enabled || !lora.name || !Number.isFinite(lora.strength)) continue
    const id = String(nextNode++)
    nodes[id] = {
      inputs: { lora_name: lora.name, strength_model: lora.strength, model: modelOutput },
      class_type: 'LoraLoaderModelOnly',
      _meta: { title: `LoRA: ${lora.name}` },
    }
    modelOutput = [id, 0]
  }

  nodes['97'] = {
    inputs: {
      seed: actualSeed,
      steps: config.animaSteps,
      cfg: config.animaCfg,
      sampler_name: config.animaSampler,
      scheduler: config.animaScheduler,
      denoise: 1,
      model: modelOutput,
      positive: ['98', 0],
      negative: ['96', 0],
      latent_image: ['95', 0],
    },
    class_type: 'KSampler',
    _meta: { title: 'KSampler' },
  }
  return nodes
}

/**
 * z-image workflow. Note the negative prompt is deliberately unused — this
 * workflow zeroes the negative conditioning (node 42) instead of encoding it.
 */
export function buildZImagePrompt(
  textPrompt: string,
  filenamePrefix: string,
  seed?: number,
  overrides?: Pick<GenOverrides, 'steps' | 'cfg'>,
): ComfyGraph {
  const actualSeed = seed ?? randomSeed()
  const steps = overrides?.steps ?? Z_IMAGE.steps
  const cfg = overrides?.cfg ?? Z_IMAGE.cfg

  return {
    '39': {
      inputs: { clip_name: Z_IMAGE.clip, type: Z_IMAGE.clipType },
      class_type: 'CLIPLoader',
      _meta: { title: 'Load CLIP' },
    },
    '40': {
      inputs: { vae_name: Z_IMAGE.vae },
      class_type: 'VAELoader',
      _meta: { title: 'Load VAE' },
    },
    '45': {
      inputs: { text: textPrompt, clip: ['39', 0] },
      class_type: 'CLIPTextEncode',
      _meta: { title: 'CLIP Text Encode (Prompt)' },
    },
    '61': {
      inputs: { dimensions: Z_IMAGE.defaultDimensions, invert: false, batch_size: 1 },
      class_type: 'EmptyLatentImagePresets',
      _meta: { title: 'Empty Latent Image Presets' },
    },
    '43': {
      inputs: { samples: ['44', 0], vae: ['40', 0] },
      class_type: 'VAEDecode',
      _meta: { title: 'VAE Decode' },
    },
    '9': {
      inputs: { filename_prefix: filenamePrefix, images: ['43', 0] },
      class_type: 'SaveImage',
      _meta: { title: 'Save Image' },
    },
    '62': {
      inputs: { unet_name: Z_IMAGE.unet, weight_dtype: 'default' },
      class_type: 'UNETLoader',
      _meta: { title: 'Load Diffusion Model' },
    },
    '47': {
      inputs: { shift: 1, model: ['62', 0] },
      class_type: 'ModelSamplingAuraFlow',
      _meta: { title: 'ModelSamplingAuraFlow' },
    },
    '42': {
      inputs: { conditioning: ['45', 0] },
      class_type: 'ConditioningZeroOut',
      _meta: { title: 'Conditioning Zero Out' },
    },
    '44': {
      inputs: {
        seed: actualSeed,
        steps,
        cfg,
        sampler_name: Z_IMAGE.sampler,
        scheduler: Z_IMAGE.scheduler,
        denoise: 1,
        model: ['47', 0],
        positive: ['45', 0],
        negative: ['42', 0],
        latent_image: ['61', 0],
      },
      class_type: 'KSampler',
      _meta: { title: 'KSampler' },
    },
  }
}

/**
 * Illustrious XL — the workflow the game actually ships against.
 *
 * The model chain is assembled by rebinding `modelOutput` as optional stages
 * are added (FaceID, then the speed LoRA), so the graph stays valid whether
 * either is present.
 */
export function buildIllustriousPrompt(
  config: Config,
  textPrompt: string,
  negativePrompt: string,
  filenamePrefix: string,
  seed?: number,
  overrides?: GenOverrides,
  referenceImagePath?: string,
): ComfyGraph {
  const actualSeed = seed ?? randomSeed()

  const steps = overrides?.steps ?? config.steps
  const cfg = overrides?.cfg ?? config.cfg
  const loraStrength = overrides?.loraStrength ?? config.loraStrength ?? 1
  const checkpoint = overrides?.checkpoint?.trim() || config.checkpoint

  const nodes: ComfyGraph = {
    '1407': {
      inputs: { ckpt_name: checkpoint },
      class_type: 'CheckpointLoaderSimple',
      _meta: { title: 'Load Checkpoint' },
    },
    '15': {
      inputs: { stop_at_clip_layer: config.clipSkip ?? -2, clip: ['1407', 1] },
      class_type: 'CLIPSetLastLayer',
      _meta: { title: 'Clip Skip' },
    },
    '522': {
      inputs: { text: textPrompt, clip: ['15', 0] },
      class_type: 'CLIPTextEncode',
      _meta: { title: 'Style' },
    },
    '1440': {
      inputs: { text: negativePrompt, clip: ['15', 0] },
      class_type: 'CLIPTextEncode',
      _meta: { title: 'Negative' },
    },
    '1457': overrides?.dimensions && overrides.width === undefined && overrides.height === undefined
      ? {
          inputs: { dimensions: overrides.dimensions, invert: true, batch_size: 1 },
          class_type: 'EmptyLatentImagePresets',
          _meta: { title: 'Empty Latent Image Presets' },
        }
      : {
          inputs: {
            width: sdxl_normalizeDimension(overrides?.width, config.sdxlWidth),
            height: sdxl_normalizeDimension(overrides?.height, config.sdxlHeight),
            batch_size: 1,
          },
          class_type: 'EmptyLatentImage',
          _meta: { title: 'SDXL image size' },
        },
    '1458': {
      inputs: {
        value: actualSeed,
        mode: true,
        action: 'increment',
        last_seed: String(actualSeed - 1),
      },
      class_type: 'GlobalSeed //Inspire',
      _meta: { title: 'GlobalSeed //Inspire' },
    },
    '1291': {
      inputs: { samples: ['1536', 1], vae: ['1536', 2] },
      class_type: 'VAEDecode',
      _meta: { title: 'VAE Decode' },
    },
    '1441': {
      inputs: { filename_prefix: filenamePrefix, images: ['1291', 0] },
      class_type: 'SaveImage',
      _meta: { title: 'Save Image' },
    },
  }

  let modelOutput: [string, number] = ['1407', 0]

  if (referenceImagePath) {
    nodes['1541'] = {
      inputs: { image: referenceImagePath, upload: 'image' },
      class_type: 'LoadImage',
      _meta: { title: 'Load Image' },
    }
    nodes['1539'] = {
      inputs: {
        preset: FACE_ID.preset,
        lora_strength: FACE_ID.loraStrength,
        provider: 'CPU',
        model: ['1407', 0],
      },
      class_type: 'IPAdapterUnifiedLoaderFaceID',
      _meta: { title: 'IPAdapterUnifiedLoaderFaceID' },
    }
    nodes['1540'] = {
      inputs: {
        weight: FACE_ID.weight,
        weight_faceidv2: FACE_ID.weightV2,
        weight_type: 'ease in',
        combine_embeds: 'concat',
        start_at: 0,
        end_at: 1,
        embeds_scaling: 'V only',
        model: ['1539', 0],
        ipadapter: ['1539', 1],
        image: ['1541', 0],
      },
      class_type: 'IPAdapterFaceID',
      _meta: { title: 'IPAdapterFaceID' },
    }
    modelOutput = ['1540', 0]
  }

  // Speed LoRA. An empty `lora` disables it — the right setting for a
  // checkpoint that already has acceleration baked in.
  if (overrides?.loras !== undefined) {
    let clipOutput: [string, number] = ['1407', 1]
    for (const [index, lora] of overrides.loras.entries()) {
      if (!lora.enabled || !lora.name || lora.strength === 0) continue
      const node = `wife_lora_${index}`
      nodes[node] = { class_type: 'LoraLoader', inputs: { lora_name: lora.name, strength_model: lora.strength,
        strength_clip: lora.strength, model: modelOutput, clip: clipOutput } }
      modelOutput = [node, 0]; clipOutput = [node, 1]
    }
    ;(nodes['15'] as { inputs: { clip: [string, number] } }).inputs.clip = clipOutput
  } else if (config.lora) {
    nodes['1538'] = {
      inputs: {
        lora_name: config.lora,
        strength_model: loraStrength,
        model: modelOutput,
      },
      class_type: 'LoraLoaderModelOnly',
      _meta: { title: 'LoraLoaderModelOnly' },
    }
    modelOutput = ['1538', 0]
  }

  nodes['158'] = {
    inputs: {
      model: modelOutput,
      clip: ['15', 0],
      vae: ['1407', 2],
      positive: ['522', 0],
      negative: ['1440', 0],
    },
    class_type: 'ToBasicPipe',
    _meta: { title: 'ToBasicPipe' },
  }

  nodes['1536'] = {
    inputs: {
      seed: actualSeed,
      steps,
      cfg,
      sampler_name: config.sampler,
      scheduler: config.scheduler,
      denoise: 1,
      basic_pipe: ['158', 0],
      latent_image: ['1457', 0],
    },
    class_type: 'ImpactKSamplerBasicPipe',
    _meta: { title: 'ImpactKSamplerBasicPipe' },
  }

  return nodes
}

/**
 * Wan i2v video. Unlike the image workflows this patches a user-supplied
 * workflow JSON rather than building a graph from scratch, because the node
 * ids are whatever the player's exported workflow used. We only rewrite the
 * inputs we own; everything else is left exactly as they saved it.
 */
export function buildWanVideoPrompt(
  workflowJson: string,
  textPrompt: string,
  negativePrompt: string,
  sourceImagePath: string,
  filenamePrefix: string,
  seed?: number,
): ComfyGraph {
  const actualSeed = seed ?? randomSeed()
  const workflow = JSON.parse(workflowJson) as Record<string, { inputs?: Record<string, unknown> }>

  const patch = (id: string, inputs: Record<string, unknown>): void => {
    const node = workflow[id]
    if (!node) {
      throw new Error(
        `Wan video workflow is missing node "${id}". The bundled workflow expects `
        + `the node ids from ComfyUI_00033_.json; a differently-exported workflow `
        + `needs its ids remapped.`,
      )
    }
    node.inputs = { ...node.inputs, ...inputs }
  }

  patch('241', { image: sourceImagePath })
  patch('207:93', { text: textPrompt })
  patch('207:89', { text: negativePrompt })
  patch('216', { value: actualSeed, mode: true, action: 'fixed', last_seed: actualSeed })
  patch('207:86', { noise_seed: actualSeed, motion_amplitude: 1 })
  patch('207:178', { noise_seed: actualSeed })
  patch('221', { filename_prefix: filenamePrefix })

  return workflow as ComfyGraph
}
