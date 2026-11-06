import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join, relative } from 'path'
import { DateTime } from 'luxon'
import { approvalHash } from './approval'
import { localCampaignsPath, loadConfig } from './config'
import { UserError } from './errors'
import {
  joinDocument,
  loadLibrary,
  splitDocument,
  type SourceBlock,
} from './library'
import { resolveMediaPath } from './media'
import { durationError, probeMediaFile } from './probe'
import { suggestNextSlot } from './slots'
import { forgetRuntimeUnlessPosted, loadState } from './state'
import { etDay, formatEt, formatWall, parseWallTime, TIME_ZONE, wallClock } from './time'
import type {
  Approval,
  OutsideWindowMode,
  RichPost,
  ScheduledPost,
  SchedulerConfig,
} from './types'
import { reviewPosts } from './validate'

export interface PostPatch {
  text?: string
  notes?: string | null
  quoteUrl?: string | null
  mediaRaw?: string | null
  date?: string | null
  time?: string | null
  shiftDays?: number
  shiftMinutes?: number
  approval?: Approval
  keepApproved?: boolean
}

export async function createPost(
  root: string,
  config: SchedulerConfig,
  input: {
    campaign: string
    id?: string
    text?: string
    notes?: string
    quoteUrl?: string
    mediaRaw?: string
    date?: string
    time?: string
  },
  now: DateTime
): Promise<RichPost> {
  assertCampaignName(input.campaign)
  const library = loadLibrary(root, config)
  const taken = takenIds(config, library.posts, now)
  let scheduled: DateTime | null = null
  if (input.date || input.time) {
    scheduled = parseDateTime(input.date, input.time)
  } else {
    scheduled = suggestNextSlot({
      campaign: input.campaign,
      config,
      posts: timed(library.posts),
      now,
    })
  }
  const id = input.id?.trim() || freshId(input.campaign, scheduled, taken, now)
  assertId(id)
  if (taken.has(id)) throw new UserError(`Post id ${id} already exists`)
  const filePath = ensureCampaignFile(config, input.campaign)
  const post = basePost({
    id,
    campaign: input.campaign,
    filePath,
    root,
    approval: 'draft',
    scheduled,
    text: input.text ?? '',
    notes: blank(input.notes),
    quoteUrl: blank(input.quoteUrl),
    mediaRaw: blank(input.mediaRaw),
  })
  const doc = splitDocument(readFileSync(filePath, 'utf8'))
  doc.blocks.push({ id, lines: serializePost(post), startLine: 1 })
  writeDocument(filePath, doc)
  return reload(root, config, id)
}

export async function updatePost(
  root: string,
  config: SchedulerConfig,
  id: string,
  patch: PostPatch,
  now: DateTime
): Promise<RichPost> {
  const found = requireOne(root, config, id)
  const next = await planUpdate(root, config, found.library, found.post, patch)
  replaceBlock(found.post.absoluteFile, id, serializePost(next))
  if (next.scheduled && found.post.scheduled) {
    if (next.scheduled.toMillis() !== found.post.scheduled.toMillis()) {
      resetIfRetryable(config.stateDir, id, now)
    }
  } else if (next.scheduled || found.post.scheduled) {
    resetIfRetryable(config.stateDir, id, now)
  }
  return reload(root, config, id)
}

export async function duplicatePost(
  root: string,
  config: SchedulerConfig,
  id: string,
  now: DateTime
): Promise<RichPost> {
  const found = requireOne(root, config, id)
  const taken = takenIds(config, found.library, now)
  const slot =
    suggestNextSlot({
      campaign: found.post.campaign,
      config,
      posts: timed(found.library),
      now,
    }) ?? found.post.scheduled?.plus({ days: 1 }) ?? null
  const copyId = freshId(found.post.campaign, slot, taken, now)
  const copy = basePost({
    id: copyId,
    campaign: found.post.campaign,
    filePath: found.post.absoluteFile,
    root,
    approval: 'draft',
    scheduled: slot,
    text: found.post.text,
    notes: found.post.notes,
    quoteUrl: found.post.quoteUrl,
    mediaRaw: found.post.mediaRaw,
  })
  const doc = splitDocument(readFileSync(found.post.absoluteFile, 'utf8'))
  const index = doc.blocks.findIndex((block) => block.id === id)
  const block: SourceBlock = { id: copyId, lines: serializePost(copy), startLine: 1 }
  if (index < 0) doc.blocks.push(block)
  else doc.blocks.splice(index + 1, 0, block)
  writeDocument(found.post.absoluteFile, doc)
  return reload(root, config, copyId)
}

