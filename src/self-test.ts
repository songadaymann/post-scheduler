import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { DateTime } from 'luxon'
import { loadConfig } from './config'
import { loadEnvFile } from './env'
import { loadPosts, tweetLength } from './library'
import { resolveMediaPath } from './media'
import { formatPreview } from './preview'
import { execute } from './run'
import {
  classifyPost,
  processDue,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  retryDelayMs,
} from './runner'
import {
  acquireLock,
  emptyState,
  loadState,
  lockFilePath,
  releaseLock,
  stateFilePath,
  writeState,
} from './state'
import { formatEt, parseWallTime, TIME_ZONE } from './time'
import type { Poster, PostRequest, ScheduledPost, SchedulerConfig } from './types'
import { runStudioSelfTest } from './studio-self-test'
import { loadValidated, validatePosts } from './validate'

const COMMISSION_BANS = [
  'donate',
  'donation',
  'gift to the studio',
  'tax-deductible',
  'tax deductible',
  'patron',
]

class MockPoster implements Poster {
  readonly calls: PostRequest[] = []
  failuresLeft = 0

  async post(input: PostRequest) {
    this.calls.push(input)
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1
      throw new Error('simulated outage')
    }
    const id = `mock-${this.calls.length}`
    return { id, url: `https://twitter.com/songadaymann/status/${id}` }
  }
}

