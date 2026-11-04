import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { relative, join } from 'path'
import { UserError } from './errors'
import { mediaKind, resolveMediaPath } from './media'
import { parseWallTime } from './time'
import type { ScheduledPost, SchedulerConfig } from './types'

const META_KEYS = new Set(['scheduled', 'media', 'campaign'])

export function loadPosts(
  root: string,
  config: SchedulerConfig
): { posts: ScheduledPost[]; errors: string[] } {
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

  const posts: ScheduledPost[] = []
  const errors: string[] = []
  const campaignFiles = new Map<string, string>()

  for (const fileName of fileNames) {
    const filePath = join(config.postsDir, fileName)
    const source = readFileSync(filePath, 'utf8')
    const parsed = parseCampaignFile(root, filePath, source)
    errors.push(...parsed.errors)
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

  posts.sort(
    (left, right) =>
      left.scheduled.toMillis() - right.scheduled.toMillis() ||
      left.id.localeCompare(right.id)
  )
  return { posts, errors }
}

function parseCampaignFile(
  root: string,
  filePath: string,
  source: string
): { posts: ScheduledPost[]; errors: string[]; campaign?: string; fileLabel: string } {
  const fileLabel = relative(root, filePath) || filePath
  const lines = stripRetired(source.replace(/^\uFEFF/, '')).split(/\r?\n/)
  const errors: string[] = []
  const posts: ScheduledPost[] = []
  let campaign: string | undefined
  let sawPost = false

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!sawPost) {
      const campaignMatch = /^campaign:\s*(\S+)\s*$/.exec(line)
      if (campaignMatch) {
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
        continue
      }
    }

    if (line.startsWith('###')) {
      const heading = /^###\s+([A-Za-z0-9][A-Za-z0-9_-]*)\s*$/.exec(line)
      if (!heading) {
        errors.push(
          `${fileLabel}:${index + 1}: heading must look like "### post-id" (letters, numbers, hyphens, underscores)`
        )
        continue
      }
      sawPost = true
      const parsed = parsePost(
        lines,
        index,
        heading[1],
        fileLabel,
        root,
        campaign
      )
      index = parsed.nextIndex - 1
      errors.push(...parsed.errors)
      if (parsed.post) posts.push(parsed.post)
      continue
    }
  }

  if (!campaign) {
    errors.push(`${fileLabel}: missing a "campaign:" line`)
    return { posts: [], errors, fileLabel }
  }

  return { posts, errors, campaign, fileLabel }
}

function parsePost(
  lines: string[],
  start: number,
  rawId: string,
  fileLabel: string,
  root: string,
  fileCampaign: string | undefined
): { post?: ScheduledPost; errors: string[]; nextIndex: number } {
  const errors: string[] = []
  const where = `${fileLabel}:${start + 1}`
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(rawId)) {
    errors.push(
      `${where}: id "${rawId}" must use letters, numbers, hyphens, or underscores`
    )
  }

  const meta = new Map<string, string>()
  let index = start + 1
  let openedFence = false
  for (; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^###\s+\S/.test(line) || /^##\s+\S/.test(line)) break
    const trimmed = line.trim()
    if (trimmed === '```text') {
      openedFence = true
      index += 1
      break
    }
    if (trimmed.startsWith('```')) {
      errors.push(`${fileLabel}:${index + 1}: text blocks must open with \`\`\`text`)
      return { errors, nextIndex: index + 1 }
    }
    if (trimmed === '' || trimmed.startsWith('<!--')) continue
    const metaMatch = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (!metaMatch) {
      errors.push(
        `${fileLabel}:${index + 1}: expected scheduled/media metadata or a \`\`\`text block`
      )
      return { errors, nextIndex: index + 1 }
    }
    const key = metaMatch[1]
    if (!META_KEYS.has(key)) {
      errors.push(`${fileLabel}:${index + 1}: unknown field "${key}"`)
      continue
    }
    if (meta.has(key)) {
      errors.push(`${fileLabel}:${index + 1}: duplicate field "${key}"`)
      continue
    }
    meta.set(key, metaMatch[2].trim())
  }

  if (!openedFence) {
    errors.push(`${where}: post ${rawId} is missing a \`\`\`text block`)
    return { errors, nextIndex: index }
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
    return { errors, nextIndex: index }
  }

  const scheduledRaw = meta.get('scheduled')
  if (!scheduledRaw) {
    errors.push(`${where}: post ${rawId} is missing scheduled`)
    return { errors, nextIndex: index }
  }

  let scheduled
  try {
    scheduled = parseWallTime(scheduledRaw)
  } catch (error) {
    errors.push(
      `${where}: ${error instanceof Error ? error.message : String(error)}`
    )
    return { errors, nextIndex: index }
  }

  const postCampaign = meta.get('campaign')
  if (postCampaign && !/^[a-z0-9][a-z0-9-]*$/.test(postCampaign)) {
    errors.push(`${where}: campaign "${postCampaign}" is not a valid campaign name`)
  }
  if (fileCampaign && postCampaign && postCampaign !== fileCampaign) {
    errors.push(
      `${where}: post campaign "${postCampaign}" does not match file campaign "${fileCampaign}"`
    )
  }
  const campaign = fileCampaign || postCampaign
  if (!campaign || errors.some((error) => error.startsWith(where))) {
    return { errors, nextIndex: index }
  }

  let mediaPath: string | undefined
  const mediaRaw = meta.get('media')
  if (mediaRaw !== undefined) {
    if (mediaRaw === '') {
      errors.push(`${where}: media path is empty`)
      return { errors, nextIndex: index }
    }
    mediaPath = resolveMediaPath(root, mediaRaw)
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(rawId)) {
    return { errors, nextIndex: index }
  }

  return {
    errors,
    nextIndex: index,
    post: {
      id: rawId,
      campaign,
      scheduled,
      text: body.join('\n'),
      ...(mediaPath ? { mediaPath } : {}),
      sourceFile: fileLabel,
    },
  }
}

function stripRetired(source: string): string {
  const lines = source.split(/\r?\n/)
  let inFence = false
  const kept: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!inFence && /^##[ \t]+Retired\b/.test(line)) break
    if (!inFence && trimmed === '```text') inFence = true
    else if (inFence && trimmed === '```') inFence = false
    kept.push(line)
  }
  return kept.join('\n')
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
