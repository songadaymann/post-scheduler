import assert from 'node:assert/strict'
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { approvalHash } from './approval'
import { loadConfig } from './config'
import { UserError } from './errors'
import {
  createPost,
  duplicatePost,
  reschedulePost,
  retirePost,
  saveCampaign,
  suggestForPost,
  updatePost,
} from './library-edit'
import { loadPosts } from './library'
import { saveMediaBytes } from './media-store'
import { execute } from './run'
import { processDue } from './runner'
import { suggestNextSlot } from './slots'
import { loadState, stateFilePath } from './state'
import { startStudio } from './studio-server'
import { formatEt, formatWall, parseWallTime, TIME_ZONE } from './time'
import type { Poster, PostRequest, ScheduledPost, SchedulerConfig } from './types'
import { reviewPosts, sameDayHeadsUps, validatePosts } from './validate'

const BANS = [
  'donate',
  'donation',
  'gift to the studio',
  'tax-deductible',
  'tax deductible',
  'patron',
]

class MockPoster implements Poster {
  readonly calls: PostRequest[] = []
  async post(input: PostRequest) {
    this.calls.push(input)
    const id = `mock-${this.calls.length}`
    return { id, url: `https://x.com/songadaymann/status/${id}` }
  }
}

export async function runStudioSelfTest(roots: string[]): Promise<void> {
  testSuggestAndReview()
  await testDraftsNeverPost(roots)
  await testLibraryCrud(roots)
  await testRescheduleMissed(roots)
  await testSeedAndOverride(roots)
  await testStudioApi(roots)
}

function testSuggestAndReview(): void {
  const config = studioConfig()
  const open = suggestNextSlot({
    campaign: 'commissions',
    config,
    posts: [],
    now: parseWallTime('2026-12-01 08:00'),
  })
  assert.equal(formatWall(open!), '2026-12-01 09:00 America/New_York')

  const occupied = suggestNextSlot({
    campaign: 'commissions',
    config,
    posts: [
      {
        id: 'wamp-day',
        campaign: 'wamp',
        scheduled: parseWallTime('2026-12-01 13:00'),
      },
    ],
    now: parseWallTime('2026-12-01 08:00'),
  })
  assert.equal(formatWall(occupied!), '2026-12-02 09:00 America/New_York')

  const spaced = suggestNextSlot({
    campaign: 'commissions',
    config: studioConfig([
      { start: '00:15', end: '02:00', startSeconds: 15 * 60, endSeconds: 2 * 3600 },
    ]),
    posts: [
      {
        id: 'late',
        campaign: 'donations',
        scheduled: parseWallTime('2026-12-01 23:00'),
      },
    ],
    now: parseWallTime('2026-12-01 22:00'),
  })
  assert.equal(formatWall(spaced!), '2026-12-02 01:00 America/New_York')

  const banned = reviewPosts(
    [makePost('tone', 'commissions', '2026-12-01 10:00', 'Please donate today')],
    config
  )
  assert.ok(banned.byId.tone.errors.some((error) => error.includes('donate')))

  const sameDay = reviewPosts(
    [
      makePost('a', 'commissions', '2026-12-01 10:00', 'one'),
      makePost('b', 'wamp', '2026-12-01 13:00', 'two'),
    ],
    config
  )
  assert.deepEqual(validatePosts(
    [
      makePost('a', 'commissions', '2026-12-01 10:00', 'one'),
      makePost('b', 'wamp', '2026-12-01 13:00', 'two'),
    ],
    config
  ).errors, [])
  assert.ok(sameDay.headsUps.some((line) => line.includes('2026-12-01')))
  assert.equal(sameDayHeadsUps([
    { campaign: 'commissions', scheduled: parseWallTime('2026-12-01 10:00') },
    { campaign: 'wamp', scheduled: parseWallTime('2026-12-03 13:00') },
  ]).length, 0)

  const close = reviewPosts(
    [
      makePost('a', 'commissions', '2026-12-01 10:00', 'one'),
      makePost('b', 'wamp', '2026-12-01 11:00', 'two'),
    ],
    config
  )
  assert.ok(close.byId.a.errors.some((error) => error.includes('minimum')))
}

