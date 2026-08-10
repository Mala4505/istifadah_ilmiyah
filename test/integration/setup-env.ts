import fs from 'node:fs'
import path from 'node:path'

/**
 * Loads the repo-root `.env` into process.env for the integration suite only.
 *
 * The unit tests under test/unit/ are pure and need no credentials; only this project
 * (vitest.integration.config.ts) pulls this in. `.env` is git-ignored and holds the real
 * project's keys — nothing here ever prints a value.
 *
 * Node 20.12+ has process.loadEnvFile(); the manual parse is the fallback so the suite
 * does not silently do nothing on an older runtime.
 */
const envPath = path.resolve(__dirname, '../../.env')

if (!fs.existsSync(envPath)) {
  throw new Error(
    `Integration suite needs a .env at the repo root (${envPath}). ` +
      'It is git-ignored — copy it in before running `npm run test:rls`.'
  )
}

if (typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envPath)
} else {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
    if (process.env[key] === undefined) process.env[key] = value
  }
}
