import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { relative, join } from 'path'
import type { DateTime } from 'luxon'
import { isApprovalStale } from './approval'
import { UserError } from './errors'
import { mediaKind, resolveMediaPath } from './media'
import { parseWallTime } from './time'
import type { Approval, RichPost, ScheduledPost, SchedulerConfig, TimeField } from './types'

const META_KEYS = new Set([
  'scheduled',
  'suggested',
  'media',
  'campaign',
  'status',
  'notes',
  'quote',
  'approvedHash',
])

export interface SourceBlock {
  id: string | null
  lines: string[]
  startLine: number
}

export interface LinedDocument {
  newline: '\n' | '\r\n'
  prelude: string[]
  blocks: SourceBlock[]
  retired: string[]
}

export function loadLibrary(
  root: string,
  config: SchedulerConfig
): { posts: RichPost[]; errors: string[]; draftIssues: string[] } {
  if (!existsSync(config.postsDir) || !statSync(config.postsDir).isDirectory()) {
    throw new UserError(`Posts directory not found: ${config.postsDir}`)
  }

  const fileNames = readdirSync(config.postsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.md') &&
        entry.name !== 'README.md' &&
        !entry.name.startsWith('.')
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))

  const posts: RichPost[] = []
  const errors: string[] = []
  const draftIssues: string[] = []
  const campaignFiles = new Map<string, string>()

  for (const fileName of fileNames) {
    const filePath = join(config.postsDir, fileName)
    const source = readFileSync(filePath, 'utf8')
    const parsed = parseCampaignSource(root, filePath, source)
    errors.push(...parsed.errors)
    draftIssues.push(...parsed.draftIssues)
    if (parsed.campaign) {
      const previous = campaignFiles.get(parsed.campaign)
      if (previous) {
        errors.push(
          `campaign ${parsed.campaign} is declared in both ${previous} and ${parsed.fileLabel}`
        )
      } else {
        campaignFiles.set(parsed.campaign, parsed.fileLabel)
      }
    }
    posts.push(...parsed.posts)
  }

  posts.sort(compareRich)
  return { posts, errors, draftIssues }
}

export function loadPosts(
  root: string,
  config: SchedulerConfig
): {
  posts: ScheduledPost[]
  untimed: RichPost[]
  errors: string[]
  draftIssues: string[]
} {
  const loaded = loadLibrary(root, config)
  const posts: ScheduledPost[] = []
  const untimed: RichPost[] = []
  for (const post of loaded.posts) {
    const scheduled = toRunnerPost(post)
    if (scheduled) posts.push(scheduled)
    else untimed.push(post)
  }
  return {
    posts,
    untimed,
    errors: loaded.errors,
    draftIssues: loaded.draftIssues,
  }
}

export function splitDocument(source: string): LinedDocument {
  const text = source.replace(/^\uFEFF/, '')
  const newline: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  let inFence = false
  let retiredAt = lines.length
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (!inFence && /^##[ \t]+Retired\b/.test(lines[index])) {
      retiredAt = index
      break
    }
    if (!inFence && trimmed.startsWith('```')) inFence = true
    else if (inFence && trimmed === '```') inFence = false
  }

  const active = lines.slice(0, retiredAt)
  const retired = lines.slice(retiredAt)
  inFence = false
  const headingIndexes: number[] = []
  for (let index = 0; index < active.length; index += 1) {
    const trimmed = active[index].trim()
    if (!inFence && /^###\s+\S/.test(active[index])) headingIndexes.push(index)
    if (!inFence && trimmed.startsWith('```')) inFence = true
    else if (inFence && trimmed === '```') inFence = false
  }

  const first = headingIndexes[0] ?? active.length
  const blocks = headingIndexes.map((start, index) => {
    const end = headingIndexes[index + 1] ?? active.length
    const blockLines = active.slice(start, end)
    const idMatch = /^###\s+(\S+)\s*$/.exec(blockLines[0] ?? '')
    return {
      id: idMatch ? idMatch[1] : null,
      lines: blockLines,
      startLine: start + 1,
    }
  })

  return { newline, prelude: active.slice(0, first), blocks, retired }
}