export function retirePost(
  root: string,
  config: SchedulerConfig,
  id: string,
  now: DateTime
): void {
  const found = requireOne(root, config, id)
  const doc = splitDocument(readFileSync(found.post.absoluteFile, 'utf8'))
  const index = doc.blocks.findIndex((block) => block.id === id)
  if (index < 0) throw new UserError(`Could not find ${id} in ${found.post.sourceFile}`)
  const removed = doc.blocks.splice(index, 1)[0]
  const body = trimTrailingEmpty(removed.lines)
  if (doc.retired.length === 0) doc.retired = ['## Retired', '', ...body]
  else doc.retired.push('', ...body)
  writeDocument(found.post.absoluteFile, doc)
  forgetRuntimeUnlessPosted(config.stateDir, id, now)
}

export function suggestForPost(
  root: string,
  config: SchedulerConfig,
  id: string,
  now: DateTime
): { date: string; time: string; label: string } {
  const found = requireOne(root, config, id)
  const slot = suggestNextSlot({
    campaign: found.post.campaign,
    config,
    posts: timed(found.library),
    now,
    excludeId: id,
    notBefore: now,
  })
  if (!slot) throw new UserError('No open slot in the next 180 days.')
  return { date: etDay(slot), time: wallClock(slot), label: formatEt(slot) }
}

export async function reschedulePost(
  root: string,
  config: SchedulerConfig,
  id: string,
  input: { date?: string; time?: string; next?: boolean },
  now: DateTime
): Promise<RichPost> {
  if (input.next) {
    const found = requireOne(root, config, id)
    const slot = suggestNextSlot({
      campaign: found.post.campaign,
      config,
      posts: timed(found.library),
      now,
      excludeId: id,
      notBefore: now,
    })
    if (!slot) throw new UserError('No open slot in the next 180 days.')
    return updatePost(
      root,
      config,
      id,
      { date: etDay(slot), time: wallClock(slot) },
      now
    )
  }
  return updatePost(root, config, id, { date: input.date, time: input.time }, now)
}

export function saveCampaign(
  root: string,
  input: {
    name: string
    title?: string
    windows: { start: string; end: string }[]
    outsideWindow?: OutsideWindowMode | null
    bannedPhrases: string[]
    createFile?: boolean
  }
): void {
  assertCampaignName(input.name)
  const path = localCampaignsPath(root)
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : null
  let parsed: { campaigns?: Record<string, unknown> }
  try {
    parsed = previous
      ? (JSON.parse(previous) as { campaigns?: Record<string, unknown> })
      : { campaigns: {} }
  } catch {
    throw new UserError('campaigns.local.json is not valid JSON')
  }
  if (!parsed.campaigns || typeof parsed.campaigns !== 'object') {
    parsed.campaigns = {}
  }
  const entry: Record<string, unknown> = {
    bannedPhrases: input.bannedPhrases,
    windows: input.windows,
  }
  if (input.outsideWindow) entry.outsideWindow = input.outsideWindow
  parsed.campaigns[input.name] = entry
  mkdirSync(dirname(path), { recursive: true })
  const next = `${JSON.stringify({ campaigns: parsed.campaigns }, null, 2)}\n`
  writeFileSync(path, next)
  try {
    loadConfig(root)
  } catch (error) {
    if (previous === null) unlinkSync(path)
    else writeFileSync(path, previous)
    throw error
  }
  if (input.createFile !== false) {
    const config = loadConfig(root)
    ensureCampaignFile(config, input.name, input.title)
  }
}