async function testDraftsNeverPost(roots: string[]): Promise<void> {
  const root = writeProject(roots, {
    'commissions.md': [
      'campaign: commissions',
      '',
      '### do-not-send',
      '',
      'status: draft',
      'scheduled: 2026-12-01 10:00',
      '',
      '```text',
      'please donate',
      '```',
      '',
      '### send-me',
      '',
      'status: approved',
      'scheduled: 2026-12-02 10:00',
      '',
      '```text',
      'Hello from the approved post',
      '```',
      '',
    ].join('\n'),
  })
  const poster = new MockPoster()
  const code = await execute({
    root,
    argv: [],
    env: { POST_SCHEDULER_ENABLED: '1' },
    now: parseWallTime('2026-12-02 10:00'),
    posterFactory: () => poster,
    info: () => {},
    error: () => {},
  })
  assert.equal(code, 0)
  assert.deepEqual(poster.calls.map((call) => call.text), ['Hello from the approved post'])
  const state = loadState(join(root, 'data', 'scheduler'), parseWallTime('2026-12-02 10:00'))
  assert.equal(state.posts['do-not-send'], undefined)
  assert.equal(state.posts['send-me']?.status, 'posted')

  const onlyDraft = writeProject(roots, {
    'commissions.md': [
      'campaign: commissions',
      '',
      '### only-draft',
      '',
      'status: draft',
      'suggested: not-a-date',
      '',
      '```text',
      'still a draft',
      '```',
      '',
    ].join('\n'),
  })
  const draftPoster = new MockPoster()
  await execute({
    root: onlyDraft,
    argv: [],
    env: { POST_SCHEDULER_ENABLED: '1' },
    now: parseWallTime('2026-12-01 10:00'),
    posterFactory: () => draftPoster,
    info: () => {},
    error: () => {},
  })
  assert.equal(draftPoster.calls.length, 0)
  assert.equal(existsSync(stateFilePath(join(onlyDraft, 'data', 'scheduler'))), false)

  const text = 'Locked copy'
  const stale = writeProject(roots, {
    'commissions.md': postFile('commissions', [
      {
        id: 'stale-copy',
        scheduled: '2026-12-01 10:00',
        text,
        extra: [
          'status: approved',
          `approvedHash: ${approvalHash('some other copy', undefined, undefined)}`,
        ],
      },
      {
        id: 'fresh-copy',
        scheduled: '2026-12-02 10:00',
        text: 'Fresh copy',
        extra: [
          'status: approved',
          `approvedHash: ${approvalHash('Fresh copy', undefined, undefined)}`,
        ],
      },
    ]),
  })
  const stalePoster = new MockPoster()
  await execute({
    root: stale,
    argv: [],
    env: { POST_SCHEDULER_ENABLED: '1' },
    now: parseWallTime('2026-12-02 10:00'),
    posterFactory: () => stalePoster,
    info: () => {},
    error: () => {},
  })
  assert.deepEqual(stalePoster.calls.map((call) => call.text), ['Fresh copy'])
  const staleState = loadState(join(stale, 'data', 'scheduler'), parseWallTime('2026-12-02 10:00'))
  assert.equal(staleState.posts['stale-copy'], undefined)
  assert.equal(staleState.posts['fresh-copy']?.status, 'posted')
}

