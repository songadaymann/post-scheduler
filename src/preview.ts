import { DateTime } from 'luxon'
import { mediaLabel } from './media'
import { classifyPost } from './runner'
import { formatEt } from './time'
import { sameDayHeadsUps } from './validate'
import type { ScheduledPost, SchedulerConfig, SchedulerState } from './types'

export function formatPreview(input: {
  posts: ScheduledPost[]
  state: SchedulerState
  config: SchedulerConfig
  now: DateTime
  enabled: boolean
  explicitPreview: boolean
  warnings: string[]
  held?: ScheduledPost[]
  untimed?: { id: string; campaign: string }[]
  draftIssues?: string[]
  headsUps?: string[]
}): string {
  const lines: string[] = []
  if (!input.enabled) {
    lines.push(
      'Posting is disabled (set POST_SCHEDULER_ENABLED=1 to enable).'
    )
  }
  if (input.explicitPreview) {
    lines.push('Preview only (--preview); nothing will be posted.')
  }
  if (lines.length > 0) lines.push('')

  const campaigns = new Set(input.posts.map((post) => post.campaign))
  lines.push(
    `Validated ${input.posts.length} post${input.posts.length === 1 ? '' : 's'} across ${campaigns.size} campaign${campaigns.size === 1 ? '' : 's'}.`
  )
  lines.push(`Timezone: ${input.config.timezone}`)
  lines.push(`Minimum spacing: ${input.config.minSpacingHours} hours`)
  lines.push(`Stale after: ${input.config.staleAfterHours} hours`)

  if (input.warnings.length > 0) {
    lines.push('')
    lines.push('Warnings:')
    for (const warning of input.warnings) lines.push(`- ${warning}`)
  }

  const headsUps =
    input.headsUps ??
    sameDayHeadsUps([...input.posts, ...(input.held ?? [])])
  if (headsUps.length > 0) {
    lines.push('')
    lines.push('Heads-up: promo campaigns share an Eastern day')
    for (const headsUp of headsUps) lines.push(`- ${headsUp}`)
  }
  if (input.draftIssues && input.draftIssues.length > 0) {
    lines.push('')
    lines.push('Draft notes (these posts are not eligible):')
    for (const issue of input.draftIssues) lines.push(`- ${issue}`)
  }

  appendHeld(lines, input.held ?? [], input.untimed ?? [])

  if (input.posts.length === 0) {
    lines.push('')
    lines.push('No posts are scheduled.')
    return lines.join('\n')
  }

  const sections: { title: string; posts: ScheduledPost[] }[] = [
    { title: 'Upcoming', posts: [] },
    { title: 'Due now', posts: [] },
    { title: 'Waiting to retry', posts: [] },
    { title: 'Too late (will be marked missed)', posts: [] },
    { title: 'Interrupted (left in posting)', posts: [] },
    { title: 'Already posted', posts: [] },
    { title: 'Already missed', posts: [] },
  ]
  const byTitle = new Map(sections.map((section) => [section.title, section]))

  for (const post of input.posts) {
    const decision = classifyPost(
      post,
      input.state.posts[post.id],
      input.now,
      input.config.staleAfterHours
    )
    const title =
      decision.kind === 'upcoming'
        ? 'Upcoming'
        : decision.kind === 'due'
          ? 'Due now'
          : decision.kind === 'waiting-retry'
            ? 'Waiting to retry'
            : decision.kind === 'miss'
              ? 'Too late (will be marked missed)'
              : decision.kind === 'posting'
                ? 'Interrupted (left in posting)'
                : decision.kind === 'posted'
                  ? 'Already posted'
                  : 'Already missed'
    byTitle.get(title)?.posts.push(post)
  }

  for (const section of sections) {
    if (section.posts.length === 0) continue
    lines.push('')
    lines.push(section.title)
    for (const post of section.posts) {
      const record = input.state.posts[post.id]
      const retryAt =
        record?.status === 'pending' && record.nextAttemptAt
          ? DateTime.fromISO(record.nextAttemptAt)
          : null
      const extra =
        retryAt?.isValid
          ? `  next attempt ${formatEt(retryAt)}`
          : record?.postedTweetUrl
            ? `  ${record.postedTweetUrl}`
            : ''
      lines.push(
        `- ${formatEt(post.scheduled)}  ${post.campaign}  ${post.id}  (${mediaLabel(post.mediaPath)})${extra}`
      )
      for (const textLine of post.text.split('\n')) {
        lines.push(`  ${textLine}`)
      }
    }
  }

  return lines.join('\n')
}

function appendHeld(
  lines: string[],
  held: ScheduledPost[],
  untimed: { id: string; campaign: string }[]
): void {
  if (held.length === 0 && untimed.length === 0) return
  lines.push('')
  lines.push('Held back (not eligible to post)')
  for (const post of held) {
    const reason = post.approvalStale
      ? 'approved copy changed'
      : post.approval === 'draft'
        ? 'draft'
        : 'not scheduled'
    lines.push(
      `- ${formatEt(post.scheduled)}  ${post.campaign}  ${post.id}  (${mediaLabel(post.mediaPath)})  ${reason}`
    )
  }
  for (const post of untimed) {
    lines.push(`- unscheduled  ${post.campaign}  ${post.id}  draft`)
  }
}
