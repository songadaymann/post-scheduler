import { join } from 'path'
import { resolveMediaPath } from './media'
import type { SchedulerConfig } from './types'

export function applyRuntimePaths(
  root: string,
  config: SchedulerConfig,
  env: NodeJS.ProcessEnv
): SchedulerConfig {
  let next = config
  if (env.POST_SCHEDULER_POSTS_DIR) {
    next = {
      ...next,
      postsDir: resolveMediaPath(root, env.POST_SCHEDULER_POSTS_DIR),
    }
  }
  if (env.POST_SCHEDULER_STATE_DIR) {
    next = {
      ...next,
      stateDir: resolveMediaPath(root, env.POST_SCHEDULER_STATE_DIR),
    }
  }
  return next
}

export function mediaDirFor(root: string, env: NodeJS.ProcessEnv): string {
  if (env.POST_SCHEDULER_MEDIA_DIR) {
    return resolveMediaPath(root, env.POST_SCHEDULER_MEDIA_DIR)
  }
  return join(root, 'data', 'media')
}

export function defaultPostsDir(root: string): string {
  return join(root, 'data', 'posts')
}
