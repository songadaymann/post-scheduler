import { DateTime } from 'luxon'

export const TIME_ZONE = 'America/New_York'

const SCHEDULED_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?: America\/New_York)?$/

interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export function toIso(value: DateTime): string {
  const iso = value.toUTC().toISO()
  if (!iso) throw new Error('Failed to format a timestamp')
  return iso
}

export function formatEt(value: DateTime): string {
  return value.setZone(TIME_ZONE).toFormat('yyyy-LL-dd hh:mm a ZZZZ')
}

export function etDay(value: DateTime): string {
  const day = value.setZone(TIME_ZONE).toISODate()
  if (!day) throw new Error('Failed to format an Eastern Time date')
  return day
}

export function localSeconds(value: DateTime): number {
  const local = value.setZone(TIME_ZONE)
  return local.hour * 3600 + local.minute * 60 + local.second
}

export function parseClock(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 3600 + minute * 60
}

// Wall times are interpreted in America/New_York. A clock time that does not
// exist (spring forward) or happens twice (fall back) is rejected so a post
// cannot be silently shifted by an hour.
export function parseWallTime(value: string): DateTime {
  const trimmed = value.trim()
  const match = SCHEDULED_PATTERN.exec(trimmed)
  if (!match) {
    throw new Error(
      `invalid scheduled datetime "${value}" (use an America/New_York wall time, e.g. 2026-12-01 10:00)`
    )
  }

  const local: LocalParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: match[6] ? Number(match[6]) : 0,
  }
  const candidates = zoneCandidates(local)
  if (candidates.length === 0) {
    throw new Error(
      `invalid scheduled datetime "${value}" (that clock time does not exist in ${TIME_ZONE})`
    )
  }
  if (candidates.length > 1) {
    throw new Error(
      `ambiguous scheduled datetime "${value}" (that clock time happens twice in ${TIME_ZONE} when daylight saving ends)`
    )
  }
  return candidates[0]
}

function zoneCandidates(local: LocalParts): DateTime[] {
  const probe = DateTime.fromObject(local, { zone: TIME_ZONE })
  if (!probe.isValid || !sameLocal(probe, local)) return []

  const found = new Map<number, DateTime>()
  found.set(probe.toMillis(), probe)

  const offsets = new Set<number>([probe.offset])
  const noon = DateTime.fromObject(
    { year: local.year, month: local.month, day: local.day, hour: 12 },
    { zone: TIME_ZONE }
  )
  if (noon.isValid) {
    offsets.add(noon.offset)
    offsets.add(noon.minus({ hours: 12 }).offset)
    offsets.add(noon.plus({ hours: 12 }).offset)
  }

  const stamp = `${pad(local.year, 4)}-${pad(local.month)}-${pad(local.day)}T${pad(local.hour)}:${pad(local.minute)}:${pad(local.second)}`
  for (const offset of offsets) {
    const zoned = DateTime.fromISO(`${stamp}${formatOffset(offset)}`, {
      setZone: true,
    }).setZone(TIME_ZONE)
    if (zoned.isValid && sameLocal(zoned, local)) {
      found.set(zoned.toMillis(), zoned)
    }
  }

  return [...found.values()]
}

function sameLocal(value: DateTime, local: LocalParts): boolean {
  const zoned = value.setZone(TIME_ZONE)
  return (
    zoned.year === local.year &&
    zoned.month === local.month &&
    zoned.day === local.day &&
    zoned.hour === local.hour &&
    zoned.minute === local.minute &&
    zoned.second === local.second
  )
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

function formatOffset(totalMinutes: number): string {
  const sign = totalMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(totalMinutes)
  const hours = Math.floor(abs / 60)
  const minutes = abs % 60
  return `${sign}${pad(hours)}:${pad(minutes)}`
}
