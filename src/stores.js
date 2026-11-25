import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Write a small JSON file atomically: write a sibling temp file, then rename
 * over the target. The gateway's settings file is single-writer per process and
 * tiny, but rename keeps a crash from leaving a half-written JSON file.
 */
export async function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, data, 'utf8')
  await rename(tmp, file)
}

/**
 * Create the data directory and a `.gitignore` that keeps the gateway's local
 * settings and credential files out of git. The profile directory itself may be
 * a git checkout or sit beside one. Entries are merged into an existing file so
 * an upgrade adds `token.txt` to a `.gitignore` written by an older version.
 */
export async function ensureDataDir(dir) {
  await mkdir(dir, { recursive: true })
  const gitignore = join(dir, '.gitignore')
  const required = ['settings.json', 'token.txt']
  let existing = ''
  try {
    existing = await readFile(gitignore, 'utf8')
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
  const lines = existing.split('\n').map((line) => line.trim())
  const missing = required.filter((entry) => !lines.includes(entry))
  if (missing.length === 0) return
  const prefix = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`
  await writeFile(gitignore, `${prefix}${missing.join('\n')}\n`, 'utf8')
}

export async function readJsonFile(file) {
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
