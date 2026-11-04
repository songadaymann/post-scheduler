import { UserError } from './errors'
import { execute } from './run'
import { runSelfTest } from './self-test'

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) {
    if (argv.length !== 1) {
      throw new UserError('--self-test cannot be combined with other arguments')
    }
    await runSelfTest()
    return
  }

  const code = await execute()
  if (code !== 0) process.exit(code)
}

if (require.main === module) {
  main().catch((error: unknown) => {
    if (error instanceof UserError) console.error(error.message)
    else if (error instanceof Error) console.error(error.stack || error.message)
    else console.error(String(error))
    process.exit(1)
  })
}
