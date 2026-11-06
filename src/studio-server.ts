import { createReadStream, existsSync, statSync } from 'fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { DateTime } from 'luxon'
import { join } from 'path'
import { loadEnvFile } from './env'
import { UserError } from './errors'
import {
  createPost,
  duplicatePost,
  reschedulePost,
  retirePost,
  saveCampaign,
  suggestForPost,
  updatePost,
  type PostPatch,
} from './library-edit'
import { saveMediaBytes } from './media-store'
import { mediaKind, mimeTypeFor, resolveMediaPath } from './media'
import { buildBootstrap, openStudioContext } from './studio-data'
import type { Approval, OutsideWindowMode } from './types'

const JSON_LIMIT = 2 * 1024 * 1024
const IMAGE_LIMIT = 20 * 1024 * 1024
const VIDEO_LIMIT = 512 * 1024 * 1024

export async function startStudio(options: {
  root?: string
  port?: number
  host?: string
  env?: NodeJS.ProcessEnv
  info?: (message: string) => void
} = {}): Promise<{ port: number; url: string; close: () => Promise<void> }> {
  const root = options.root ?? process.cwd()
  const env = options.env ?? process.env
  loadEnvFile(root, env)
  const info = options.info ?? ((message: string) => console.log(message))
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 4310
  let chain: Promise<unknown> = Promise.resolve()
  const gate = <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.then(work, work)
    chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  const server = createServer((req, res) => {
    handle(req, res, root, env, gate).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      const status = error instanceof UserError ? 400 : 500
      sendJson(res, status, { error: message })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })
  const address = server.address()
  const chosen = typeof address === 'object' && address ? address.port : port
  const url = `http://${host}:${chosen}`
  const context = openStudioContext(root, env)
  const mode = env.POST_SCHEDULER_ENABLED === '1' ? 'enabled' : 'preview'
  info(`Song a Day studio at ${url}`)
  info(`Library: ${context.config.postsDir}`)
  info(`Runner: ${mode}`)
  return {
    port: chosen,
    url,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  env: NodeJS.ProcessEnv,
  gate: <T>(work: () => Promise<T>) => Promise<T>
): Promise<void> {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const path = decodeURIComponent(url.pathname)
  if (req.method === 'GET' && path === '/') {
    sendHtml(res)
    return
  }
  if (req.method === 'GET' && path === '/api/health') {
    sendJson(res, 200, { ok: true })
    return
  }
  if (req.method === 'GET' && path === '/api/media/preview') {
    sendMedia(root, url.searchParams.get('path') || '', req, res)
    return
  }
  if (req.method === 'GET' && path === '/api/bootstrap') {
    const body = await gate(async () => buildBootstrap(openStudioContext(root, env)))
    sendJson(res, 200, body)
    return
  }
  if (req.method === 'POST' && path === '/api/media') {
    const saved = await gate(async () => {
      const filename = String(req.headers['x-filename'] || 'upload')
      const kind = mediaKind(filename)
      const limit = kind === 'video' ? VIDEO_LIMIT : IMAGE_LIMIT
      const bytes = await readBody(req, limit)
      return saveMediaBytes(root, filename, bytes, env)
    })
    sendJson(res, 200, {
      mediaRaw: saved.storedPath,
      kind: saved.kind,
      bytes: saved.bytes,
      url: `/api/media/preview?path=${encodeURIComponent(saved.storedPath)}`,
    })
    return
  }

  const result = await gate(() => routeJson(req, path, root, env))
  sendJson(res, 200, result)
}

async function routeJson(
  req: IncomingMessage,
  path: string,
  root: string,
  env: NodeJS.ProcessEnv
): Promise<Record<string, unknown>> {
  if (req.method !== 'POST') throw new UserError(`No route for ${req.method || 'GET'} ${path}`)
  const context = openStudioContext(root, env)
  const now = DateTime.now()
  if (path === '/api/campaigns') {
    const body = asRecord(await readJson(req))
    saveCampaign(root, {
      name: requiredString(body.name, 'name'),
      title: optionalString(body.title),
      windows: parseWindows(body.windows),
      outsideWindow: parseOutside(body.outsideWindow),
      bannedPhrases: parsePhrases(body.bannedPhrases),
      createFile: true,
    })
    return { bootstrap: await buildBootstrap(openStudioContext(root, env), now) }
  }

  if (path === '/api/posts') {
    const body = asRecord(await readJson(req))
    const created = await createPost(
      root,
      context.config,
      {
        campaign: requiredString(body.campaign, 'campaign'),
        id: optionalString(body.id),
        text: optionalString(body.text),
        notes: optionalString(body.notes),
        quoteUrl: optionalString(body.quoteUrl),
        mediaRaw: optionalString(body.mediaRaw),
        date: optionalString(body.date),
        time: optionalString(body.time),
      },
      now
    )
    return {
      selectedId: created.id,
      bootstrap: await buildBootstrap(openStudioContext(root, env), now),
    }
  }

  const match = /^\/api\/posts\/([^/]+)(?:\/(duplicate|retire|reschedule|suggest))?$/.exec(path)
  if (!match) throw new UserError(`No route for ${path}`)
  const id = match[1]
  const action = match[2]
  if (action === 'suggest') {
    await readJson(req)
    return {
      ...suggestForPost(root, context.config, id, now),
    }
  }
  if (action === 'duplicate') {
    await readJson(req)
    const copy = await duplicatePost(root, context.config, id, now)
    return {
      selectedId: copy.id,
      message: `Duplicated as ${copy.id}`,
      bootstrap: await buildBootstrap(openStudioContext(root, env), now),
    }
  }
  if (action === 'retire') {
    await readJson(req)
    retirePost(root, context.config, id, now)
    return {
      message: `Retired ${id}`,
      bootstrap: await buildBootstrap(openStudioContext(root, env), now),
    }
  }
  if (action === 'reschedule') {
    const body = asRecord(await readJson(req))
    const updated = await reschedulePost(
      root,
      context.config,
      id,
      {
        date: optionalString(body.date),
        time: optionalString(body.time),
        next: body.next === true,
      },
      now
    )
    return {
      selectedId: updated.id,
      message: 'Rescheduled',
      bootstrap: await buildBootstrap(openStudioContext(root, env), now),
    }
  }

  const body = asRecord(await readJson(req))
  const updated = await updatePost(root, context.config, id, patchFrom(body), now)
  return {
    selectedId: updated.id,
    bootstrap: await buildBootstrap(openStudioContext(root, env), now),
  }
}

function patchFrom(body: Record<string, unknown>): PostPatch {
  const patch: PostPatch = {}
  if ('text' in body) patch.text = stringOrEmpty(body.text)
  if ('notes' in body) patch.notes = body.notes === null ? null : stringOrEmpty(body.notes)
  if ('quoteUrl' in body) patch.quoteUrl = body.quoteUrl === null ? null : stringOrEmpty(body.quoteUrl)
  if ('mediaRaw' in body) patch.mediaRaw = body.mediaRaw === null ? null : stringOrEmpty(body.mediaRaw)
  if ('date' in body) patch.date = body.date === null ? null : optionalString(body.date) ?? null
  if ('time' in body) patch.time = body.time === null ? null : optionalString(body.time) ?? null
  if (typeof body.shiftDays === 'number') patch.shiftDays = body.shiftDays
  if (typeof body.shiftMinutes === 'number') patch.shiftMinutes = body.shiftMinutes
  if (body.approval === 'draft' || body.approval === 'approved') {
    patch.approval = body.approval as Approval
  }
  if (body.keepApproved === true) patch.keepApproved = true
  return patch
}

function parseWindows(value: unknown): { start: string; end: string }[] {
  if (!Array.isArray(value)) throw new UserError('windows must be a list')
  return value.map((entry) => {
    const record = asRecord(entry)
    return {
      start: requiredString(record.start, 'window start'),
      end: requiredString(record.end, 'window end'),
    }
  })
}

function parsePhrases(value: unknown): string[] {
  if (!Array.isArray(value)) throw new UserError('bannedPhrases must be a list')
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

function parseOutside(value: unknown): OutsideWindowMode | null {
  if (value === null || value === undefined || value === '') return null
  if (value === 'warn' || value === 'fail') return value
  throw new UserError('outsideWindow must be warn, fail, or empty')
}

function sendHtml(res: ServerResponse): void {
  const path = join(__dirname, 'studio', 'index.html')
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  createReadStream(path).pipe(res)
}

function sendMedia(
  root: string,
  rawPath: string,
  req: IncomingMessage,
  res: ServerResponse
): void {
  if (!rawPath) throw new UserError('Missing media path')
  const absolute = resolveMediaPath(root, rawPath)
  if (!mediaKind(absolute) || !existsSync(absolute) || !statSync(absolute).isFile()) {
    sendJson(res, 404, { error: 'Media not found' })
    return
  }
  const stat = statSync(absolute)
  const mime = mimeTypeFor(absolute)
  const range = req.headers.range
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range)
    if (match) {
      const start = Number(match[1])
      const end = match[2] ? Number(match[2]) : stat.size - 1
      if (start <= end && end < stat.size) {
        res.writeHead(206, {
          'Content-Type': mime,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        })
        createReadStream(absolute, { start, end }).pipe(res)
        return
      }
    }
  }
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  })
  createReadStream(absolute).pipe(res)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return readBody(req, JSON_LIMIT).then((buffer) => {
    if (buffer.length === 0) return {}
    try {
      return JSON.parse(buffer.toString('utf8')) as unknown
    } catch {
      throw new UserError('Request body is not valid JSON')
    }
  })
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] || 0)
  if (declared > limit) throw new UserError(`Upload is larger than ${limit} bytes`)
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new UserError(`Upload is larger than ${limit} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UserError('Expected a JSON object')
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UserError(`${label} is required`)
  }
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.trim() === '' ? undefined : value.trim()
}

function stringOrEmpty(value: unknown): string {
  if (typeof value !== 'string') throw new UserError('Expected a string')
  return value
}
