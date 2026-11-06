import ffmpeg from 'fluent-ffmpeg'
import { existsSync, statSync } from 'fs'
import { MAX_VIDEO_SECONDS, mediaKind } from './media'

export type ProbeResult =
  | { ok: true; seconds: number }
  | { ok: false; reason: 'unavailable' }
  | { ok: false; reason: 'unreadable'; detail: string }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'unsupported' }

export async function probeMediaFile(filePath: string): Promise<ProbeResult> {
  if (!mediaKind(filePath)) return { ok: false, reason: 'unsupported' }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return { ok: false, reason: 'missing' }
  }
  if (mediaKind(filePath) !== 'video') return { ok: true, seconds: 0 }
  try {
    const seconds = await probeDuration(filePath)
    if (!seconds) {
      return {
        ok: false,
        reason: 'unreadable',
        detail: 'ffprobe did not report a duration',
      }
    }
    return { ok: true, seconds }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (ffprobeMissing(message)) {
      return { ok: false, reason: 'unavailable' }
    }
    return { ok: false, reason: 'unreadable', detail: clipProbeError(message) }
  }
}

export function durationError(seconds: number): string | null {
  if (seconds > MAX_VIDEO_SECONDS) {
    return `Video is ${seconds.toFixed(1)}s. Clips must be ${MAX_VIDEO_SECONDS}s or shorter and are not trimmed.`
  }
  return null
}

function clipProbeError(message: string): string {
  const lines = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const useful = [...lines].reverse().find((line) => /invalid|error|duration|moov|no such/i.test(line))
  return (useful || lines[lines.length - 1] || 'unreadable video').slice(0, 240)
}

function ffprobeMissing(message: string): boolean {
  if (/ffprobe exited with code/i.test(message)) return false
  return /ENOENT|cannot find ffprobe|ffprobe: not found|spawn ffprobe/i.test(message)
}

function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err)
        return
      }
      resolve(metadata.format.duration || 0)
    })
  })
}
