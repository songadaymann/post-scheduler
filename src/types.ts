import type { DateTime } from 'luxon'

export type OutsideWindowMode = 'warn' | 'fail'

export interface TimeWindow {
  start: string
  end: string
  startSeconds: number
  endSeconds: number
}

export interface CampaignConfig {
  bannedPhrases: string[]
  windows: TimeWindow[]
  outsideWindow?: OutsideWindowMode
}

export interface SchedulerConfig {
  timezone: string
  postsDir: string
  stateDir: string
  minSpacingHours: number
  staleAfterHours: number
  outsideWindow: OutsideWindowMode
  campaigns: Record<string, CampaignConfig>
}

export type Approval = 'draft' | 'approved'
export type TimeField = 'scheduled' | 'suggested' | 'none'

export interface ScheduledPost {
  id: string
  campaign: string
  scheduled: DateTime
  text: string
  mediaPath?: string
  sourceFile: string
  // Omitted on in-memory fixtures means a legacy approved post.
  // Parsed library posts always set this. Drafts are never sent.
  approval?: Approval
  approvalStale?: boolean
  timeField?: TimeField
  suggested?: DateTime
  notes?: string
  quoteUrl?: string
  mediaRaw?: string
  approvedHash?: string
}

// A library post that may not have a send time yet. Drafts without a time
// stay here so the studio can edit them; the runner never sees them.
export interface RichPost {
  id: string
  campaign: string
  approval: Approval
  approvalStale: boolean
  timeField: TimeField
  scheduled: DateTime | null
  suggested: DateTime | null
  text: string
  mediaPath?: string
  mediaRaw?: string
  notes?: string
  quoteUrl?: string
  approvedHash?: string
  sourceFile: string
  absoluteFile: string
  parseErrors: string[]
}

export type PostStatus = 'pending' | 'posting' | 'posted' | 'missed'

export interface PostRecord {
  id: string
  campaign: string
  scheduledFor: string
  status: PostStatus
  attempts: number
  nextAttemptAt?: string
  postingStartedAt?: string
  postedAt?: string
  postedTweetId?: string
  postedTweetUrl?: string
  missedAt?: string
  lastError?: string
}

export interface SchedulerState {
  version: 1
  posts: Record<string, PostRecord>
  updatedAt: string
}

export interface PostResult {
  id: string
  url: string
}

export interface PostRequest {
  text: string
  mediaPath?: string
}

export interface Poster {
  post(input: PostRequest): Promise<PostResult>
}

export type PostDecision =
  | { kind: 'upcoming' }
  | { kind: 'due' }
  | { kind: 'waiting-retry'; nextAttemptAt: string }
  | { kind: 'miss' }
  | { kind: 'posted' }
  | { kind: 'missed-recorded' }
  | { kind: 'posting' }
