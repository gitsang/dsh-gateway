import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import bcrypt from 'bcryptjs'

/** bcrypt cost for the one password hash. 10 keeps first-run setup quick. */
const BCRYPT_ROUNDS = 10

/**
 * Write a small JSON file atomically: write a sibling temp file, then rename
 * over the target. The auth/session files are single-writer per process and
 * tiny, but rename keeps a crash from leaving a half-written JSON file.
 */
export async function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, data, 'utf8')
  await rename(tmp, file)
}

/**
 * Create the data directory and a `.gitignore` that keeps the local
 * credential/session files out of git. The profile directory itself may be a
 * git checkout or sit beside one; ignore entries are added only when the file
 * does not already exist.
 */
export async function ensureDataDir(dir) {
  await mkdir(dir, { recursive: true })
  const gitignore = join(dir, '.gitignore')
  try {
    await readFile(gitignore, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') {
      await writeFile(gitignore, 'auth.json\nsession.json\n', 'utf8')
      return
    }
    throw err
  }
}

async function readJsonFile(file) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return undefined
    throw err
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`invalid JSON in ${file}: ${err.message}`)
  }
}

export class AuthStore {
  constructor(file) {
    this.file = file
    this.hash = null
    this.writeQueue = Promise.resolve()
  }

  async init() {
    await ensureDataDir(dirname(this.file))
    const data = await readJsonFile(this.file)
    this.hash = typeof data?.passwordHash === 'string' ? data.passwordHash : null
  }

  hasPassword() {
    return this.hash !== null
  }

  async setPassword(password) {
    this.hash = await bcrypt.hash(password, BCRYPT_ROUNDS)
    await this.save()
  }

  async verify(password) {
    if (this.hash === null) return false
    return bcrypt.compare(password, this.hash)
  }

  async save() {
    const data = `${JSON.stringify({ passwordHash: this.hash }, null, 2)}\n`
    const write = () => atomicWrite(this.file, data)
    this.writeQueue = this.writeQueue.then(write, write)
    return this.writeQueue
  }
}

export class SessionStore {
  constructor(file, ttlMs) {
    this.file = file
    this.ttlMs = ttlMs
    this.tokens = new Map()
    this.writeQueue = Promise.resolve()
    this.saveTimer = null
    this.closed = false
  }

  async init() {
    await ensureDataDir(dirname(this.file))
    const data = await readJsonFile(this.file)
    const tokens = data?.tokens ?? {}
    for (const [token, expiresAt] of Object.entries(tokens)) {
      if (typeof expiresAt === 'number' && expiresAt > Date.now()) {
        this.tokens.set(token, expiresAt)
      }
    }
  }

  /** Return the session when the token exists and has not expired. */
  get(token) {
    const expiresAt = this.tokens.get(token)
    if (expiresAt === undefined) return undefined
    if (expiresAt <= Date.now()) {
      this.tokens.delete(token)
      this.scheduleSave()
      return undefined
    }
    return { token, expiresAt }
  }

  /** Create a session token and persist it before the response is sent. */
  async create() {
    const token = randomBytes(32).toString('base64url')
    this.tokens.set(token, Date.now() + this.ttlMs)
    await this.save()
    return token
  }

  /** Rolling expiry: each authenticated request extends the token to now+ttl. */
  touch(token) {
    if (this.tokens.has(token)) {
      this.tokens.set(token, Date.now() + this.ttlMs)
      this.scheduleSave()
    }
  }

  async delete(token) {
    if (this.tokens.delete(token)) await this.save()
  }

  scheduleSave() {
    if (this.saveTimer !== null || this.closed) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.save().catch(() => {})
    }, 1000)
    this.saveTimer.unref?.()
  }

  async save() {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    const data = `${JSON.stringify({ tokens: Object.fromEntries(this.tokens) }, null, 2)}\n`
    const write = () => atomicWrite(this.file, data)
    this.writeQueue = this.writeQueue.then(write, write)
    return this.writeQueue
  }

  async close() {
    this.closed = true
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await this.save().catch(() => {})
  }
}