export async function runSelfTest(): Promise<void> {
  const roots: string[] = []
  try {
    testTime()
    testParsing(roots)
    testValidation(roots)
    await testRunner(roots)
    testLock(roots)
    await testExecute(roots)
    testEnvFile(roots)
    testRealLibrary()
    await runStudioSelfTest(roots)
    console.log('Self-test passed.')
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
}

function testTime(): void {
  const morning = parseWallTime('2026-12-01 10:00 America/New_York')
  assert.equal(morning.hour, 10)
  assert.equal(morning.toUTC().hour, 15)
  assert.equal(formatEt(morning), '2026-12-01 10:00 AM EST')
  assert.equal(
    parseWallTime('2026-12-01T10:00:30').toUTC().toISO(),
    morning.plus({ seconds: 30 }).toUTC().toISO()
  )

  assert.throws(
    () => parseWallTime('tomorrow'),
    /invalid scheduled datetime/
  )
  assert.throws(
    () => parseWallTime('2026-12-01'),
    /invalid scheduled datetime/
  )
  assert.throws(
    () => parseWallTime('2026-02-31 10:00'),
    /does not exist/
  )
  assert.throws(
    () => parseWallTime('2026-03-08 02:30'),
    /does not exist/
  )
  assert.throws(
    () => parseWallTime('2026-11-01 01:30'),
    /ambiguous/
  )
  assert.equal(parseWallTime('2026-03-08 10:00').hour, 10)
  assert.equal(parseWallTime('2026-11-01 10:00').hour, 10)
  assert.equal(retryDelayMs(1), RETRY_BASE_MS)
  assert.equal(retryDelayMs(2), RETRY_BASE_MS * 2)
  assert.equal(retryDelayMs(20), RETRY_MAX_MS)
}

function testParsing(roots: string[]): void {
  const root = writeProject(roots, {
    'commissions.md': [
      'campaign: commissions',
      '',
      '### spaced',
      '',
      'scheduled: 2026-12-01 10:00',
      '',
      '```text',
      'line one  ',
      '',
      'line three',
      '```',
      '',
      '### kept-retired-word',
      '',
      'scheduled: 2026-12-02 10:15',
      '',
      '```text',
      'hello',
      '## Retired',
      'there',
      '```',
      '',
      '## Retired',
      '',
      '### spaced',
      '',
      'scheduled: not-a-date',
      '',
      '```text',
      'please donate',
      '```',
      '',
      '### comm-retired-do-not-schedule',
      '',
      'scheduled: 2026-01-01 10:00',
      '',
      '```text',
      'ignored',
      '```',
    ].join('\n'),
  })

  const crlfRoot = writeProject(roots, {
    'commissions.md': ['campaign: commissions', '', '### crlf', '', 'scheduled: 2026-12-01 10:00', '', '```text', 'one', '', 'two', '```', ''].join('\r\n'),
  })
  const crlf = loadPosts(crlfRoot, loadConfig(crlfRoot))
  assert.equal(crlf.errors.length, 0)
  assert.equal(crlf.posts[0]?.text, 'one\n\ntwo')

  const loaded = loadPosts(root, loadConfig(root))
  assert.deepEqual(loaded.errors, [])
  assert.deepEqual(
    loaded.posts.map((post) => post.id),
    ['spaced', 'kept-retired-word']
  )
  assert.equal(loaded.posts[0]?.text, 'line one  \n\nline three')
  assert.equal(loaded.posts[1]?.text, 'hello\n## Retired\nthere')
  assert.equal(loaded.posts[0]?.campaign, 'commissions')

  const mediaRoot = writeProject(roots, {})
  const clip = join(mediaRoot, 'clips', 'spot.mp4')
  mkdirSync(join(mediaRoot, 'clips'), { recursive: true })
  writeFileSync(clip, 'not-a-real-video')
  writeFileSync(
    join(mediaRoot, 'posts', 'wamp.md'),
    postFile('wamp', [
      {
        id: 'with-video',
        scheduled: '2026-12-01 13:00',
        text: 'watch',
        media: 'clips/spot.mp4',
      },
    ])
  )
  const mediaPosts = loadPosts(mediaRoot, loadConfig(mediaRoot))
  assert.equal(mediaPosts.errors.length, 0)
  assert.equal(mediaPosts.posts[0]?.mediaPath, clip)
  assert.equal(
    resolveMediaPath(mediaRoot, '~/clips/a.mp4'),
    join(homedir(), 'clips/a.mp4')
  )

  const mismatch = writeProject(roots, {
    'commissions.md': [
      'campaign: commissions',
      '',
      '### bad heading',
      '',
      '### mismatch',
      '',
      'campaign: wamp',
      'scheduled: 2026-12-01 10:00',
      '',
      '```text',
      'nope',
      '```',
    ].join('\n'),
  })
  const mismatchLoaded = loadPosts(mismatch, loadConfig(mismatch))
  assert.ok(
    mismatchLoaded.errors.some((error) => error.includes('heading must look like'))
  )
  assert.ok(
    mismatchLoaded.errors.some((error) => error.includes('does not match'))
  )
  assert.equal(mismatchLoaded.posts.length, 0)

  const duplicateCampaign = writeProject(roots, {
    'a.md': 'campaign: commissions\n',
    'b.md': 'campaign: commissions\n',
  })
  const duplicateCampaignLoaded = loadPosts(
    duplicateCampaign,
    loadConfig(duplicateCampaign)
  )
  assert.ok(
    duplicateCampaignLoaded.errors.some((error) =>
      error.includes('declared in both')
    )
  )
}

function testValidation(roots: string[]): void {
  const inside = (id: string, campaign: string, when: string, text = 'hello') =>
    makePost({ id, campaign, scheduled: parseWallTime(when), text })

  const ok = validatePosts(
    [
      inside('a', 'commissions', '2026-12-01 10:00'),
      inside('b', 'wamp', '2026-12-01 12:00'),
      inside('c', 'commissions', '2026-12-02 23:00'),
      inside('d', 'commissions', '2026-12-03 00:30'),
    ],
    configWith({ minSpacingHours: 2 })
  )
  assert.deepEqual(ok.errors, [])

  const tooClose = validatePosts(
    [
      inside('a', 'commissions', '2026-12-01 10:00'),
      inside('b', 'wamp', '2026-12-01 11:59'),
    ],
    configWith({ minSpacingHours: 2 })
  )
  assert.ok(tooClose.errors.some((error) => error.includes('minimum spacing')))

  const sameDay = validatePosts(
    [
      inside('a', 'commissions', '2026-12-01 10:00'),
      inside('b', 'commissions', '2026-12-01 18:00'),
    ],
    configWith({})
  )
  assert.ok(sameDay.errors.some((error) => error.includes('more than one post')))

  const duplicate = validatePosts(
    [
      inside('same', 'commissions', '2026-12-01 10:00'),
      inside('same', 'wamp', '2026-12-02 10:00'),
    ],
    configWith({})
  )
  assert.ok(duplicate.errors.some((error) => error.includes('duplicate id same')))

  const bans = configWith({
    campaigns: {
      commissions: { bannedPhrases: COMMISSION_BANS, windows: [] },
    },
  })
  for (const phrase of ['Please Donate today', 'a donation drive', 'TAX-DEDUCTIBLE', 'tax deductible', 'become a patron', 'Gift to the studio']) {
    const result = validatePosts(
      [inside('a', 'commissions', '2026-12-01 10:00', phrase)],
      bans
    )
    assert.ok(
      result.errors.some((error) => error.includes('banned phrase')),
      phrase
    )
  }
  const donor = validatePosts(
    [inside('a', 'commissions', '2026-12-01 10:00', 'a donor wrote in')],
    bans
  )
  assert.deepEqual(donor.errors, [])
  const donationCampaign = validatePosts(
    [inside('a', 'donations', '2026-12-01 16:00', 'please donate')],
    bans
  )
  assert.deepEqual(donationCampaign.errors, [])

  const windows = configWith({
    outsideWindow: 'fail',
    campaigns: {
      commissions: {
        bannedPhrases: [],
        windows: [{ start: '09:00', end: '12:00', startSeconds: 9 * 3600, endSeconds: 12 * 3600 }],
      },
    },
  })
  assert.deepEqual(
    validatePosts([inside('a', 'commissions', '2026-12-01 09:00', 'a'.repeat(280))], windows).errors,
    []
  )
  assert.deepEqual(
    validatePosts([inside('a', 'commissions', '2026-12-01 11:59')], windows).errors,
    []
  )
  assert.ok(
    validatePosts([inside('a', 'commissions', '2026-12-01 12:00')], windows).errors.some(
      (error) => error.includes('outside')
    )
  )
  const emoji = `${'a'.repeat(279)}😀`
  assert.equal(tweetLength(emoji), 280)
  assert.deepEqual(
    validatePosts([inside('a', 'commissions', '2026-12-01 10:00', emoji)], windows).errors,
    []
  )
  assert.ok(
    validatePosts(
      [inside('a', 'commissions', '2026-12-01 10:00', `${emoji}!`)],
      windows
    ).errors.some((error) => error.includes('281 characters'))
  )
  assert.ok(
    validatePosts(
      [inside('a', 'commissions', '2026-12-01 10:00', '   ')],
      windows
    ).errors.some((error) => error.includes('empty'))
  )

  const warn = validatePosts(
    [inside('a', 'commissions', '2026-12-01 08:00')],
    configWith({
      outsideWindow: 'fail',
      campaigns: {
        commissions: {
          bannedPhrases: [],
          windows: [{ start: '09:00', end: '12:00', startSeconds: 9 * 3600, endSeconds: 12 * 3600 }],
          outsideWindow: 'warn',
        },
      },
    })
  )
  assert.deepEqual(warn.errors, [])
  assert.equal(warn.warnings.length, 1)

  const libraryRoot = writeProject(roots, {
    'commissions.md': postFile('commissions', [
      { id: 'long', scheduled: '2026-12-01 10:00', text: 'a'.repeat(281) },
      { id: 'bad-date', scheduled: 'not-a-date', text: 'second' },
    ]),
    'wamp.md': postFile('wamp', [
      { id: 'long', scheduled: '2026-12-02 13:00', text: 'same id' },
      { id: 'near', scheduled: '2026-12-01 11:00', text: 'too close' },
    ]),
  })
  const combined = collectErrors(libraryRoot)
  assert.ok(combined.some((error) => error.includes('281 characters')))
  assert.ok(combined.some((error) => error.includes('invalid scheduled datetime')))
  assert.ok(combined.some((error) => error.includes('duplicate id')))
  assert.ok(combined.some((error) => error.includes('minimum spacing')))

  const missingMedia = writeProject(roots, {
    'wamp.md': postFile('wamp', [
      {
        id: 'clip',
        scheduled: '2026-12-01 13:00',
        text: 'video',
        media: 'missing.mp4',
      },
    ]),
  })
  assert.ok(collectErrors(missingMedia).some((error) => error.includes('not found')))

  const badType = writeProject(roots, {
    'wamp.md': postFile('wamp', [
      {
        id: 'clip',
        scheduled: '2026-12-01 13:00',
        text: 'video',
        media: 'notes.exe',
      },
    ]),
  })
  assert.ok(collectErrors(badType).some((error) => error.includes('media must be')))

  const badConfig = writeProject(
    roots,
    { 'commissions.md': 'campaign: commissions\n' },
    { timezone: TIME_ZONE, minSpacingHours: 0 }
  )
  assert.throws(() => loadConfig(badConfig), /minSpacingHours/)
  const unknownKey = writeProject(
    roots,
    { 'commissions.md': 'campaign: commissions\n' },
    { timezone: TIME_ZONE, notARealKey: 1 }
  )
  assert.throws(() => loadConfig(unknownKey), /unknown key/)
}

async function testRunner(roots: string[]): Promise<void> {
  const scheduled = parseWallTime('2026-12-01 10:00')
  const other = parseWallTime('2026-12-01 12:00')

  const earlyDir = freshDir(roots)
  const early = new MockPoster()
  const earlySummary = await quietDue({
    posts: [makePost({ id: 'early', campaign: 'commissions', scheduled, text: 'later' })],
    config: configWith({ stateDir: earlyDir }),
    now: scheduled.minus({ minutes: 1 }),
    poster: early,
  })
  assert.equal(early.calls.length, 0)
  assert.deepEqual(earlySummary.posted, [])
  assert.equal(existsSync(stateFilePath(earlyDir)), false)

  const onTimeDir = freshDir(roots)
  const onTime = new MockPoster()
  await quietDue({
    posts: [makePost({ id: 'on-time', campaign: 'commissions', scheduled, text: 'hello\n\nthere' })],
    config: configWith({ stateDir: onTimeDir }),
    now: scheduled,
    poster: onTime,
  })
  assert.equal(onTime.calls.length, 1)
  assert.equal(onTime.calls[0]?.text, 'hello\n\nthere')
  assert.equal(onTime.calls[0]?.mediaPath, undefined)
  await quietDue({
    posts: [makePost({ id: 'on-time', campaign: 'commissions', scheduled, text: 'hello\n\nthere' })],
    config: configWith({ stateDir: onTimeDir }),
    now: scheduled.plus({ minutes: 10 }),
    poster: onTime,
  })
  assert.equal(onTime.calls.length, 1)
  assert.equal(loadState(onTimeDir, scheduled).posts['on-time']?.status, 'posted')

  const boundaryDir = freshDir(roots)
  const boundary = new MockPoster()
  await quietDue({
    posts: [makePost({ id: 'edge', campaign: 'commissions', scheduled, text: 'edge' })],
    config: configWith({ stateDir: boundaryDir }),
    now: scheduled.plus({ hours: 2 }),
    poster: boundary,
  })
  assert.equal(boundary.calls.length, 1)

  const lateDir = freshDir(roots)
  const late = new MockPoster()
  await quietDue({
    posts: [makePost({ id: 'late', campaign: 'commissions', scheduled, text: 'late' })],
    config: configWith({ stateDir: lateDir }),
    now: scheduled.plus({ hours: 2, seconds: 1 }),
    poster: late,
  })
  assert.equal(late.calls.length, 0)
  assert.equal(loadState(lateDir, scheduled).posts.late?.status, 'missed')
  await quietDue({
    posts: [makePost({ id: 'late', campaign: 'commissions', scheduled, text: 'late' })],
    config: configWith({ stateDir: lateDir }),
    now: scheduled,
    poster: late,
  })
  assert.equal(late.calls.length, 0)

  const retryDir = freshDir(roots)
  const retry = new MockPoster()
  retry.failuresLeft = 1
  const retryPost = makePost({
    id: 'retry',
    campaign: 'commissions',
    scheduled,
    text: 'retry me',
  })
  await quietDue({
    posts: [retryPost],
    config: configWith({ stateDir: retryDir }),
    now: scheduled,
    poster: retry,
  })
  assert.equal(retry.calls.length, 1)
  assert.equal(loadState(retryDir, scheduled).posts.retry?.status, 'pending')
  await quietDue({
    posts: [retryPost],
    config: configWith({ stateDir: retryDir }),
    now: scheduled.plus({ milliseconds: RETRY_BASE_MS - 1000 }),
    poster: retry,
  })
  assert.equal(retry.calls.length, 1)
  await quietDue({
    posts: [retryPost],
    config: configWith({ stateDir: retryDir }),
    now: scheduled.plus({ milliseconds: RETRY_BASE_MS }),
    poster: retry,
  })
  assert.equal(retry.calls.length, 2)
  assert.equal(loadState(retryDir, scheduled).posts.retry?.status, 'posted')
  await quietDue({
    posts: [retryPost],
    config: configWith({ stateDir: retryDir }),
    now: scheduled.plus({ hours: 1 }),
    poster: retry,
  })
  assert.equal(retry.calls.length, 2)

  const capDir = freshDir(roots)
  const cap = new MockPoster()
  cap.failuresLeft = 1
  const capNow = scheduled.plus({ hours: 2 }).minus({ minutes: 4 })
  await quietDue({
    posts: [retryPost],
    config: configWith({ stateDir: capDir }),
    now: capNow,
    poster: cap,
  })
  assert.equal(
    DateTime.fromISO(loadState(capDir, capNow).posts.retry?.nextAttemptAt ?? '').toMillis(),
    scheduled.plus({ hours: 2 }).toMillis()
  )
  await quietDue({
    posts: [retryPost],
    config: configWith({ stateDir: capDir }),
    now: capNow.plus({ minutes: 1 }),
    poster: cap,
  })
  assert.equal(cap.calls.length, 1)
  await quietDue({
    posts: [retryPost],
    config: configWith({ stateDir: capDir }),
    now: scheduled.plus({ hours: 2 }),
    poster: cap,
  })
  assert.equal(cap.calls.length, 2)

  const giveUpDir = freshDir(roots)
  const giveUp = new MockPoster()
  giveUp.failuresLeft = 5
  await quietDue({
    posts: [retryPost],
    config: configWith({ stateDir: giveUpDir }),
    now: scheduled.plus({ hours: 2 }),
    poster: giveUp,
  })
  assert.equal(giveUp.calls.length, 1)
  assert.equal(loadState(giveUpDir, scheduled).posts.retry?.status, 'missed')
  await quietDue({
    posts: [retryPost],
    config: configWith({ stateDir: giveUpDir }),
    now: scheduled.plus({ hours: 3 }),
    poster: giveUp,
  })
  assert.equal(giveUp.calls.length, 1)

  const bothDir = freshDir(roots)
  const both = new MockPoster()
  await quietDue({
    posts: [
      makePost({ id: 'a', campaign: 'commissions', scheduled, text: 'A' }),
      makePost({ id: 'b', campaign: 'wamp', scheduled: other, text: 'B' }),
    ],
    config: configWith({ stateDir: bothDir }),
    now: other,
    poster: both,
  })
  assert.deepEqual(
    both.calls.map((call) => call.text),
    ['A', 'B']
  )

  const splitDir = freshDir(roots)
  const split = new MockPoster()
  await quietDue({
    posts: [
      makePost({ id: 'a', campaign: 'commissions', scheduled, text: 'A' }),
      makePost({ id: 'b', campaign: 'wamp', scheduled: other, text: 'B' }),
    ],
    config: configWith({ stateDir: splitDir }),
    now: other.plus({ seconds: 1 }),
    poster: split,
  })
  assert.deepEqual(
    split.calls.map((call) => call.text),
    ['B']
  )
  const splitState = loadState(splitDir, other)
  assert.equal(splitState.posts.a?.status, 'missed')
  assert.equal(splitState.posts.b?.status, 'posted')

  const mediaDir = freshDir(roots)
  const clip = join(mediaDir, 'clip.mp4')
  writeFileSync(clip, 'clip')
  const mediaPoster = new MockPoster()
  await quietDue({
    posts: [
      makePost({
        id: 'clip',
        campaign: 'wamp',
        scheduled,
        text: 'with video',
        mediaPath: clip,
      }),
    ],
    config: configWith({ stateDir: mediaDir }),
    now: scheduled,
    poster: mediaPoster,
  })
  assert.equal(mediaPoster.calls[0]?.mediaPath, clip)

  const stuckDir = freshDir(roots)
  const stuckState = emptyState(scheduled)
  stuckState.posts.stuck = {
    id: 'stuck',
    campaign: 'commissions',
    scheduledFor: scheduled.toUTC().toISO() ?? '',
    status: 'posting',
    attempts: 1,
  }
  writeState(stuckDir, stuckState)
  const stuck = new MockPoster()
  const logs: string[] = []
  await quietDue({
    posts: [makePost({ id: 'stuck', campaign: 'commissions', scheduled, text: 'stuck' })],
    config: configWith({ stateDir: stuckDir }),
    now: scheduled,
    poster: stuck,
    error: (message) => logs.push(message),
  })
  assert.equal(stuck.calls.length, 0)
  assert.equal(loadState(stuckDir, scheduled).posts.stuck?.status, 'posting')
  assert.ok(logs.some((line) => line.includes('Not retrying stuck')))

  const decision = classifyPost(
    makePost({ id: 'x', campaign: 'commissions', scheduled, text: 'x' }),
    undefined,
    scheduled.plus({ hours: 2 }),
    2
  )
  assert.equal(decision.kind, 'due')
}

async function testLock(roots: string[]): Promise<void> {
  const dir = freshDir(roots)
  const held = acquireLock(dir)
  assert.notEqual(held, null)
  assert.equal(acquireLock(dir), null)
  releaseLock(dir, held)
  const again = acquireLock(dir)
  assert.notEqual(again, null)
  releaseLock(dir, again)

  writeFileSync(lockFilePath(dir), '999\n')
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
  utimesSync(lockFilePath(dir), old, old)
  const recovered = acquireLock(dir)
  assert.notEqual(recovered, null)
  releaseLock(dir, recovered)
}

async function testExecute(roots: string[]): Promise<void> {
  const help: string[] = []
  assert.equal(await execute({ argv: ['--help'], env: {}, info: (line) => help.push(line) }), 0)
  assert.match(help.join('\n'), /npm run preview/)
  await assert.rejects(
    () => execute({ argv: ['--nope'], env: {} }),
    /Unknown argument/
  )

  const root = writeProject(roots, {
    'commissions.md': postFile('commissions', [
      { id: 'hello-id', scheduled: '2026-12-01 10:00', text: 'Hello from the test' },
    ]),
  })
  const due = parseWallTime('2026-12-01 10:00')
  const disabledLogs: string[] = []
  let disabledFactories = 0
  const disabled = await execute({
    root,
    argv: [],
    env: {},
    now: due,
    posterFactory: () => {
      disabledFactories += 1
      return new MockPoster()
    },
    info: (line) => disabledLogs.push(line),
  })
  assert.equal(disabled, 0)
  assert.equal(disabledFactories, 0)
  assert.match(disabledLogs.join('\n'), /Posting is disabled/)
  assert.match(disabledLogs.join('\n'), /hello-id/)
  assert.equal(existsSync(stateFilePath(join(root, 'data', 'scheduler'))), false)

  const previewLogs: string[] = []
  let previewFactories = 0
  const preview = await execute({
    root,
    argv: ['--preview'],
    env: { POST_SCHEDULER_ENABLED: '1' },
    now: due,
    posterFactory: () => {
      previewFactories += 1
      return new MockPoster()
    },
    info: (line) => previewLogs.push(line),
  })
  assert.equal(preview, 0)
  assert.equal(previewFactories, 0)
  assert.match(previewLogs.join('\n'), /Preview only/)
  assert.equal(existsSync(stateFilePath(join(root, 'data', 'scheduler'))), false)

  await assert.rejects(
    () =>
      execute({
        root,
        argv: [],
        env: { POST_SCHEDULER_ENABLED: '1' },
        now: due,
      }),
    /TWITTER_API_KEY/
  )
  assert.equal(existsSync(stateFilePath(join(root, 'data', 'scheduler'))), false)

  const mock = new MockPoster()
  const enabledLogs: string[] = []
  const enabled = await execute({
    root,
    argv: [],
    env: { POST_SCHEDULER_ENABLED: '1' },
    now: due,
    posterFactory: () => mock,
    info: (line) => enabledLogs.push(line),
    error: (line) => enabledLogs.push(line),
  })
  assert.equal(enabled, 0)
  assert.equal(mock.calls.length, 1)
  assert.equal(mock.calls[0]?.text, 'Hello from the test')
  assert.match(enabledLogs.join('\n'), /Posted hello-id/)
  const second = new MockPoster()
  await execute({
    root,
    argv: [],
    env: { POST_SCHEDULER_ENABLED: '1' },
    now: due.plus({ minutes: 5 }),
    posterFactory: () => second,
    info: () => {},
    error: () => {},
  })
  assert.equal(second.calls.length, 0)
  assert.equal(
    loadState(join(root, 'data', 'scheduler'), due).posts['hello-id']?.status,
    'posted'
  )

  const lockedRoot = writeProject(roots, {
    'commissions.md': postFile('commissions', [
      { id: 'locked', scheduled: '2026-12-01 10:00', text: 'locked' },
    ]),
  })
  const lockDir = join(lockedRoot, 'data', 'scheduler')
  const held = acquireLock(lockDir)
  try {
    const lockedPoster = new MockPoster()
    const lockedLogs: string[] = []
    await execute({
      root: lockedRoot,
      argv: [],
      env: { POST_SCHEDULER_ENABLED: '1' },
      now: due,
      posterFactory: () => lockedPoster,
      info: (line) => lockedLogs.push(line),
    })
    assert.equal(lockedPoster.calls.length, 0)
    assert.match(lockedLogs.join('\n'), /skipping/)
  } finally {
    releaseLock(lockDir, held)
  }

  const warnRoot = writeProject(
    roots,
    {
      'commissions.md': postFile('commissions', [
        { id: 'outside', scheduled: '2026-12-01 13:00', text: 'outside window' },
      ]),
    },
    {
      timezone: TIME_ZONE,
      postsDir: 'posts',
      stateDir: 'data/scheduler',
      minSpacingHours: 2,
      staleAfterHours: 2,
      outsideWindow: 'fail',
      campaigns: {
        commissions: {
          outsideWindow: 'warn',
          windows: [{ start: '09:00', end: '12:00' }],
        },
      },
    }
  )
  const warnPoster = new MockPoster()
  const warnLogs: string[] = []
  await execute({
    root: warnRoot,
    argv: [],
    env: { POST_SCHEDULER_ENABLED: '1' },
    now: parseWallTime('2026-12-01 13:00'),
    posterFactory: () => warnPoster,
    info: (line) => warnLogs.push(line),
  })
  assert.equal(warnPoster.calls.length, 1)
  assert.match(warnLogs.join('\n'), /Warning:/)

  const failRoot = writeProject(
    roots,
    {
      'commissions.md': postFile('commissions', [
        { id: 'blocked', scheduled: '2026-12-01 13:00', text: 'blocked' },
      ]),
    },
    {
      timezone: TIME_ZONE,
      outsideWindow: 'fail',
      campaigns: {
        commissions: { windows: [{ start: '09:00', end: '12:00' }] },
      },
    }
  )
  let failFactories = 0
  await assert.rejects(
    () =>
      execute({
        root: failRoot,
        argv: [],
        env: { POST_SCHEDULER_ENABLED: '1' },
        now: parseWallTime('2026-12-01 13:00'),
        posterFactory: () => {
          failFactories += 1
          return new MockPoster()
        },
      }),
    /outside the commissions window/
  )
  assert.equal(failFactories, 0)
}

function testEnvFile(roots: string[]): void {
  const root = freshDir(roots)
  writeFileSync(
    join(root, '.env'),
    [
      '# comment',
      'POST_SCHEDULER_ENABLED=1',
      'TWITTER_API_KEY=secret-value',
      '',
    ].join('\n')
  )
  const previousEnabled = process.env.POST_SCHEDULER_ENABLED
  const previousKey = process.env.TWITTER_API_KEY
  process.env.POST_SCHEDULER_ENABLED = '0'
  delete process.env.TWITTER_API_KEY
  try {
    loadEnvFile(root)
    assert.equal(process.env.POST_SCHEDULER_ENABLED, '0')
    assert.equal(process.env.TWITTER_API_KEY, 'secret-value')
  } finally {
    restoreEnv('POST_SCHEDULER_ENABLED', previousEnabled)
    restoreEnv('TWITTER_API_KEY', previousKey)
  }
}

function testRealLibrary(): void {
  const root = join(__dirname, '..')
  const config = loadConfig(root, { local: false })
  assert.equal(config.timezone, TIME_ZONE)
  assert.equal(config.postsDir, join(root, 'data', 'posts'))
  assert.equal(config.minSpacingHours, 2)
  assert.equal(config.staleAfterHours, 2)
  assert.deepEqual(
    [...config.campaigns.commissions.bannedPhrases].sort(),
    [...COMMISSION_BANS].sort()
  )
  assert.equal(config.campaigns.donations?.outsideWindow, 'warn')
  assert.equal(config.campaigns.wamp?.windows.length, 2)

  const templates = { ...config, postsDir: join(root, 'posts') }
  const { posts, warnings } = loadValidated(root, templates)
  assert.deepEqual(warnings, [])
  const ids = [
    'comm-2026-12-01',
    'wamp-2026-12-01',
    'donations-2026-12-01',
    'comm-2026-12-03',
    'wamp-2026-12-03',
    'donations-2026-12-04',
  ]
  assert.deepEqual(
    posts.map((post) => post.id),
    ids
  )
  assert.ok(!posts.some((post) => post.id === 'comm-retired-do-not-schedule'))
  const wamp = posts.find((post) => post.id === 'wamp-2026-12-01')
  assert.equal(
    wamp?.text,
    [
      'EXAMPLE TEMPLATE - replace before enabling.',
      '',
      'WAMP is the guessing game where the winning title becomes a song.',
      '',
      'New round is open.',
    ].join('\n')
  )
  const donation = posts.find((post) => post.id === 'donations-2026-12-01')
  assert.ok(donation?.text.includes('donate'))

  const preview = formatPreview({
    posts,
    state: emptyState(parseWallTime('2026-11-15 12:00')),
    config,
    now: parseWallTime('2026-11-15 12:00'),
    enabled: false,
    explicitPreview: false,
    warnings: [],
  })
  assert.match(preview, /Posting is disabled/)
  assert.match(preview, /2026-12-01 10:00 AM EST/)
  assert.match(preview, /2026-12-01 01:00 PM EST/)
  assert.doesNotMatch(preview, /comm-retired-do-not-schedule/)
  const positions = ids.map((id) => preview.indexOf(id))
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(positions[index] > positions[index - 1], ids[index])
  }

  const latePreview = formatPreview({
    posts: [posts[0]],
    state: emptyState(),
    config,
    now: posts[0].scheduled.plus({ hours: 3 }),
    enabled: true,
    explicitPreview: true,
    warnings: [],
  })
  assert.match(latePreview, /Too late/)
  assert.match(latePreview, /Preview only/)
}

