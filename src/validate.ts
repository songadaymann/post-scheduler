import { loadPosts, tweetLength, assertMediaReadable } from './library'
import { UserError } from './errors'
import { etDay, formatEt, localSeconds } from './time'
import type { ScheduledPost, SchedulerConfig } from './types'

const TWEET_LIMIT = 280

export function loadValidated(
  root: string,
  config: SchedulerConfig
): { posts: ScheduledPost[]; warnings: string[] } {
  const loaded = loadPosts(root, config)
  const result = validatePosts(loaded.posts, config)
  const errors = [...loaded.errors, ...result.errors]
  if (errors.length > 0) {
    throw new UserError(
      `Post library is invalid:\n${errors.map((error) => `- ${error}`).join('\n')}`
    )
  }
  return { posts: loaded.posts, warnings: result.warnings }
}

export function validatePosts(
  posts: ScheduledPost[],
  config: SchedulerConfig
): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []

  const ids = new Map<string, ScheduledPost>()
  for (const post of posts) {
    const previous = ids.get(post.id)
    if (previous) {
      errors.push(
        `duplicate id ${post.id} in ${previous.sourceFile} and ${post.sourceFile}`
      )
    } else {
      ids.set(post.id, post)
    }

    if (post.text.trim() === '') {
      errors.push(`${post.sourceFile}: ${post.id} text is empty`)
    }
    const length = tweetLength(post.text)
    if (length > TWEET_LIMIT) {
      errors.push(
        `${post.sourceFile}: ${post.id} is ${length} characters (limit ${TWEET_LIMIT})`
      )
    }

    const mediaError = assertMediaReadable(post)
    if (mediaError) errors.push(mediaError)

    const phrases = config.campaigns[post.campaign]?.bannedPhrases ?? []
    const haystack = post.text.toLowerCase()
    const hits = phrases.filter((phrase) =>
      haystack.includes(phrase.toLowerCase())
    )
    if (hits.length > 0) {
      errors.push(
        `${post.sourceFile}: ${post.id} contains banned phrase(s) for ${post.campaign}: ${hits.join(', ')}`
      )
    }

    const windowMessage = windowViolation(post, config)
    if (windowMessage) {
      const mode =
        config.campaigns[post.campaign]?.outsideWindow ?? config.outsideWindow
      if (mode === 'warn') warnings.push(windowMessage)
      else errors.push(windowMessage)
    }
  }

  const byDay = new Map<string, ScheduledPost[]>()
  for (const post of posts) {
    const key = `${post.campaign}|${etDay(post.scheduled)}`
    const group = byDay.get(key) ?? []
    group.push(post)
    byDay.set(key, group)
  }
  for (const group of byDay.values()) {
    if (group.length < 2) continue
    const day = etDay(group[0].scheduled)
    errors.push(
      `campaign ${group[0].campaign} has more than one post on ${day} ET: ${group
        .map((post) => post.id)
        .join(', ')}`
    )
  }

  for (let leftIndex = 0; leftIndex < posts.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < posts.length;
      rightIndex += 1
    ) {
      const left = posts[leftIndex]
      const right = posts[rightIndex]
      if (left.campaign === right.campaign) continue
      const gapMs = Math.abs(
        left.scheduled.toMillis() - right.scheduled.toMillis()
      )
      const limitMs = config.minSpacingHours * 60 * 60 * 1000
      if (gapMs < limitMs) {
        errors.push(
          `${left.id} (${left.campaign}) at ${formatEt(left.scheduled)} and ${right.id} (${right.campaign}) at ${formatEt(right.scheduled)} are ${formatGap(gapMs)} apart, under the ${config.minSpacingHours} hour minimum spacing`
        )
      }
    }
  }

  return { errors, warnings }
}

function windowViolation(
  post: ScheduledPost,
  config: SchedulerConfig
): string | null {
  const windows = config.campaigns[post.campaign]?.windows ?? []
  if (windows.length === 0) return null
  const seconds = localSeconds(post.scheduled)
  const inside = windows.some(
    (window) => seconds >= window.startSeconds && seconds < window.endSeconds
  )
  if (inside) return null
  const allowed = windows
    .map((window) => `${window.start}–${window.end}`)
    .join(' or ')
  return `${post.sourceFile}: ${post.id} is at ${formatEt(post.scheduled)}, outside the ${post.campaign} window (${allowed} ET, start inclusive, end exclusive)`
}

function formatGap(gapMs: number): string {
  const minutes = Math.round(gapMs / 60000)
  if (minutes < 120) return `${minutes} minutes`
  const hours = gapMs / 3600000
  const rounded = Number.isInteger(hours) ? String(hours) : hours.toFixed(2)
  return `${rounded} hours`
}