export function serializePost(post: RichPost): string[] {
  const lines = [`### ${post.id}`, '', `status: ${post.approval}`]
  if (post.scheduled) {
    const stamp = formatWall(post.scheduled)
    lines.push(
      post.approval === 'approved' ? `scheduled: ${stamp}` : `suggested: ${stamp}`
    )
  }
  if (post.mediaRaw) lines.push(`media: ${post.mediaRaw}`)
  if (post.quoteUrl) lines.push(`quote: ${post.quoteUrl}`)
  if (post.approval === 'approved' && post.approvedHash) {
    lines.push(`approvedHash: ${post.approvedHash}`)
  }
  if (post.notes) {
    if (post.notes.includes('\n')) {
      lines.push('', '```notes', post.notes, '```')
    } else {
      lines.push(`notes: ${post.notes}`)
    }
  }
  lines.push('', '```text', post.text, '```')
  return lines
}

async function planUpdate(
  root: string,
  config: SchedulerConfig,
  library: RichPost[],
  old: RichPost,
  patch: PostPatch
): Promise<RichPost> {
  if ((patch.shiftDays || patch.shiftMinutes) && (patch.date !== undefined || patch.time !== undefined)) {
    throw new UserError('Shift the time or set a date and time, not both.')
  }
  const timedPatch = shiftedPatch(old, patch)
  const time = resolveTime(old, timedPatch)
  const text = patch.text !== undefined ? patch.text : old.text
  const notes = patch.notes === undefined ? old.notes : blank(patch.notes)
  const quoteUrl = patch.quoteUrl === undefined ? old.quoteUrl : blank(patch.quoteUrl)
  const mediaRaw = patch.mediaRaw === undefined ? old.mediaRaw : blank(patch.mediaRaw)
  const copyChanged =
    text !== old.text ||
    (quoteUrl ?? '') !== (old.quoteUrl ?? '') ||
    (mediaRaw ?? '') !== (old.mediaRaw ?? '')
  const explicitApprove = patch.approval === 'approved' || patch.keepApproved === true

  let approval: Approval = old.approval
  let approvedHash = old.approvedHash
  if (explicitApprove) {
    approval = 'approved'
    approvedHash = approvalHash(text, quoteUrl, mediaRaw)
  } else if (patch.approval === 'draft' || (copyChanged && old.approval === 'approved')) {
    approval = 'draft'
    approvedHash = undefined
  } else if (approval === 'approved' && !approvedHash && !old.approvalStale) {
    approvedHash = approvalHash(text, quoteUrl, mediaRaw)
  }

  if (old.approvalStale && approval === 'approved' && !explicitApprove) {
    throw new UserError(
      'This copy changed after it was approved. Re-approve it before it can stay on the schedule.'
    )
  }
  if (approval === 'approved' && !time.scheduled) {
    throw new UserError('Pick an Eastern send time before approving.')
  }
  const timeChanged =
    (time.scheduled?.toMillis() ?? null) !== (old.scheduled?.toMillis() ?? null)
  if (timeChanged && loadState(config.stateDir, DateTime.now()).posts[old.id]?.status === 'posted') {
    throw new UserError('This tweet already posted. Duplicate it to schedule another one.')
  }

  const next = basePost({
    id: old.id,
    campaign: old.campaign,
    filePath: old.absoluteFile,
    root,
    approval,
    scheduled: time.scheduled,
    text,
    notes,
    quoteUrl,
    mediaRaw,
    approvedHash: approval === 'approved' ? approvedHash : undefined,
  })

  if (approval === 'approved') {
    const problems = [
      ...reviewOne(root, config, library, next),
      ...(await videoProblems(next.mediaPath)),
    ]
    if (problems.length > 0) {
      throw new UserError(problems.join('\n'))
    }
  }
  return next
}

