import { DateTime } from 'luxon'
import { isEligibleToPost } from './approval'
import { loadState, writeState } from './state'
import { formatEt, toIso } from './time'
import type {
  PostDecision,
  PostRecord,
  Poster,
  ScheduledPost,
  SchedulerConfig,
  SchedulerState,
} from './types'

export const RETRY_BASE_MS = 5 * 60 * 1000
export const RETRY_MAX_MS = 30 * 60 * 1000

export interface RunSummary {
  posted: { id: string; url: string }[]
  missed: string[]
  failed: { id: string; error: string; nextAttemptAt?: string }[]
  interrupted: string[]
}

export function retryDelayMs(attempts: number): number {
  return Math.min(
    RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
    RETRY_MAX_MS
  )
}

export function classifyPost(
  post: ScheduledPost,
  record: PostRecord | undefined,
  now: DateTime,
  staleAfterHours: number
): PostDecision {
  if (record?.status === 'posted') return { kind: 'posted' }
  if (record?.status === 'missed') return { kind: 'missed-recorded' }
  if (record?.status === 'posting') return { kind: 'posting' }

  const cutoff = post.scheduled.plus({ hours: staleAfterHours })
  // "More than 2 hours late" still posts at the exact cutoff instant.
  if (now.toMillis() > cutoff.toMillis()) return { kind: 'miss' }
  if (now.toMillis() < post.scheduled.toMillis()) return { kind: 'upcoming' }
  if (record?.nextAttemptAt) {
    const nextAttempt = DateTime.fromISO(record.nextAttemptAt)
    if (nextAttempt.isValid && nextAttempt.toMillis() > now.toMillis()) {
      return { kind: 'waiting-retry', nextAttemptAt: record.nextAttemptAt }
    }
  }
  return { kind: 'due' }
}

export async function processDue(options: {
  posts: ScheduledPost[]
  config: SchedulerConfig
  now: DateTime
  poster: Poster
  info?: (message: string) => void
  error?: (message: string) => void
}): Promise<RunSummary> {
  const info = options.info ?? ((message: string) => console.log(message))
  const error = options.error ?? ((message: string) => console.error(message))
  const state = loadState(options.config.stateDir, options.now)
  const summary: RunSummary = {
    posted: [],
    missed: [],
    failed: [],
    interrupted: [],
  }

  const ordered = [...options.posts].sort(
    (left, right) =>
      left.scheduled.toMillis() - right.scheduled.toMillis() ||
      left.id.localeCompare(right.id)
  )

  for (const post of ordered) {
    // Drafts, suggested-only times, and approvals whose copy changed are
    // never sent. They are also not marked missed: a suggested time is not
    // a commitment, and a stale approval is waiting for Jonathan.
    if (!isEligibleToPost(post)) continue

    const decision = classifyPost(
      post,
      state.posts[post.id],
      options.now,
      options.config.staleAfterHours
    )

    if (decision.kind === 'posting') {
      summary.interrupted.push(post.id)
      error(
        `Not retrying ${post.id}: a previous run left it in "posting". If it is not on X, set status to "pending" in the state file before the cutoff. If it posted, set status to "posted". Leaving it avoids a duplicate.`
      )
      continue
    }

    if (decision.kind === 'miss') {
      const record = ensureRecord(state, post)
      record.status = 'missed'
      record.missedAt = toIso(options.now)
      record.lastError = `more than ${options.config.staleAfterHours} hours late`
      summary.missed.push(post.id)
      error(
        `MISSED ${post.id} (${post.campaign}): scheduled ${formatEt(post.scheduled)}, more than ${options.config.staleAfterHours} hours late. It will not be posted.`
      )
      persist(state, options.config.stateDir, options.now)
      continue
    }

    if (decision.kind !== 'due') continue

    const record = ensureRecord(state, post)
    record.status = 'posting'
    record.attempts += 1
    record.postingStartedAt = toIso(options.now)
    delete record.lastError
    persist(state, options.config.stateDir, options.now)

    try {
      info(`Posting ${post.id} (${post.campaign})...`)
      const result = await options.poster.post(
        post.mediaPath
          ? { text: post.text, mediaPath: post.mediaPath }
          : { text: post.text }
      )
      record.status = 'posted'
      record.postedAt = toIso(options.now)
      record.postedTweetId = result.id
      record.postedTweetUrl = result.url
      delete record.nextAttemptAt
      delete record.lastError
      summary.posted.push({ id: post.id, url: result.url })
      info(`Posted ${post.id}: ${result.url}`)
    } catch (caught) {
      const message = clip(caught instanceof Error ? caught.message : String(caught))
      const cutoff = post.scheduled.plus({
        hours: options.config.staleAfterHours,
      })
      const delayMs = retryDelayMs(record.attempts)
      let next = options.now.plus({ milliseconds: delayMs })
      if (next.toMillis() > cutoff.toMillis()) {
        if (options.now.toMillis() < cutoff.toMillis()) {
          next = cutoff
        } else {
          record.status = 'missed'
          record.missedAt = toIso(options.now)
          delete record.nextAttemptAt
          record.lastError = message
          summary.missed.push(post.id)
          error(
            `MISSED ${post.id} (${post.campaign}) after ${record.attempts} failed attempt(s): ${message}. The ${options.config.staleAfterHours} hour cutoff has passed.`
          )
          persist(state, options.config.stateDir, options.now)
          continue
        }
      }

      record.status = 'pending'
      record.lastError = message
      record.nextAttemptAt = toIso(next)
      summary.failed.push({
        id: post.id,
        error: message,
        nextAttemptAt: record.nextAttemptAt,
      })
      error(
        `${post.id} failed (attempt ${record.attempts}): ${message}. Next attempt at ${formatEt(next)}.`
      )
    }

    persist(state, options.config.stateDir, options.now)
  }

  if (
    summary.posted.length === 0 &&
    summary.missed.length === 0 &&
    summary.failed.length === 0 &&
    summary.interrupted.length === 0
  ) {
    info('No posts are due.')
  }

  return summary
}

function ensureRecord(state: SchedulerState, post: ScheduledPost): PostRecord {
  const existing = state.posts[post.id]
  if (existing) {
    existing.campaign = post.campaign
    existing.scheduledFor = toIso(post.scheduled)
    return existing
  }
  const created: PostRecord = {
    id: post.id,
    campaign: post.campaign,
    scheduledFor: toIso(post.scheduled),
    status: 'pending',
    attempts: 0,
  }
  state.posts[post.id] = created
  return created
}

function persist(state: SchedulerState, stateDir: string, now: DateTime): void {
  state.updatedAt = toIso(now)
  writeState(stateDir, state)
}

function clip(message: string): string {
  return message.length > 500 ? `${message.slice(0, 500)}…` : message
}
