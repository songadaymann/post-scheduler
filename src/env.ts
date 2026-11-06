import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { UserError } from './errors'

export const CREDENTIAL_ENV_NAMES = [
  'TWITTER_API_KEY',
  'TWITTER_API_SECRET',
  'TWITTER_ACCESS_TOKEN',
  'TWITTER_ACCESS_SECRET',
] as const

export function requireEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const value = env[name]
  if (!value) {
    throw new UserError(`Missing required environment variable ${name}`)
  }
  return value
}

export function missingCredentialNames(env: NodeJS.ProcessEnv): string[] {
  return CREDENTIAL_ENV_NAMES.filter((name) => !env[name])
}

// Fill unset variables from a local .env. Existing process env wins so launchd
// can override a file, and values already in the environment are never replaced.
export function loadEnvFile(
  root: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  const path = join(root, '.env')
  if (!existsSync(path)) return

  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (env[key] === undefined) env[key] = value
  }
}
