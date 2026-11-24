import type { Config, WorkflowType, AnimaLoraSetting } from './config.ts'

export type CharacterLoraMode = 'inherit' | 'replace' | 'append' | 'none'
export interface CharacterLoraSettings {
  sdxlLoraMode?: CharacterLoraMode
  sdxlLoras?: AnimaLoraSetting[]
  animaLoraMode?: CharacterLoraMode
  animaLoras?: AnimaLoraSetting[]
}

export function ImageStudio_아내LoRA정리하기(raw: CharacterLoraSettings): CharacterLoraSettings {
  const result: CharacterLoraSettings = {}
  for (const engine of ['sdxl', 'anima'] as const) {
    const mode = raw[`${engine}LoraMode`]
    result[`${engine}LoraMode`] = ['replace', 'append', 'none'].includes(mode || '') ? mode : 'inherit'
    const loras = raw[`${engine}Loras`]
    result[`${engine}Loras`] = Array.isArray(loras) ? loras.filter(item => item && typeof item.name === 'string' && item.name.trim()).map(item => ({
      name: item.name.trim().replace(/^loras[\\/]/i, ''), enabled: item.enabled !== false,
      strength: Math.min(20, Math.max(-20, Number.isFinite(Number(item.strength)) ? Number(item.strength) : 1)),
    })) : []
  }
  return result
}

/** Read a registered character from a normal key or H_Status's second segment. */
export function ImageStudio_이미지캐릭터찾기(talentName: string, characterIds: readonly string[]): string | undefined {
  const lower = talentName.toLowerCase()
  const ids = [...characterIds].sort((a, b) => b.length - a.length)
  const subject = /^situation_[a-z0-9_]+__/.test(lower) ? lower.slice(lower.indexOf('__') + 2) : lower
  return ids.find(candidate => subject === candidate || subject.startsWith(candidate + '__')
    || (!/^situation_/.test(lower) && (subject.startsWith(candidate + '-') || subject.startsWith(candidate + '_'))))
}

// undefined means the historical common workflow; [] explicitly disables LoRA.
export function ImageStudio_아내LoRA선택하기(config: Config, talentName: string, workflow: WorkflowType): AnimaLoraSetting[] | undefined {
  if (workflow !== 'illustrious' && workflow !== 'anima') return undefined
  const id = ImageStudio_이미지캐릭터찾기(talentName, Object.keys(config.characterLoras || {}))
  if (!id) return undefined
  const settings = ImageStudio_아내LoRA정리하기(config.characterLoras[id])
  const engine = workflow === 'anima' ? 'anima' : 'sdxl'
  const mode = settings[`${engine}LoraMode`]
  if (mode === 'inherit') return undefined
  if (mode === 'none') return []
  const common = engine === 'anima' ? config.animaLoras : config.lora ? [{ name: config.lora, enabled: true, strength: config.loraStrength }] : []
  const selected = mode === 'append' ? [...common, ...settings[`${engine}Loras`]!] : settings[`${engine}Loras`]!
  // An explicitly repeated filename uses the wife's value rather than stacking twice.
  return [...new Map(selected.filter(item => item.enabled && item.strength !== 0).map(item => [item.name, { ...item }])).values()]
}