async function testLibraryCrud(roots: string[]): Promise<void> {
  const root = writeProject(roots, {
    'commissions.md': 'campaign: commissions\n',
  })
  const config = loadConfig(root)
  const now = parseWallTime('2026-11-01 08:00')
  const created = await createPost(
    root,
    config,
    { campaign: 'commissions', text: 'First draft', date: '2026-12-01', time: '10:00' },
    now
  )
  assert.equal(created.approval, 'draft')
  assert.equal(created.timeField, 'suggested')
  assert.match(readFileSync(created.absoluteFile, 'utf8'), /status: draft/)
  assert.match(readFileSync(created.absoluteFile, 'utf8'), /suggested: 2026-12-01 10:00/)
  assert.doesNotMatch(readFileSync(created.absoluteFile, 'utf8'), /\nscheduled:/)

  await assert.rejects(
    () => updatePost(root, config, created.id, { text: 'please donate', approval: 'approved' }, now),
    (error: unknown) => error instanceof UserError && /donate/i.test(error.message)
  )
  assert.match(readFileSync(created.absoluteFile, 'utf8'), /First draft/)

  const approved = await updatePost(
    root,
    config,
    created.id,
    { text: 'A song for you', approval: 'approved', date: '2026-12-01', time: '10:00' },
    now
  )
  assert.equal(approved.approval, 'approved')
  assert.equal(approved.approvedHash, approvalHash('A song for you', undefined, undefined))
  assert.match(readFileSync(approved.absoluteFile, 'utf8'), /scheduled: 2026-12-01 10:00/)

  const demoted = await updatePost(root, config, created.id, { text: 'A song for you, revised' }, now)
  assert.equal(demoted.approval, 'draft')
  assert.equal(demoted.approvedHash, undefined)

  const kept = await updatePost(
    root,
    config,
    created.id,
    { text: 'A song for you', approval: 'approved', keepApproved: true, date: '2026-12-01', time: '10:00' },
    now
  )
  assert.equal(kept.approval, 'approved')
  assert.equal(kept.approvedHash, approvalHash('A song for you', undefined, undefined))

  const noted = await updatePost(root, config, created.id, { notes: 'internal only' }, now)
  assert.equal(noted.approval, 'approved')
  assert.equal(noted.notes, 'internal only')
  assert.match(readFileSync(noted.absoluteFile, 'utf8'), /notes: internal only/)

  const copy = await duplicatePost(root, config, created.id, now)
  assert.equal(copy.approval, 'draft')
  assert.notEqual(copy.id, created.id)
  assert.equal(copy.text, 'A song for you')

  const suggestion = suggestForPost(root, config, copy.id, now)
  assert.match(suggestion.date, /^\d{4}-\d{2}-\d{2}$/)
  assert.match(suggestion.time, /^\d{2}:\d{2}$/)

  retirePost(root, config, copy.id, now)
  const loaded = loadPosts(root, config)
  assert.ok(!loaded.posts.some((post) => post.id === copy.id))
  const retiredFile = readFileSync(join(root, 'posts', 'commissions.md'), 'utf8')
  assert.match(retiredFile, /## Retired/)
  assert.match(retiredFile, new RegExp(copy.id))
  assert.match(retiredFile, new RegExp(created.id))

  saveCampaign(root, {
    name: 'reshares',
    windows: [{ start: '18:00', end: '21:00' }],
    outsideWindow: 'warn',
    bannedPhrases: ['spam'],
  })
  const saved = loadConfig(root)
  assert.equal(saved.campaigns.reshares?.outsideWindow, 'warn')
  assert.deepEqual(saved.campaigns.reshares?.bannedPhrases, ['spam'])
  assert.ok(existsSync(join(root, 'posts', 'reshares.md')))
  assert.throws(
    () =>
      saveCampaign(root, {
        name: 'nope',
        windows: [{ start: '21:00', end: '18:00' }],
        bannedPhrases: [],
      }),
    /start before it ends/
  )
  assert.equal(loadConfig(root).campaigns.nope, undefined)
  assert.equal(loadConfig(root).campaigns.reshares?.outsideWindow, 'warn')

  const photo = saveMediaBytes(root, 'portrait.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  assert.match(photo.storedPath, /^data\/media\/\d+-portrait\.jpg$/)
  const withMedia = await updatePost(
    root,
    config,
    created.id,
    { mediaRaw: photo.storedPath },
    now
  )
  assert.equal(withMedia.mediaRaw, photo.storedPath)
  assert.match(readFileSync(withMedia.absoluteFile, 'utf8'), new RegExp(photo.storedPath))
}

async function testRescheduleMissed(roots: string[]): Promise<void> {
  const root = writeProject(roots, {
    'commissions.md': postFile('commissions', [
      { id: 'missed-one', scheduled: '2026-12-01 10:00', text: 'Try again later' },
    ]),
  })
  const config = loadConfig(root)
  const scheduled = parseWallTime('2026-12-01 10:00')
  const late = new MockPoster()
  await processDue({
    posts: loadPosts(root, config).posts,
    config,
    now: scheduled.plus({ hours: 2, seconds: 1 }),
    poster: late,
    info: () => {},
    error: () => {},
  })
  assert.equal(late.calls.length, 0)
  assert.equal(loadState(config.stateDir, scheduled).posts['missed-one']?.status, 'missed')

  const moved = await reschedulePost(
    root,
    config,
    'missed-one',
    { date: '2026-12-08', time: '10:15' },
    scheduled
  )
  assert.equal(formatEt(moved.scheduled!), '2026-12-08 10:15 AM EST')
  assert.equal(loadState(config.stateDir, scheduled).posts['missed-one'], undefined)

  const again = new MockPoster()
  await execute({
    root,
    argv: [],
    env: { POST_SCHEDULER_ENABLED: '1' },
    now: parseWallTime('2026-12-08 10:15'),
    posterFactory: () => again,
    info: () => {},
    error: () => {},
  })
  assert.deepEqual(again.calls.map((call) => call.text), ['Try again later'])
  assert.equal(
    loadState(config.stateDir, scheduled).posts['missed-one']?.status,
    'posted'
  )
}

async function testSeedAndOverride(roots: string[]): Promise<void> {
  const root = freshDir(roots)
  mkdirSync(join(root, 'posts'))
  writeFileSync(
    join(root, 'posts', 'commissions.md'),
    postFile('commissions', [
      { id: 'seeded-post', scheduled: '2026-12-01 10:00', text: 'from the template' },
    ])
  )
  writeFileSync(
    join(root, 'scheduler.config.json'),
    JSON.stringify({
      timezone: TIME_ZONE,
      postsDir: 'data/posts',
      stateDir: 'data/scheduler',
      minSpacingHours: 2,
      staleAfterHours: 2,
      outsideWindow: 'fail',
      campaigns: {
        commissions: { windows: [{ start: '09:00', end: '12:00' }] },
      },
    })
  )
  const logs: string[] = []
  await execute({
    root,
    argv: ['--preview'],
    env: {},
    now: parseWallTime('2026-11-01 10:00'),
    info: (line) => logs.push(line),
  })
  assert.ok(existsSync(join(root, 'data', 'posts', 'commissions.md')))
  assert.match(logs.join('\n'), /Seeded/)
  assert.match(logs.join('\n'), /seeded-post/)

  const custom = freshDir(roots)
  mkdirSync(join(custom, 'alt-posts'))
  writeFileSync(
    join(custom, 'alt-posts', 'commissions.md'),
    postFile('commissions', [
      { id: 'alt-post', scheduled: '2026-12-01 10:00', text: 'alternate library' },
    ])
  )
  writeFileSync(
    join(custom, 'scheduler.config.json'),
    JSON.stringify({
      timezone: TIME_ZONE,
      postsDir: 'data/posts',
      stateDir: 'data/scheduler',
      minSpacingHours: 2,
      staleAfterHours: 2,
      outsideWindow: 'fail',
      campaigns: { commissions: { windows: [{ start: '09:00', end: '12:00' }] } },
    })
  )
  const altLogs: string[] = []
  await execute({
    root: custom,
    argv: ['--preview'],
    env: { POST_SCHEDULER_POSTS_DIR: 'alt-posts' },
    now: parseWallTime('2026-11-01 10:00'),
    info: (line) => altLogs.push(line),
  })
  assert.match(altLogs.join('\n'), /alt-post/)
  assert.equal(existsSync(join(custom, 'data', 'posts')), false)
}

async function testStudioApi(roots: string[]): Promise<void> {
  const root = writeProject(roots, {
    'commissions.md': 'campaign: commissions\n',
    'wamp.md': 'campaign: wamp\n',
  })
  const studio = await startStudio({
    root,
    port: 0,
    env: { POST_SCHEDULER_ENABLED: '0' },
    info: () => {},
  })
  try {
    const page = await fetch(`${studio.url}/`)
    const html = await page.text()
    assert.equal(page.status, 200)
    assert.match(html, /Save & Keep Approved/)
    assert.match(html, /Suggest next open slot/)
    assert.match(html, /Open on X/)
    assert.match(html, /Reschedule/)

    const bootstrap = await jsonFetch(studio.url, '/api/bootstrap')
    assert.equal(bootstrap.runner.label, 'Preview')
    assert.equal(bootstrap.runner.armed, false)
    assert.ok(bootstrap.campaigns.some((campaign: { name: string }) => campaign.name === 'commissions'))

    const created = await jsonFetch(studio.url, '/api/posts', {
      campaign: 'commissions',
      text: 'Desk draft',
      date: '2026-12-03',
      time: '10:00',
    })
    const createdId = created.selectedId as string
    assert.ok(createdId)
    const draft = created.bootstrap.posts.find((post: { id: string }) => post.id === createdId)
    assert.ok(draft)
    assert.equal(draft.approval, 'draft')

    const blocked = await fetch(`${studio.url}/api/posts/${createdId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'please donate', approval: 'approved', date: '2026-12-03', time: '10:00' }),
    })
    assert.equal(blocked.status, 400)
    const blockedBody = await blocked.json() as { error: string }
    assert.match(blockedBody.error, /donate/i)

    const upload = await fetch(`${studio.url}/api/media`, {
      method: 'POST',
      headers: { 'X-Filename': 'clip.jpg' },
      body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    })
    assert.equal(upload.status, 200)
    const uploaded = await upload.json() as { mediaRaw: string; url: string }
    assert.match(uploaded.mediaRaw, /^data\/media\//)
    const preview = await fetch(`${studio.url}${uploaded.url}`)
    assert.equal(preview.status, 200)
    assert.equal(preview.headers.get('content-type'), 'image/jpeg')

    const attached = await jsonFetch(studio.url, `/api/posts/${createdId}`, {
      mediaRaw: uploaded.mediaRaw,
      approval: 'draft',
    })
    const attachedPost = attached.bootstrap.posts.find((post: { id: string }) => post.id === createdId)
    assert.ok(attachedPost)
    assert.equal(attachedPost.mediaRaw, uploaded.mediaRaw)
    assert.equal(attachedPost.mediaKind, 'image')

    const approved = await jsonFetch(studio.url, `/api/posts/${createdId}`, {
      text: 'Desk draft ready',
      approval: 'approved',
      date: '2026-12-03',
      time: '10:00',
      mediaRaw: uploaded.mediaRaw,
    })
    const approvedPost = approved.bootstrap.posts.find((post: { id: string }) => post.id === createdId)
    assert.ok(approvedPost)
    assert.equal(approvedPost.approval, 'approved')
    assert.equal(approvedPost.bucket, 'scheduled')

    const shifted = await jsonFetch(studio.url, `/api/posts/${createdId}`, { shiftDays: 1 })
    const shiftedPost = shifted.bootstrap.posts.find((post: { id: string }) => post.id === createdId)
    assert.ok(shiftedPost)
    assert.equal(shiftedPost.date, '2026-12-04')
    assert.equal(shiftedPost.approval, 'approved')

    await jsonFetch(studio.url, '/api/campaigns', {
      name: 'reshares',
      windows: [{ start: '19:00', end: '22:00' }],
      outsideWindow: 'warn',
      bannedPhrases: [],
    })
    assert.ok(existsSync(join(root, 'posts', 'reshares.md')))
    const reshared = loadConfig(root)
    assert.equal(reshared.campaigns.reshares?.windows[0]?.start, '19:00')

    if (ffprobeInstalled()) {
      const video = saveMediaBytes(root, 'too-fake.mp4', Buffer.from('not-a-video'))
      const videoResponse = await fetch(`${studio.url}/api/posts/${createdId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaRaw: video.storedPath, approval: 'approved', keepApproved: true }),
      })
      assert.equal(videoResponse.status, 400)
      const videoBody = await videoResponse.json() as { error: string }
      assert.match(videoBody.error, /duration|ffprobe|video/i)
    }
  } finally {
    await studio.close()
  }
}

