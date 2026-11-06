import { DateTime } from 'luxon'
import { loadConfig } from './config'
import { missingCredentialNames } from './env'
import { xIntentUrl } from './intent'
import { loadLibrary, toRunnerPost, tweetLength } from './library'
import { mediaKind } from './media'
import { listLocalMedia } from './media-store'
import { applyRuntimePaths, mediaDirFor } from './paths'
import { durationError, probeMediaFile } from './probe'
import { classifyPost } from './runner'
import { ensureLocalLibrary } from './seed'
import { emptyState, loadState } from './state'
import { etDay, formatEt, TIME_ZONE, wallClock } from './time'
import type { PostRecord, RichPost, SchedulerConfig, SchedulerState } from './types'
import { reviewPosts, TWEET_LIMIT } from './validate'

const CAMPAIGN_ORDER = ['commissions', 'wamp', 'donations', 'reshares']

export interface StudioContext {
  root: string
  env: NodeJS.ProcessEnv
  config: SchedulerConfig
}

export function openStudioContext(
  root: string,
  env: NodeJS.ProcessEnv
): StudioContext {
  const config = applyRuntimePaths(root, loadConfig(root), env)
  ensureLocalLibrary(root, config, env)
  return {
    root,
    env,
    config: applyRuntimePaths(root, loadConfig(root), env),
  }
}

export async function buildBootstrap(
  context: StudioContext,
  now: DateTime = DateTime.now()
): Promise<Record<string, unknown>> {
  const { root, env, config } = context
  const loaded = loadLibrary(root, config)
  let state: SchedulerState
  let stateError: string | null = null
  try {
    state = loadState(config.stateDir, now)
  } catch (error) {
    state = emptyState(now)
    stateError = error instanceof Error ? error.message : String(error)
  }

  const timed = loaded.posts.flatMap((post) => {
    const runner = toRunnerPost(post)
    return runner ? [runner] : []
  })
  const review = reviewPosts(timed, config)
  const probes = await probeVideos(loaded.posts)

  const posts = loaded.posts.map((post) =>
    presentPost(post, review.byId[post.id], probes, state, now, config)
  )
  const campaigns = presentCampaigns(config, posts)
  const missing = missingCredentialNames(env)
  const enabled = env.POST_SCHEDULER_ENABLED === '1'
  const armed = enabled && missing.length === 0
  const upcoming = posts.filter((post) => post.runner === 'scheduled' || post.runner === 'due')
  const next = [...upcoming].sort((left, right) =>
    `${left.date} ${left.time}`.localeCompare(`${right.date} ${right.time}`)
  )[0]

  return {
    timezone: TIME_ZONE,
    tweetLimit: TWEET_LIMIT,
    handle: env.TWITTER_USERNAME || 'songadaymann',
    now: {
      date: etDay(now),
      time: wallClock(now),
      label: formatEt(now),
    },
    runner: {
      armed,
      enabled,
      credentialsConfigured: missing.length === 0,
      missingCredentials: missing,
      label: armed ? 'Armed' : 'Preview',
      detail: armed
        ? 'Approved posts can go out on the next runner pass.'
        : enabled
          ? `Enabled, but missing ${missing.join(', ')}.`
          : 'The runner will not post until you arm it.',
    },
    queue: {
      upcoming: posts.filter((post) => post.runner === 'scheduled').length,
      due: posts.filter((post) => post.runner === 'due').length,
      missed: posts.filter((post) =>
        post.runner === 'missed' || post.runner === 'failed' || post.runner === 'interrupted'
      ).length,
      next: next
        ? {
            id: next.id,
            campaign: next.campaign,
            label: `${next.date} ${next.time} ET`,
          }
        : null,
    },
    config: {
      minSpacingHours: config.minSpacingHours,
      staleAfterHours: config.staleAfterHours,
      outsideWindow: config.outsideWindow,
      postsDir: config.postsDir,
      mediaDir: mediaDirFor(root, env),
    },
    campaigns,
    posts,
    headsUps: review.headsUps,
    libraryErrors: stateError ? [stateError, ...loaded.errors] : loaded.errors,
    draftIssues: loaded.draftIssues,
    media: listLocalMedia(root, env).map((item) => ({
      storedPath: item.storedPath,
      kind: item.kind,
      bytes: item.bytes,
      url: previewUrl(item.storedPath),
    })),
  }
}

function presentCampaigns(
  config: SchedulerConfig,
  posts: Record<string, unknown>[]
): Record<string, unknown>[] {
  const names = new Set<string>([
    ...Object.keys(config.campaigns),
    ...posts.map((post) => String(post.campaign)),
  ])
  return [...names].sort(compareCampaign).map((name) => {
    const campaign = config.campaigns[name]
    const mine = posts.filter((post) => post.campaign === name)
    return {
      name,
      windows: (campaign?.windows ?? []).map((window) => ({
        start: window.start,
        end: window.end,
      })),
      outsideWindow: campaign?.outsideWindow ?? null,
      bannedPhrases: campaign?.bannedPhrases ?? [],
      counts: {
        draft: mine.filter((post) => post.bucket === 'draft').length,
        scheduled: mine.filter((post) => post.bucket === 'scheduled').length,
        posted: mine.filter((post) => post.bucket === 'posted').length,
        missed: mine.filter((post) => post.bucket === 'missed').length,
      },
    }
  })
}