function shiftedPatch(old: RichPost, patch: PostPatch): PostPatch {
  if (!patch.shiftDays && !patch.shiftMinutes) return patch
  if (!old.scheduled) throw new UserError('Set a time before shifting it.')
  const shifted = old.scheduled.setZone(TIME_ZONE).plus({
    days: patch.shiftDays ?? 0,
    minutes: patch.shiftMinutes ?? 0,
  })
  const date = etDay(shifted)
  const time = wallClock(shifted)
  parseDateTime(date, time)
  return { ...patch, date, time, shiftDays: undefined, shiftMinutes: undefined }
}

function resolveTime(
  old: RichPost,
  patch: PostPatch
): { scheduled: DateTime | null } {
  const touched = patch.date !== undefined || patch.time !== undefined
  if (!touched) return { scheduled: old.scheduled }
  if (!patch.date && !patch.time) return { scheduled: null }
  return { scheduled: parseDateTime(patch.date, patch.time) }
}

function parseDateTime(date: string | null | undefined, time: string | null | undefined): DateTime {
  if (!date || !time) throw new UserError('Send time needs both a date and a time (Eastern).')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new UserError('Use a date like 2026-12-01 and a time like 10:00.')
  }
  try {
    return parseWallTime(`${date} ${time}`)
  } catch (error) {
    throw new UserError(error instanceof Error ? error.message : String(error))
  }
}

function reviewOne(
  root: string,
  config: SchedulerConfig,
  library: RichPost[],
  next: RichPost
): string[] {
  const posts: ScheduledPost[] = []
  for (const post of library) {
    const source = post.id === next.id ? next : post
    if (!source.scheduled) continue
    posts.push(toScheduled(root, source))
  }
  if (next.scheduled && !posts.some((post) => post.id === next.id)) {
    posts.push(toScheduled(root, next))
  }
  return reviewPosts(posts, config).byId[next.id]?.errors ?? []
}

async function videoProblems(mediaPath: string | undefined): Promise<string[]> {
  if (!mediaPath) return []
  const probe = await probeMediaFile(mediaPath)
  if (probe.ok) {
    if (probe.seconds === 0) return []
    const issue = durationError(probe.seconds)
    return issue ? [issue] : []
  }
  if (probe.reason === 'unavailable' || probe.reason === 'missing' || probe.reason === 'unsupported') {
    return []
  }
  return [`Could not read video duration: ${probe.detail}`]
}

function toScheduled(root: string, post: RichPost): ScheduledPost {
  if (!post.scheduled) throw new Error(`Post ${post.id} has no time`)
  const mediaPath = post.mediaRaw ? resolveMediaPath(root, post.mediaRaw) : post.mediaPath
  return {
    id: post.id,
    campaign: post.campaign,
    scheduled: post.scheduled,
    text: post.text,
    ...(mediaPath ? { mediaPath } : {}),
    sourceFile: post.sourceFile,
    approval: post.approval,
    timeField: post.approval === 'approved' ? 'scheduled' : 'suggested',
  }
}

