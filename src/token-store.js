import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * A launch token dsh will accept: base64url text. dsh compares the query token
 * to its own with a constant-time byte comparison, so any such string works;
 * the length floor keeps a casually chosen secret from being guessable.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,}$/

/** Whether `value` is usable as a launch token. */
export function isValidToken(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value)
}

/**
 * The gateway's persistent launch token.
 *
 * dsh mints a fresh random launch token per process, which forces every new
 * browser to fetch the new startup URL after each restart. The gateway keeps
 * one stable token instead — from `DSH_GATEWAY_TOKEN` when set, otherwise a
 * generated secret persisted in the data directory — and installs it into
 * dsh's Connection at boot (see `installLaunchToken` in index.js). The sign-in
 * URL then survives restarts and can be bookmarked.
 *
 * The token is a credential: the file is written with owner-only permissions
 * and listed in the data directory's .gitignore.
 */
export class LaunchTokenStore {
  /**
   * @param file - path of the persisted token file.
   * @param envToken - `DSH_GATEWAY_TOKEN` value, or undefined.
   * @param logger - optional logger for a rejected env value.
   */
  constructor(file, envToken, logger) {
    this.file = file
    this.envToken = envToken
    this.logger = logger
    this.token = null
    this.source = 'generated'
  }

  async init() {
    await mkdir(dirname(this.file), { recursive: true })

    if (this.envToken !== undefined && this.envToken !== '') {
      if (isValidToken(this.envToken)) {
        this.token = this.envToken
        this.source = 'env'
        return
      }
      this.logger?.warn(
        'dsh-gateway: DSH_GATEWAY_TOKEN must be at least 22 base64url characters ([A-Za-z0-9_-]); ignoring it'
      )
    }

    let stored
    try {
      stored = (await readFile(this.file, 'utf8')).trim()
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
    }
    if (isValidToken(stored)) {
      this.token = stored
      this.source = 'file'
      // Repair permissions on a file an older version or a copy left open.
      await chmod(this.file, 0o600).catch(() => {})
      return
    }

    this.token = randomBytes(32).toString('base64url')
    this.source = 'generated'
    await writeFile(this.file, `${this.token}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(this.file, 0o600).catch(() => {})
  }
}