function ffprobeInstalled(): boolean {
  const result = spawnSync('ffprobe', ['-version'], { encoding: 'utf8' })
  return result.status === 0
}

function studioConfig(
  windows: { start: string; end: string; startSeconds: number; endSeconds: number }[] = [
    { start: '09:00', end: '12:00', startSeconds: 9 * 3600, endSeconds: 12 * 3600 },
  ]
): SchedulerConfig {
  return {
    timezone: TIME_ZONE,
    postsDir: 'posts',
    stateDir: join(tmpdir(), 'post-scheduler-unused'),
    minSpacingHours: 2,
    staleAfterHours: 2,
    outsideWindow: 'fail',
    campaigns: {
      commissions: { bannedPhrases: BANS, windows },
      wamp: {
        bannedPhrases: [],
        windows: [{ start: '12:00', end: '15:00', startSeconds: 12 * 3600, endSeconds: 15 * 3600 }],
      },
    },
  }
}

function makePost(id: string, campaign: string, when: string, text: string): ScheduledPost {
  return {
    id,
    campaign,
    scheduled: parseWallTime(when),
    text,
    sourceFile: `posts/${campaign}.md`,
    approval: 'approved',
    timeField: 'scheduled',
  }
}

function postFile(
  campaign: string,
  posts: { id: string; scheduled: string; text: string; extra?: string[] }[]
): string {
  return [
    `campaign: ${campaign}`,
    '',
    ...posts.map((post) =>
      [
        `### ${post.id}`,
        '',
        ...(post.extra ?? []),
        `scheduled: ${post.scheduled}`,
        '',
        '```text',
        post.text,
        '```',
        '',
      ].join('\n')
    ),
  ].join('\n')
}

