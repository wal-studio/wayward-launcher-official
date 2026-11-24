// 실행: bun wml/mods/imagestudio/backend/wayward-imagegen/src/checkWebp.ts
import { webpAvailable } from './comfy/media.ts'

if (!await webpAvailable()) {
  console.error('WebP encoder is unavailable. Install dependencies in the bundled server folder.')
  process.exitCode = 1
}