export function joinDocument(doc: LinedDocument): string {
  const nl = doc.newline
  const chunks: string[] = []
  const prelude = trimTrailingEmpty(doc.prelude)
  if (prelude.some((line) => line.trim() !== '')) chunks.push(prelude.join(nl))
  for (const block of doc.blocks) {
    chunks.push(trimTrailingEmpty(block.lines).join(nl))
  }
  let body = chunks.join(`${nl}${nl}`)
  if (doc.retired.length > 0) {
    const retired = doc.retired.join(nl)
    body = body ? `${body}${nl}${nl}${retired}` : retired
  }
  if (!body.endsWith(nl)) body += nl
  return body
}

export function assertMediaReadable(post: ScheduledPost): string | null {
  if (!post.mediaPath) return null
  if (!mediaKind(post.mediaPath)) {
    return `${post.sourceFile}: ${post.id} media must be a video (${[
      '.mp4',
      '.mov',
      '.m4v',
      '.webm',
    ].join(', ')}) or an image (${['.jpg', '.jpeg', '.png', '.gif', '.webp'].join(', ')})`
  }
  if (!existsSync(post.mediaPath) || !statSync(post.mediaPath).isFile()) {
    return `${post.sourceFile}: ${post.id} media file not found: ${post.mediaPath}`
  }
  return null
}

export function tweetLength(text: string): number {
  return Array.from(text).length
}

function parseCampaignSource(
  root: string,
  filePath: string,
  source: string
): {
  posts: RichPost[]
  errors: string[]
  draftIssues: string[]
  campaign?: string
  fileLabel: string
} {
  const fileLabel = relative(root, filePath) || filePath
  const document = splitDocument(source)
  const errors: string[] = []
  const draftIssues: string[] = []
  const posts: RichPost[] = []
  const campaign = campaignFromPrelude(document.prelude, fileLabel, errors)

  for (const block of document.blocks) {
    const parsed = parsePostBlock(
      block.lines,
      block.startLine,
      fileLabel,
      filePath,
      root,
      campaign
    )
    if (parsed.fatal) errors.push(...parsed.errors)
    else draftIssues.push(...parsed.errors)
    if (parsed.post && campaign) posts.push(parsed.post)
  }

  if (!campaign) {
    errors.push(`${fileLabel}: missing a "campaign:" line`)
    return { posts: [], errors, draftIssues, fileLabel }
  }

  return { posts, errors, draftIssues, campaign, fileLabel }
}

function campaignFromPrelude(
  lines: string[],
  fileLabel: string,
  errors: string[]
): string | undefined {
  let campaign: string | undefined
  for (let index = 0; index < lines.length; index += 1) {
    const campaignMatch = /^campaign:\s*(\S+)\s*$/.exec(lines[index])
    if (!campaignMatch) continue
    const name = campaignMatch[1]
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      errors.push(
        `${fileLabel}:${index + 1}: campaign "${name}" must be lowercase letters, numbers, and hyphens`
      )
    } else if (campaign && campaign !== name) {
      errors.push(`${fileLabel}:${index + 1}: multiple campaign lines`)
    } else {
      campaign = name
    }
  }
  return campaign
}