function quietDue(
  options: Parameters<typeof processDue>[0]
): ReturnType<typeof processDue> {
  return processDue({
    info: () => {},
    error: () => {},
    ...options,
  })
}

function collectErrors(root: string): string[] {
  const config = loadConfig(root)
  const loaded = loadPosts(root, config)
  const result = validatePosts(loaded.posts, config)
  return [...loaded.errors, ...result.errors]
}

function makePost(input: {
  id: string
  campaign: string
  scheduled: DateTime
  text: string
  mediaPath?: string
}): ScheduledPost {
  return {
    id: input.id,
    campaign: input.campaign,
    scheduled: input.scheduled,
    text: input.text,
    sourceFile: `posts/${input.campaign}.md`,
    ...(input.mediaPath ? { mediaPath: input.mediaPath } : {}),
  }
}

function configWith(
  overrides: Partial<SchedulerConfig> & { stateDir?: string }
): SchedulerConfig {
  return {
    timezone: TIME_ZONE,
    postsDir: 'posts',
    stateDir: overrides.stateDir ?? join(tmpdir(), 'post-scheduler-unused'),
    minSpacingHours: overrides.minSpacingHours ?? 2,
    staleAfterHours: overrides.staleAfterHours ?? 2,
    outsideWindow: overrides.outsideWindow ?? 'fail',
    campaigns: overrides.campaigns ?? {},
  }
}