function writeProject(roots: string[], files: Record<string, string>): string {
  const root = freshDir(roots)
  mkdirSync(join(root, 'posts'))
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, 'posts', name), body)
  }
  writeFileSync(
    join(root, 'scheduler.config.json'),
    JSON.stringify(
      {
        timezone: TIME_ZONE,
        postsDir: 'posts',
        stateDir: 'data/scheduler',
        minSpacingHours: 2,
        staleAfterHours: 2,
        outsideWindow: 'fail',
        campaigns: {
          commissions: {
            bannedPhrases: BANS,
            windows: [{ start: '09:00', end: '12:00' }],
          },
          wamp: { windows: [{ start: '12:00', end: '15:00' }] },
          donations: { windows: [{ start: '15:00', end: '18:00' }] },
        },
      },
      null,
      2
    )
  )
  return root
}

function freshDir(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'post-scheduler-studio-'))
  roots.push(root)
  return root
}

async function jsonFetch(
  url: string,
  path: string,
  body?: unknown
): Promise<{
  runner: { label: string; armed: boolean }
  campaigns: { name: string; windows?: { start: string }[] }[]
  posts: {
    id: string
    approval: string
    bucket: string
    mediaRaw: string
    mediaKind: string | null
    date: string | null
  }[]
  selectedId?: string
  bootstrap: {
    posts: {
      id: string
      approval: string
      bucket: string
      mediaRaw: string
      mediaKind: string | null
      date: string | null
    }[]
  }
}> {
  const response = await fetch(`${url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json() as { error?: string }
  if (!response.ok) throw new Error(payload.error || response.statusText)
  return payload as Awaited<ReturnType<typeof jsonFetch>>
}