function parsePostBlock(
  lines: string[],
  startLine: number,
  fileLabel: string,
  filePath: string,
  root: string,
  fileCampaign: string | undefined
): { post?: RichPost; errors: string[]; fatal: boolean } {
  const errors: string[] = []
  const where = `${fileLabel}:${startLine}`
  const heading = /^###\s+(\S+)\s*$/.exec(lines[0] ?? '')
  const rawId = heading ? heading[1] : ''
  if (!heading || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(rawId)) {
    errors.push(
      `${where}: heading must look like "### post-id" (letters, numbers, hyphens, underscores)`
    )
    return { errors, fatal: true }
  }

  const meta = new Map<string, string>()
  let index = 1
  let openedFence = false
  for (; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()
    if (trimmed === '```notes') {
      const note = readFence(lines, index)
      if (!note.closed) {
        errors.push(`${where}: post ${rawId} is missing a closing \`\`\` fence`)
        return { errors, fatal: fatalFor(meta) }
      }
      if (meta.has('notes')) {
        errors.push(`${fileLabel}:${startLine + index}: duplicate field "notes"`)
      } else {
        meta.set('notes', note.body)
      }
      index = note.nextIndex - 1
      continue
    }
    if (trimmed === '```text') {
      openedFence = true
      index += 1
      break
    }
    if (trimmed.startsWith('```')) {
      errors.push(`${fileLabel}:${startLine + index}: text blocks must open with \`\`\`text`)
      return { errors, fatal: fatalFor(meta) }
    }
    if (trimmed === '' || trimmed.startsWith('<!--')) continue
    const metaMatch = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (!metaMatch) {
      errors.push(
        `${fileLabel}:${startLine + index}: expected scheduled/media metadata or a \`\`\`text block`
      )
      return { errors, fatal: fatalFor(meta) }
    }
    const key = metaMatch[1]
    if (!META_KEYS.has(key)) {
      errors.push(`${fileLabel}:${startLine + index}: unknown field "${key}"`)
      continue
    }
    if (meta.has(key)) {
      errors.push(`${fileLabel}:${startLine + index}: duplicate field "${key}"`)
      continue
    }
    meta.set(key, metaMatch[2].trim())
  }

  if (!openedFence) {
    errors.push(`${where}: post ${rawId} is missing a \`\`\`text block`)
    return { errors, fatal: fatalFor(meta) }
  }

  const body: string[] = []
  let closed = false
  for (; index < lines.length; index += 1) {
    if (lines[index].trim() === '```') {
      closed = true
      index += 1
      break
    }
    body.push(lines[index])
  }
  if (!closed) {
    errors.push(`${where}: post ${rawId} is missing a closing \`\`\` fence`)
    return { errors, fatal: fatalFor(meta) }
  }

  const statusRaw = meta.get('status')
  let approval: Approval = 'approved'
  if (statusRaw !== undefined) {
    if (statusRaw !== 'draft' && statusRaw !== 'approved') {
      errors.push(`${where}: status must be "draft" or "approved"`)
      return { errors, fatal: true }
    }
    approval = statusRaw
  }
  const fatal = approval !== 'draft'

  const postCampaign = meta.get('campaign')
  if (postCampaign && !/^[a-z0-9][a-z0-9-]*$/.test(postCampaign)) {
    errors.push(`${where}: campaign "${postCampaign}" is not a valid campaign name`)
  }
  if (fileCampaign && postCampaign && postCampaign !== fileCampaign) {
    errors.push(
      `${where}: post campaign "${postCampaign}" does not match file campaign "${fileCampaign}"`
    )
  }
  if (!fileCampaign) return { errors, fatal: true }
  if (errors.some((error) => error.startsWith(where))) {
    return { errors, fatal }
  }

  let scheduled: RichPost['scheduled'] = null
  let suggested: DateTime | null = null
  let timeField: TimeField = 'none'
  const scheduledRaw = meta.get('scheduled')
  const suggestedRaw = meta.get('suggested')
  if (scheduledRaw !== undefined) {
    const parsed = parseOptionalTime(scheduledRaw, where, errors)
    if (parsed) {
      scheduled = parsed
      timeField = 'scheduled'
    }
  }
  if (suggestedRaw !== undefined) {
    const parsed = parseOptionalTime(suggestedRaw, where, errors)
    if (parsed) {
      suggested = parsed
      if (!scheduled) {
        scheduled = parsed
        timeField = 'suggested'
      }
    }
  }
  if (!scheduled && (scheduledRaw !== undefined || suggestedRaw !== undefined) && approval !== 'draft') {
    return { errors, fatal: true }
  }
  if (!scheduled && approval !== 'draft') {
    errors.push(`${where}: post ${rawId} is missing scheduled`)
    return { errors, fatal: true }
  }

  let mediaPath: string | undefined
  let mediaRaw: string | undefined
  const mediaValue = meta.get('media')
  if (mediaValue !== undefined) {
    if (mediaValue === '') {
      errors.push(`${where}: media path is empty`)
      return { errors, fatal }
    }
    mediaRaw = mediaValue
    mediaPath = resolveMediaPath(root, mediaValue)
  }

  const notes = blankToUndefined(meta.get('notes'))
  const quoteUrl = blankToUndefined(meta.get('quote'))
  const approvedHash = meta.get('approvedHash')
  if (approvedHash !== undefined && approvedHash === '') {
    errors.push(`${where}: approvedHash is empty`)
  }
  const text = body.join('\n')
  const hash = approvedHash || undefined
  const approvalStale = isApprovalStale(approval, hash, text, quoteUrl, mediaRaw)

  return {
    errors,
    fatal,
    post: {
      id: rawId,
      campaign: fileCampaign,
      approval,
      approvalStale,
      timeField: scheduled ? timeField : 'none',
      scheduled,
      suggested,
      text,
      ...(mediaPath ? { mediaPath } : {}),
      ...(mediaRaw ? { mediaRaw } : {}),
      ...(notes ? { notes } : {}),
      ...(quoteUrl ? { quoteUrl } : {}),
      ...(hash ? { approvedHash: hash } : {}),
      sourceFile: fileLabel,
      absoluteFile: filePath,
      parseErrors: [...errors],
    },
  }
}