function postFile(
  campaign: string,
  posts: { id: string; scheduled: string; text: string; media?: string }[]
): string {
  return [`campaign: ${campaign}`, '', ...posts.map(postBlock)].join('\n')
}

function postBlock(post: {
  id: string
  scheduled: string
  text: string
  media?: string
}): string {
  const lines = [`### ${post.id}`, '', `scheduled: ${post.scheduled}`]
  if (post.media) lines.push(`media: ${post.media}`)
  lines.push('', '```text', post.text, '```', '')
  return lines.join('\n')
}

function writeProject(
  roots: string[],
  files: Record<string, string>,
  config?: unknown
): string {
  const root = freshDir(roots)
  mkdirSync(join(root, 'posts'))
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, 'posts', name), body)
  }
  writeFileSync(
    join(root, 'scheduler.config.json'),
    JSON.stringify(
      config ?? {
        timezone: TIME_ZONE,
        postsDir: 'posts',
        stateDir: 'data/scheduler',
        minSpacingHours: 2,
        staleAfterHours: 2,
        outsideWindow: 'fail',
        campaigns: {
          commissions: {
            bannedPhrases: COMMISSION_BANS,
            windows: [{ start: '09:00', end: '12:00' }],
          },
        },
      },
      null,
      2
    )
  )
  return root
}

function freshDir(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'post-scheduler-'))
  roots.push(root)
  return root
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
