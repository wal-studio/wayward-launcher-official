function splitTags(text: string): string[] {
  return String(text || '').split(',').map(tag => tag.trim()).filter(Boolean)
}

function normalized(tag: string): string {
  return tag.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Remove exact comma-separated tags while preserving every other segment. */
export function removePromptTags(source: string, unwanted: readonly string[]): string {
  const rejected = new Set(unwanted.map(normalized))
  return splitTags(source).filter(tag => !rejected.has(normalized(tag))).join(', ')
}

/**
 * Replace the stock character identity while preserving Wayward's scene,
 * outfit, mood and room tags. Explicit scenes can reorder those stock tags,
 * so a simple substring replacement is not reliable.
 */
export function replaceStockCharacterPrompt(source: string, replacement: string, original: string): string {
  const stockTags = new Set([...splitTags(original), ...splitTags(replacement)].map(normalized))
  const remainder = splitTags(source).filter(tag => !stockTags.has(normalized(tag)))
  return [...splitTags(replacement), ...remainder].join(', ')
}
