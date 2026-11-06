import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { DateTime } from 'luxon'
import { UserError } from './errors'
import { toIso } from './time'
import type { PostRecord, PostStatus, SchedulerState } from './types'

const LOCK_STALE_AFTER_MS = 60 * 60 * 1000
const STATUSES = new Set<PostStatus>(['pending', 'posting', 'posted', 'missed'])

export function stateFilePath(stateDir: string): string {
  return join(stateDir, 'state.json')
}

export function lockFilePath(stateDir: string): string {
  return join(stateDir, 'runner.lock')
}

export function emptyState(now: DateTime = DateTime.utc()): SchedulerState {
  return { version: 1, posts: {}, updatedAt: toIso(now) }
}

export function loadState(stateDir: string, now: DateTime): SchedulerState {
  const path = stateFilePath(stateDir)
  if (!existsSync(path)) return emptyState(now)

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new UserError(`State file is corrupt (${path}): ${message}`)
  }
  return parseState(parsed, path)
}

export function forgetRuntimeUnlessPosted(
  stateDir: string,
  id: string,
  now: DateTime
): boolean {
  const state = loadState(stateDir, now)
  const record = state.posts[id]
  if (!record || record.status === 'posted') return false
  delete state.posts[id]
  state.updatedAt = toIso(now)
  writeState(stateDir, state)
  return true
}

export function writeState(stateDir: string, state: SchedulerState): void {
  mkdirSync(stateDir, { recursive: true })
  const path = stateFilePath(stateDir)
  const tempPath = `${path}.${process.pid}.tmp`
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tempPath, path)
}

export function acquireLock(stateDir: string): number | null {
  mkdirSync(stateDir, { recursive: true })
  const path = lockFilePath(stateDir)
  if (existsSync(path)) {
    const ageMs = Date.now() - statSync(path).mtimeMs
    if (ageMs <= LOCK_STALE_AFTER_MS) return null
    unlinkSync(path)
  }

  const descriptor = openSync(path, 'wx')
  writeFileSync(descriptor, `${process.pid}\n`)
  return descriptor
}

export function releaseLock(stateDir: string, descriptor: number | null): void {
  if (descriptor === null) return
  closeSync(descriptor)
  const path = lockFilePath(stateDir)
  if (existsSync(path)) unlinkSync(path)
}

function parseState(value: unknown, path: string): SchedulerState {
  const record = asRecord(value, path)
  if (record.version !== 1) {
    throw new UserError(
      `Unsupported state version in ${path}: ${String(record.version)}`
    )
  }
  const postsValue = asRecord(record.posts, `${path} posts`)
  const posts: Record<string, PostRecord> = {}
  for (const [id, raw] of Object.entries(postsValue)) {
    posts[id] = parseRecord(raw, `${path} posts.${id}`, id)
  }
  const updatedAt =
    typeof record.updatedAt === 'string' ? record.updatedAt : toIso(DateTime.utc())
  return { version: 1, posts, updatedAt }
}

function parseRecord(value: unknown, label: string, fallbackId: string): PostRecord {
  const record = asRecord(value, label)
  const status = record.status
  if (typeof status !== 'string' || !STATUSES.has(status as PostStatus)) {
    throw new UserError(`${label} has an invalid status`)
  }
  if (typeof record.attempts !== 'number' || record.attempts < 0) {
    throw new UserError(`${label} has an invalid attempts count`)
  }
  const id = typeof record.id === 'string' ? record.id : fallbackId
  const campaign = typeof record.campaign === 'string' ? record.campaign : ''
  const scheduledFor =
    typeof record.scheduledFor === 'string' ? record.scheduledFor : ''
  if (!campaign || !scheduledFor) {
    throw new UserError(`${label} is missing campaign or scheduledFor`)
  }

  const parsed: PostRecord = {
    id,
    campaign,
    scheduledFor,
    status: status as PostStatus,
    attempts: record.attempts,
  }
  assignOptional(parsed, 'nextAttemptAt', record.nextAttemptAt)
  assignOptional(parsed, 'postingStartedAt', record.postingStartedAt)
  assignOptional(parsed, 'postedAt', record.postedAt)
  assignOptional(parsed, 'postedTweetId', record.postedTweetId)
  assignOptional(parsed, 'postedTweetUrl', record.postedTweetUrl)
  assignOptional(parsed, 'missedAt', record.missedAt)
  assignOptional(parsed, 'lastError', record.lastError)
  return parsed
}

function assignOptional(
  record: PostRecord,
  key: keyof PostRecord,
  value: unknown
): void {
  if (typeof value === 'string' && value.length > 0) {
    record[key] = value as never
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UserError(`${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}
