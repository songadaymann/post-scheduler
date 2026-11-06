import { DateTime } from 'luxon'
import { loadConfig } from './config'
import { missingCredentialNames, loadEnvFile } from './env'
import { UserError } from './errors'
import { formatPreview } from './preview'
import { processDue } from './runner'
import { acquireLock, loadState, releaseLock } from './state'
import { createTwitterPoster } from './twitter'
import type { Poster } from './types'
import { loadValidated } from './validate'

const KNOWN_FLAGS = new Set(['--preview', '--help', '-h'])

export async function execute(
  options: {
    argv?: string[]
    env?: NodeJS.ProcessEnv
    root?: string
    now?: DateTime
    posterFactory?: () => Poster
    info?: (message: string) => void
    error?: (message: string) => void
  } = {}
): Promise<number> {
  const root = options.root ?? process.cwd()
  const argv = options.argv ?? process.argv.slice(2)
  const env = options.env ?? process.env
  if (!options.env) loadEnvFile(root, env)

  const unknown = argv.filter((arg) => !KNOWN_FLAGS.has(arg))
  if (unknown.length > 0) {
    throw new UserError(
      `Unknown argument: ${unknown.join(' ')}\n\n${usageText()}`
    )
  }
  const info = options.info ?? ((message: string) => console.log(message))
  const error = options.error ?? ((message: string) => console.error(message))
  if (argv.includes('--help') || argv.includes('-h')) {
    info(usageText())
    return 0
  }

  const config = loadConfig(root)
  const { posts, warnings } = loadValidated(root, config)
  const enabled = env.POST_SCHEDULER_ENABLED === '1'
  const explicitPreview = argv.includes('--preview')
  const now = options.now ?? DateTime.now()

  if (!enabled || explicitPreview) {
    info(
      formatPreview({
        posts,
        state: loadState(config.stateDir, now),
        config,
        now,
        enabled,
        explicitPreview,
        warnings,
      })
    )
    return 0
  }

  for (const warning of warnings) info(`Warning: ${warning}`)

  if (!options.posterFactory) {
    const missing = missingCredentialNames(env)
    if (missing.length > 0) {
      throw new UserError(
        `Missing required environment variable(s): ${missing.join(', ')}`
      )
    }
  }

  const lock = acquireLock(config.stateDir)
  if (lock === null) {
    info('Another post-scheduler run is active; skipping.')
    return 0
  }

  try {
    const poster = (
      options.posterFactory ?? (() => createTwitterPoster(env))
    )()
    await processDue({ posts, config, now, poster, info, error })
  } finally {
    releaseLock(config.stateDir, lock)
  }
  return 0
}

export function usageText(): string {
  return [
    'Usage:',
    '  npm run preview     validate and print the schedule in Eastern Time (never posts)',
    '  npm start           post due items when POST_SCHEDULER_ENABLED=1',
    '  npm run self-test   run local checks with a mocked poster (no network)',
    '',
    'Flags:',
    '  --preview     print the schedule even when posting is enabled',
    '  --self-test   run local checks',
    '  --help        show this help',
  ].join('\n')
}