function presentPost(
  post: RichPost,
  review: { errors: string[]; warnings: string[] } | undefined,
  probes: Map<string, { error?: string; warning?: string; seconds?: number }>,
  state: SchedulerState,
  now: DateTime,
  config: SchedulerConfig
): Record<string, unknown> {
  const errors = [...(review?.errors ?? [])]
  const warnings = [...(review?.warnings ?? [])]
  if (!post.scheduled) {
    if (post.text.trim() === '') errors.push('Text is empty')
    const length = tweetLength(post.text)
    if (length > TWEET_LIMIT) errors.push(`Text is ${length} characters (limit ${TWEET_LIMIT})`)
    const phrases = config.campaigns[post.campaign]?.bannedPhrases ?? []
    const hits = phrases.filter((phrase) => post.text.toLowerCase().includes(phrase.toLowerCase()))
    if (hits.length > 0) errors.push(`Banned for ${post.campaign}: ${hits.join(', ')}`)
    warnings.push('No send time yet')
  }
  if (post.quoteUrl && !/^https?:\/\//i.test(post.quoteUrl)) {
    warnings.push('Quote URL should start with http:// or https://')
  }
  for (const issue of post.parseErrors) warnings.push(issue)

  let durationSeconds: number | null = null
  const probe = post.mediaPath ? probes.get(post.mediaPath) : undefined
  if (probe?.error) errors.push(probe.error)
  if (probe?.warning) warnings.push(probe.warning)
  if (probe?.seconds) durationSeconds = probe.seconds

  const record = state.posts[post.id]
  const runner = runnerKind(post, record, now, config)
  const media = post.mediaPath ? mediaKind(post.mediaPath) : null
  return {
    id: post.id,
    campaign: post.campaign,
    approval: post.approval,
    approvalStale: post.approvalStale,
    timeField: post.timeField,
    date: post.scheduled ? etDay(post.scheduled) : null,
    time: post.scheduled ? wallClock(post.scheduled) : null,
    text: post.text,
    notes: post.notes ?? '',
    quoteUrl: post.quoteUrl ?? '',
    mediaRaw: post.mediaRaw ?? '',
    mediaKind: media,
    mediaUrl: post.mediaRaw && media ? previewUrl(post.mediaRaw) : null,
    durationSeconds,
    runner,
    bucket: bucketFor(runner),
    postedUrl: record?.postedTweetUrl ?? null,
    lastError: record?.lastError ?? null,
    attempts: record?.attempts ?? 0,
    errors,
    warnings,
    intentUrl: xIntentUrl(post.text, post.quoteUrl),
  }
}

function runnerKind(
  post: RichPost,
  record: PostRecord | undefined,
  now: DateTime,
  config: SchedulerConfig
): string {
  if (record?.status === 'posted') return 'posted'
  if (post.approvalStale) return 'needs-approval'
  if (post.approval !== 'approved' || post.timeField !== 'scheduled' || !post.scheduled) {
    return 'draft'
  }
  if (record?.status === 'missed') return 'missed'
  if (record?.status === 'posting') return 'interrupted'
  const runnerPost = toRunnerPost(post)
  if (!runnerPost) return 'draft'
  const decision = classifyPost(runnerPost, record, now, config.staleAfterHours)
  if (decision.kind === 'due') return 'due'
  if (decision.kind === 'miss') return 'missed'
  if (decision.kind === 'waiting-retry') return 'retrying'
  if (record?.lastError) return 'failed'
  return 'scheduled'
}

function bucketFor(runner: string): string {
  if (runner === 'posted') return 'posted'
  if (runner === 'missed' || runner === 'failed' || runner === 'interrupted') return 'missed'
  if (runner === 'draft' || runner === 'needs-approval') return 'draft'
  return 'scheduled'
}

async function probeVideos(
  posts: RichPost[]
): Promise<Map<string, { error?: string; warning?: string; seconds?: number }>> {
  const paths = [...new Set(posts.flatMap((post) => (post.mediaPath && mediaKind(post.mediaPath) === 'video' ? [post.mediaPath] : [])))]
  const entries = await Promise.all(
    paths.map(async (filePath) => {
      const probe = await probeMediaFile(filePath)
      if (probe.ok) {
        const issue = durationError(probe.seconds)
        return [filePath, issue ? { error: issue, seconds: probe.seconds } : { seconds: probe.seconds }] as const
      }
      if (probe.reason === 'unavailable') {
        return [filePath, { warning: 'ffprobe is not installed, so video duration was not checked.' }] as const
      }
      if (probe.reason === 'unreadable') {
        return [filePath, { error: `Could not read video duration: ${probe.detail}` }] as const
      }
      return [filePath, {}] as const
    })
  )
  return new Map(entries)
}

function previewUrl(storedPath: string): string {
  return `/api/media/preview?path=${encodeURIComponent(storedPath)}`
}

function compareCampaign(left: string, right: string): number {
  const leftIndex = CAMPAIGN_ORDER.indexOf(left)
  const rightIndex = CAMPAIGN_ORDER.indexOf(right)
  if (leftIndex !== -1 || rightIndex !== -1) {
    if (leftIndex === -1) return 1
    if (rightIndex === -1) return -1
    return leftIndex - rightIndex
  }
  return left.localeCompare(right)
}
