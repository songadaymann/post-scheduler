import { DateTime } from 'luxon'
import { etDay, parseWallTime, TIME_ZONE } from './time'
import type { SchedulerConfig, TimeWindow } from './types'

const HORIZON_DAYS = 180

export function suggestNextSlot(options: {
  campaign: string
  config: SchedulerConfig
  posts: { id: string; campaign: string; scheduled: DateTime }[]
  now: DateTime
  excludeId?: string
  notBefore?: DateTime
}): DateTime | null {
  const notBefore = (options.notBefore ?? options.now).setZone(TIME_ZONE)
  const windows = windowsFor(options.campaign, options.config)
  let day = notBefore.startOf('day')

  for (let offset = 0; offset < HORIZON_DAYS; offset += 1) {
    const dayKey = etDay(day)
    const occupied = options.posts.some(
      (post) =>
        post.id !== options.excludeId && etDay(post.scheduled) === dayKey
    )
    if (!occupied) {
      for (const window of windows) {
        const slot = firstFit(dayKey, window, notBefore, options)
        if (slot) return slot
      }
    }
    day = day.plus({ days: 1 })
  }
  return null
}

function windowsFor(campaign: string, config: SchedulerConfig): TimeWindow[] {
  const configured = config.campaigns[campaign]?.windows ?? []
  if (configured.length > 0) return configured
  return [
    {
      start: '10:00',
      end: '10:15',
      startSeconds: 10 * 3600,
      endSeconds: 10 * 3600 + 15 * 60,
    },
  ]
}

function firstFit(
  dayKey: string,
  window: TimeWindow,
  notBefore: DateTime,
  options: {
    posts: { id: string; scheduled: DateTime }[]
    excludeId?: string
    config: SchedulerConfig
  }
): DateTime | null {
  const start = atWall(dayKey, window.start)
  const end = atWall(dayKey, window.end)
  if (!start || !end || start >= end) return null

  let cursor = start
  if (notBefore.toMillis() > start.toMillis()) {
    const aligned = ceilQuarter(notBefore)
    if (!aligned || aligned.toMillis() <= start.toMillis()) return null
    cursor = aligned
  }

  while (cursor.toMillis() < end.toMillis()) {
    if (spacingOk(cursor, options)) return cursor
    const next = nextQuarter(cursor)
    if (!next || next.toMillis() <= cursor.toMillis()) return null
    cursor = next
  }
  return null
}

function spacingOk(
  candidate: DateTime,
  options: {
    posts: { id: string; scheduled: DateTime }[]
    excludeId?: string
    config: SchedulerConfig
  }
): boolean {
  const limitMs = options.config.minSpacingHours * 60 * 60 * 1000
  return options.posts.every((post) => {
    if (post.id === options.excludeId) return true
    return Math.abs(post.scheduled.toMillis() - candidate.toMillis()) >= limitMs
  })
}

function atWall(day: string, clock: string): DateTime | null {
  try {
    return parseWallTime(`${day} ${clock}`)
  } catch {
    return null
  }
}

function ceilQuarter(value: DateTime): DateTime | null {
  const local = value.setZone(TIME_ZONE)
  if (
    local.second === 0 &&
    local.millisecond === 0 &&
    local.minute % 15 === 0
  ) {
    return atWall(local.toFormat('yyyy-LL-dd'), local.toFormat('HH:mm'))
  }
  return nextQuarter(local)
}

function nextQuarter(value: DateTime): DateTime | null {
  const local = value.setZone(TIME_ZONE).startOf('minute')
  const remainder = local.minute % 15
  const delta = remainder === 0 ? 15 : 15 - remainder
  const shifted = local.plus({ minutes: delta }).set({ second: 0, millisecond: 0 })
  return atWall(shifted.toFormat('yyyy-LL-dd'), shifted.toFormat('HH:mm'))
}
