import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs'
import { extname, join, relative, sep } from 'path'
import { UserError } from './errors'
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, mediaKind } from './media'
import { mediaDirFor } from './paths'

const IMAGE_LIMIT = 20 * 1024 * 1024
const VIDEO_LIMIT = 512 * 1024 * 1024

export interface StoredMedia {
  storedPath: string
  absolutePath: string
  kind: 'image' | 'video'
  bytes: number
  modifiedAt: string
}

export function listLocalMedia(
  root: string,
  env: NodeJS.ProcessEnv = process.env
): StoredMedia[] {
  const dir = mediaDirFor(root, env)
  if (!existsSync(dir)) return []
  const found: StoredMedia[] = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const absolutePath = join(dir, name)
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) continue
    const kind = mediaKind(absolutePath)
    if (!kind) continue
    const stat = statSync(absolutePath)
    found.push({
      storedPath: toStoredPath(root, absolutePath),
      absolutePath,
      kind,
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    })
  }
  found.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
  return found
}

export function saveMediaBytes(
  root: string,
  filename: string,
  bytes: Buffer,
  env: NodeJS.ProcessEnv = process.env
): StoredMedia {
  const extension = extname(filename).toLowerCase()
  const kind = mediaKind(filename)
  if (!kind || (!IMAGE_EXTENSIONS.has(extension) && !VIDEO_EXTENSIONS.has(extension))) {
    throw new UserError(
      'Media must be .jpg, .jpeg, .png, .gif, .webp, .mp4, .mov, .m4v, or .webm'
    )
  }
  const limit = kind === 'video' ? VIDEO_LIMIT : IMAGE_LIMIT
  if (bytes.length > limit) {
    throw new UserError(
      `That ${kind} is ${bytes.length} bytes, over the ${limit} byte limit.`
    )
  }
  const dir = mediaDirFor(root, env)
  mkdirSync(dir, { recursive: true })
  const safe = safeFilename(filename)
  const absolutePath = join(dir, `${Date.now()}-${safe}`)
  const temp = `${absolutePath}.tmp`
  writeFileSync(temp, bytes)
  renameSync(temp, absolutePath)
  const stat = statSync(absolutePath)
  return {
    storedPath: toStoredPath(root, absolutePath),
    absolutePath,
    kind,
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  }
}

export function toStoredPath(root: string, absolutePath: string): string {
  const rel = relative(root, absolutePath)
  if (!rel || rel.startsWith('..') || rel.startsWith(`..${sep}`)) return absolutePath
  return rel.split(sep).join('/')
}

function safeFilename(filename: string): string {
  const base = filename.replace(/[/\\]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-')
  const trimmed = base.replace(/^\.+/, '').slice(-80)
  return trimmed || 'upload'
}
