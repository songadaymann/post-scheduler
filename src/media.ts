import { homedir } from 'os'
import { isAbsolute, join, resolve, extname } from 'path'

export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm'])
export const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
])

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

export function mediaKind(filePath: string): 'video' | 'image' | null {
  const extension = extname(filePath).toLowerCase()
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  return null
}

export function mimeTypeFor(filePath: string): string {
  const mime = MIME_TYPES[extname(filePath).toLowerCase()]
  if (!mime) {
    throw new Error(`Unsupported media type for ${filePath}`)
  }
  return mime
}

export function resolveMediaPath(root: string, value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  if (isAbsolute(value)) return value
  return resolve(root, value)
}

export function mediaLabel(filePath: string | undefined): string {
  if (!filePath) return 'text'
  return mediaKind(filePath) ?? 'media'
}
