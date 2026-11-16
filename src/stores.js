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
 * settings file out of git. The profile directory itself may be a git checkout
 * or sit beside one; ignore entries are added only when the file does not
 * already exist.
 */
export async function ensureDataDir(dir) {
  await mkdir(dir, { recursive: true })
  const gitignore = join(dir, '.gitignore')
  try {
    await readFile(gitignore, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') {
      await writeFile(gitignore, 'settings.json\n', 'utf8')
      return
    }
    throw err
  }
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
