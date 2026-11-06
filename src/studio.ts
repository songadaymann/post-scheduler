import { UserError } from './errors'
import { startStudio } from './studio-server'

async function main(): Promise<void> {
  const raw = process.env.PORT ?? '4310'
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UserError(`PORT must be an integer from 1 to 65535 (received ${raw})`)
  }
  if (port === 8765) {
    throw new UserError(
      'Port 8765 is used by another local app. Unset PORT to use 4310, or choose a different port.'
    )
  }
  await startStudio({ port, host: '127.0.0.1' })
}

if (require.main === module) {
  main().catch((error: unknown) => {
    if (error instanceof UserError) console.error(error.message)
    else if (error instanceof Error) console.error(error.stack || error.message)
    else console.error(String(error))
    process.exit(1)
  })
}
