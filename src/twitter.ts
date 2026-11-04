import { statSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { extname, join } from 'path'
import ffmpeg from 'fluent-ffmpeg'
import { TwitterApi } from 'twitter-api-v2'
import { requireEnv } from './env'
import { UserError } from './errors'
import { mediaKind, mimeTypeFor } from './media'
import type { Poster } from './types'

const MAX_VIDEO_DURATION = 140
const MAX_VIDEO_SIZE = 512 * 1024 * 1024
const UPLOAD_ATTEMPTS = 3
const UPLOAD_RETRY_DELAYS_MS = [5_000, 15_000]
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNABORTED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
])

export function createTwitterPoster(
  env: NodeJS.ProcessEnv = process.env
): Poster {
  const client = new TwitterApi({
    appKey: requireEnv('TWITTER_API_KEY', env),
    appSecret: requireEnv('TWITTER_API_SECRET', env),
    accessToken: requireEnv('TWITTER_ACCESS_TOKEN', env),
    accessSecret: requireEnv('TWITTER_ACCESS_SECRET', env),
  })
  const username = env.TWITTER_USERNAME || 'songadaymann'

  return {
    async post({ text, mediaPath }) {
      const mediaId = mediaPath
        ? await uploadMedia(client, mediaPath)
        : undefined
      const tweet = await client.v2.tweet(
        mediaId
          ? { text, media: { media_ids: [mediaId] as [string] } }
          : { text }
      )
      const id = tweet.data?.id
      if (!id) throw new Error('X did not return a post id')
      return {
        id,
        url: `https://twitter.com/${username}/status/${id}`,
      }
    },
  }
}

async function uploadMedia(client: TwitterApi, mediaPath: string): Promise<string> {
  const kind = mediaKind(mediaPath)
  if (kind === 'image') {
    return client.v1.uploadMedia(mediaPath, {
      mimeType: mimeTypeFor(mediaPath),
      target: 'tweet',
    })
  }
  if (kind === 'video') return uploadVideo(client, mediaPath)
  throw new UserError(`Unsupported media type: ${mediaPath}`)
}

async function uploadVideo(client: TwitterApi, videoPath: string): Promise<string> {
  let processedPath: string | undefined
  try {
    processedPath = await processVideoIfNeeded(videoPath)
    for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
      try {
        console.log(
          `Uploading video (attempt ${attempt}/${UPLOAD_ATTEMPTS})...`
        )
        return await client.v1.uploadMedia(processedPath, {
          mimeType: 'video/mp4',
          target: 'tweet',
        })
      } catch (error) {
        const retry =
          attempt < UPLOAD_ATTEMPTS && isRetryableUploadError(error)
        if (!retry) throw error
        const delayMs = UPLOAD_RETRY_DELAYS_MS[attempt - 1]
        console.warn(
          `Video upload attempt ${attempt} failed: ${errorMessage(error)}. Retrying in ${Math.round(delayMs / 1000)}s.`
        )
        await sleep(delayMs)
      }
    }
    throw new Error('Video upload exhausted all attempts')
  } finally {
    if (processedPath && processedPath !== videoPath) {
      try {
        unlinkSync(processedPath)
      } catch (error) {
        console.warn(`Could not remove processed video: ${errorMessage(error)}`)
      }
    }
  }
}

// Videos that already fit X's limits upload as-is. Anything else is
// transcoded, but never trimmed: a too-long clip fails instead of being cut.
async function processVideoIfNeeded(videoPath: string): Promise<string> {
  const info = await inspectVideo(videoPath)
  if (info.exceedsDurationLimit) {
    throw new UserError(
      `Video is ${info.durationSeconds.toFixed(3)}s; X API videos must be ${MAX_VIDEO_DURATION}s or shorter. Refusing to trim.`
    )
  }
  const isMp4 = extname(videoPath).toLowerCase() === '.mp4'
  if (!info.exceedsSizeLimit && isMp4) return videoPath

  const outputPath = join(tmpdir(), `post-scheduler-${process.pid}-${Date.now()}.mp4`)
  await transcode(videoPath, outputPath)
  return outputPath
}

async function inspectVideo(videoPath: string): Promise<{
  durationSeconds: number
  exceedsDurationLimit: boolean
  exceedsSizeLimit: boolean
}> {
  const durationSeconds = await getVideoDuration(videoPath)
  if (!durationSeconds) {
    throw new UserError(
      `Could not read a duration for ${videoPath}. Install ffmpeg and use a video file.`
    )
  }
  return {
    durationSeconds,
    exceedsDurationLimit: durationSeconds > MAX_VIDEO_DURATION,
    exceedsSizeLimit: statSync(videoPath).size > MAX_VIDEO_SIZE,
  }
}

function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        const message = err.message || String(err)
        if (/ffprobe|ENOENT|not found/i.test(message)) {
          reject(
            new UserError(
              'ffmpeg/ffprobe is required to post video. Install it with: brew install ffmpeg'
            )
          )
          return
        }
        reject(err)
        return
      }
      resolve(metadata.format.duration || 0)
    })
  })
}

function transcode(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .size('1280x720')
      .videoBitrate('2000k')
      .audioBitrate('128k')
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (error: Error) => reject(error))
      .run()
  })
}

function isRetryableUploadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as {
    type?: unknown
    code?: unknown
    status?: unknown
    response?: { status?: unknown }
  }
  if (candidate.type === 'request') return true
  if (
    typeof candidate.code === 'string' &&
    RETRYABLE_NETWORK_CODES.has(candidate.code)
  ) {
    return true
  }
  const status = [candidate.status, candidate.response?.status, candidate.code].find(
    (value) => typeof value === 'number'
  )
  return typeof status === 'number' && (status === 429 || status >= 500)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
