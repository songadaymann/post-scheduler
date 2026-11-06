import { createHash } from 'crypto'
import type { Approval, TimeField } from './types'

// Hash covers the copy that would actually go out: text, quote URL, and the
// media path as written in the markdown file. Notes and send time are not
// part of the post, so editing them does not invalidate an approval.
export function approvalHash(
  text: string,
  quoteUrl: string | undefined,
  mediaRaw: string | undefined
): string {
  return createHash('sha256')
    .update('post-scheduler-approval-v1\n')
    .update(text)
    .update('\n---quote---\n')
    .update(quoteUrl ?? '')
    .update('\n---media---\n')
    .update(mediaRaw ?? '')
    .digest('hex')
}

export function isApprovalStale(
  approval: Approval,
  hash: string | undefined,
  text: string,
  quoteUrl: string | undefined,
  mediaRaw: string | undefined
): boolean {
  if (approval !== 'approved' || !hash) return false
  return hash !== approvalHash(text, quoteUrl, mediaRaw)
}

export function isEligibleToPost(post: {
  approval?: Approval
  approvalStale?: boolean
  timeField?: TimeField
}): boolean {
  if (post.approval === 'draft') return false
  if (post.approvalStale) return false
  if (post.timeField === 'suggested' || post.timeField === 'none') return false
  return true
}
