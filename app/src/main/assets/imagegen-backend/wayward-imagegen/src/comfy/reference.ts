// 개별 검수와 대기열이 같은 기준으로 참조 파일과 생성 식별값을 확인합니다.
import fs from 'node:fs'
import path from 'node:path'
import type { Config, WorkflowType } from '../config.ts'
import type { CacheStore, CacheEntry } from '../cache/cacheStore.ts'
import { HttpError } from '../http/router.ts'

export interface ImageStudioReferenceInput { referenceKey?: string; referencePath?: string; denoise?: number }
export interface ImageStudioReference { path: string; identity: string; denoise: number }
export function ImageStudio_기준이미지읽기(config: Config, cache: CacheStore, body: ImageStudioReferenceInput, workflow: WorkflowType): ImageStudioReference | null {
  if (body.referenceKey === undefined) return null
  if (typeof body.referenceKey !== 'string' || !body.referenceKey || body.referenceKey.length > 2048)
    throw new HttpError(400, '기준 이미지 키가 올바르지 않습니다.')
  if (!Number.isFinite(body.denoise) || body.denoise! <= 0 || body.denoise! > 1)
    throw new HttpError(400, 'img2img 노이즈 강도는 0 초과 1 이하입니다.')
  if (!['illustrious','anima'].includes(workflow)) throw new HttpError(501, 'SDXL 또는 Anima에서 img2img를 사용하세요.')
  const references=Object.values(cache.entries).filter(entry=>entry.talentName===body.referenceKey).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))
  let reference=references.find(entry=>{const full=cache.absolutePathOf(entry);return full&&fs.existsSync(full)})
  if (!reference && typeof body.referencePath==='string') {
    const relative=body.referencePath.replaceAll('\\','/'),resolved=path.resolve(config.imagesDir,relative)
    if (relative.length>4096 || path.isAbsolute(relative) || relative.split('/').some(part=>part==='..')
      || !resolved.startsWith(path.resolve(config.imagesDir)+path.sep) || !/\.(png|webp|jpe?g)$/i.test(relative))
      throw new HttpError(400,'기준 이미지는 images 폴더 내부의 이미지여야 합니다.')
    if(fs.existsSync(resolved)) reference={talentName:body.referenceKey,imagePath:relative,createdAt:0,promptHash:'reference',prompt:'',imageType:'portrait'} as CacheEntry
  }
  const full=reference&&cache.absolutePathOf(reference)
  if(!reference||!full)throw new HttpError(404,'정확한 기준 이미지 파일이 없습니다: '+body.referenceKey)
  const stat=fs.statSync(full)
  if(!stat.isFile())throw new HttpError(400,'기준 이미지가 파일이 아닙니다.')
  if(stat.size>20*1024*1024)throw new HttpError(413,'기준 이미지가 20MB를 넘습니다.')
  return {path:full,identity:reference.imagePath+'|'+stat.mtimeMs+'|'+stat.size,denoise:body.denoise!}
}
