// EasyGen 참고: Wayward_EasyGen_MOD_v3.41_v1.0.15_FINAL.zip의 src/nai/client.ts.
// 공식 API 명세: https://image.novelai.net/docs/doc.json
import { inflateRawSync } from 'node:zlib'
import { randomInt } from 'node:crypto'
import type { Config } from '../config.ts'
import { derivePromptHash } from '../naming.ts'

export const NAI_MODELS = ['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-4-full', 'nai-diffusion-4-curated-preview']
export const NAI_SAMPLERS = ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2m', 'k_dpmpp_2s_ancestral', 'k_dpmpp_sde', 'k_dpm_2', 'ddim_v3']
export const NAI_SCHEDULES = ['karras', 'native', 'exponential', 'polyexponential']
const NAI_ENDPOINT = 'https://image.novelai.net'
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const NAI_MAX_IMAGE_BYTES = 64 * 1024 * 1024

/** 일반 생성과 대기열에 동일한 NAI 프롬프트를 적용합니다. 게임의 인물·장면 태그는 유지합니다. */
export function NovelAI_프롬프트만들기(config: Config, prompt: string, negativePrompt = '') {
  return {
    prompt: [config.naiCommonPrompt, config.naiArtistPrompt, prompt].map(value => value.trim()).filter(Boolean).join(', '),
    negativePrompt: [config.naiNegativePrompt, negativePrompt].map(value => value.trim()).filter(Boolean).join(', '),
  }
}

/** 토큰은 생성 결과의 정체성과 무관하므로 해시에 넣지 않습니다. */
export function NovelAI_생성해시만들기(config: Config, prompt: string, negativePrompt: string, seed?: number): string {
  const parameters = { model: config.naiModel, steps: config.naiSteps, scale: config.naiScale,
    width: config.naiWidth, height: config.naiHeight, sampler: config.naiSampler, noiseSchedule: config.naiNoiseSchedule,
    ...(typeof seed === 'number' && Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff ? { seed } : {}) }
  return derivePromptHash(prompt + '|nai:' + JSON.stringify(parameters), negativePrompt)
}

/** PNG 또는 ZIP의 첫 PNG만 메모리로 읽습니다. 응답의 파일 경로로 디스크에 쓰지 않습니다. */
export function NovelAI_PNG읽기(buffer: Buffer): Buffer {
  if (buffer.length > NAI_MAX_IMAGE_BYTES) throw new Error('NovelAI 이미지 응답이 64MB를 넘습니다.')
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return buffer
  let end = -1
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { end = offset; break }
  }
  if (end < 0) throw new Error('NovelAI 응답에 PNG 또는 올바른 ZIP이 없습니다.')
  const count = buffer.readUInt16LE(end + 10)
  let offset = buffer.readUInt32LE(end + 16)
  for (let index = 0; index < count; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const size = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const next = offset + 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32)
    const local = buffer.readUInt32LE(offset + 42)
    if (next > buffer.length) break
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    if (/\.png$/i.test(name)) {
      if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50 || size > NAI_MAX_IMAGE_BYTES) break
      const data = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
      if (data + compressedSize > buffer.length) break
      const compressed = buffer.subarray(data, data + compressedSize)
      const png = method === 0 ? Buffer.from(compressed) : method === 8
        ? inflateRawSync(compressed, { maxOutputLength: NAI_MAX_IMAGE_BYTES }) : null
      if (!png || png.length !== size || !png.subarray(0, 8).equals(PNG_SIGNATURE)) break
      return png
    }
    offset = next
  }
  throw new Error('NovelAI ZIP에 읽을 수 있는 PNG가 없습니다.')
}

/** 서버 응답에 토큰이 반사되어도 오류·로그·브라우저로 전달하지 않습니다. */
export async function NovelAI_오류읽기(response: Response, token: string): Promise<Error> {
  const text = (await response.text()).split(token).join('[redacted]').slice(0, 500)
  return new Error(`NovelAI API ${response.status}: ${text || response.statusText}`)
}

/** 완성된 프롬프트를 NAI에 한 장씩 전송합니다. 비용이 중복 발생하는 자동 재시도는 하지 않습니다. */
export async function NovelAI_이미지생성하기(config: Config, prompt: string, negativePrompt: string, seed?: number) {
  const token = config.naiToken.trim()
  if (!token) throw new Error('NovelAI API 토큰을 이미지 생성 방식 설정에서 저장하세요.')
  const actualSeed = Number.isInteger(seed) && seed! >= 0 && seed! <= 0xffffffff ? seed! : randomInt(0x100000000)
  const modern = !config.naiModel.endsWith('-3')
  const parameters = {
    params_version: config.naiModel.includes('diffusion-5') ? 4 : 3,
    width: config.naiWidth, height: config.naiHeight, steps: config.naiSteps, scale: config.naiScale,
    sampler: config.naiSampler, noise_schedule: config.naiNoiseSchedule, seed: actualSeed, n_samples: 1,
    negative_prompt: negativePrompt, qualityToggle: true, ucPreset: 0, legacy: false, legacy_v3_extend: false,
    ...(modern ? {
      v4_prompt: { caption: { base_caption: prompt, char_captions: [] }, use_coords: false, use_order: true },
      v4_negative_prompt: { caption: { base_caption: negativePrompt, char_captions: [] }, legacy_uc: false },
    } : {}),
  }
  const response = await fetch(NAI_ENDPOINT + '/ai/generate-image', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/zip' },
    body: JSON.stringify({ input: prompt, model: config.naiModel, action: 'generate', parameters }),
    signal: AbortSignal.timeout(180_000),
  })
  if (!response.ok) throw await NovelAI_오류읽기(response, token)
  let bytes = Buffer.from(await response.arrayBuffer())
  if ((response.headers.get('content-type') || '').includes('json')) {
    const result = JSON.parse(bytes.toString('utf8')) as { images?: { image?: string }[] }
    if (!result.images?.[0]?.image) throw new Error('NovelAI가 이미지 데이터를 반환하지 않았습니다.')
    bytes = Buffer.from(result.images[0].image, 'base64')
  }
  return { bytes: NovelAI_PNG읽기(bytes), seed: actualSeed }
}

/** 생성 비용 없이 저장된 토큰의 구독 조회를 확인합니다. 잔여 이미지 수를 추정하지 않습니다. */
export async function NovelAI_연결확인하기(config: Config) {
  const token = config.naiToken.trim()
  if (!token) throw new Error('NovelAI API 토큰을 먼저 저장하세요.')
  const response = await fetch(NAI_ENDPOINT + '/user/subscription', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw await NovelAI_오류읽기(response, token)
  const subscription = await response.json() as { active?: boolean; tier?: number; trainingStepsLeft?: { fixedTrainingStepsLeft?: number; purchasedTrainingSteps?: number } }
  return { connected: true, active: subscription.active === true, tier: subscription.tier ?? null,
    anlas: subscription.trainingStepsLeft ?? null }
}