function basePost(input: {
  id: string
  campaign: string
  filePath: string
  root: string
  approval: Approval
  scheduled: DateTime | null
  text: string
  notes?: string
  quoteUrl?: string
  mediaRaw?: string
  approvedHash?: string
}): RichPost {
  const mediaPath = input.mediaRaw
    ? resolveMediaPath(input.root, input.mediaRaw)
    : undefined
  return {
    id: input.id,
    campaign: input.campaign,
    approval: input.approval,
    approvalStale: false,
    timeField: input.scheduled
      ? input.approval === 'approved'
        ? 'scheduled'
        : 'suggested'
      : 'none',
    scheduled: input.scheduled,
    suggested: input.approval === 'draft' ? input.scheduled : null,
    text: input.text,
    ...(mediaPath ? { mediaPath } : {}),
    ...(input.mediaRaw ? { mediaRaw: input.mediaRaw } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    ...(input.quoteUrl ? { quoteUrl: input.quoteUrl } : {}),
    ...(input.approvedHash ? { approvedHash: input.approvedHash } : {}),
    sourceFile: sourceLabel(input.root, input.filePath),
    absoluteFile: input.filePath,
    parseErrors: [],
  }
}

function requireOne(
  root: string,
  config: SchedulerConfig,
  id: string
): { post: RichPost; library: RichPost[] } {
  const loaded = loadLibrary(root, config)
  const matches = loaded.posts.filter((post) => post.id === id)
  if (matches.length === 0) throw new UserError(`No post with id ${id}`)
  if (matches.length > 1) throw new UserError(`Duplicate id ${id}`)
  return { post: matches[0], library: loaded.posts }
}

function reload(root: string, config: SchedulerConfig, id: string): RichPost {
  return requireOne(root, config, id).post
}

function replaceBlock(filePath: string, id: string, lines: string[]): void {
  const doc = splitDocument(readFileSync(filePath, 'utf8'))
  const index = doc.blocks.findIndex((block) => block.id === id)
  if (index < 0) throw new UserError(`Could not find ${id} in the campaign file`)
  doc.blocks[index] = { id, lines, startLine: doc.blocks[index].startLine }
  writeDocument(filePath, doc)
}

function writeDocument(filePath: string, doc: ReturnType<typeof splitDocument>): void {
  const body = joinDocument(doc)
  const temp = `${filePath}.${process.pid}.tmp`
  writeFileSync(temp, body)
  renameSync(temp, filePath)
}

function ensureCampaignFile(
  config: SchedulerConfig,
  name: string,
  title?: string
): string {
  mkdirSync(config.postsDir, { recursive: true })
  const filePath = join(config.postsDir, `${name}.md`)
  if (!existsSync(filePath)) {
    const heading = title?.trim() || name.slice(0, 1).toUpperCase() + name.slice(1)
    writeFileSync(filePath, `# ${heading}\n\ncampaign: ${name}\n`)
  }
  return filePath
}

function resetIfRetryable(stateDir: string, id: string, now: DateTime): void {
  const state = loadState(stateDir, now)
  const record = state.posts[id]
  if (!record) return
  if (record.status === 'posted' || record.status === 'posting') return
  if (record.status === 'missed' || record.lastError || record.nextAttemptAt) {
    forgetRuntimeUnlessPosted(stateDir, id, now)
  }
}

function takenIds(
  config: SchedulerConfig,
  posts: RichPost[],
  now: DateTime
): Set<string> {
  const taken = new Set(posts.map((post) => post.id))
  const state = loadState(config.stateDir, now)
  for (const [id, record] of Object.entries(state.posts)) {
    if (record.status === 'posted') taken.add(id)
  }
  return taken
}

function freshId(
  campaign: string,
  when: DateTime | null,
  taken: Set<string>,
  now: DateTime
): string {
  const day = (when ?? now).setZone(TIME_ZONE).toFormat('yyyy-LL-dd')
  const base = `${campaign}-${day}`
  if (!taken.has(base)) return base
  for (let index = 2; index < 500; index += 1) {
    const id = `${base}-${index}`
    if (!taken.has(id)) return id
  }
  throw new UserError('Could not mint a new post id')
}

function timed(posts: RichPost[]): { id: string; campaign: string; scheduled: DateTime }[] {
  return posts.flatMap((post) =>
    post.scheduled
      ? [{ id: post.id, campaign: post.campaign, scheduled: post.scheduled }]
      : []
  )
}

function assertCampaignName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new UserError(
      `Campaign "${name}" must be lowercase letters, numbers, and hyphens`
    )
  }
}

function assertId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    throw new UserError(
      `Id "${id}" must use letters, numbers, hyphens, or underscores`
    )
  }
}

function blank(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  return value === '' ? undefined : value
}

function trimTrailingEmpty(lines: string[]): string[] {
  const copy = [...lines]
  while (copy.length > 0 && copy[copy.length - 1].trim() === '') copy.pop()
  return copy
}

function sourceLabel(root: string, filePath: string): string {
  const label = relative(root, filePath)
  return label || filePath
}