function parseOptionalTime(
  value: string,
  where: string,
  errors: string[]
): DateTime | null {
  try {
    return parseWallTime(value)
  } catch (error) {
    errors.push(`${where}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function readFence(
  lines: string[],
  openIndex: number
): { body: string; closed: boolean; nextIndex: number } {
  const body: string[] = []
  let index = openIndex + 1
  for (; index < lines.length; index += 1) {
    if (lines[index].trim() === '```') {
      return { body: body.join('\n'), closed: true, nextIndex: index + 1 }
    }
    body.push(lines[index])
  }
  return { body: body.join('\n'), closed: false, nextIndex: index }
}

function fatalFor(meta: Map<string, string>): boolean {
  return meta.get('status') !== 'draft'
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return value === '' ? undefined : value
}

function trimTrailingEmpty(lines: string[]): string[] {
  const copy = [...lines]
  while (copy.length > 0 && copy[copy.length - 1].trim() === '') copy.pop()
  return copy
}

function compareRich(left: RichPost, right: RichPost): number {
  const leftTime = left.scheduled?.toMillis() ?? Number.MAX_SAFE_INTEGER
  const rightTime = right.scheduled?.toMillis() ?? Number.MAX_SAFE_INTEGER
  return leftTime - rightTime || left.id.localeCompare(right.id)
}

export function toRunnerPost(post: RichPost): ScheduledPost | null {
  if (!post.scheduled) return null
  return {
    id: post.id,
    campaign: post.campaign,
    scheduled: post.scheduled,
    text: post.text,
    ...(post.mediaPath ? { mediaPath: post.mediaPath } : {}),
    sourceFile: post.sourceFile,
    approval: post.approval,
    approvalStale: post.approvalStale,
    timeField: post.timeField,
    ...(post.suggested ? { suggested: post.suggested } : {}),
    ...(post.notes ? { notes: post.notes } : {}),
    ...(post.quoteUrl ? { quoteUrl: post.quoteUrl } : {}),
    ...(post.mediaRaw ? { mediaRaw: post.mediaRaw } : {}),
    ...(post.approvedHash ? { approvedHash: post.approvedHash } : {}),
  }
}
