import { existsSync, readFileSync } from 'fs'
import { isAbsolute, join } from 'path'
import { UserError } from './errors'
import type {
  CampaignConfig,
  OutsideWindowMode,
  SchedulerConfig,
  TimeWindow,
} from './types'
import { TIME_ZONE, parseClock } from './time'

const TOP_LEVEL_KEYS = new Set([
  'timezone',
  'postsDir',
  'stateDir',
  'minSpacingHours',
  'staleAfterHours',
  'outsideWindow',
  'campaigns',
])

const CAMPAIGN_KEYS = new Set(['bannedPhrases', 'windows', 'outsideWindow'])
const WINDOW_KEYS = new Set(['start', 'end'])

export function loadConfig(root: string): SchedulerConfig {
  const path = join(root, 'scheduler.config.json')
  if (!existsSync(path)) {
    throw new UserError(`Missing scheduler.config.json in ${root}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new UserError(`scheduler.config.json is not valid JSON: ${message}`)
  }

  const record = asRecord(parsed, 'scheduler.config.json')
  assertOnlyKeys(record, TOP_LEVEL_KEYS, 'scheduler.config.json')

  const timezone = stringOrDefault(record, 'timezone', TIME_ZONE, 'timezone')
  if (timezone !== TIME_ZONE) {
    throw new UserError(
      `scheduler.config.json timezone must be ${TIME_ZONE} (received ${timezone})`
    )
  }

  const postsDir = resolveDir(
    root,
    stringOrDefault(record, 'postsDir', 'posts', 'postsDir')
  )
  const stateDir = resolveDir(
    root,
    stringOrDefault(record, 'stateDir', 'data/scheduler', 'stateDir')
  )

  return {
    timezone,
    postsDir,
    stateDir,
    minSpacingHours: positiveNumber(
      record,
      'minSpacingHours',
      2,
      'minSpacingHours'
    ),
    staleAfterHours: positiveNumber(
      record,
      'staleAfterHours',
      2,
      'staleAfterHours'
    ),
    outsideWindow: outsideWindowMode(
      record.outsideWindow ?? 'fail',
      'outsideWindow'
    ),
    campaigns: parseCampaigns(record.campaigns ?? {}),
  }
}

function parseCampaigns(value: unknown): Record<string, CampaignConfig> {
  const record = asRecord(value, 'campaigns')
  const campaigns: Record<string, CampaignConfig> = {}
  for (const [name, raw] of Object.entries(record)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      throw new UserError(
        `campaign name "${name}" must be lowercase letters, numbers, and hyphens`
      )
    }
    const campaign = asRecord(raw, `campaigns.${name}`)
    assertOnlyKeys(campaign, CAMPAIGN_KEYS, `campaigns.${name}`)
    const config: CampaignConfig = {
      bannedPhrases: stringList(
        campaign.bannedPhrases ?? [],
        `campaigns.${name}.bannedPhrases`
      ),
      windows: parseWindows(campaign.windows ?? [], `campaigns.${name}.windows`),
    }
    if (campaign.outsideWindow !== undefined) {
      config.outsideWindow = outsideWindowMode(
        campaign.outsideWindow,
        `campaigns.${name}.outsideWindow`
      )
    }
    campaigns[name] = config
  }
  return campaigns
}

function parseWindows(value: unknown, label: string): TimeWindow[] {
  if (!Array.isArray(value)) {
    throw new UserError(`${label} must be an array`)
  }
  return value.map((entry, index) => {
    const window = asRecord(entry, `${label}[${index}]`)
    assertOnlyKeys(window, WINDOW_KEYS, `${label}[${index}]`)
    const start = requiredString(window.start, `${label}[${index}].start`)
    const end = requiredString(window.end, `${label}[${index}].end`)
    const startSeconds = parseClock(start)
    const endSeconds = parseClock(end)
    if (startSeconds === null || endSeconds === null) {
      throw new UserError(
        `${label}[${index}] times must be HH:mm (received ${start}–${end})`
      )
    }
    if (startSeconds >= endSeconds) {
      throw new UserError(
        `${label}[${index}] must start before it ends on the same Eastern day (${start}–${end})`
      )
    }
    return { start, end, startSeconds, endSeconds }
  })
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new UserError(`${label} must be an array`)
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new UserError(`${label}[${index}] must be a non-empty string`)
    }
    return entry
  })
}

function outsideWindowMode(value: unknown, label: string): OutsideWindowMode {
  if (value === 'warn' || value === 'fail') return value
  throw new UserError(`${label} must be "warn" or "fail"`)
}

function positiveNumber(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
  label: string
): number {
  if (record[key] === undefined) return fallback
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new UserError(`${label} must be a positive number`)
  }
  return value
}

function stringOrDefault(
  record: Record<string, unknown>,
  key: string,
  fallback: string,
  label: string
): string {
  if (record[key] === undefined) return fallback
  return requiredString(record[key], label)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UserError(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function resolveDir(root: string, value: string): string {
  return isAbsolute(value) ? value : join(root, value)
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UserError(`${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowed: Set<string>,
  label: string
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new UserError(`${label} has unknown key "${key}"`)
    }
  }
}
