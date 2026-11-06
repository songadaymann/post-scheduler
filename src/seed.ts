import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { defaultPostsDir, mediaDirFor } from './paths'
import type { SchedulerConfig } from './types'

// First local boot copies the committed templates into the gitignored
// library. Existing CLI tests point postsDir at their own folder, so they
// never match this path and are left alone.
export function ensureLocalLibrary(
  root: string,
  config: SchedulerConfig,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const expected = resolve(defaultPostsDir(root))
  if (resolve(config.postsDir) !== expected) return false
  mkdirSync(mediaDirFor(root, env), { recursive: true })
  if (existsSync(config.postsDir)) return false

  mkdirSync(config.postsDir, { recursive: true })
  const templateDir = join(root, 'posts')
  if (!existsSync(templateDir)) return false

  const names = readdirSync(templateDir)
    .filter(
      (name) =>
        name.endsWith('.md') && name !== 'README.md' && !name.startsWith('.')
    )
    .sort((left, right) => left.localeCompare(right))
  for (const name of names) {
    copyFileSync(join(templateDir, name), join(config.postsDir, name))
  }
  return names.length > 0
}
